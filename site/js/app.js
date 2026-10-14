import { Planner, formatTime, formatDistance, distance } from './router.js';

/* global L */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  site: null,
  transit: null,
  precincts: null,
  planner: null,
  home: null,       // { lat, lon, label }
  outbound: [],     // itineraries to the polling place
  inbound: [],      // itineraries back home
  layers: {},
};

// ---------- Boot ----------

async function loadJson(url, optional = false) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (optional) return null;
    throw e;
  }
}

async function init() {
  try {
    [state.site, state.transit] = await Promise.all([loadJson('data/site-data.json'), loadJson('data/transit.json')]);
    if (state.site.hasPrecincts) state.precincts = await loadJson('data/precincts.geojson', true);
  } catch (e) {
    showBanner(`The trip planner couldn't load its data (${esc(e.message)}). Please try again later.`);
    $('#plan-btn').disabled = true;
    return;
  }
  state.planner = new Planner(state.transit);
  setupText();
  setupForm();
  setupMap();
}

function setupText() {
  const { site, transit } = state;
  document.title = site.siteName;
  $('#site-name').textContent = site.siteName;
  const eDate = parseDate(site.election.date);
  $('#election-chip').textContent = `${site.election.name}: ${eDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
  $('#lookup-link').href = site.links.voterLookup;
  $('#hours-hint').textContent = `Polls are open ${formatTime(toMin(site.election.pollsOpen))} to ${formatTime(toMin(site.election.pollsClose))}. If you're in line by closing time, you can vote.`;

  const notes = [];
  const today = todayStr(site.timezone);
  if (today > site.election.date) notes.push(`This election is over. Polling places and bus schedules shown here may be out of date.`);
  if (transit.substituted) {
    notes.push(`${site.transit.agency} hasn't published its schedule for ${eDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} yet, so trip times use the schedule for ${parseDate(transit.serviceDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}. Check again closer to Election Day.`);
  }
  if (notes.length) showBanner(notes.map(esc).join('<br>'));

  const fare = site.transit.fareNote ? ` ${site.transit.fareNote}`
    : transit.fare ? ` A regular fare is $${transit.fare.price.toFixed(2)} (from ${site.transit.agency}'s published fare data).` : '';
  $('#info-body').innerHTML = `
    <ul>
      <li><strong>Bring what you need to vote.</strong> Check current ID rules at <a href="${esc(site.links.stateElections)}" target="_blank" rel="noopener">elections.virginia.gov</a>.</li>
      <li><strong>Riding the bus.</strong> Bus times come from ${esc(site.transit.agency)}'s published schedule. Real buses can run late, so leave yourself some extra time.${esc(fare)}
        See <a href="${esc(site.transit.agencyUrl)}" target="_blank" rel="noopener">${esc(site.transit.agency)}</a> for ${site.transit.fareNote ? '' : 'fares, '}detours and real-time arrivals.</li>
      <li><strong>Accessibility.</strong> ${esc(site.transit.paratransitNote)} Virginia also offers curbside voting for voters age 65 or older and voters with a disability. Ask an election officer when you arrive.</li>
      <li><strong>Early voting.</strong> ${esc(site.earlyVoting.note)} Early voting runs ${esc(fmtDate(site.earlyVoting.start))} to ${esc(fmtDate(site.earlyVoting.end))} at ${esc(site.earlyVoting.address)}.</li>
      <li><strong>Questions about where you vote?</strong> Call the ${esc(site.links.registrarName)} at ${esc(site.links.registrarPhone)} or visit the <a href="${esc(site.links.cityElections)}" target="_blank" rel="noopener">city's elections page</a>.</li>
    </ul>`;

  $('#footer').innerHTML = `
    <p>Polling places: <a href="${esc(site.links.cityPollingPlaces)}" target="_blank" rel="noopener">${esc(site.cityGov)}</a> (checked ${esc(fmtDate(site.pollingChecked))}).
       Bus schedules: ${esc(site.transit.agency)} GTFS feed, updated ${esc(new Date(transit.generated).toLocaleDateString('en-US'))}.
       Maps: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors.</p>
    <p>When you search for an address, it's sent to OpenStreetMap's geocoder to place it on the map. This site doesn't store it.</p>
    <p>This is an independent, nonpartisan tool. It isn't run by the ${esc(site.cityGov)}, the Virginia Department of Elections, or ${esc(site.transit.agency)}. Always confirm your polling place with official sources.</p>`;
}

// ---------- Form ----------

function setupForm() {
  const { site } = state;
  const select = $('#place');
  const places = site.places.filter((p) => !p.early).sort((a, b) => a.precinct.localeCompare(b.precinct));
  const early = site.places.find((p) => p.early);
  const today = todayStr(site.timezone);
  select.innerHTML = `<option value="">${state.precincts ? 'Detect from my address' : 'Choose your precinct'}</option>` +
    places.map((p) => `<option value="${esc(p.id)}">${esc(p.precinct)} (${esc(p.place)})</option>`).join('') +
    (early && today <= site.earlyVoting.end ? `<option value="${esc(early.id)}">Early voting: ${esc(early.place.replace(/ \(early voting\)$/, ''))}</option>` : '');

  const depart = $('#depart');
  const open = toMin(site.election.pollsOpen) - 60;
  const close = toMin(site.election.pollsClose) - 30;
  for (let m = open; m <= close; m += 15) {
    depart.add(new Option(formatTime(m), String(m), false, m === 8 * 60));
  }

  $('#address').addEventListener('input', () => { state.home = null; hideSuggestions(); setStatus('#home-status', ''); });
  $('#locate').addEventListener('click', useMyLocation);
  $('#place').addEventListener('change', () => { setStatus('#place-status', ''); highlightPlace($('#place').value); });
  $('#trip-form').addEventListener('submit', onSubmit);
}

async function onSubmit(e) {
  e.preventDefault();
  const btn = $('#plan-btn');
  btn.disabled = true;
  btn.textContent = 'Finding buses…';
  try {
    if (!state.home) {
      const q = $('#address').value.trim();
      if (!q) { setStatus('#home-status', 'Enter your home address, use your location, or tap the map.', 'bad'); $('#address').focus(); return; }
      const hits = await geocodeAddress(q);
      if (!hits.length) { setStatus('#home-status', `We couldn't find that address in ${state.site.cityName}. Check the spelling, or tap your home on the map.`, 'bad'); return; }
      if (hits.length > 1 && !sameSpot(hits)) { showSuggestions(hits); setStatus('#home-status', 'Which one is your address?', ''); return; }
      setHome(hits[0]);
    }
    plan();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find my bus';
  }
}

function sameSpot(hits) {
  return hits.every((h) => distance(h.lat, h.lon, hits[0].lat, hits[0].lon) < 60);
}

function setHome(h, { quiet = false } = {}) {
  state.home = h;
  hideSuggestions();
  if (!quiet) setStatus('#home-status', `✓ ${h.label}`, 'ok');
  drawHome();
  if (!$('#place').value || $('#place').dataset.auto === '1') detectPrecinct();
}

function detectPrecinct() {
  if (!state.precincts || !state.home) return;
  const id = precinctAt(state.home.lat, state.home.lon);
  const select = $('#place');
  if (id) {
    select.value = id;
    select.dataset.auto = '1';
    const p = placeById(id);
    setStatus('#place-status', `Based on your address, you probably vote in ${p.precinct}. Please confirm it matches your voter card.`, 'ok');
    highlightPlace(id);
  } else {
    select.value = '';
    setStatus('#place-status', `We couldn't match that address to a ${state.site.precinctArea} precinct. Choose your precinct from the list (it's on your voter card).`, 'bad');
  }
}

function plan() {
  const { site, planner } = state;
  let placeId = $('#place').value;
  if (!placeId && state.precincts) { detectPrecinct(); placeId = $('#place').value; }
  if (!placeId) {
    setStatus('#place-status', 'Choose your precinct so we know where you vote.', 'bad');
    $('#place').focus();
    return;
  }
  const place = placeById(placeId);
  const departAt = Number($('#depart').value);
  const home = state.home;

  if (!Number.isFinite(place.lat)) {
    renderResults(place, [], { noCoords: true });
    return;
  }
  const to = { lat: place.lat, lon: place.lon };
  const options = planner.options(home, to, departAt, 3);
  const walkMeters = distance(home.lat, home.lon, to.lat, to.lon) * planner.o.detour;
  state.outbound = options;
  state.inbound = [];
  state.trip = { home, place, departAt };
  renderResults(place, options, { walkMeters });
  if (options.length) selectOption(0); else drawItinerary(null);
}

function planReturn() {
  const { home, place, departAt } = state.trip;
  const voteDone = Math.max(departAt + 45, (state.outbound[0]?.arrive ?? departAt) + 30);
  const options = state.planner.options({ lat: place.lat, lon: place.lon }, home, voteDone, 3);
  state.inbound = options;
  const el = $('#return-results');
  el.innerHTML = `<h3>Getting home (leaving around ${formatTime(voteDone)})</h3>` +
    (options.length ? options.map((o, i) => optionHtml(o, i, true)).join('') : `<p class="muted">We didn't find a bus home within two hours of ${formatTime(voteDone)}.</p>`);
  bindOptions(el);
  if (options.length) selectOption(0, el);
}

// ---------- Results ----------

function renderResults(place, options, { walkMeters, noCoords } = {}) {
  const { site, transit, planner, home } = state;
  const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${home.lat},${home.lon}&destination=${encodeURIComponent(place.address)}&travelmode=transit`;
  const polls = place.early
    ? `<p class="muted">Early voting location</p>`
    : `<p class="muted">${esc(place.precinct)} precinct · Polls open ${formatTime(toMin(site.election.pollsOpen))}–${formatTime(toMin(site.election.pollsClose))}</p>`;
  let html = `
    <div class="card">
      <h2>${esc(place.place)}</h2>
      <p>${esc(place.address)}</p>
      ${polls}
      ${place.note ? `<p class="note">${esc(place.note)}</p>` : ''}
    </div>`;

  if (noCoords) {
    html += `<div class="card"><p>We don't have this location on the map yet. <a href="${gmaps}" target="_blank" rel="noopener">Get transit directions in Google Maps</a>.</p></div>`;
    $('#results').innerHTML = html;
    return;
  }

  html += `<div class="card" id="outbound-results"><h2>Bus options</h2>`;
  if (walkMeters < 1300) {
    html += `<p class="note">Your polling place is about ${formatDistance(walkMeters)} away, roughly a ${Math.round(walkMeters / planner.o.walkSpeed)}-minute walk. Walking may be faster than the bus.</p>`;
  }
  if (options.length) {
    html += options.map((o, i) => optionHtml(o, i)).join('');
    const late = options[0].arrive > toMin(site.election.pollsClose) && !place.early;
    if (late) html += `<p class="note">⚠ This gets you there after polls close at ${formatTime(toMin(site.election.pollsClose))}. Try leaving earlier.</p>`;
  } else {
    const nearHome = planner.stopsNear(home.lat, home.lon).length;
    const nearPlace = planner.stopsNear(place.lat, place.lon).length;
    const why = !nearHome ? 'There are no bus stops within about ¾ mile of your home.'
      : !nearPlace ? 'There are no bus stops within about ¾ mile of this polling place.'
      : `We couldn't find a trip with two buses or fewer leaving around ${formatTime(state.trip.departAt)}. Try a different time.`;
    html += `<p>${esc(why)}</p>`;
  }
  html += `<p class="muted" style="margin-top:10px"><a href="${gmaps}" target="_blank" rel="noopener">Compare in Google Maps</a> · times are scheduled, not live.</p>`;
  if (options.length && !place.early) html += `<button type="button" class="secondary" id="return-btn">Plan my trip home</button>`;
  html += `<div id="return-results"></div></div>`;

  // Routes near home and near the polling place
  const list = (lat, lon) => planner.routesNear(lat, lon, 800)
    .sort((a, b) => a.meters - b.meters)
    .map((r) => `<li>${badge(r.route)} <span>${esc(routeName(r.route))} · stop ${esc(transit.stops[r.stop][0])} (${formatDistance(r.meters)})</span></li>`).join('');
  const nh = list(home.lat, home.lon);
  const np = list(place.lat, place.lon);
  html += `<div class="card"><h2>Bus routes nearby</h2>
    <h3>Near your home</h3>${nh ? `<ul class="routes-list">${nh}</ul>` : '<p class="muted">None within ½ mile.</p>'}
    <h3>Near your polling place</h3>${np ? `<ul class="routes-list">${np}</ul>` : '<p class="muted">None within ½ mile.</p>'}
  </div>`;

  $('#results').innerHTML = html;
  bindOptions($('#outbound-results'));
  $('#return-btn')?.addEventListener('click', planReturn);
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function optionHtml(o, i, ret = false) {
  const rides = o.legs.filter((l) => l.type === 'ride');
  const minutes = Math.round(o.arrive - o.leave);
  const steps = o.legs.map((l) => stepHtml(l, o, ret)).join('');
  return `
    <div class="option" data-index="${i}">
      <button type="button" aria-expanded="false">
        <span>
          <span class="option-times">${formatTime(o.leave)} → ${formatTime(o.arrive)}</span><br>
          <span class="option-meta">${minutes} min · ${rides.length === 1 ? '1 bus' : `${rides.length} buses`} · ${formatDistance(o.walkMeters)} walking</span>
        </span>
        <span class="badges">${rides.map((r) => badge(r.route)).join('')}</span>
      </button>
      <ol class="steps" hidden>${steps}</ol>
    </div>`;
}

function stepHtml(l, o, ret) {
  const { stops } = state.transit;
  const stopName = (i) => esc(stops[i][0]);
  if (l.type === 'ride') {
    const r = state.transit.routes[l.route];
    return `<li class="ride" style="--leg-color:${esc(r.color)}"><span class="time">${formatTime(l.depart)}</span>
      Take ${badge(l.route)} ${esc(l.headsign ? `toward ${l.headsign}` : routeName(l.route))} from <strong>${stopName(l.fromStop)}</strong>.
      Ride ${l.stopCount} stop${l.stopCount === 1 ? '' : 's'} and get off at <strong>${stopName(l.toStop)}</strong> (${formatTime(l.arrive)}).</li>`;
  }
  const dist = formatDistance(l.meters);
  if (l.first) {
    const dest = ret ? 'Leave the polling place' : 'Leave home';
    return `<li><span class="time">${formatTime(o.leave)}</span> ${dest} and walk ${dist} to <strong>${stopName(l.toStop)}</strong>.</li>`;
  }
  if (l.final) {
    const dest = ret ? 'home' : 'your polling place';
    return `<li><span class="time">${formatTime(o.arrive)}</span> Walk ${dist} to ${dest}.</li>`;
  }
  return `<li>Walk ${dist} to <strong>${stopName(l.toStop)}</strong> to change buses.</li>`;
}

function bindOptions(container) {
  container.querySelectorAll(':scope > .option > button').forEach((btn) => {
    btn.addEventListener('click', () => selectOption(Number(btn.parentElement.dataset.index), container));
  });
}

function selectOption(i, container = $('#outbound-results')) {
  // Only one itinerary (outbound or return) is shown on the map at a time
  $('#results').querySelectorAll('.option').forEach((el) => {
    const on = el.parentElement === container && Number(el.dataset.index) === i;
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
    el.querySelector('button').setAttribute('aria-expanded', String(on));
    el.querySelector('.steps').hidden = !on;
  });
  const list = container.id === 'return-results' ? state.inbound : state.outbound;
  drawItinerary(list[i]);
}

function badge(routeIdx) {
  const r = state.transit.routes[routeIdx];
  return `<span class="badge" style="background:${esc(r.color)};color:${esc(r.textColor)}" title="${esc(routeName(routeIdx))}">${esc(r.short || r.long.slice(0, 3))}</span>`;
}

function routeName(i) {
  const r = state.transit.routes[i];
  return r.short && r.long ? `Route ${r.short}: ${r.long}` : r.long || `Route ${r.short}`;
}

// ---------- Map ----------

function setupMap() {
  const { site, transit } = state;
  const map = L.map('map', { zoomControl: true }).setView(site.mapCenter, site.mapZoom);
  state.map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // All bus routes, faint
  const routes = L.layerGroup().addTo(map);
  for (const [ri, lines] of Object.entries(transit.shapes)) {
    const r = transit.routes[ri];
    for (const line of lines) {
      L.polyline(line, { color: r.color, weight: 3, opacity: 0.35 }).bindTooltip(routeName(Number(ri)), { sticky: true }).addTo(routes);
    }
  }
  state.layers.routes = routes;

  if (state.precincts) {
    state.layers.precincts = L.geoJSON(state.precincts, {
      style: { color: '#6d28d9', weight: 1, opacity: 0.4, fillOpacity: 0.03 },
      interactive: false,
    }).addTo(map);
  }

  // Polling places
  state.layers.places = {};
  for (const p of site.places) {
    if (!Number.isFinite(p.lat)) continue;
    const m = L.marker([p.lat, p.lon], { icon: placeIcon(p, false), title: p.place, keyboard: true }).addTo(map);
    const div = document.createElement('div');
    div.innerHTML = `<strong>${esc(p.place)}</strong><br>${esc(p.address)}<br><span style="color:#5b6878">${p.early ? 'Early voting' : `${esc(p.precinct)} precinct`}</span><br>`;
    const b = document.createElement('button');
    b.textContent = 'I vote here';
    b.addEventListener('click', () => {
      $('#place').value = p.id;
      $('#place').dataset.auto = '';
      setStatus('#place-status', '');
      highlightPlace(p.id);
      map.closePopup();
      if (state.home) plan();
    });
    div.append(b);
    m.bindPopup(div);
    state.layers.places[p.id] = m;
  }

  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    $('#address').value = `Pin at ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setHome({ lat, lon: lng, label: 'Using the pin you dropped on the map' });
  });

  $('#legend').innerHTML = `<div><span class="pin home" style="width:14px;height:14px;border-width:1px"></span> Home</div>
    <div><span class="pin poll" style="width:14px;height:14px;border-width:1px"></span> Polling place</div>
    <div><span class="pin early" style="width:14px;height:14px;border-width:1px"></span> Early voting</div>
    <div><i style="background:#888;opacity:.6"></i> Bus routes</div>`;
  $('#legend').hidden = false;
}

function placeIcon(p, active) {
  const cls = p.early ? 'early' : `poll${active ? '' : ' dim'}`;
  const size = active || p.early ? 30 : 22;
  return L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>✓</span></div>`, iconSize: [size, size], iconAnchor: [size / 2, size], popupAnchor: [0, -size] });
}

function highlightPlace(id) {
  for (const [pid, m] of Object.entries(state.layers.places || {})) {
    const p = placeById(pid);
    m.setIcon(placeIcon(p, pid === id));
    m.setZIndexOffset(pid === id ? 1000 : 0);
  }
}

function drawHome() {
  const { map, home } = state;
  if (state.layers.home) state.layers.home.remove();
  state.layers.home = L.marker([home.lat, home.lon], {
    icon: L.divIcon({ className: '', html: '<div class="pin home"><span>⌂</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] }),
    title: 'Home',
    zIndexOffset: 1100,
  }).addTo(map);
  map.setView([home.lat, home.lon], Math.max(map.getZoom(), 14));
}

function drawItinerary(o) {
  const { map, transit } = state;
  if (state.layers.trip) state.layers.trip.remove();
  if (!o) {
    const pts = [[state.trip.home.lat, state.trip.home.lon], [state.trip.place.lat, state.trip.place.lon]];
    map.fitBounds(pts, { padding: [40, 40] });
    return;
  }
  const g = L.layerGroup().addTo(map);
  const pt = (s) => [transit.stops[s][1], transit.stops[s][2]];
  const walkStyle = { color: '#334155', weight: 4, opacity: 0.8, dashArray: '2 8', lineCap: 'round' };
  const bounds = [[o.from.lat, o.from.lon], [o.to.lat, o.to.lon]];
  for (const l of o.legs) {
    if (l.type === 'ride') {
      const r = transit.routes[l.route];
      const path = l.path.map(pt);
      L.polyline(path, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(g);
      L.polyline(path, { color: r.color, weight: 6, opacity: 1 }).addTo(g);
      for (const [s, label] of [[l.fromStop, `Board ${routeName(l.route)} at ${formatTime(l.depart)}`], [l.toStop, `Get off at ${formatTime(l.arrive)}`]]) {
        L.marker(pt(s), { icon: L.divIcon({ className: '', html: `<div class="stop-dot" style="--c:${esc(r.color)}"></div>`, iconSize: [14, 14] }) })
          .bindTooltip(`${transit.stops[s][0]}: ${label}`).addTo(g);
      }
      bounds.push(...path);
    } else if (l.first) {
      L.polyline([[o.from.lat, o.from.lon], pt(l.toStop)], walkStyle).addTo(g);
    } else if (l.final) {
      L.polyline([pt(l.fromStop), [o.to.lat, o.to.lon]], walkStyle).addTo(g);
    } else {
      L.polyline([pt(l.fromStop), pt(l.toStop)], walkStyle).addTo(g);
    }
  }
  state.layers.trip = g;
  map.fitBounds(bounds, { padding: [40, 40] });
}

// ---------- Geocoding ----------

async function geocodeAddress(q) {
  const { site } = state;
  const b = site.searchBounds;
  const query = q.toLowerCase().includes(site.cityName.toLowerCase()) ? q : `${q}, ${site.city}`;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    q: query, format: 'jsonv2', addressdetails: '1', limit: '5', countrycodes: 'us',
    viewbox: `${b.west},${b.north},${b.east},${b.south}`, bounded: '1',
  });
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    return rows.map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), label: shortLabel(r) }));
  } catch {
    setStatus('#home-status', "The address search isn't responding right now. Tap your home on the map instead.", 'bad');
    return [];
  }
}

function shortLabel(r) {
  const a = r.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const town = a.city || a.town || a.village || a.county || '';
  return [street || r.name, town, a.postcode].filter(Boolean).join(', ') || r.display_name;
}

function showSuggestions(hits) {
  const ul = $('#suggestions');
  ul.innerHTML = '';
  for (const h of hits) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = h.label;
    b.addEventListener('click', () => { setHome(h); plan(); });
    li.append(b);
    ul.append(li);
  }
  ul.hidden = false;
}

function hideSuggestions() {
  $('#suggestions').hidden = true;
}

function useMyLocation() {
  if (!navigator.geolocation) { setStatus('#home-status', "Your browser can't share its location. Type your address instead.", 'bad'); return; }
  setStatus('#home-status', 'Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('#address').value = 'My current location';
      setHome({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Using your current location' });
    },
    () => setStatus('#home-status', "We couldn't get your location. Type your address or tap the map.", 'bad'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

// ---------- Precinct lookup ----------

function precinctAt(lat, lon) {
  for (const f of state.precincts.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h)))) return f.properties.id;
  }
  return null;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- Helpers ----------

function placeById(id) { return state.site.places.find((p) => p.id === id); }
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDate(s) { return parseDate(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
function todayStr(tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }

function setStatus(sel, text, kind = '') {
  const el = $(sel);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function showBanner(html) {
  const b = $('#banner');
  b.innerHTML = html;
  b.hidden = false;
}

init();
