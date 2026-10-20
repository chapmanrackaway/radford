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

// Regression: a beta tester was sent to a far upstream stop and carried past the
// stop beside the polling place, then told to walk back.
test('boards at the closest stop the bus passes, not the first one in walking range', () => {
  const from = { lat: 37.27, lon: -79.96 };  // at East-West stop 3 (stop 2 is also walkable)
  const to = { lat: 37.27, lon: -79.93 };    // at East-West stop 6
  // Leaving at 8:20, the 8:30 bus can be caught at stop 2 (8:36) or stop 3 (8:39)
  const [best] = planner.plan(from, to, 8 * 60 + 20);
  const ride = best.legs.find((l) => l.type === 'ride');
  assert.equal(ride.fromStop, stopId('Test East-West Stop 3'));
  assert.equal(ride.toStop, stopId('Test East-West Stop 6'));
  assert.ok(best.legs[0].meters < 50);
  assert.deepEqual(ride.path[0], ride.fromStop);
});

test('gets off beside the destination even when that stop is walkable from home', () => {
  const from = { lat: 37.27, lon: -79.96 };  // at East-West stop 3
  const to = { lat: 37.2702, lon: -79.95 };  // beside East-West stop 4, ~0.55 mi away
  const opts = planner.options(from, to, 8 * 60, 3);
  assert.ok(opts.length > 0);
  for (const o of opts) {
    const ride = o.legs.find((l) => l.type === 'ride');
    assert.equal(ride.fromStop, stopId('Test East-West Stop 3'));
    assert.equal(ride.toStop, stopId('Test East-West Stop 4'));
    assert.ok(o.legs.at(-1).meters < 50);
  }
});

test('drops bus options that need as much walking as walking straight there', () => {
  // Polling place halfway between two stops on different routes: any bus trip
  // walks at least as far as just walking.
  const from = { lat: 37.2745, lon: -79.955 };
  const to = { lat: 37.2745, lon: -79.951 };
  assert.deepEqual(planner.options(from, to, 8 * 60, 3), []);
});

// Regression (Radford, Route 60): the bus reached a stop 0.5 mi from the polling
// place, then one 0.16 mi away a few minutes later. A different bus set the
// "earliest arrival" window, the closer stop fell just outside it, and the rider
// was told to get off early and walk the long way.
test('stays on the same bus to a closer stop when it costs only a few minutes', () => {
  const north = (m) => 37 + m / 111195;
  const east = (m) => -80 + m / 88805;
  const net = {
    routes: [{ id: 'a', short: 'A', long: 'A' }, { id: 'b', short: 'B', long: 'B' }],
    stops: [
      ['Home A', north(5000), -80],
      ['Far stop K', north(700), -80],    // 700 m from the destination
      ['Near stop M', north(100), -80],   // 100 m from the destination
      ['Home B', north(5000), -80],
      ['Other route F', 37, east(1100)],  // 1100 m from the destination, but reached first
    ],
    patterns: [
      { route: 0, headsign: '', stops: [0, 1, 2], trips: [[600, 619, 630]] },
      { route: 1, headsign: '', stops: [3, 4], trips: [[600, 610]] },
    ],
    shapes: {},
  };
  const p = new Planner(net);
  const [best] = p.plan({ lat: north(5000), lon: -80 }, { lat: 37, lon: -80 }, 598);
  const ride = best.legs.find((l) => l.type === 'ride');
  assert.equal(net.stops[ride.toStop][0], 'Near stop M');
  assert.ok(best.legs.at(-1).meters < 150);
});

// Radford: a voter 0.2 mi from the polling place was offered a 10-minute bus ride
// of one stop that saved ~50 m of walking over a 5-minute walk.
test('drops bus trips that are slower than walking and barely save any walking', () => {
  const north = (m) => 37 + m / 111195;
  const net = {
    routes: [{ id: 'a', short: 'A', long: 'A' }],
    stops: [['Next to home', north(330), -80], ['Next to polling place', north(20), -80]],
    patterns: [{ route: 0, headsign: '', stops: [0, 1], trips: [[605, 612]] }],
    shapes: {},
  };
  const p = new Planner(net);
  const from = { lat: north(350), lon: -80 }, to = { lat: 37, lon: -80 };
  assert.equal(p.plan(from, to, 600).length, 1);      // the bus trip exists...
  assert.equal(p.options(from, to, 600, 3).length, 0); // ...but walking (~6 min) is the better choice
  // A bus that beats walking is still offered
  net.patterns[0].trips = [[601, 602]];
  assert.equal(new Planner(net).options(from, to, 600, 3).length, 1);
});
