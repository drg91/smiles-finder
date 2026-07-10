'use strict';

/**
 * Configuración de proxy (para saltear el bloqueo por IP de datacenter del
 * WAF de Smiles). Se define con la variable de entorno SMILES_PROXY:
 *
 *   SMILES_PROXY=http://usuario:clave@host:puerto
 *   SMILES_PROXY=http://host:puerto            (sin auth)
 *
 * Soporta http/https. (Para SOCKS habría que sumar una dependencia extra.)
 */

function getProxy() {
  const raw = (process.env.SMILES_PROXY || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      url: raw,
      protocol: u.protocol.replace(':', ''), // 'http' | 'https'
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      // host:port sin credenciales (para --proxy-server de Chromium)
      server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`,
    };
  } catch {
    console.warn(`[proxy] SMILES_PROXY inválido: "${raw}" — se ignora`);
    return null;
  }
}

/**
 * Devuelve una función tipo fetch que enruta por el proxy. Usa `undici.request`
 * (API de bajo nivel) en vez de `undici.fetch`: el spec de WHATWG fetch oculta
 * a propósito los errores de conexión reales detrás de un genérico "fetch
 * failed" / "Request was cancelled." — con `request()` se ve el motivo real
 * (ej: "Proxy response (407) !== 200 when HTTP Tunneling" si el proxy
 * rechaza la autenticación). Devuelve null si no hay proxy configurado.
 */
function getProxyFetch() {
  const proxy = getProxy();
  if (!proxy) return null;
  try {
    const undici = require('undici');
    const token = proxy.username
      ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
      : undefined;
    const agent = new undici.ProxyAgent(token ? { uri: proxy.server, token } : proxy.server);
    return async (url, opts = {}) => {
      const { statusCode, headers, body } = await undici.request(url, { ...opts, dispatcher: agent });
      return {
        status: statusCode,
        ok: statusCode >= 200 && statusCode < 300,
        headers: toHeaders(headers),
        text: () => body.text(),
      };
    };
  } catch (err) {
    console.warn('[proxy] no se pudo inicializar el fetch con proxy:', err.message);
    return null;
  }
}

/** Normaliza el objeto plano de headers de undici.request a un Headers real (con .entries()). */
function toHeaders(raw) {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw || {})) {
    if (Array.isArray(v)) v.forEach((val) => h.append(k, val));
    else if (v != null) h.append(k, v);
  }
  return h;
}

module.exports = { getProxy, getProxyFetch };
