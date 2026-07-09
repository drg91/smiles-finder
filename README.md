# ✈️ Smiles Finder

Buscador de vuelos baratos con millas en **[smiles.com.ar](https://www.smiles.com.ar)**, estilo [Smiles Helper](https://smileshelper.com/), pero corriendo en tu máquina y con búsqueda masiva:

- **Un origen → varios destinos → varios meses (o fechas puntuales), todo en una sola búsqueda.** Busca día por día y te muestra todo ordenado de más barato a más caro.
- Precios **Club Smiles** y común, tasas de embarque a demanda, filtros por escalas / aerolínea / tope de millas, top 10 por destino o por mes.
- Link directo a la página de emisión de smiles.com.ar para cada vuelo.
- Progreso en vivo (una búsqueda de 3 destinos × 2 meses son ~180 consultas; las va mostrando a medida que llegan).

## Cómo se conecta a Smiles

No hace scraping ni necesita tu usuario. Usa la **API REST interna de Smiles** (`api-air-flightsearch-prd.smiles.com.br`) — la misma que llama la web oficial cuando buscás un vuelo — autenticada con la API key **pública** que Smiles embebe en el JavaScript de su frontend. Es el mismo mecanismo que usan Smiles Helper y todos los buscadores de la comunidad. Los precios que devuelve son exactamente los de la web.

## Usarla online (sin instalar nada)

### Opción A: GitHub Pages (recomendada, gratis y siempre encendida)

La app también funciona **100% en el navegador** (el JS llama directo a la API de Smiles), así que se puede servir como sitio estático. Ya está todo configurado; solo hace falta:

1. Hacer el repo **público**: Settings → General → Danger Zone → *Change visibility* (GitHub Pages gratis requiere repo público).
2. Correr el workflow "Deploy a GitHub Pages": pestaña **Actions** → *Deploy a GitHub Pages* → *Run workflow* (o pushear cualquier cambio). El workflow habilita Pages solo.
3. Listo: la app queda en **https://drg91.github.io/smiles-finder/**

### Opción B: Render (con servidor, gratis)

Si preferís que las consultas salgan de un servidor (evita cualquier tema de CORS y habilita la auto-renovación de API key):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/drg91/smiles-finder)

Creás la cuenta gratis con tu GitHub y un click. Ojo: el plan free "duerme" el servicio tras 15 min sin uso (el primer request luego tarda ~1 min en despertar).

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
