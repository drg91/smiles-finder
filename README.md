# ✈️ Smiles Finder

Buscador de vuelos baratos con millas en **[smiles.com.ar](https://www.smiles.com.ar)**, estilo [Smiles Helper](https://smileshelper.com/), pero corriendo en tu máquina y con búsqueda masiva:

- **Un origen → varios destinos → varios meses (o fechas puntuales), todo en una sola búsqueda.** Busca día por día y te muestra todo ordenado de más barato a más caro.
- Precios **Club Smiles** y común, tasas de embarque a demanda, filtros por escalas / aerolínea / tope de millas, top 10 por destino o por mes.
- Link directo a la página de emisión de smiles.com.ar para cada vuelo.
- Progreso en vivo (una búsqueda de 3 destinos × 2 meses son ~180 consultas; las va mostrando a medida que llegan).

## Cómo se conecta a Smiles

No hace scraping ni necesita tu usuario. Usa la **API REST interna de Smiles** (`api-air-flightsearch-prd.smiles.com.br`) — la misma que llama la web oficial cuando buscás un vuelo — autenticada con la API key **pública** que Smiles embebe en el JavaScript de su frontend. Los precios que devuelve son exactamente los de la web.

Smiles protege esa API con **Akamai Bot Manager**, que rechaza (HTTP 406) los requests que no vienen de un navegador real y **no permite llamadas desde otras webs** (CORS). Por eso la app tiene dos motores de transporte y elige solo:

- **`http`** — `fetch` de Node, liviano. Funciona cuando el WAF no está estricto.
- **`browser`** — un **Chromium headless real** (puppeteer-core + `@sparticuz/chromium`) que carga smiles.com.ar, ejecuta el script anti-bot de Akamai, obtiene sus cookies y hace los requests desde el contexto de la página. Indistinguible del sitio real, pasa el WAF.

Con `SMILES_ENGINE=auto` (default) arranca en `http` y, si aparece un 406, **cambia solo a `browser`** para el resto de la sesión.

> Esto necesita un servidor (no corre en un sitio estático puro por el CORS de Akamai). Por eso la forma recomendada de tenerla online es **Render**.

## Usarla online: Render (gratis)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/drg91/smiles-finder)

1. Clic en el botón → **Sign in with GitHub** (cuenta gratis, sin tarjeta).
2. Render lee el `render.yaml` del repo y arma el servicio `smiles-finder` solo → **Apply / Deploy**.
3. En un par de minutos te da tu URL, tipo **`https://smiles-finder-xxxx.onrender.com`**. Esa es tu app.

Se **redespliega solo** con cada push a la rama. Un par de detalles del plan free:

- El servicio **se duerme tras 15 min sin uso**; la primera visita después tarda ~1 min en despertar.
- Tiene 512 MB de RAM. La app usa un solo Chromium compartido para todas las búsquedas, así que entra — pero si hacés búsquedas gigantes y ves reinicios, bajá `SMILES_CONCURRENCY` a `3`.

### ¿Y GitHub Pages?

En `docs/` queda una versión que corre 100% en el navegador, servible como sitio estático. **Pero Smiles bloquea las llamadas cross-origin (CORS)**, así que en la práctica no puede buscar — sirve solo de demo de la interfaz. Para buscar de verdad usá Render o local.

## Uso local

Requisito: [Node.js](https://nodejs.org) 18 o superior. Nada más (cero dependencias).

```bash
npm start
# → abre http://localhost:3000
```

1. Poné el **origen** (código IATA, ej: `EZE`, `AEP`, `COR`).
2. Poné uno o más **destinos** separados por coma (ej: `MAD, BCN, FCO`).
3. Tildá los **meses** que tengas libres (opcionalmente acotá el rango de días), y/o cargá **fechas puntuales**.
4. **Buscar vuelos**. Los resultados aparecen en vivo, ordenados por millas.

> ⚠️ Cuantas más combinaciones, más tarda: cada destino×día es una consulta a Smiles. Hay un límite de 800 combinaciones por búsqueda y una concurrencia moderada para no gatillar el rate limit de Smiles. Si ves muchos errores 429, bajá la concurrencia (ver abajo).

### Probar sin conexión (datos falsos)

```bash
npm run mock
```

Levanta la app con datos sintéticos para probar la interfaz.

## Configuración (opcional, archivo `.env`)

```ini
# Puerto del servidor (default 3000)
PORT=3000

# Consultas simultáneas contra Smiles (default 5). Bajar a 2-3 si hay muchos 429.
SMILES_CONCURRENCY=5

# API key de Smiles. Solo hace falta si la key embebida deja de funcionar.
# SMILES_API_KEY=xxxxxxxxxxxxxxxxxxxx

# Moneda y región (defaults: ARS / ARGENTINA)
# SMILES_CURRENCY=ARS
# SMILES_REGION=ARGENTINA
```

### Si la API key deja de funcionar

Smiles rota muy de vez en cuando la key pública de su frontend. Si las búsquedas fallan con 401/403:

1. La app **intenta renovarla sola** (escanea los bundles JS de smiles.com.ar). También podés forzarlo visitando `http://localhost:3000/api/status?refresh=1`.
2. Si no, sacala a mano: entrá a [smiles.com.ar](https://www.smiles.com.ar), buscá cualquier vuelo, abrí las DevTools del navegador (F12) → pestaña **Network** → filtrá por `airlines/search` → copiá el valor del header `x-api-key` del request → pegalo en `.env` como `SMILES_API_KEY=...`.

## Notas

- Herramienta **no oficial**, sin afiliación con Smiles/GOL. Verificá siempre precio y disponibilidad en smiles.com.ar antes de emitir.
- Las búsquedas son "solo ida". Para ida y vuelta, buscá cada tramo por separado (invertí origen/destino) — es lo mismo que hace Smiles al emitir.
- La columna **Tasas** se consulta a demanda (botón "ver") para no duplicar la cantidad de requests.
