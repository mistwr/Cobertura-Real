// api/anacom.js — Proxy real para GEO.ANACOM ArcGIS
// Reproduz exactamente as queries que geo.anacom.pt faz internamente:
//   1. Layer 3 (RedeMovel polígono) → id_quad do ponto
//   2. Tables 5,6,7,8 (MEO/NOS/Vodafone/DIGI) WHERE id_quad = X → dados móvel
//   3. Layer 0 (RedeFixa pontos) → edif_cod dos edifícios próximos (50m)
//   4. Table 1 (RedeFixa alfanumérica) WHERE edif_cod IN (...) → dados fixo
//   5. Layer 2 (RedeSatelite polígono) → velocidades satélite
// CommonJS — máxima compatibilidade Vercel

const BASE = 'https://geo.anacom.pt/server/rest/services/publico/Coberturas_Disponiveis/MapServer';

// Campos reais da Portaria 77/2023
const MOVEL_FIELDS = 'id_quad,voz_ms_2g,voz_ms_3g,vel_dl_3g,vel_dl_4g,vel_dl_5g,vel_dl_4g_sa,vel_dl_5g_sa';

// Operadores móveis: layer table IDs
const MOVEL_OPS = [
  { id: 5, nome: 'MEO'      },
  { id: 6, nome: 'NOS'      },
  { id: 7, nome: 'Vodafone' },
  { id: 8, nome: 'DIGI'     },
];

// Qualidade voz coded values
const VOZ_QUAL = { 0:'Não disponível', 1:'Limitada', 2:'Aceitável', 3:'Boa', 4:'Muito Boa' };

// Velocidade 3G coded values (Mbps)
const VEL_3G = { 0:0, 1:1, 2:7, 14:18, 21:21 };

// Velocidade 4G coded values (Mbps)
const VEL_4G = { 0:0, 10:10, 30:30, 50:50, 100:100, 150:150, 300:300, 600:600, 1000:1000 };

// Velocidade 5G coded values (Mbps)
const VEL_5G = { 0:0, 50:50, 100:100, 300:300, 600:600, 1000:1000, 2000:2000, 3000:3000 };

async function q(layerId, params, timeout = 8000) {
  const url = `${BASE}/${layerId}/query?${new URLSearchParams({ ...params, f: 'json' })}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'CoberturaPT/2.0' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    console.warn(`Layer ${layerId} query failed:`, e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (!lat || !lon || isNaN(lat) || isNaN(lon) || lat < 28 || lat > 44 || lon < -32 || lon > -5) {
    return res.status(400).json({ ok: false, error: 'Coordenadas inválidas ou fora de Portugal' });
  }

  const geoPoint = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const spatialParams = {
    geometry:       geoPoint,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    returnGeometry: 'false',
    outSR:          '4326',
  };

  try {
    // ── PASSO 1: id_quad (quadrante 100m da rede móvel) ──────────
    const movelGrid = await q(3, { ...spatialParams, outFields: 'id_quad' });
    const idQuad = movelGrid?.features?.[0]?.attributes?.id_quad || null;

    // ── PASSO 2: Dados por operador móvel ────────────────────────
    let movel = [];
    if (idQuad) {
      const movelResults = await Promise.allSettled(
        MOVEL_OPS.map(op =>
          q(op.id, {
            where:    `id_quad = '${idQuad}'`,
            outFields: MOVEL_FIELDS,
          })
        )
      );

      movel = MOVEL_OPS.map((op, i) => {
        const res = movelResults[i];
        if (res.status !== 'fulfilled' || !res.value?.features?.length) return null;
        const a = res.value.features[0].attributes;

        // Serviços disponíveis
        const servicos = [];
        const v2g = parseInt(a.voz_ms_2g) || 0;
        const v3g = parseInt(a.voz_ms_3g) || 0;
        const dl3g = VEL_3G[parseInt(a.vel_dl_3g)] || 0;
        const dl4g = VEL_4G[parseInt(a.vel_dl_4g)] || parseInt(a.vel_dl_4g) || 0;
        const dl5g = VEL_5G[parseInt(a.vel_dl_5g)] || parseInt(a.vel_dl_5g) || 0;
        const dl5g_sa = VEL_5G[parseInt(a.vel_dl_5g_sa)] || 0;

        if (v2g > 0) servicos.push({ tech: '2G', disponivel: true, qualidade: VOZ_QUAL[v2g] || 'Disponível', tipo: 'voz' });
        if (v3g > 0 || dl3g > 0) servicos.push({ tech: '3G', disponivel: true, vel_dl: dl3g, qualidade: dl3g >= 21 ? 'Boa' : dl3g >= 14 ? 'Aceitável' : 'Limitada' });
        if (dl4g > 0) servicos.push({ tech: '4G', disponivel: true, vel_dl: dl4g, qualidade: dl4g >= 150 ? 'Muito Boa' : dl4g >= 50 ? 'Boa' : 'Aceitável' });
        if (dl5g > 0) servicos.push({ tech: '5G', disponivel: true, vel_dl: dl5g, qualidade: 'Boa' });
        if (dl5g_sa > 0 && !dl5g) servicos.push({ tech: '5G SA', disponivel: true, vel_dl: dl5g_sa, qualidade: 'Muito Boa' });

        if (!servicos.length) return null;
        return { operador: op.nome, id_quad: idQuad, servicos };
      }).filter(Boolean);
    }

    // ── PASSO 3: Edifícios próximos (rede fixa) ──────────────────
    const fixaPoints = await q(0, {
      ...spatialParams,
      outFields: 'edif_cod',
      distance:  50,
      units:     'esriSRUnit_Meter',
      spatialRel: 'esriSpatialRelIntersects',
    });

    // Fallback: aumentar distância se não encontrar
    let edifCods = fixaPoints?.features?.map(f => f.attributes.edif_cod).filter(Boolean) || [];
    if (!edifCods.length) {
      const fixaWide = await q(0, {
        ...spatialParams,
        outFields: 'edif_cod',
        distance:  200,
        units:     'esriSRUnit_Meter',
      });
      edifCods = fixaWide?.features?.map(f => f.attributes.edif_cod).filter(Boolean) || [];
    }

    // ── PASSO 4: Dados de rede fixa por edifício ─────────────────
    let fixa = [];
    if (edifCods.length) {
      const inClause = edifCods.slice(0, 5).map(c => `'${c}'`).join(',');
      const fixaData = await q(1, {
        where:    `edif_cod IN (${inClause})`,
        outFields: '*',
      });

      if (fixaData?.features?.length) {
        // Agrupar por operador (pode haver vários registos por edifício)
        const byOp = {};
        fixaData.features.forEach(f => {
          const a = f.attributes;
          const opCode = parseInt(a.operador) || 0;
          const opNome = a.operador_alias || resolveOperador(opCode) || `Op.${opCode}`;
          const key = opNome;
          if (!byOp[key]) {
            byOp[key] = {
              operador:   opNome,
              edif_cod:   a.edif_cod,
              tecnologia: a.tecnologia || a.tipo_tecnologia || '',
              vel_dl:     parseInt(a.vel_dl) || 0,
              vel_ul:     parseInt(a.vel_ul) || 0,
              servicos:   parseFixaServicos(a),
            };
          } else {
            // Manter a maior velocidade
            if (parseInt(a.vel_dl) > byOp[key].vel_dl) {
              byOp[key].vel_dl = parseInt(a.vel_dl);
              byOp[key].vel_ul = parseInt(a.vel_ul) || byOp[key].vel_ul;
              byOp[key].tecnologia = a.tecnologia || byOp[key].tecnologia;
            }
          }
        });
        fixa = Object.values(byOp);
      }
    }

    // ── PASSO 5: Satélite ─────────────────────────────────────────
    const satData = await q(2, { ...spatialParams, outFields: 'operador,operador_alias,vel_dl_sat,vel_ul_sat,estado' });
    const sat = (satData?.features || [])
      .filter(f => f.attributes.estado === 1 || f.attributes.estado === null)
      .map(f => {
        const a = f.attributes;
        const opCode = parseInt(a.operador) || 0;
        return {
          operador:   a.operador_alias || resolveOperador(opCode),
          tecnologia: 'Satélite',
          vel_dl:     parseInt(a.vel_dl_sat) || 0,
          vel_ul:     parseInt(a.vel_ul_sat) || 0,
        };
      })
      .filter(s => s.vel_dl > 0);

    // ── Resultado ─────────────────────────────────────────────────
    const hasData = fixa.length || movel.length || sat.length;
    if (!hasData) {
      // Nenhum dado da API → gerar estimativa
      return res.status(200).json({
        ok: true,
        source: 'estimativa',
        lat, lon, idQuad,
        fixa: [], movel: [], sat: [],
        aviso: 'Sem dados ANACOM nesta localização exacta. A rede fixa usa resolução ao nível do edifício — tente clicar mais perto de um edifício.',
      });
    }

    return res.status(200).json({
      ok: true,
      source: 'geo.anacom.pt',
      lat, lon, idQuad,
      edifCods: edifCods.slice(0, 3),
      fixa,
      movel,
      sat,
      actualizacao: 'Q4 2025',
    });

  } catch (err) {
    console.error('ANACOM proxy error:', err);
    return res.status(200).json({
      ok: false,
      source: 'erro',
      error: err.message,
      fixa: [], movel: [], sat: [],
    });
  }
};

// ── Helpers ───────────────────────────────────────────────────────

function resolveOperador(code) {
  const map = { 48:'MEO', 52:'NOS', 53:'NOS Madeira', 51:'NOS Açores', 81:'Vodafone', 21:'DIGI PORTUGAL', 55:'NOWO', 69:'Starlink', 56:'ONITELECOM' };
  return map[code] || null;
}

function parseFixaServicos(a) {
  const servicos = [];
  // Campos típicos da tabela fixa Portaria 77
  const tec = (a.tecnologia || a.tipo_tecnologia || '').toUpperCase();
  if (tec.includes('FTTH') || tec.includes('FTTB')) servicos.push('Fibra');
  if (tec.includes('HFC') || tec.includes('COAX')) servicos.push('Cabo');
  if (tec.includes('ADSL') || tec.includes('XDSL') || tec.includes('VDSL')) servicos.push('ADSL/VDSL');
  if (a.tv === 1 || a.tv === true) servicos.push('TV');
  if (a.voz === 1 || a.voz === true) servicos.push('Voz');
  if (!servicos.length) servicos.push('Internet');
  return servicos;
}
