// Generates test/fixtures/mini-gtfs: a tiny made-up two-route network laid over
// Roanoke's coordinates. It is test data only and does not reflect real service.
//   Route E (east-west) along lat 37.270, Route N (north-south) along lon -79.940;
//   they cross at stop "N4/E5". Buses every 30 min, 3 min between stops.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'mini-gtfs');
mkdirSync(dir, { recursive: true });

const stops = [];
const eStops = [], nStops = [];
for (let i = 0; i < 9; i++) {
  const lon = -79.99 + i * 0.01;
  if (i === 5) { eStops.push('X'); continue; }
  stops.push([`E${i}`, `Test East-West Stop ${i}`, 37.27, lon.toFixed(5)]);
  eStops.push(`E${i}`);
}
for (let i = 0; i < 8; i++) {
  const lat = 37.235 + i * 0.01;
  if (i === 3) { nStops.push('X'); continue; }
  stops.push([`N${i}`, `Test North-South Stop ${i}`, lat.toFixed(5), -79.94]);
  nStops.push(`N${i}`);
}
// Crossing stop: E5 position is lon -79.94, N3 position is lat 37.265 (~550 m apart),
// so use a single shared stop at the true intersection.
stops.push(['X', 'Test Crossing Stop', 37.27, -79.94]);
nStops[3] = 'X';
// keep N ordering monotonic: crossing at lat 37.27 sits between N3 (37.265) slot and N4 (37.275)

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`;

const trips = [];
const stopTimes = [];
const addTrips = (route, seq, dirId, offset) => {
  for (let start = 6 * 60 + offset; start <= 20 * 60; start += 30) {
    const id = `${route}${dirId}-${start}`;
    trips.push([route, 'WKDY', id, `${route} ${dirId ? 'Inbound' : 'Outbound'}`, dirId, `${route}${dirId}`]);
    seq.forEach((s, i) => {
      // Leave every other intermediate time blank to exercise interpolation
      const t = i === 0 || i === seq.length - 1 || i % 2 === 0 ? hhmm(start + i * 3) : '';
      stopTimes.push([id, t, t, s, i + 1]);
    });
  }
};
addTrips('E', eStops, 0, 0);
addTrips('E', [...eStops].reverse(), 1, 10);
addTrips('N', nStops, 0, 5);
addTrips('N', [...nStops].reverse(), 1, 20);
// A weekend-only trip that must not appear on a Tuesday
trips.push(['E', 'WKND', 'weekend-only', 'Weekend', 0, 'E0']);
eStops.forEach((s, i) => stopTimes.push(['weekend-only', hhmm(600 + i * 3), hhmm(600 + i * 3), s, i + 1]));

const shapes = [];
const shapeFor = (id, seq) => seq.forEach((s, i) => {
  const st = stops.find((x) => x[0] === s);
  shapes.push([id, st[2], st[3], i + 1]);
});
shapeFor('E0', eStops); shapeFor('E1', [...eStops].reverse());
shapeFor('N0', nStops); shapeFor('N1', [...nStops].reverse());

const csv = (header, rows) => [header.join(','), ...rows.map((r) => r.map((v) => (/[",]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : v)).join(','))].join('\n') + '\n';
const files = {
  'agency.txt': csv(['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], [['T', 'Test Transit', 'https://example.com', 'America/New_York']]),
  'routes.txt': csv(['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'], [['E', '1', 'Test "East-West"', 3, 'C62828', 'FFFFFF'], ['N', '2', 'Test North-South', 3, '1565C0', 'FFFFFF']]),
  'stops.txt': csv(['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], stops),
  'calendar.txt': csv(['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], [['WKDY', 1, 1, 1, 1, 1, 0, 0, '20260101', '20261231'], ['WKND', 0, 0, 0, 0, 0, 1, 1, '20260101', '20261231']]),
  'calendar_dates.txt': csv(['service_id', 'date', 'exception_type'], [['WKDY', '20261110', 2]]),
  'trips.txt': csv(['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id'], trips),
  'stop_times.txt': csv(['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], stopTimes),
  'shapes.txt': csv(['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], shapes),
  'fare_attributes.txt': csv(['fare_id', 'price', 'currency_type', 'payment_method', 'transfers'], [['F', '1.50', 'USD', 0, '']]),
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
console.log(`Wrote ${Object.keys(files).length} files to ${dir}`);
