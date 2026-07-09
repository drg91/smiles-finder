'use strict';

/**
 * Cliente de la API no oficial de Smiles (la misma que usa smiles.com.ar).
 *
 * Endpoint de búsqueda:
 *   GET https://api-air-flightsearch-prd.smiles.com.br/v1/airlines/search
 *
 * Endpoint de tasas de embarque:
 *   GET https://api-airlines-boarding-tax-prd.smiles.com.br/v1/airlines/flight/boardingtax
 *
 * Ambos requieren el header `x-api-key` (key pública del frontend de Smiles).
 */

const { getApiKey, refreshApiKey } = require('./apikey');

const SEARCH_URL = 'https://api-air-flightsearch-prd.smiles.com.br/v1/airlines/search';
const TAX_URL = 'https://api-airlines-boarding-tax-prd.smiles.com.br/v1/airlines/flight/boardingtax';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MOCK = process.env.SMILES_MOCK === '1';

function baseHeaders() {
  return {
    'x-api-key': getApiKey(),
    region: process.env.SMILES_REGION || 'ARGENTINA',
    channel: 'Web',
    origin: 'https://www.smiles.com.ar',
    referer: 'https://www.smiles.com.ar/',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'es-AR,es;q=0.9',
    'user-agent': BROWSER_UA,
  };
}

/**
 * Busca los vuelos de un día para un par origen-destino.
 * @param {object} q { origin, destination, date: 'YYYY-MM-DD', adults, children, infants, cabin }
 * @returns {Promise<Array>} lista de vuelos normalizados
 */
async function searchDay(q, { retries = 2 } = {}) {
  if (MOCK) return mockSearchDay(q);

  const params = new URLSearchParams({
    adults: String(q.adults ?? 1),
    children: String(q.children ?? 0),
    infants: String(q.infants ?? 0),
    cabinType: q.cabin || 'all',
    currencyCode: process.env.SMILES_CURRENCY || 'ARS',
    departureDate: q.date,
    originAirportCode: q.origin,
    destinationAirportCode: q.destination,
    tripType: '2', // solo ida; ida y vuelta se busca como dos "solo ida"
    isFlexibleDateChecked: 'false',
    forceCongener: 'false',
    r: 'ar',
  });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${SEARCH_URL}?${params}`, {
        headers: baseHeaders(),
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 401 || res.status === 403) {
        // Key vencida/rotada: intentar refrescarla una vez y reintentar.
        const refreshed = await refreshApiKey();
        if (refreshed.ok && attempt < retries) continue;
        throw new HttpError(res.status, 'API key rechazada por Smiles. Configurá SMILES_API_KEY (ver README).');
      }
      if (res.status === 429) {
        // Rate limit: backoff y reintento.
        await sleep(1500 * (attempt + 1) + Math.random() * 1000);
        lastErr = new HttpError(429, 'Rate limit de Smiles (429)');
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, `Smiles respondió HTTP ${res.status}`);

      const data = await res.json();
      return normalizeFlights(data, q);
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.status !== 429) throw err;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr || new Error('Búsqueda fallida');
}

/** Normaliza la respuesta cruda de Smiles a filas simples para la UI. */
function normalizeFlights(data, q) {
  const segment = data?.requestedFlightSegmentList?.[0];
  const flights = segment?.flightList || [];
  const out = [];

  for (const f of flights) {
    const fares = {};
    for (const fare of f.fareList || []) {
      // Tipos: SMILES_CLUB (precio socios club), SMILES (precio común),
      // SMILES_MONEY (millas + pesos)
      fares[fare.type] = {
        miles: fare.miles ?? null,
        money: fare.money ?? null,
        uid: fare.uid || null,
      };
    }

    const clubMiles = fares.SMILES_CLUB?.miles ?? null;
    const smilesMiles = fares.SMILES?.miles ?? null;
    const bestMiles = clubMiles ?? smilesMiles;
    if (bestMiles == null || bestMiles <= 0) continue; // sin disponibilidad canjeable

    out.push({
      origin: f.departure?.airport?.code || q.origin,
      destination: f.arrival?.airport?.code || q.destination,
      date: q.date,
      departureTime: (f.departure?.date || '').slice(11, 16),
      arrivalTime: (f.arrival?.date || '').slice(11, 16),
      arrivalDate: (f.arrival?.date || '').slice(0, 10),
      airline: f.airline?.name || f.airline?.code || '—',
      airlineCode: f.airline?.code || '',
      stops: f.stops ?? 0,
      durationHours: f.duration?.hours ?? null,
      durationMinutes: f.duration?.minutes ?? 0,
      cabin: f.cabin || '',
      clubMiles,
      smilesMiles,
      moneyFare: fares.SMILES_MONEY?.money ?? null,
      bestMiles,
      // Para consultar tasas de embarque a demanda:
      uid: f.uid || null,
      fareUid: fares.SMILES_CLUB?.uid || fares.SMILES?.uid || null,
      bookingUrl: emissionUrl(q),
    });
  }
  return out;
}

/** Link directo a la página de emisión de smiles.com.ar para esa búsqueda. */
function emissionUrl(q) {
  const millis = Date.parse(`${q.date}T15:00:00Z`);
  const params = new URLSearchParams({
    originAirportCode: q.origin,
    destinationAirportCode: q.destination,
    departureDate: String(millis),
    adults: String(q.adults ?? 1),
    children: String(q.children ?? 0),
    infants: String(q.infants ?? 0),
    isFlexibleDateChecked: 'false',
    tripType: '2',
    cabinType: q.cabin || 'all',
    currencyCode: process.env.SMILES_CURRENCY || 'ARS',
  });
  return `https://www.smiles.com.ar/emission?${params}`;
}

/**
 * Consulta las tasas de embarque de un vuelo puntual.
 * @returns {Promise<{miles: number|null, money: number|null}>}
 */
async function getBoardingTax({ uid, fareUid, adults = 1, children = 0, infants = 0 }) {
  if (MOCK) return { miles: 12000, money: 48000 + Math.round(Math.random() * 30000) };

  const params = new URLSearchParams({
    adults: String(adults),
    children: String(children),
    infants: String(infants),
    fareuid: fareUid,
    uid,
    type: 'SEGMENT_1',
    highlightText: 'SMILES_CLUB',
  });
  const res = await fetch(`${TAX_URL}?${params}`, {
    headers: baseHeaders(),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new HttpError(res.status, `No se pudieron obtener las tasas (HTTP ${res.status})`);
  const data = await res.json();
  const totals = data?.totals;
  return {
    miles: totals?.totalBoardingTax?.miles ?? null,
    money: totals?.totalBoardingTax?.money ?? null,
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Modo mock (SMILES_MOCK=1): datos sintéticos para probar la app sin red.
// ---------------------------------------------------------------------------
function mockSearchDay(q) {
  const airlines = [
    ['GOL', 'G3'],
    ['Aerolineas Argentinas', 'AR'],
    ['LATAM', 'LA'],
    ['Copa Airlines', 'CM'],
    ['Air France', 'AF'],
  ];
  const seed = hash(`${q.origin}${q.destination}${q.date}`);
  const n = seed % 5; // algunos días sin vuelos
  const flights = [];
  for (let i = 0; i < n; i++) {
    const [name, code] = airlines[(seed + i * 7) % airlines.length];
    const club = 20000 + ((seed * (i + 3)) % 180000);
    const stops = (seed + i) % 3 === 0 ? 0 : ((seed + i) % 2) + 1;
    const depHour = 6 + ((seed + i * 5) % 17);
    flights.push({
      origin: q.origin,
      destination: q.destination,
      date: q.date,
      departureTime: `${String(depHour).padStart(2, '0')}:${(seed + i) % 2 ? '30' : '00'}`,
      arrivalTime: `${String((depHour + 11) % 24).padStart(2, '0')}:45`,
      arrivalDate: q.date,
      airline: name,
      airlineCode: code,
      stops,
      durationHours: 8 + (i % 9),
      durationMinutes: (seed + i) % 60,
      cabin: 'ECONOMIC',
      clubMiles: club,
      smilesMiles: Math.round(club * 1.14),
      moneyFare: null,
      bestMiles: club,
      uid: `mock-${seed}-${i}`,
      fareUid: `mockfare-${seed}-${i}`,
      bookingUrl: emissionUrl(q),
    });
  }
  return new Promise((r) => setTimeout(() => r(flights), 120 + (seed % 300)));
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

module.exports = { searchDay, getBoardingTax, emissionUrl };
