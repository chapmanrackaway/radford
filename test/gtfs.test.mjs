import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseTime, buildTransit, chooseServiceDate, activeServices, simplify } from '../scripts/lib/gtfs.mjs';
import { matchPrecincts } from '../scripts/lib/precincts.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-gtfs');
export const fixture = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('parseCsv handles BOM, quotes, CRLF and blank lines', () => {
  const rows = parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n\r\n2,z');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
});

test('parseTime supports times past midnight', () => {
  assert.equal(parseTime('25:10:30'), 25 * 60 + 10.5);
  assert.equal(parseTime(''), null);
});

test('service calendar honors weekdays and exceptions', () => {
  const cal = parseCsv(fixture['calendar.txt']);
  const cd = parseCsv(fixture['calendar_dates.txt']);
  assert.deepEqual([...activeServices(cal, cd, '2026-11-03')], ['WKDY']);
  assert.deepEqual([...activeServices(cal, cd, '2026-11-07')], ['WKND']);
  assert.equal(activeServices(cal, cd, '2026-11-10').size, 0);
  assert.deepEqual(chooseServiceDate(cal, cd, '2026-11-10'), { date: '2026-11-03', substituted: true });
  assert.deepEqual(chooseServiceDate(cal, cd, '2027-03-02'), { date: '2026-12-29', substituted: true });
});

test('buildTransit keeps only the service date and interpolates blank times', () => {
  const t = buildTransit(fixture, { targetDate: '2026-11-03' });
  assert.equal(t.serviceDate, '2026-11-03');
  assert.equal(t.substituted, false);
  assert.equal(t.routes.length, 2);
  assert.equal(t.routes[0].long, 'Test "East-West"');
  assert.equal(t.fare.price, 1.5);
  assert.equal(t.patterns.length, 4); // weekend trip excluded
  const east = t.patterns.find((p) => p.headsign === 'E Outbound');
  assert.deepEqual(east.trips[0].slice(0, 4), [360, 363, 366, 369]);
  assert.ok(east.trips.every((trip, i, all) => i === 0 || trip[0] >= all[i - 1][0]));
  assert.ok(Object.values(t.shapes).every((lines) => lines.length === 2));
});

test('simplify drops collinear points but keeps corners', () => {
  const pts = [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]];
  assert.deepEqual(simplify(pts, 0.01), [[0, 0], [0, 2], [2, 2]]);
});

test('matchPrecincts keeps only polygons that name a current precinct', () => {
  const sq = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const { geojson, matched, unmatched } = matchPrecincts({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { NAME: 'GRAND VIEW' }, geometry: sq },
      { type: 'Feature', properties: { NAME: 'Retired Precinct' }, geometry: sq },
      { type: 'Feature', properties: { NAME: 'Lee-Hi' }, geometry: { type: 'Point', coordinates: [0, 0] } },
    ],
  }, [{ id: 'grandview', precinct: 'Grandview' }, { id: 'lee-hi', precinct: 'Lee-Hi' }]);
  assert.deepEqual(matched, ['grandview']);
  assert.deepEqual(unmatched, ['Lee-Hi']);
  assert.equal(geojson.features.length, 1);
});
