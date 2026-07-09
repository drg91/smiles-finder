'use strict';

/**
 * Smiles Finder — buscador de vuelos baratos con millas en smiles.com.ar
 *
 * Servidor HTTP sin dependencias (Node >= 18).
 *   npm start          → http://localhost:3000
 *   SMILES_MOCK=1 …    → datos sintéticos para probar la UI sin red
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { searchDay, getBoardingTax } = require('./lib/smiles');
const { getApiKey, setApiKey, refreshApiKey } = require('./lib/apikey');

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Concurrencia contra la API de Smiles: bajarla si aparecen muchos 429.
const CONCURRENCY = Number(process.env.SMILES_CONCURRENCY || 5);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/search-stream') return await handleSearchStream(url, req, res);
    if (url.pathname === '/api/tax') return await handleTax(url, res);
    if (url.pathname === '/api/status') return await handleStatus(url, res);
    return serveStatic(url.pathname, res);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message || 'Error interno' });
  }
});

server.listen(PORT, () => {
  const mock = process.env.SMILES_MOCK === '1' ? ' [MODO MOCK: datos de prueba]' : '';
  console.log(`✈  Smiles Finder corriendo en http://localhost:${PORT}${mock}`);
});

// ---------------------------------------------------------------------------
// GET /api/search-stream  (Server-Sent Events)
//   ?origin=EZE&destinations=MAD,BCN&months=2026-09,2026-10&dates=2026-12-24
//   &adults=1&cabin=all&startDay=1&endDay=31
// Emite eventos: meta, progress, flights, error, done
// ---------------------------------------------------------------------------
async function handleSearchStream(url, req, res) {
  const p = url.searchParams;
  const origin = clean(p.get('origin'));
  const destinations = list(p.get('destinations')).map(clean).filter(isAirport);
  const months = list(p.get('months')).filter((m) => /^\d{4}-\d{2}$/.test(m));
  const looseDates = list(p.get('dates')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const adults = clampInt(p.get('adults'), 1, 9, 1);
  const children = clampInt(p.get('children'), 0, 9, 0);
  const cabin = ['all', 'ECONOMIC', 'PREMIUM_ECONOMIC', 'BUSINESS'].includes(p.get('cabin'))
    ? p.get('cabin')
    : 'all';
  const startDay = clampInt(p.get('startDay'), 1, 31, 1);
  const endDay = clampInt(p.get('endDay'), 1, 31, 31);

  if (!isAirport(origin)) throw httpError(400, 'Origen inválido (código IATA de 3 letras, ej: EZE)');
  if (destinations.length === 0) throw httpError(400, 'Ingresá al menos un destino válido');
  if (months.length === 0 && looseDates.length === 0)
    throw httpError(400, 'Ingresá al menos un mes o una fecha');

  // Expandir meses a fechas concretas (solo fechas futuras)
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dates = new Set(looseDates.filter((d) => d >= todayStr));
  for (const month of months) {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    for (let d = Math.max(1, startDay); d <= Math.min(daysInMonth, endDay); d++) {
      const dateStr = `${month}-${String(d).padStart(2, '0')}`;
      if (dateStr >= todayStr) dates.add(dateStr);
    }
  }

  const jobs = [];
  for (const destination of destinations) {
    for (const date of [...dates].sort()) {
      jobs.push({ origin, destination, date, adults, children, cabin });
    }
  }
  if (jobs.length === 0) throw httpError(400, 'No hay fechas futuras para buscar');
  if (jobs.length > 800)
    throw httpError(400, `Demasiadas combinaciones (${jobs.length}). Reducí destinos o fechas (máx. 800).`);

  // SSE
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('meta', { totalJobs: jobs.length, destinations, dates: dates.size });

  let aborted = false;
  req.on('close', () => (aborted = true));

  let done = 0;
  let errors = 0;
  let next = 0;

  const worker = async () => {
    while (!aborted) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      try {
        const flights = await searchDay(job);
        if (flights.length > 0) send('flights', flights);
      } catch (err) {
        errors++;
        send('joberror', {
          destination: job.destination,
          date: job.date,
          message: err.message,
          status: err.status || null,
        });
        // Si la key fue rechazada, no tiene sentido seguir martillando.
        if (err.status === 401 || err.status === 403) {
          aborted = true;
          send('fatal', { message: err.message });
        }
      } finally {
        done++;
        send('progress', { done, total: jobs.length, errors });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  send('done', { done, errors });
  res.end();
}

// ---------------------------------------------------------------------------
// GET /api/tax?uid=...&fareUid=...&adults=1&children=0
// ---------------------------------------------------------------------------
async function handleTax(url, res) {
  const p = url.searchParams;
  const uid = p.get('uid');
  const fareUid = p.get('fareUid');
  if (!uid || !fareUid) throw httpError(400, 'Faltan uid/fareUid');
  const tax = await getBoardingTax({
    uid,
    fareUid,
    adults: clampInt(p.get('adults'), 1, 9, 1),
    children: clampInt(p.get('children'), 0, 9, 0),
  });
  sendJson(res, 200, tax);
}

// ---------------------------------------------------------------------------
// GET /api/status            → estado y key en uso (enmascarada)
// GET /api/status?refresh=1  → fuerza re-extracción de la key desde smiles.com.ar
// ---------------------------------------------------------------------------
async function handleStatus(url, res) {
  if (url.searchParams.get('refresh') === '1') {
    const result = await refreshApiKey();
    return sendJson(res, 200, { refreshed: result.ok, detail: result.error || 'key actualizada', apiKey: mask(getApiKey()) });
  }
  if (url.searchParams.get('setKey')) setApiKey(url.searchParams.get('setKey'));
  sendJson(res, 200, {
    apiKey: mask(getApiKey()),
    mock: process.env.SMILES_MOCK === '1',
    concurrency: CONCURRENCY,
  });
}

// ---------------------------------------------------------------------------

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function clean(s) {
  return (s || '').trim().toUpperCase();
}
function list(s) {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}
function isAirport(s) {
  return /^[A-Z]{3}$/.test(s || '');
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function mask(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '****';
}

/** Carga .env simple (KEY=VALUE por línea) sin dependencias. */
function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* sin .env */
  }
}
