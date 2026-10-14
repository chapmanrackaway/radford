// Matches precinct polygons from a GIS service to our polling-place list by name.
// Polygons whose name doesn't match a current precinct are dropped, so an
// outdated boundary layer can only fail to suggest a precinct, never suggest
// one that doesn't exist.

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
    features.push({ type: 'Feature', properties: { id }, geometry: f.geometry });
  }
  return {
    geojson: { type: 'FeatureCollection', features },
    matched: [...matched],
    unmatched: precincts.filter((p) => !matched.has(p.id)).map((p) => p.precinct),
  };
}
