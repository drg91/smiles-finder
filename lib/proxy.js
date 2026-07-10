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
 * Devuelve una función fetch que enruta por el proxy, usando el `fetch` del
 * paquete undici (su dispatcher no es compatible con el fetch global de Node,
 * por eso se usan ambos del mismo paquete). Devuelve null si no hay proxy.
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
    return (url, opts = {}) => undici.fetch(url, { ...opts, dispatcher: agent });
  } catch (err) {
    console.warn('[proxy] no se pudo inicializar el fetch con proxy:', err.message);
    return null;
  }
}

module.exports = { getProxy, getProxyFetch };
