import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransit } from '../scripts/lib/gtfs.mjs';
import { Planner, distance, formatTime, formatDistance } from '../site/js/router.js';
import { fixture } from './gtfs.test.mjs';

const transit = buildTransit(fixture, { targetDate: '2026-11-03' });
const planner = new Planner(transit);
const stopId = (name) => transit.stops.findIndex((s) => s[0] === name);

test('distance is about right', () => {
  const d = distance(37.27, -79.99, 37.27, -79.98);
  assert.ok(d > 870 && d < 900, String(d));
});

test('one-bus trip along a single route', () => {
  const from = { lat: 37.2705, lon: -79.99 };  // at East-West stop 0
  const to = { lat: 37.2705, lon: -79.95 };    // at East-West stop 4
  const [best] = planner.plan(from, to, 7 * 60 - 3);
  assert.equal(best.rides, 1);
  const ride = best.legs.find((l) => l.type === 'ride');
  assert.equal(transit.routes[ride.route].short, '1');
  assert.equal(ride.fromStop, stopId('Test East-West Stop 0'));
  assert.equal(ride.toStop, stopId('Test East-West Stop 4'));
  assert.equal(ride.depart, 420);
  assert.equal(ride.arrive, 432);
  assert.equal(best.legs[0].type, 'walk');
  assert.equal(best.legs.at(-1).type, 'walk');
  assert.ok(best.arrive > 432 && best.arrive < 434);
});

test('two-bus trip transfers at the crossing', () => {
  const from = { lat: 37.27, lon: -79.99 };   // west end of route 1
  const to = { lat: 37.305, lon: -79.94 };    // north end of route 2
  const results = planner.plan(from, to, 8 * 60);
  const two = results.find((r) => r.rides === 2);
  assert.ok(two, 'expected a two-bus itinerary');
  const rides = two.legs.filter((l) => l.type === 'ride');
  assert.deepEqual(rides.map((r) => transit.routes[r.route].short), ['1', '2']);
  assert.equal(rides[0].toStop, stopId('Test Crossing Stop'));
  assert.equal(rides[1].fromStop, stopId('Test Crossing Stop'));
  assert.ok(rides[1].depart >= rides[0].arrive + 2, 'respects the minimum transfer time');
  assert.equal(new Set(results.map((r) => r.rides)).size, results.length);
});

test('no trip when the destination is far from any stop', () => {
  assert.deepEqual(planner.plan({ lat: 37.27, lon: -79.99 }, { lat: 37.40, lon: -79.60 }, 480), []);
});

test('no trip after service ends', () => {
  assert.deepEqual(planner.plan({ lat: 37.27, lon: -79.99 }, { lat: 37.27, lon: -79.95 }, 23 * 60), []);
});

test('options returns distinct later departures', () => {
  const opts = planner.options({ lat: 37.27, lon: -79.99 }, { lat: 37.27, lon: -79.95 }, 7 * 60, 3);
  assert.equal(opts.length, 3);
  const departs = opts.map((o) => o.legs.find((l) => l.type === 'ride').depart);
  assert.deepEqual(departs, [420, 450, 480]);
});

test('routesNear lists each route once with its closest stop', () => {
  const near = planner.routesNear(37.27, -79.94, 300);
  assert.equal(near.length, 2);
  assert.ok(near.every((r) => r.stop === stopId('Test Crossing Stop')));
});

test('formatting helpers', () => {
  assert.equal(formatTime(6 * 60 + 5), '6:05 AM');
  assert.equal(formatTime(12 * 60), '12:00 PM');
  assert.equal(formatTime(19 * 60 + 30.4), '7:30 PM');
  assert.equal(formatDistance(1609.34), '1.0 mi');
  assert.equal(formatDistance(50), '160 ft');
});
