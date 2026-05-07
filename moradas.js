// api/moradas.js — Proxy para geoapi.pt e Nominatim (sem CORS no browser)
// CommonJS — máxima compatibilidade Vercel

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon, cp, q } = req.query;
  const UA = 'CoberturaPT/2.0 (cobertura-real.vercel.app)';

  try {
    // ── MODO 1: Código Postal ────────────────────────────────────
    if (cp) {
      const cpClean = String(cp).replace(/\s/g, '').replace(/^(\d{4})(\d{3})$/, '$1-$2');
      if (!/^\d{4}-\d{3}$/.test(cpClean)) {
        return res.status(400).json({ ok: false, error: 'Formato inválido. Use XXXX-XXX' });
      }
      const r = await fetch(`https://json.geoapi.pt/codigo_postal/${cpClean}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) return res.status(404).json({ ok: false, error: `CP ${cpClean} não encontrado` });
      const d = await r.json();
      // geoapi.pt pode retornar um objecto ou array
      const item = Array.isArray(d) ? d[0] : d;
      if (!item) return res.status(404).json({ ok: false, error: 'CP sem dados' });
      return res.status(200).json({
        ok: true,
        tipo: 'codigo_postal',
        latitude:      parseFloat(item.latitude  || item.Latitude  || 0),
        longitude:     parseFloat(item.longitude || item.Longitude || 0),
        rua:           item.rua       || item.Rua       || '',
        localidade:    item.localidade|| item.Localidade|| '',
        freguesia:     item.freguesia || '',
        concelho:      item.concelho  || '',
        distrito:      item.distrito  || '',
        codigo_postal: cpClean,
        altitude:      item.altitude  || null,
      });
    }

    // ── MODO 2: Reverse Geocode GPS ──────────────────────────────
    if (lat && lon) {
      const latF = parseFloat(lat), lonF = parseFloat(lon);
      if (isNaN(latF) || isNaN(lonF)) {
        return res.status(400).json({ ok: false, error: 'lat/lon inválidos' });
      }

      // Correr geoapi.pt e Nominatim em paralelo
      const [gpRes, nmRes] = await Promise.allSettled([
        fetch(`https://json.geoapi.pt/gps/${latF},${lonF}`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000)
        }),
        fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latF}&lon=${lonF}&format=json&accept-language=pt`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000)
        }),
      ]);

      let gd = null, nd = null;
      if (gpRes.status === 'fulfilled' && gpRes.value.ok) {
        try { gd = await gpRes.value.json(); } catch {}
      }
      if (nmRes.status === 'fulfilled' && nmRes.value.ok) {
        try { nd = await nmRes.value.json(); } catch {}
      }

      const addr = nd?.address || {};
      return res.status(200).json({
        ok: true,
        tipo: 'gps',
        latitude:      latF,
        longitude:     lonF,
        // geoapi.pt tem dados PT oficiais (CAOP + CTT)
        distrito:      gd?.distrito      || '',
        concelho:      gd?.concelho      || addr.county    || '',
        freguesia:     gd?.freguesia     || '',
        rua:           gd?.rua           || addr.road      || '',
        numero_porta:  gd?.numero_porta  || addr.house_number || '',
        localidade:    gd?.localidade    || addr.city || addr.town || addr.village || '',
        codigo_postal: gd?.codigo_postal || addr.postcode   || '',
        altitude:      gd?.altitude      || null,
        // Extra geoapi.pt
        uso_solo:        gd?.uso_solo        || '',
        perigo_incendio: gd?.perigo_incendio || '',
        // Nominatim display
        display_name: nd?.display_name || '',
        _nominatim:   addr,
      });
    }

    // ── MODO 3: Geocode texto (Nominatim) ────────────────────────
    if (q) {
      const query = `${q} Portugal`;
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=pt&countrycodes=pt`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) }
      );
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Nominatim error' });
      const results = await r.json();
      return res.status(200).json({ ok: true, tipo: 'geocode', results });
    }

    return res.status(400).json({ ok: false, error: 'Parâmetros: lat+lon, cp, ou q' });

  } catch (err) {
    console.error('Moradas error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
};
