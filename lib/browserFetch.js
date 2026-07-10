'use strict';

/**
 * Motor "navegador": hace los requests a la API de Smiles desde un Chromium
 * headless real (puppeteer-core + @sparticuz/chromium).
 *
 * ¿Por qué? El WAF de Smiles (Akamai Bot Manager) devuelve 406 a requests
 * hechos desde Node: detecta la firma TLS, que no es la de un Chrome real.
 * Un navegador de verdad tiene la firma correcta, ejecuta el script anti-bot
 * de Akamai al cargar smiles.com.ar (obtiene las cookies bm_sz/_abck) y los
 * fetch se hacen desde el contexto de la página, con origin y referer
 * legítimos — indistinguible del sitio real.
 */

const BOOTSTRAP_URL = process.env.SMILES_BOOTSTRAP_URL || 'https://www.smiles.com.ar/home';
const PAGE_MAX_USES = 400; // reciclar la página cada tantos requests

let puppeteer = null;
let launching = null; // promesa de {browser, page}
let uses = 0;

function browserAvailable() {
  try {
    puppeteer = puppeteer || require('puppeteer-core');
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable() {
  if (process.env.SMILES_CHROME_PATH) return process.env.SMILES_CHROME_PATH;
  try {
    const chromium = require('@sparticuz/chromium');
    const c = chromium.default || chromium;
    return await c.executablePath();
  } catch {
    /* probar rutas de sistema */
  }
  const fs = require('fs');
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch { /* siguiente */ }
  }
  throw new Error(
    'No se encontró Chrome/Chromium. Instalá Google Chrome o definí SMILES_CHROME_PATH en .env'
  );
}

async function launchArgs() {
  try {
    const chromium = require('@sparticuz/chromium');
    const c = chromium.default || chromium;
    return c.args;
  } catch {
    return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  }
}

async function getPage() {
  if (launching) {
    const ctx = await launching;
    if (!ctx.page.isClosed() && uses < PAGE_MAX_USES) return ctx.page;
    // reciclar
    await ctx.browser.close().catch(() => {});
    launching = null;
  }
  launching = (async () => {
    if (!browserAvailable()) throw new Error('puppeteer-core no está instalado (corré npm install)');
    const executablePath = await resolveExecutable();
    const browser = await puppeteer.launch({
      executablePath,
      args: [...(await launchArgs()), '--disable-blink-features=AutomationControlled'],
      headless: true,
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      (await browser.userAgent()).replace('HeadlessChrome', 'Chrome')
    );
    // Ahorrar memoria/ancho de banda sin afectar el sensor anti-bot
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    console.log('[browser] cargando', BOOTSTRAP_URL, 'para inicializar cookies…');
    await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Dar tiempo a que corra el script de Akamai y setee cookies
    await new Promise((r) => setTimeout(r, 4000));
    console.log('[browser] listo');
    uses = 0;
    return { browser, page };
  })();
  launching.catch(() => (launching = null));
  const ctx = await launching;
  return ctx.page;
}

/**
 * GET a `url` con `headers` desde el contexto de la página de Smiles.
 * @returns {Promise<{status: number, body: string}>}
 */
async function browserFetch(url, headers, { retryOnCrash = true } = {}) {
  const page = await getPage();
  uses++;
  try {
    return await page.evaluate(
      async (u, h) => {
        const res = await fetch(u, { headers: h, signal: AbortSignal.timeout(30000) });
        return { status: res.status, body: await res.text() };
      },
      url,
      headers
    );
  } catch (err) {
    // Página/browser muerto (OOM, crash): relanzar una vez
    if (retryOnCrash) {
      if (launching) {
        const ctx = await launching.catch(() => null);
        if (ctx) await ctx.browser.close().catch(() => {});
        launching = null;
      }
      return browserFetch(url, headers, { retryOnCrash: false });
    }
    throw err;
  }
}

async function closeBrowser() {
  if (launching) {
    const ctx = await launching.catch(() => null);
    if (ctx) await ctx.browser.close().catch(() => {});
    launching = null;
  }
}

module.exports = { browserFetch, browserAvailable, closeBrowser };
