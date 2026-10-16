// Matches precinct polygons from a GIS service to our polling-place list by name.
// Polygons whose name doesn't match a current precinct are dropped, so an
// outdated boundary layer can only fail to suggest a precinct, never suggest
// one that doesn't exist.

import { simplify } from './gtfs.mjs';

export const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

export function matchPrecincts(geojson, precincts) {
  if (geojson?.type !== 'FeatureCollection') throw new Error('not a GeoJSON FeatureCollection');
  const byName = new Map(precincts.map((p) => [normalize(p.precinct), p.id]));
  const features = [];
  const matched = new Set();
  for (const f of geojson.features || []) {
    const type = f.geometry?.type;
    if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
    const id = Object.values(f.properties || {}).map((v) => byName.get(normalize(v))).find(Boolean);
    if (!id) continue;
    matched.add(id);
    features.push({ type: 'Feature', properties: { id }, geometry: slim(f.geometry) });
  }
  return {
    geojson: { type: 'FeatureCollection', features },
    matched: [...matched],
    unmatched: precincts.filter((p) => !matched.has(p.id)).map((p) => p.precinct),
  };
}

// Drops detail finer than a few meters and rounds to ~1 m, which shrinks the
// file a lot without changing which precinct an address falls in.
function slim(geometry) {
  const ring = (r) => {
    const pts = simplify(r.map(([lon, lat]) => [lat, lon]), 0.00002).map(([lat, lon]) => [round(lon), round(lat)]);
    return pts.length >= 4 ? pts : r;
  };
  const poly = (rings) => rings.map(ring);
  return geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: poly(geometry.coordinates) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map(poly) };
}

const round = (n) => Math.round(n * 1e5) / 1e5;
