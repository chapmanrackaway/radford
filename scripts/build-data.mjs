#!/usr/bin/env node
// Builds everything in site/data/ from live sources:
//   transit.json        Radford Transit schedule for Election Day (from GTFS)
//   site-data.json      site config + polling places with coordinates
//   precincts.geojson   precinct boundaries (optional; used to suggest a precinct)
//
// Usage:
//   node scripts/build-data.mjs                  # fetch everything
//   node scripts/build-data.mjs --gtfs feed.zip  # use a local GTFS zip or folder
//   node scripts/build-data.mjs --skip-geocode --skip-precincts

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { buildTransit } from './lib/gtfs.mjs';
import { geocode } from './lib/geocode.mjs';
import { matchPrecincts } from './lib/precincts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'site', 'data');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const log = (...m) => console.log('•', ...m);
const warn = (...m) => console.warn('⚠', ...m);

async function loadGtfs(urls) {
  const local = opt('--gtfs');
  if (local) {
    if ((await stat(local)).isDirectory()) {
      const files = {};
      for (const f of await readdir(local)) if (f.endsWith('.txt')) files[f] = await readFile(join(local, f), 'utf8');
      return { files, source: local };
    }
    return { files: unzip(await readFile(local)), source: local };
  }
  for (const url of urls) {
    try {
      log(`Downloading GTFS from ${url}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const files = unzip(new Uint8Array(await res.arrayBuffer()));
      if (!files['stop_times.txt']) throw new Error('zip has no stop_times.txt');
      return { files, source: url };
    } catch (e) {
      warn(`GTFS download failed (${url}): ${e.message}`);
    }
  }
  throw new Error('Could not download a GTFS feed from any configured URL');
}

function unzip(buf) {
  const files = {};
  for (const [name, data] of Object.entries(unzipSync(buf))) {
    const base = name.split('/').pop();
    if (base.endsWith('.txt')) files[base] = strFromU8(data);
  }
  return files;
}

async function main() {
  const config = JSON.parse(await readFile(join(root, 'config', 'site.json'), 'utf8'));
  const polling = JSON.parse(await readFile(join(root, 'data', 'polling-places.json'), 'utf8'));
  await mkdir(outDir, { recursive: true });

  // 1. Transit
  const { files, source } = await loadGtfs(config.transit.gtfsUrls);
  const transit = buildTransit(files, { targetDate: config.election.date });
  transit.source = source;
  transit.generated = new Date().toISOString();
  if (transit.substituted) {
    warn(`Feed has no service on ${config.election.date}; using the ${transit.serviceDate} schedule instead.`);
  }
  const trips = transit.patterns.reduce((n, p) => n + p.trips.length, 0);
  log(`Transit: ${transit.routes.length} routes, ${transit.stops.length} stops, ${transit.patterns.length} patterns, ${trips} trips on ${transit.serviceDate}`);
  await writeFile(join(outDir, 'transit.json'), JSON.stringify(transit));

  // 2. Polling places
  const places = [...polling.precincts, { ...config.earlyVoting, precinct: null, place: config.earlyVoting.name, early: true }];
  if (!flag('--skip-geocode')) {
    for (const p of places) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) continue;
      const hit = await geocode(p.address);
      if (hit) Object.assign(p, hit);
      else warn(`Could not geocode ${p.place} (${p.address})`);
    }
  }
  const located = places.filter((p) => Number.isFinite(p.lat)).length;
  log(`Polling places: ${located}/${places.length} located`);

  const siteData = {
    ...config,
    pollingSource: polling.source,
    pollingChecked: polling.checked,
    places: places.map(({ id, precinct, place, address, note, lat, lon, early }) => ({ id, precinct, place, address, note, lat, lon, early: !!early })),
  };
  delete siteData.transit.gtfsUrls;
  await writeFile(join(outDir, 'site-data.json'), JSON.stringify(siteData, null, 2));

  // 3. Precinct boundaries (optional)
  if (!flag('--skip-precincts') && config.precinctBoundaries?.url) {
    try {
      const res = await fetch(config.precinctBoundaries.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { geojson, matched, unmatched } = matchPrecincts(await res.json(), polling.precincts);
      log(`Precinct boundaries: matched ${matched.length}/${polling.precincts.length} precincts`);
      if (unmatched.length) warn(`No boundary for: ${unmatched.join(', ')}`);
      if (matched.length) {
        await writeFile(join(outDir, 'precincts.geojson'), JSON.stringify(geojson));
        siteData.hasPrecincts = true;
        await writeFile(join(outDir, 'site-data.json'), JSON.stringify(siteData, null, 2));
      }
    } catch (e) {
      warn(`Skipping precinct boundaries: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
