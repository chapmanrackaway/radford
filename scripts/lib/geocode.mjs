// Address -> { lat, lon } for build-time geocoding of polling places.
// Tries the US Census geocoder first, then OpenStreetMap Nominatim.

const UA = 'radford-rides-to-vote (build script)';

async function census(address) {
  const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  url.search = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Census HTTP ${res.status}`);
  const match = (await res.json()).result?.addressMatches?.[0];
  return match ? { lat: match.coordinates.y, lon: match.coordinates.x } : null;
}

async function nominatim(address) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: address, format: 'json', limit: '1', countrycodes: 'us' });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const hit = (await res.json())[0];
  // Nominatim's usage policy allows at most one request per second.
  await new Promise((r) => setTimeout(r, 1100));
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

export async function geocode(address) {
  for (const fn of [census, nominatim]) {
    try {
      const hit = await fn(address);
      if (hit) return { lat: Math.round(hit.lat * 1e6) / 1e6, lon: Math.round(hit.lon * 1e6) / 1e6 };
    } catch (e) {
      console.warn(`⚠ ${e.message} for ${address}`);
    }
  }
  return null;
}
