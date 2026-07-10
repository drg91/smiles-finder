'use strict';

/**
 * Manejo de la API key de Smiles.
 *
 * La web oficial de Smiles (smiles.com.ar / smiles.com.br) llama a su API
 * interna con una API key pública embebida en los bundles de JavaScript del
 * frontend. Esa key rota muy de vez en cuando. Estrategia:
 *
 *   1. Usar SMILES_API_KEY del entorno / .env si está definida.
 *   2. Si no, usar la key por defecto conocida (la histórica de la web).
 *   3. Si la API devuelve 401/403, intentar re-extraer la key vigente
 *      escaneando los bundles JS de smiles.com.ar (refreshApiKey).
 */

// Key pública histórica embebida en el frontend de Smiles (usada por
// smileshelper y demás buscadores de la comunidad).
const DEFAULT_API_KEY = 'aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let currentKey = process.env.SMILES_API_KEY || DEFAULT_API_KEY;
let lastRefreshAt = 0;
// fetch que enruta por SMILES_PROXY si está definido (misma lógica que
// lib/smiles.js) — sin esto el refresh se hace desde la IP de datacenter y
// el WAF lo bloquea aunque las búsquedas ya pasen por el proxy.
const proxyFetch = require('./proxy').getProxyFetch();

function getApiKey() {
  return currentKey;
}

function setApiKey(key) {
  if (key && typeof key === 'string') currentKey = key.trim();
}

/**
 * Intenta extraer la API key vigente desde el sitio de Smiles.
 * Best-effort: si falla, se conserva la key actual.
 * @returns {Promise<{ok: boolean, key?: string, error?: string}>}
 */
async function refreshApiKey() {
  // No spamear: máx. un refresh cada 5 minutos.
  if (Date.now() - lastRefreshAt < 5 * 60 * 1000) {
    return { ok: false, error: 'refresh reciente, se conserva la key actual' };
  }
  lastRefreshAt = Date.now();

  const pages = [
    'https://www.smiles.com.ar/emission?originAirportCode=EZE&destinationAirportCode=GRU&departureDate=2099-01-01&adults=1&children=0&infants=0&tripType=2&cabinType=all',
    'https://www.smiles.com.ar/home',
    'https://www.smiles.com.br/home',
  ];

  for (const page of pages) {
    try {
      const html = await fetchText(page);
      // Bundles JS referenciados en la página
      const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)]
        .map((m) => m[1])
        .map((src) => (src.startsWith('http') ? src : new URL(src, page).href));

      // La key también puede estar inline en el HTML
      const inline = findKey(html);
      if (inline) {
        setApiKey(inline);
        return { ok: true, key: inline };
      }

      for (const url of scriptUrls.slice(0, 25)) {
        try {
          const js = await fetchText(url);
          const key = findKey(js);
          if (key) {
            setApiKey(key);
            return { ok: true, key };
          }
        } catch {
          /* siguiente bundle */
        }
      }
    } catch {
      /* siguiente página */
    }
  }
  return { ok: false, error: 'no se pudo extraer la key del sitio de Smiles' };
}

/** Busca patrones de api key asociados a la API de vuelos en un texto JS/HTML. */
function findKey(text) {
  // Patrones tipo: apiKey:"XXXX", "x-api-key":"XXXX", api_key = 'XXXX'
  const patterns = [
    /x-api-key["']?\s*[:=]\s*["']([A-Za-z0-9]{30,60})["']/i,
    /api[_-]?key["']?\s*[:=]\s*["']([A-Za-z0-9]{30,60})["']/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  // Heurística: token de ~40 chars cerca de una mención al host de flightsearch
  const idx = text.indexOf('api-air-flightsearch');
  if (idx >= 0) {
    const windowText = text.slice(Math.max(0, idx - 3000), idx + 3000);
    const m = windowText.match(/["']([A-Za-z0-9]{38,44})["']/);
    if (m) return m[1];
  }
  return null;
}

async function fetchText(url) {
  const doFetch = proxyFetch || fetch;
  const res = await doFetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

module.exports = { getApiKey, setApiKey, refreshApiKey, DEFAULT_API_KEY };
