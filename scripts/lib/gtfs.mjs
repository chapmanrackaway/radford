// Turns a raw GTFS feed into the compact transit.json the site loads.
//
// Output shape (indexes refer into the arrays):
//   routes:   [{ id, short, long, color, textColor }]
//   stops:    [[name, lat, lon]]
//   patterns: [{ route, headsign, stops: [stopIdx], trips: [[minutesAtEachStop]] }]
//   shapes:   { [routeIdx]: [[[lat, lon], ...], ...] }
// Times are minutes after midnight on the service date (can exceed 1440).

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); });
    return o;
  });
}

export function parseTime(t) {
  if (!t) return null;
  const [h, m, s] = t.split(':').map(Number);
  if ([h, m].some(Number.isNaN)) return null;
  return h * 60 + m + (s || 0) / 60;
}

const ymd = (d) => d.replaceAll('-', '');
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Service IDs running on dateStr (YYYY-MM-DD), honoring calendar_dates exceptions. */
export function activeServices(calendar, calendarDates, dateStr) {
  const day = weekdayOf(dateStr);
  const key = ymd(dateStr);
  const active = new Set();
  for (const c of calendar) {
    if (c[day] === '1' && c.start_date <= key && key <= c.end_date) active.add(c.service_id);
  }
  for (const cd of calendarDates) {
    if (cd.date !== key) continue;
    if (cd.exception_type === '1') active.add(cd.service_id);
    if (cd.exception_type === '2') active.delete(cd.service_id);
  }
  return active;
}

/** First and last dates the feed has any service on. */
export function feedRange(calendar, calendarDates) {
  const dates = [
    ...calendar.flatMap((c) => [c.start_date, c.end_date]),
    ...calendarDates.filter((d) => d.exception_type === '1').map((d) => d.date),
  ].filter(Boolean).sort();
  if (!dates.length) return null;
  const fmt = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return { start: fmt(dates[0]), end: fmt(dates[dates.length - 1]) };
}

/**
 * Picks the date whose schedule we publish. Prefers the target date; if the feed
 * doesn't run anything that day (e.g. it expires first), uses the nearest date
 * in the feed that falls on the same weekday.
 */
export function chooseServiceDate(calendar, calendarDates, target) {
  if (activeServices(calendar, calendarDates, target).size) return { date: target, substituted: false };
  const range = feedRange(calendar, calendarDates);
  if (!range) return null;
  for (let w = 1; w <= 104; w++) {
    for (const cand of [addDays(target, -7 * w), addDays(target, 7 * w)]) {
      if (cand < range.start || cand > range.end) continue;
      if (activeServices(calendar, calendarDates, cand).size) return { date: cand, substituted: true };
    }
  }
  return null;
}

/** Douglas-Peucker on [lat, lon] points; tolerance in degrees. */
export function simplify(points, tol = 0.00004) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ay, ax] = points[a];
    const [by, bx] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0 && max > tol * tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (n, p = 5) => Math.round(n * 10 ** p) / 10 ** p;
const round1 = (n) => Math.round(n * 10) / 10;

/** Fill blank (non-timepoint) times by linear interpolation between known ones. */
function interpolate(times) {
  let last = -1;
  for (let i = 0; i < times.length; i++) {
    if (times[i] == null) continue;
    if (last >= 0 && i - last > 1) {
      const step = (times[i] - times[last]) / (i - last);
      for (let j = last + 1; j < i; j++) times[j] = times[last] + step * (j - last);
    }
    last = i;
  }
  return times.every((t) => t != null) ? times : null;
}

/**
 * @param files  object mapping GTFS filename (e.g. "stops.txt") to its text
 * @param opts   { targetDate: 'YYYY-MM-DD' }
 */
export function buildTransit(files, { targetDate }) {
  const read = (name) => (files[name] ? parseCsv(files[name]) : []);
  const calendar = read('calendar.txt');
  const calendarDates = read('calendar_dates.txt');
  const chosen = chooseServiceDate(calendar, calendarDates, targetDate);
  if (!chosen) throw new Error(`GTFS feed has no service near ${targetDate}`);
  const services = activeServices(calendar, calendarDates, chosen.date);

  const agency = read('agency.txt')[0] || {};

  // Routes
  const routeRows = read('routes.txt');
  const routeIdx = new Map();
  const routes = routeRows.map((r, i) => {
    routeIdx.set(r.route_id, i);
    return {
      id: r.route_id,
      short: r.route_short_name || '',
      long: r.route_long_name || '',
      color: r.route_color ? `#${r.route_color}` : '#1f6feb',
      textColor: r.route_text_color ? `#${r.route_text_color}` : '#ffffff',
    };
  });

  // Trips running on the service date
  const trips = new Map();
  for (const t of read('trips.txt')) {
    if (!services.has(t.service_id) || !routeIdx.has(t.route_id)) continue;
    trips.set(t.trip_id, { route: routeIdx.get(t.route_id), headsign: t.trip_headsign || '', shape: t.shape_id, st: [] });
  }

  for (const s of read('stop_times.txt')) {
    const trip = trips.get(s.trip_id);
    if (!trip) continue;
    trip.st.push({ seq: Number(s.stop_sequence), stop: s.stop_id, t: parseTime(s.departure_time) ?? parseTime(s.arrival_time) });
  }

  // Stops (only those actually served that day)
  const stopRows = new Map(read('stops.txt').map((s) => [s.stop_id, s]));
  const stopIdx = new Map();
  const stops = [];
  const stopIndex = (id) => {
    if (!stopIdx.has(id)) {
      let s = stopRows.get(id);
      if (!s) return -1;
      // Some feeds put times on platforms whose coordinates live on the parent.
      if ((!s.stop_lat || !s.stop_lon) && s.parent_station) s = { ...stopRows.get(s.parent_station), stop_name: s.stop_name };
      const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1;
      stopIdx.set(id, stops.length);
      stops.push([s.stop_name || id, round(lat), round(lon)]);
    }
    return stopIdx.get(id);
  };

  // Group trips into patterns (same route + same ordered stops)
  const patternMap = new Map();
  for (const trip of trips.values()) {
    trip.st.sort((a, b) => a.seq - b.seq);
    const stopIds = trip.st.map((x) => stopIndex(x.stop));
    if (stopIds.length < 2 || stopIds.includes(-1)) continue;
    const times = interpolate(trip.st.map((x) => x.t));
    if (!times) continue;
    const key = `${trip.route}|${trip.headsign}|${stopIds.join(',')}`;
    if (!patternMap.has(key)) patternMap.set(key, { route: trip.route, headsign: trip.headsign, stops: stopIds, trips: [], shapes: new Set() });
    const p = patternMap.get(key);
    p.trips.push(times.map(round1));
    if (trip.shape) p.shapes.add(trip.shape);
  }

  const patterns = [...patternMap.values()].map((p) => {
    p.trips.sort((a, b) => a[0] - b[0]);
    return p;
  });

  // Shapes, grouped by route; fall back to stop sequence when a feed has no shapes.txt
  const shapePts = new Map();
  for (const s of read('shapes.txt')) {
    if (!shapePts.has(s.shape_id)) shapePts.set(s.shape_id, []);
    shapePts.get(s.shape_id).push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
  }
  const shapes = {};
  const seen = new Set();
  for (const p of patterns) {
    const lines = (shapes[p.route] ||= []);
    if (p.shapes.size) {
      for (const id of p.shapes) {
        if (seen.has(id) || !shapePts.has(id)) continue;
        seen.add(id);
        const pts = shapePts.get(id).sort((a, b) => a[0] - b[0]).map(([, la, lo]) => [la, lo]);
        lines.push(simplify(pts).map(([la, lo]) => [round(la), round(lo)]));
      }
    } else {
      lines.push(p.stops.map((i) => [stops[i][1], stops[i][2]]));
    }
  }

  // Fare (simple flat fare, when the feed publishes one)
  const fareRows = read('fare_attributes.txt');
  let fare = null;
  if (fareRows.length) {
    const prices = fareRows.map((f) => Number(f.price)).filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length) fare = { price: Math.min(...prices), currency: fareRows[0].currency_type || 'USD' };
  }

  // Routes with no service that day are dropped from the output
  const usedRoutes = [...new Set(patterns.map((p) => p.route))].sort((a, b) => a - b);
  const remap = new Map(usedRoutes.map((r, i) => [r, i]));
  const outShapes = {};
  for (const r of usedRoutes) outShapes[remap.get(r)] = shapes[r] || [];

  return {
    agency: agency.agency_name || '',
    serviceDate: chosen.date,
    targetDate,
    substituted: chosen.substituted,
    feedRange: feedRange(calendar, calendarDates),
    fare,
    routes: usedRoutes.map((r) => routes[r]),
    stops,
    patterns: patterns.map((p) => ({ route: remap.get(p.route), headsign: p.headsign, stops: p.stops, trips: p.trips })),
    shapes: outShapes,
  };
}
