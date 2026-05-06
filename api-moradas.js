/**
 * /api/moradas — Proxy para geoapi.pt (moradas PT, CP, reverse geocode)
 *
 * Query params:
 *   lat + lon  → reverse geocode GPS
 *   cp         → lookup código postal (ex: "4000-007")
 *   q          → geocode texto (passa para Nominatim)
 */

const GEOAPI = 'https://json.geoapi.pt';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon, cp, q } = req.query;

  try {
    // ── MODO 1: Código Postal ─────────────────────────────────────
    if (cp) {
      const cpClean = cp.replace(/\s/g, '').replace(/(\d{4})(\d{3})/, '$1-$2');
      const r = await fetch(`${GEOAPI}/codigo_postal/${cpClean}`, {
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) return res.status(404).json({ error: 'CP não encontrado', ok: false });
      const d = await r.json();
      return res.status(200).json({ ok: true, tipo: 'codigo_postal', ...d });
    }

    // ── MODO 2: Reverse Geocode GPS ───────────────────────────────
    if (lat && lon) {
      const latF = parseFloat(lat), lonF = parseFloat(lon);
      if (isNaN(latF) || isNaN(lonF)) {
        return res.status(400).json({ error: 'lat/lon inválidos', ok: false });
      }

      // geoapi.pt GPS endpoint: retorna distrito, concelho, freguesia, rua, nº porta, CP, altitude
      const [gpioRes, nominatimRes] = await Promise.allSettled([
        fetch(`${GEOAPI}/gps/${latF},${lonF}`, { signal: AbortSignal.timeout(6000) }),
        fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${latF}&lon=${lonF}&format=json&accept-language=pt`,
          { headers: { 'User-Agent': 'CoberturaPT/1.0' }, signal: AbortSignal.timeout(5000) }
        )
      ]);

      let geoData = null, nominatimData = null;

      if (gpioRes.status === 'fulfilled' && gpioRes.value.ok) {
        geoData = await gpioRes.value.json();
      }
      if (nominatimRes.status === 'fulfilled' && nominatimRes.value.ok) {
        nominatimData = await nominatimRes.value.json();
      }

      // Merge: geoapi.pt tem dados PT oficiais, Nominatim tem rua/porta
      const merged = {
        ok: true,
        tipo: 'gps',
        lat: latF,
        lon: lonF,
        // geoapi.pt campos
        distrito:      geoData?.distrito || '',
        concelho:      geoData?.concelho || '',
        freguesia:     geoData?.freguesia || '',
        rua:           geoData?.rua || nominatimData?.address?.road || '',
        numero_porta:  geoData?.numero_porta || nominatimData?.address?.house_number || '',
        localidade:    geoData?.localidade || nominatimData?.address?.city || nominatimData?.address?.town || '',
        codigo_postal: geoData?.codigo_postal || nominatimData?.address?.postcode || '',
        altitude:      geoData?.altitude || null,
        // uso do solo e risco
        uso_solo:        geoData?.uso_solo || '',
        perigo_incendio: geoData?.perigo_incendio || '',
        perigo_inundacao:geoData?.perigo_inundacao || '',
        // Nominatim campos extra
        display_name:  nominatimData?.display_name || '',
        _geoapi_raw:   geoData,
        _nominatim:    nominatimData?.address || null
      };

      return res.status(200).json(merged);
    }

    // ── MODO 3: Geocode texto (via Nominatim server-side) ─────────
    if (q) {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ' Portugal')}&format=json&limit=5&accept-language=pt&countrycodes=pt`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'CoberturaPT/1.0' },
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) return res.status(502).json({ error: 'Nominatim error', ok: false });
      const results = await r.json();
      return res.status(200).json({ ok: true, tipo: 'geocode', results });
    }

    return res.status(400).json({ error: 'Parâmetros: lat+lon, cp, ou q', ok: false });

  } catch (err) {
    console.error('Moradas proxy error:', err);
    return res.status(502).json({ error: err.message, ok: false });
  }
}
