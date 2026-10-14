// Bus trip planner over the compact schedule in transit.json.
// A small RAPTOR search: it finds the earliest arrival using at most
// `maxRides` buses, with walking at the start, at transfers, and at the end.
// Runs in the browser and in Node (tests).

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distance(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const DEFAULTS = {
  walkSpeed: 75,        // meters per minute (~2.8 mph)
  detour: 1.25,         // street distance vs. straight line
  maxWalk: 1200,        // meters, to the first stop and from the last stop
  maxTransferWalk: 350, // meters between stops when changing buses
  minTransfer: 2,       // minutes to make a connection
  maxRides: 2,
  maxWait: 120,         // ignore trips leaving more than this many minutes after you're at the stop
};

export class Planner {
  constructor(transit, options = {}) {
    this.t = transit;
    this.o = { ...DEFAULTS, ...options };
    this.stopPatterns = transit.stops.map(() => []);
    transit.patterns.forEach((p, pi) => p.stops.forEach((s, i) => this.stopPatterns[s].push([pi, i])));
    this._transfers = null;
  }

  walkMinutes(meters) {
    return (meters * this.o.detour) / this.o.walkSpeed;
  }

  /** Stops within `radius` meters of a point, nearest first. */
  stopsNear(lat, lon, radius = this.o.maxWalk) {
    const out = [];
    this.t.stops.forEach(([, sLat, sLon], i) => {
      const d = distance(lat, lon, sLat, sLon);
      if (d <= radius) out.push({ stop: i, meters: d });
    });
    return out.sort((a, b) => a.meters - b.meters);
  }

  /** Routes serving stops within `radius`, each with its closest stop. */
  routesNear(lat, lon, radius = this.o.maxWalk) {
    const best = new Map();
    for (const { stop, meters } of this.stopsNear(lat, lon, radius)) {
      for (const [pi] of this.stopPatterns[stop]) {
        const r = this.t.patterns[pi].route;
        if (!best.has(r)) best.set(r, { route: r, stop, meters });
      }
    }
    return [...best.values()];
  }

  transfers() {
    if (this._transfers) return this._transfers;
    const { stops } = this.t;
    const cell = 0.004; // ~400 m grid buckets
    const grid = new Map();
    const key = (la, lo) => `${Math.floor(la / cell)},${Math.floor(lo / cell)}`;
    stops.forEach(([, la, lo], i) => {
      const k = key(la, lo);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    this._transfers = stops.map(([, la, lo], i) => {
      const gy = Math.floor(la / cell), gx = Math.floor(lo / cell);
      const out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gy + dy},${gx + dx}`) || []) {
          if (j === i) continue;
          const d = distance(la, lo, stops[j][1], stops[j][2]);
          if (d <= this.o.maxTransferWalk) out.push([j, d]);
        }
      }
      return out;
    });
    return this._transfers;
  }

  /**
   * Earliest-arrival search.
   * @returns {Array} up to one itinerary per number of rides that improves on fewer rides
   */
  plan(from, to, departAt) {
    const o = this.o;
    const nStops = this.t.stops.length;
    const K = o.maxRides;
    // best[k][s]: earliest arrival at stop s using k rides; labels[k][s] explains how
    const best = Array.from({ length: K + 1 }, () => new Float64Array(nStops).fill(Infinity));
    const labels = Array.from({ length: K + 1 }, () => new Array(nStops));
    const bestAny = new Float64Array(nStops).fill(Infinity);

    let marked = new Set();
    for (const { stop, meters } of this.stopsNear(from.lat, from.lon)) {
      const t = departAt + this.walkMinutes(meters);
      best[0][stop] = t;
      bestAny[stop] = t;
      labels[0][stop] = { type: 'access', meters };
      marked.add(stop);
    }

    for (let k = 1; k <= K && marked.size; k++) {
      // Patterns touched by improved stops, with the earliest index to start scanning
      const queue = new Map();
      for (const s of marked) {
        for (const [pi, idx] of this.stopPatterns[s]) {
          if (!queue.has(pi) || idx < queue.get(pi)) queue.set(pi, idx);
        }
      }
      const newly = new Set();
      for (const [pi, startIdx] of queue) {
        const p = this.t.patterns[pi];
        let trip = -1, boardIdx = -1;
        for (let i = startIdx; i < p.stops.length; i++) {
          const s = p.stops[i];
          if (trip >= 0) {
            const arr = p.trips[trip][i];
            if (arr < best[k][s] && arr < bestAny[s]) {
              best[k][s] = arr;
              bestAny[s] = arr;
              labels[k][s] = { type: 'ride', pattern: pi, trip, boardIdx, alightIdx: i };
              newly.add(s);
            }
          }
          // Can we catch an earlier trip here?
          const ready = best[k - 1][s] + (k > 1 && labels[k - 1][s]?.type !== 'access' ? o.minTransfer : 0);
          if (ready === Infinity) continue;
          if (trip >= 0 && p.trips[trip][i] < ready) continue;
          const t = earliestTrip(p.trips, i, ready, trip);
          if (t >= 0 && p.trips[t][i] - ready <= o.maxWait && (trip < 0 || t !== trip)) {
            trip = t;
            boardIdx = i;
          }
        }
      }
      // Walking transfers from stops reached by bus this round
      // (never onto a stop reached by bus this round, so ride labels stay intact)
      const xfers = this.transfers();
      const ridden = [...newly];
      const riddenSet = new Set(ridden);
      for (const s of ridden) {
        for (const [j, d] of xfers[s]) {
          if (riddenSet.has(j)) continue;
          const t = best[k][s] + this.walkMinutes(d);
          if (t < best[k][j] && t < bestAny[j]) {
            best[k][j] = t;
            bestAny[j] = t;
            labels[k][j] = { type: 'walk', from: s, meters: d };
            newly.add(j);
          }
        }
      }
      marked = newly;
    }

    // Finish: walk from a stop near the destination
    const egress = this.stopsNear(to.lat, to.lon);
    const results = [];
    let bestSoFar = Infinity;
    for (let k = 1; k <= K; k++) {
      let pick = null;
      for (const { stop, meters } of egress) {
        const arrive = best[k][stop] + this.walkMinutes(meters);
        if (arrive < (pick?.arrive ?? Infinity)) pick = { stop, meters, arrive };
      }
      if (pick && pick.arrive < bestSoFar - 0.5) {
        bestSoFar = pick.arrive;
        results.push(this.reconstruct(labels, k, pick, departAt, from, to));
      }
    }
    return results;
  }

  reconstruct(labels, k, pick, departAt, from, to) {
    const legs = [{ type: 'walk', fromStop: pick.stop, meters: pick.meters, minutes: this.walkMinutes(pick.meters), final: true }];
    let s = pick.stop;
    for (let round = k; round >= 0; round--) {
      let label = labels[round][s];
      if (label?.type === 'walk') {
        legs.push({ type: 'walk', fromStop: label.from, toStop: s, meters: label.meters, minutes: this.walkMinutes(label.meters) });
        s = label.from;
        label = labels[round][s];
      }
      if (round === 0) {
        legs.push({ type: 'walk', toStop: s, meters: label.meters, minutes: this.walkMinutes(label.meters), first: true });
        break;
      }
      const p = this.t.patterns[label.pattern];
      const times = p.trips[label.trip];
      legs.push({
        type: 'ride',
        route: p.route,
        headsign: p.headsign,
        pattern: label.pattern,
        fromStop: p.stops[label.boardIdx],
        toStop: p.stops[label.alightIdx],
        depart: times[label.boardIdx],
        arrive: times[label.alightIdx],
        stopCount: label.alightIdx - label.boardIdx,
        path: p.stops.slice(label.boardIdx, label.alightIdx + 1),
      });
      s = p.stops[label.boardIdx];
    }
    legs.reverse();
    // Express the opening walk as "leave home at" so the rider doesn't wait at the stop longer than needed
    const firstRide = legs.find((l) => l.type === 'ride');
    const leave = firstRide.depart - legs[0].minutes;
    const walking = legs.filter((l) => l.type === 'walk').reduce((m, l) => m + l.meters, 0);
    return {
      rides: k,
      leave: Math.max(departAt, Math.floor(leave)),
      arrive: pick.arrive,
      walkMeters: walking,
      legs,
      from,
      to,
    };
  }

  /** Several options, each leaving after the previous one's first bus. */
  options(from, to, departAt, count = 3) {
    const out = [];
    const seen = new Set();
    let t = departAt;
    for (let i = 0; i < count * 2 && out.length < count; i++) {
      const res = this.plan(from, to, t);
      if (!res.length) break;
      for (const r of res) {
        const sig = r.legs.filter((l) => l.type === 'ride').map((l) => `${l.pattern}@${l.depart}`).join('|');
        if (!seen.has(sig)) { seen.add(sig); out.push(r); }
      }
      const firstDepart = Math.min(...res.map((r) => r.legs.find((l) => l.type === 'ride').depart));
      t = firstDepart - res[0].legs[0].minutes + 1;
    }
    return out.sort((a, b) => a.arrive - b.arrive || a.rides - b.rides).slice(0, count);
  }
}

function earliestTrip(trips, i, ready, current) {
  // trips are sorted by first departure; times at a given stop are nearly always sorted too
  let lo = 0, hi = current >= 0 ? current : trips.length - 1;
  if (hi < 0) return -1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trips[mid][i] >= ready) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (found < 0 && current < 0) return -1;
  // Guard against occasional overtaking trips by scanning a few neighbors
  let bestT = found;
  const end = Math.min(trips.length, (found < 0 ? trips.length : found) + 3);
  for (let j = Math.max(0, (found < 0 ? trips.length : found) - 3); j < end; j++) {
    if (trips[j][i] >= ready && (bestT < 0 || trips[j][i] < trips[bestT][i])) bestT = j;
  }
  return bestT;
}

export function formatTime(minutes) {
  const m = Math.round(minutes);
  let h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ampm}`;
}

export function formatDistance(meters) {
  const miles = meters / 1609.34;
  if (miles < 0.1) return `${Math.round(meters * 3.281 / 10) * 10} ft`;
  return `${miles.toFixed(1)} mi`;
}
