'use strict';

// ---------------------------------------------------------------------------
// Smiles Finder funciona en dos modos:
//   'server': hay un backend Node (server.js) que hace las consultas a Smiles
//             y streamea resultados por SSE. (npm start / Render)
//   'static': no hay backend (ej: GitHub Pages). El navegador llama directo
//             a la API pública del frontend de Smiles, con la misma lógica.
// ---------------------------------------------------------------------------

const SMILES_SEARCH_URL = 'https://api-air-flightsearch-prd.smiles.com.br/v1/airlines/search';
const SMILES_TAX_URL = 'https://api-airlines-boarding-tax-prd.smiles.com.br/v1/airlines/flight/boardingtax';
// Key pública embebida en el frontend de smiles.com.ar (se puede pisar abajo)
const DEFAULT_API_KEY = 'aJqPU7xNHl9qN3NVZnPaJ208aPo2Bh2p2ZV844tw';
const STATIC_CONCURRENCY = 4;

let appMode = 'server';
let allFlights = [];
let searchAbort = null; // función para cancelar la búsqueda en curso
let sortKey = 'miles';
let sortAsc = true;

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('es-AR');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const now = new Date();
  const monthsBox = $('months');
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" name="month" value="${value}"> ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    monthsBox.appendChild(label);
  }

  try {
    const saved = JSON.parse(localStorage.getItem('smilesFinder.lastSearch') || 'null');
    if (saved) {
      $('origin').value = saved.origin || '';
      $('destinations').value = saved.destinations || '';
      $('dates').value = saved.dates || '';
      $('adults').value = saved.adults || '1';
      $('cabin').value = saved.cabin || 'all';
      for (const cb of document.querySelectorAll('input[name=month]')) {
        cb.checked = (saved.months || []).includes(cb.value);
      }
    }
  } catch { /* sin datos guardados */ }

  $('searchForm').addEventListener('submit', onSearch);
  $('cancelBtn').addEventListener('click', stopSearch);
  for (const el of ['fStops', 'fMaxMiles', 'fExclude', 'fTop', 'fClubOnly']) {
    $(el).addEventListener('input', render);
  }
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortAsc = !sortAsc;
      else { sortKey = key; sortAsc = true; }
      document.querySelectorAll('th').forEach((t) => t.classList.toggle('sorted', t === th));
      render();
    });
  }

  // Detectar modo: ¿hay backend?
  try {
    const res = await fetch('api/status', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error();
    appMode = 'server';
  } catch {
    appMode = 'static';
    $('staticExtras').hidden = false;
    $('apiKeyInput').value = localStorage.getItem('smilesFinder.apiKey') || '';
    $('apiKeyInput').addEventListener('change', () => {
      localStorage.setItem('smilesFinder.apiKey', $('apiKeyInput').value.trim());
    });
  }
})();

function getApiKey() {
  return ($('apiKeyInput')?.value || '').trim() || DEFAULT_API_KEY;
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
function onSearch(e) {
  e.preventDefault();
  stopSearch();

  const months = [...document.querySelectorAll('input[name=month]:checked')].map((c) => c.value);
  const input = {
    origin: $('origin').value.trim().toUpperCase(),
    destinations: $('destinations').value,
    months,
    dates: $('dates').value,
    adults: $('adults').value,
    cabin: $('cabin').value,
    startDay: $('startDay').value || '1',
    endDay: $('endDay').value || '31',
  };

  localStorage.setItem('smilesFinder.lastSearch', JSON.stringify({
    origin: input.origin, destinations: input.destinations,
    dates: input.dates, adults: input.adults, cabin: input.cabin, months,
  }));

  allFlights = [];
  $('errorsList').innerHTML = '';
  $('errors').hidden = true;
  $('filters').hidden = false;
  $('results').hidden = false;
  $('searchBtn').disabled = true;
  $('cancelBtn').hidden = false;
  $('progressWrap').hidden = false;
  setProgress(0, 1, 0);
  render();

  if (appMode === 'server') startServerSearch(input);
  else startStaticSearch(input);
}

function stopSearch() {
  if (searchAbort) { searchAbort(); searchAbort = null; }
  $('searchBtn').disabled = false;
  $('cancelBtn').hidden = true;
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 300);
}

function handleFlights(flights) {
  allFlights.push(...flights);
  queueRender();
}

function finishSearch() {
  stopSearch();
  render();
}

// --- Modo server: SSE ------------------------------------------------------
function startServerSearch(input) {
  const params = new URLSearchParams({
    origin: input.origin,
    destinations: input.destinations,
    months: input.months.join(','),
    dates: input.dates,
    adults: input.adults,
    cabin: input.cabin,
    startDay: input.startDay,
    endDay: input.endDay,
  });
  const es = new EventSource(`api/search-stream?${params}`);
  searchAbort = () => es.close();

  es.addEventListener('meta', (ev) => {
    $('progressText').textContent = `0 / ${JSON.parse(ev.data).totalJobs} búsquedas`;
  });
  es.addEventListener('flights', (ev) => handleFlights(JSON.parse(ev.data)));
  es.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    setProgress(p.done, p.total, p.errors);
  });
  es.addEventListener('joberror', (ev) => {
    const e = JSON.parse(ev.data);
    addError(`${e.destination} ${e.date}: ${e.message}`);
  });
  es.addEventListener('fatal', (ev) => {
    addError(`⛔ ${JSON.parse(ev.data).message}`);
    finishSearch();
  });
  es.addEventListener('done', finishSearch);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) finishSearch();
  };
}

// --- Modo estático: fan-out desde el navegador ------------------------------
async function startStaticSearch(input) {
  let jobs;
  try {
    jobs = buildJobs(input);
  } catch (err) {
    addError(`⛔ ${err.message}`);
    finishSearch();
    return;
  }

  $('progressText').textContent = `0 / ${jobs.length} búsquedas`;
  let aborted = false;
  searchAbort = () => (aborted = true);

  let done = 0;
  let errors = 0;
  let next = 0;

  const worker = async () => {
    while (!aborted) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      try {
        const flights = await smilesSearchDay(job);
        if (flights.length) handleFlights(flights);
      } catch (err) {
        errors++;
        addError(`${job.destination} ${job.date}: ${err.message}`);
        if (err.status === 401 || err.status === 403) {
          aborted = true;
          addError('⛔ API key rechazada por Smiles. Pegá una key vigente en el campo "API key" (instrucciones en el README).');
        }
        if (err.cors) {
          aborted = true;
          addError('⛔ El navegador bloqueó la llamada a Smiles (CORS) o no hay conexión. Usá la versión con servidor: npm start o Render (ver README).');
        }
      } finally {
        done++;
        setProgress(done, jobs.length, errors);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(STATIC_CONCURRENCY, jobs.length) }, worker));
  finishSearch();
}

/** Expande destinos × (meses + fechas puntuales) en trabajos por día. */
function buildJobs(input) {
  const origin = input.origin;
  const destinations = input.destinations
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s));
  const looseDates = input.dates
    .split(',').map((s) => s.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const startDay = Math.max(1, parseInt(input.startDay, 10) || 1);
  const endDay = Math.min(31, parseInt(input.endDay, 10) || 31);

  if (!/^[A-Z]{3}$/.test(origin)) throw new Error('Origen inválido (código IATA de 3 letras, ej: EZE)');
  if (!destinations.length) throw new Error('Ingresá al menos un destino válido');
  if (!input.months.length && !looseDates.length) throw new Error('Ingresá al menos un mes o una fecha');

  const todayStr = new Date().toISOString().slice(0, 10);
  const dates = new Set(looseDates.filter((d) => d >= todayStr));
  for (const month of input.months) {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    for (let d = startDay; d <= Math.min(daysInMonth, endDay); d++) {
      const dateStr = `${month}-${String(d).padStart(2, '0')}`;
      if (dateStr >= todayStr) dates.add(dateStr);
    }
  }

  const jobs = [];
  for (const destination of destinations) {
    for (const date of [...dates].sort()) {
      jobs.push({ origin, destination, date, adults: input.adults, cabin: input.cabin });
    }
  }
  if (!jobs.length) throw new Error('No hay fechas futuras para buscar');
  if (jobs.length > 800) throw new Error(`Demasiadas combinaciones (${jobs.length}). Reducí destinos o fechas (máx. 800).`);
  return jobs;
}

/** Llama a la API de Smiles directo desde el navegador y normaliza. */
async function smilesSearchDay(job, retries = 2) {
  const params = new URLSearchParams({
    adults: String(job.adults || 1),
    children: '0',
    infants: '0',
    cabinType: job.cabin || 'all',
    currencyCode: 'ARS',
    departureDate: job.date,
    originAirportCode: job.origin,
    destinationAirportCode: job.destination,
    tripType: '2',
    isFlexibleDateChecked: 'false',
    forceCongener: 'false',
    r: 'ar',
  });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let res;
      try {
        res = await fetch(`${SMILES_SEARCH_URL}?${params}`, {
          headers: { 'x-api-key': getApiKey(), region: 'ARGENTINA', channel: 'Web' },
          signal: AbortSignal.timeout(30000),
        });
      } catch (netErr) {
        if (netErr.name === 'TimeoutError') throw netErr;
        // fetch lanza TypeError tanto por red caída como por bloqueo CORS
        const e = new Error('Fallo de red o bloqueo CORS');
        e.cors = true;
        throw e;
      }
      if (res.status === 401 || res.status === 403) {
        const e = new Error(`API key rechazada (HTTP ${res.status})`);
        e.status = res.status;
        throw e;
      }
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1) + Math.random() * 1000);
        lastErr = new Error('Rate limit de Smiles (429)');
        continue;
      }
      if (!res.ok) throw new Error(`Smiles respondió HTTP ${res.status}`);
      const data = await res.json();
      return normalizeFlights(data, job);
    } catch (err) {
      lastErr = err;
      if (err.status || err.cors) throw err;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr || new Error('Búsqueda fallida');
}

/** Misma normalización que hace el backend (lib/smiles.js). */
function normalizeFlights(data, job) {
  const flights = data?.requestedFlightSegmentList?.[0]?.flightList || [];
  const out = [];
  for (const f of flights) {
    const fares = {};
    for (const fare of f.fareList || []) {
      fares[fare.type] = { miles: fare.miles ?? null, money: fare.money ?? null, uid: fare.uid || null };
    }
    const clubMiles = fares.SMILES_CLUB?.miles ?? null;
    const smilesMiles = fares.SMILES?.miles ?? null;
    const bestMiles = clubMiles ?? smilesMiles;
    if (bestMiles == null || bestMiles <= 0) continue;

    out.push({
      origin: f.departure?.airport?.code || job.origin,
      destination: f.arrival?.airport?.code || job.destination,
      date: job.date,
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
      uid: f.uid || null,
      fareUid: fares.SMILES_CLUB?.uid || fares.SMILES?.uid || null,
      bookingUrl: emissionUrl(job),
    });
  }
  return out;
}

function emissionUrl(job) {
  const millis = Date.parse(`${job.date}T15:00:00Z`);
  const params = new URLSearchParams({
    originAirportCode: job.origin,
    destinationAirportCode: job.destination,
    departureDate: String(millis),
    adults: String(job.adults || 1),
    children: '0',
    infants: '0',
    isFlexibleDateChecked: 'false',
    tripType: '2',
    cabinType: job.cabin || 'all',
    currencyCode: 'ARS',
  });
  return `https://www.smiles.com.ar/emission?${params}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Progreso / errores
// ---------------------------------------------------------------------------
function setProgress(done, total, errors) {
  $('progressFill').style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
  $('progressText').textContent =
    `${done} / ${total} búsquedas · ${allFlights.length} vuelos` + (errors ? ` · ${errors} errores` : '');
}

function addError(msg) {
  $('errors').hidden = false;
  const li = document.createElement('li');
  li.textContent = msg;
  $('errorsList').appendChild(li);
  $('errorsSummary').textContent = `${$('errorsList').children.length} búsquedas con error (click para ver)`;
}

// ---------------------------------------------------------------------------
// Render de resultados con filtros
// ---------------------------------------------------------------------------
function render() {
  const clubOnly = $('fClubOnly').checked;
  const maxStops = $('fStops').value === '' ? null : Number($('fStops').value);
  const maxMiles = Number($('fMaxMiles').value) || null;
  const excluded = $('fExclude').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const top = $('fTop').value;

  const milesOf = (f) => (clubOnly ? (f.clubMiles ?? f.smilesMiles) : (f.smilesMiles ?? f.clubMiles));

  let rows = allFlights.filter((f) => {
    if (milesOf(f) == null) return false;
    if (maxStops != null && f.stops > maxStops) return false;
    if (maxMiles && milesOf(f) > maxMiles) return false;
    if (excluded.some((x) => f.airline.toLowerCase().includes(x))) return false;
    return true;
  });

  rows.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'date': va = a.date; vb = b.date; break;
      case 'airline': va = a.airline; vb = b.airline; break;
      case 'stops': va = a.stops; vb = b.stops; break;
      case 'duration':
        va = (a.durationHours ?? 99) * 60 + a.durationMinutes;
        vb = (b.durationHours ?? 99) * 60 + b.durationMinutes;
        break;
      default: va = milesOf(a); vb = milesOf(b);
    }
    const cmp = va < vb ? -1 : va > vb ? 1 : milesOf(a) - milesOf(b);
    return sortAsc ? cmp : -cmp;
  });

  if (top) {
    const byGroup = new Map();
    const groupOf = (f) => (top === 'dest' ? f.destination : f.date.slice(0, 7));
    const grouped = [];
    for (const f of rows) {
      const g = groupOf(f);
      const n = byGroup.get(g) || 0;
      if (n < 10) { byGroup.set(g, n + 1); grouped.push(f); }
    }
    rows = grouped;
  }

  const best = new Map();
  for (const f of rows) {
    const cur = best.get(f.destination);
    if (!cur || milesOf(f) < milesOf(cur)) best.set(f.destination, f);
  }
  $('summary').innerHTML = [...best.entries()]
    .sort((a, b) => milesOf(a[1]) - milesOf(b[1]))
    .map(([dest, f]) => `${f.origin}→${dest}: <b>${fmt.format(milesOf(f))}</b> millas (${f.date})`)
    .join(' &nbsp;·&nbsp; ');

  const body = $('resultsBody');
  body.innerHTML = '';
  $('noResults').hidden = rows.length > 0 || !!searchAbort;

  const frag = document.createDocumentFragment();
  for (const f of rows.slice(0, 500)) {
    const tr = document.createElement('tr');
    const dur = f.durationHours != null ? `${f.durationHours}h ${String(f.durationMinutes).padStart(2, '0')}m` : '—';
    const stops = f.stops === 0 ? '<span class="direct">Directo</span>' : `${f.stops}`;
    const other = clubOnly ? f.smilesMiles : f.clubMiles;
    tr.innerHTML = `
      <td>${f.date}</td>
      <td><span class="tag">${f.origin} → ${f.destination}</span></td>
      <td>${f.departureTime || '—'}</td>
      <td>${escapeHtml(f.airline)}</td>
      <td>${stops}</td>
      <td>${dur}</td>
      <td class="miles">${fmt.format(milesOf(f))}${other ? ` <small>(${clubOnly ? 'común' : 'club'}: ${fmt.format(other)})</small>` : ''}</td>
      <td class="taxCell"></td>
      <td><a class="book" href="${f.bookingUrl}" target="_blank" rel="noopener">Emitir ↗</a></td>`;

    const taxCell = tr.querySelector('.taxCell');
    if (f.tax) {
      taxCell.textContent = `$${fmt.format(f.tax.money ?? 0)}`;
    } else if (f.uid && f.fareUid) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small';
      btn.textContent = 'ver';
      btn.addEventListener('click', () => loadTax(f, btn));
      taxCell.appendChild(btn);
    } else {
      taxCell.textContent = '—';
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

async function loadTax(f, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const adults = $('adults').value;
    if (appMode === 'server') {
      const res = await fetch(`api/tax?uid=${encodeURIComponent(f.uid)}&fareUid=${encodeURIComponent(f.fareUid)}&adults=${adults}`);
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      f.tax = await res.json();
    } else {
      const params = new URLSearchParams({
        adults, children: '0', infants: '0',
        fareuid: f.fareUid, uid: f.uid,
        type: 'SEGMENT_1', highlightText: 'SMILES_CLUB',
      });
      const res = await fetch(`${SMILES_TAX_URL}?${params}`, {
        headers: { 'x-api-key': getApiKey(), region: 'ARGENTINA', channel: 'Web' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      f.tax = {
        miles: data?.totals?.totalBoardingTax?.miles ?? null,
        money: data?.totals?.totalBoardingTax?.money ?? null,
      };
    }
    render();
  } catch (err) {
    btn.textContent = 'error';
    btn.title = err.message;
    btn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
