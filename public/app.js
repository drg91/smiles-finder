'use strict';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let allFlights = [];
let eventSource = null;
let sortKey = 'miles';
let sortAsc = true;

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('es-AR');

// ---------------------------------------------------------------------------
// Init: chips de meses (próximos 12) y última búsqueda guardada
// ---------------------------------------------------------------------------
(function init() {
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
})();

// ---------------------------------------------------------------------------
// Búsqueda (SSE)
// ---------------------------------------------------------------------------
function onSearch(e) {
  e.preventDefault();
  stopSearch();

  const months = [...document.querySelectorAll('input[name=month]:checked')].map((c) => c.value);
  const params = new URLSearchParams({
    origin: $('origin').value.trim().toUpperCase(),
    destinations: $('destinations').value,
    months: months.join(','),
    dates: $('dates').value,
    adults: $('adults').value,
    cabin: $('cabin').value,
    startDay: $('startDay').value || '1',
    endDay: $('endDay').value || '31',
  });

  localStorage.setItem('smilesFinder.lastSearch', JSON.stringify({
    origin: $('origin').value, destinations: $('destinations').value,
    dates: $('dates').value, adults: $('adults').value, cabin: $('cabin').value, months,
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

  eventSource = new EventSource(`/api/search-stream?${params}`);
  let renderQueued = false;
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 300);
  };

  eventSource.addEventListener('meta', (ev) => {
    const meta = JSON.parse(ev.data);
    $('progressText').textContent = `0 / ${meta.totalJobs} búsquedas`;
  });
  eventSource.addEventListener('flights', (ev) => {
    allFlights.push(...JSON.parse(ev.data));
    queueRender();
  });
  eventSource.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    setProgress(p.done, p.total, p.errors);
  });
  eventSource.addEventListener('joberror', (ev) => {
    const e2 = JSON.parse(ev.data);
    addError(`${e2.destination} ${e2.date}: ${e2.message}`);
  });
  eventSource.addEventListener('fatal', (ev) => {
    addError(`⛔ ${JSON.parse(ev.data).message}`);
    stopSearch();
  });
  eventSource.addEventListener('done', () => {
    stopSearch();
    render();
  });
  eventSource.onerror = () => {
    // El servidor cierra el stream al terminar; si fue un error real ya se mostró.
    if (eventSource && eventSource.readyState === EventSource.CLOSED) stopSearch();
  };
}

function stopSearch() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  $('searchBtn').disabled = false;
  $('cancelBtn').hidden = true;
}

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

  // Resumen: mejor precio por destino
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
  $('noResults').hidden = rows.length > 0 || !!eventSource;

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
    const res = await fetch(`/api/tax?uid=${encodeURIComponent(f.uid)}&fareUid=${encodeURIComponent(f.fareUid)}&adults=${adults}`);
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    f.tax = await res.json();
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
