// ============================================
// SERVICE B — Gateway API (Normalized + Enrichment)
// Port: 3002
// ============================================

require('dotenv').config(); // Load .env variables
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

// ── Config from .env ──────────────────────────────────────────
const SOURCE_API_URL    = process.env.SOURCE_API_URL    || 'http://localhost:3001';
const GEOAPIFY_API_KEY  = process.env.GEOAPIFY_API_KEY  || '';
const PORT              = process.env.PORT              || 3002;
const SERVICE_TIME_MIN  = parseInt(process.env.SERVICE_TIME_MIN) || 60;

// ── In-memory stores ──────────────────────────────────────────
let normalizedOrders = {}; // key: shipmentid, value: array of all versions
let usdCopCache      = null; // cached exchange rate

// =============================================================
// HELPER: Parse weight string → number in lbs
// "10000lbs" → 10000 | "500 lbs" → 500 | "200" → 200
// =============================================================
function parseWeight(raw) {
  if (!raw) return null;
  const match = String(raw).match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

// =============================================================
// HELPER: Parse pieces → number or null
// "10" → 10 | "five" → null | "N/A" → null
// =============================================================
function parsePieces(raw) {
  if (!raw) return null;
  const num = parseFloat(raw);
  return isNaN(num) ? null : num;
}

// =============================================================
// HELPER: Parse container string → { letters, numbers }
// "CONT-A123" → { letters: "CONT-A", numbers: "123" }
// =============================================================
function parseContainer(raw) {
  if (!raw) return { letters: null, numbers: null };
  const letters = raw.replace(/[0-9]/g, '').replace(/-$/, '');
  const numbers = raw.replace(/[^0-9]/g, '');
  return { letters: letters || null, numbers: numbers || null };
}

// =============================================================
// HELPER: Get USD→COP rate (with cache)
// =============================================================
async function getUsdCopRate() {
  if (usdCopCache) return usdCopCache; // return cached value if exists

  const response = await axios.get('https://open.er-api.com/v6/latest/USD');
  usdCopCache = {
    rate: response.data.rates.COP,
    provider: 'open.er-api.com',
    updated_at: new Date().toISOString()
  };
  return usdCopCache;
}

// =============================================================
// HELPER: Normalize a raw order into a NormalizedOrder
// =============================================================
function normalizeOrder(raw) {
  const rateUsd  = parseFloat(raw.rate)          || 0;
  const fuelUsd  = parseFloat(raw.fuelsurcharge)  || 0;
  const extraUsd = parseFloat(raw.additional_charge_1) || 0;
  const totalUsd = rateUsd + fuelUsd + extraUsd;

  // Build ramp_filters array (combine rampfilter1 and rampfilter2)
  const rampFilters = [];
  if (raw.rampfilter1) rampFilters.push(raw.rampfilter1);
  if (raw.rampfilter2) rampFilters.push(raw.rampfilter2);

  // Build additional_charges array
  const additionalCharges = [];
  if (raw.additional_charge_1) additionalCharges.push(parseFloat(raw.additional_charge_1));

  // Calculate processing seconds
  let processingSecs = null;
  if (raw.hour_init && raw.hour_end) {
    const init = new Date(raw.hour_init);
    const end  = new Date(raw.hour_end);
    processingSecs = Math.round((end - init) / 1000);
  }

  return {
    shipment_id:   raw.shipmentid,
    order_type:    raw.order_type    || null,
    customer_code: raw.customer_code || null,
    container:     parseContainer(raw.container),
    driver_id:     raw.driver_id     || null,

    stops: [
      { stop: 1, address: raw.stop1_address || null, lat: null, lon: null },
      { stop: 2, address: raw.stop2_address || null, lat: null, lon: null }
    ],

    schedule: {
      pickup_date:   raw.date1 || null,
      pickup_time:   raw.time1 || null,
      delivery_date: raw.date2 || null,
      delivery_time: raw.time2 || null
    },

    cargo: {
      pieces_raw:   raw.pieces || null,
      pieces_count: parsePieces(raw.pieces),
      weight_raw:   raw.weight || null,
      weight_lbs:   parseWeight(raw.weight)
    },

    financials: {
      rate_usd:              rateUsd,
      fuelsurcharge_usd:     fuelUsd,
      additional_charges_usd: additionalCharges,
      total_usd:             totalUsd,
      rate_cop:              null, // filled after pricing refresh
      fuelsurcharge_cop:     null,
      total_cop:             null,
      pricing:               null
    },

    ramp_filters: rampFilters,

    processing: {
      hour_init:          raw.hour_init   || null,
      hour_end:           raw.hour_end    || null,
      processing_seconds: processingSecs
    },

    routing: null // filled after routing refresh
  };
}

// =============================================================
// HELPER: Geocode an address using Geoapify
// Returns { lat, lon } or null
// =============================================================
const geocodeCache = {}; // cache by address string

async function geocodeAddress(address) {
  if (!address) return null;
  if (geocodeCache[address]) return geocodeCache[address]; // use cache

  try {
    const url = `https://api.geoapify.com/v1/geocode/search`;
    const response = await axios.get(url, {
      params: { text: address, apiKey: GEOAPIFY_API_KEY, limit: 1 }
    });

    const features = response.data.features;
    if (!features || features.length === 0) return null;

    const [lon, lat] = features[0].geometry.coordinates;
    const result = { lat, lon };
    geocodeCache[address] = result; // save to cache
    return result;

  } catch (err) {
    console.error(`Geocoding failed for "${address}":`, err.message);
    return null;
  }
}

// =============================================================
// HELPER: Get route from OSRM
// Returns { distance_km, duration_min } or null
// =============================================================
async function getRoute(coord1, coord2) {
  if (!coord1 || !coord2) return null;

  try {
    const coords = `${coord1.lon},${coord1.lat};${coord2.lon},${coord2.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}`;
    const response = await axios.get(url, { params: { overview: 'false' } });

    const route = response.data.routes[0];
    if (!route) return null;

    return {
      distance_km:  Math.round(route.distance / 1000 * 100) / 100,
      duration_min: Math.round(route.duration / 60 * 100) / 100
    };
  } catch (err) {
    console.error('Routing failed:', err.message);
    return null;
  }
}

// =============================================================
// HELPER: Calculate SLA feasibility
// =============================================================
function calcFeasibility(order, route) {
  const { pickup_date, pickup_time, delivery_date, delivery_time } = order.schedule;

  // If any schedule data is missing → not feasible to calculate
  if (!pickup_date || !pickup_time || !delivery_date || !delivery_time) {
    return { feasible: null, reason: 'insufficient_schedule_data' };
  }

  if (!route) {
    return { feasible: null, reason: 'routing_data_unavailable' };
  }

  const pickupAt     = new Date(`${pickup_date}T${pickup_time}:00`);
  const deliveryDue  = new Date(`${delivery_date}T${delivery_time}:00`);
  const availableMin = (deliveryDue - pickupAt) / 60000;
  const travelMin    = route.duration_min;
  const feasible     = (travelMin + SERVICE_TIME_MIN) <= availableMin;

  return {
    distance_km:      route.distance_km,
    duration_min:     route.duration_min,
    available_min:    availableMin,
    service_time_min: SERVICE_TIME_MIN,
    feasible,
    reason: feasible ? 'on_time' : 'insufficient_time'
  };
}

// =============================================================
// HELPER: Get the "current" version of a shipment
// Rule: the record with the latest hour_end
// =============================================================
function getCurrent(versions) {
  return versions.reduce((best, curr) => {
    if (!best) return curr;
    const bestTime = new Date(best.processing.hour_end  || 0);
    const currTime = new Date(curr.processing.hour_end  || 0);
    return currTime > bestTime ? curr : best;
  }, null);
}

// =============================================================
// ENDPOINT 1: POST /orders/sync
// Fetches raw orders from Source API and normalizes them
// =============================================================
app.post('/orders/sync', async (req, res) => {
  try {
    const response = await axios.get(`${SOURCE_API_URL}/raw/orders`, {
      params: { limit: 1000 }
    });

    const rawOrders = response.data.data;
    normalizedOrders = {}; // reset

    for (const raw of rawOrders) {
      const normalized = normalizeOrder(raw);
      const id = normalized.shipment_id;

      if (!normalizedOrders[id]) normalizedOrders[id] = [];
      normalizedOrders[id].push(normalized);
    }

    const totalShipments = Object.keys(normalizedOrders).length;
    const totalRecords   = rawOrders.length;
    const duplicates     = totalRecords - totalShipments;

    res.json({
      message: '✅ Sync complete',
      total_records:   totalRecords,
      total_shipments: totalShipments,
      duplicates_found: duplicates
    });

  } catch (err) {
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

// =============================================================
// ENDPOINT 2: GET /orders
// Returns current version of all orders with filters
// =============================================================
app.get('/orders', (req, res) => {
  const { customer_code, order_type, ramp_filter, date_from, date_to, limit, offset } = req.query;

  let results = Object.values(normalizedOrders).map(getCurrent).filter(Boolean);

  if (customer_code) results = results.filter(o => o.customer_code === customer_code);
  if (order_type)    results = results.filter(o => o.order_type    === order_type);
  if (ramp_filter)   results = results.filter(o => o.ramp_filters.includes(ramp_filter));
  if (date_from)     results = results.filter(o => o.schedule.pickup_date >= date_from);
  if (date_to)       results = results.filter(o => o.schedule.pickup_date <= date_to);

  const offsetNum = parseInt(offset) || 0;
  const limitNum  = parseInt(limit)  || 100;
  const paginated = results.slice(offsetNum, offsetNum + limitNum);

  res.json({ total: results.length, offset: offsetNum, limit: limitNum, data: paginated });
});

// =============================================================
// ENDPOINT 3: GET /orders/:shipmentid
// Returns only the CURRENT version
// =============================================================
app.get('/orders/:shipmentid', (req, res) => {
  const versions = normalizedOrders[req.params.shipmentid];
  if (!versions) return res.status(404).json({ error: 'Shipment not found' });
  res.json(getCurrent(versions));
});

// =============================================================
// ENDPOINT 4: GET /orders/:shipmentid/history
// Returns ALL versions (for audit)
// =============================================================
app.get('/orders/:shipmentid/history', (req, res) => {
  const versions = normalizedOrders[req.params.shipmentid];
  if (!versions) return res.status(404).json({ error: 'Shipment not found' });
  res.json({ shipmentid: req.params.shipmentid, total_versions: versions.length, data: versions });
});

// =============================================================
// ENDPOINT 5: GET /market/usd-cop
// Returns cached USD→COP rate
// =============================================================
app.get('/market/usd-cop', async (req, res) => {
  try {
    const rate = await getUsdCopRate();
    res.json(rate);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rate', details: err.message });
  }
});

// =============================================================
// ENDPOINT 6: POST /orders/refresh-pricing
// Recalculates COP values for all normalized orders
// =============================================================
app.post('/orders/refresh-pricing', async (req, res) => {
  try {
    usdCopCache = null; // force fresh rate
    const pricing = await getUsdCopRate();

    let updated = 0;
    for (const versions of Object.values(normalizedOrders)) {
      for (const order of versions) {
        const f = order.financials;
        f.rate_cop          = Math.round(f.rate_usd          * pricing.rate * 100) / 100;
        f.fuelsurcharge_cop = Math.round(f.fuelsurcharge_usd * pricing.rate * 100) / 100;
        f.total_cop         = Math.round(f.total_usd         * pricing.rate * 100) / 100;
        f.pricing = { usd_cop_rate: pricing.rate, provider: pricing.provider, updated_at: pricing.updated_at };
        updated++;
      }
    }

    res.json({ message: '✅ Pricing refreshed', usd_cop_rate: pricing.rate, orders_updated: updated });
  } catch (err) {
    res.status(500).json({ error: 'Pricing refresh failed', details: err.message });
  }
});

// =============================================================
// ENDPOINT 7: POST /orders/refresh-routing
// Geocodes + routes all orders (or a batch)
// =============================================================
app.post('/orders/refresh-routing', async (req, res) => {
  const { shipmentid, limit, offset } = req.query;

  let targets = [];

  if (shipmentid) {
    const versions = normalizedOrders[shipmentid];
    if (!versions) return res.status(404).json({ error: 'Shipment not found' });
    targets = versions;
  } else {
    const all = Object.values(normalizedOrders).flat();
    const off = parseInt(offset) || 0;
    const lim = parseInt(limit)  || 10;
    targets = all.slice(off, off + lim);
  }

  let processed = 0;
  for (const order of targets) {
    try {
      // Geocode stop 1
      if (!order.stops[0].lat) {
        const coords = await geocodeAddress(order.stops[0].address);
        if (coords) { order.stops[0].lat = coords.lat; order.stops[0].lon = coords.lon; }
      }
      // Geocode stop 2
      if (!order.stops[1].lat) {
        const coords = await geocodeAddress(order.stops[1].address);
        if (coords) { order.stops[1].lat = coords.lat; order.stops[1].lon = coords.lon; }
      }

      console.log(`[${order.shipment_id}] Stop1: ${order.stops[0].lat},${order.stops[0].lon} | Stop2: ${order.stops[1].lat},${order.stops[1].lon}`);

      const coord1 = order.stops[0].lat ? { lat: order.stops[0].lat, lon: order.stops[0].lon } : null;
      const coord2 = order.stops[1].lat ? { lat: order.stops[1].lat, lon: order.stops[1].lon } : null;
      const route  = await getRoute(coord1, coord2);

      console.log(`[${order.shipment_id}] Route:`, route);

      order.routing = route ? { ...route, ...calcFeasibility(order, route) } : { error: 'Could not calculate route' };
      processed++;
    } catch (err) {
      console.error(`Error on ${order.shipment_id}:`, err.message);
    }
  }

  res.json({ message: '✅ Routing refreshed', orders_processed: processed });
});

// =============================================================
// ENDPOINT 8: GET /orders/:shipmentid/route
// Returns distance/time for a shipment
// =============================================================
app.get('/orders/:shipmentid/route', (req, res) => {
  const versions = normalizedOrders[req.params.shipmentid];
  if (!versions) return res.status(404).json({ error: 'Shipment not found' });
  const current = getCurrent(versions);
  if (!current.routing) return res.status(404).json({ error: 'No routing data. Run POST /orders/refresh-routing first.' });
  res.json({ shipmentid: req.params.shipmentid, routing: current.routing });
});

// =============================================================
// ENDPOINT 9: GET /orders/:shipmentid/feasibility
// Returns SLA feasibility
// =============================================================
app.get('/orders/:shipmentid/feasibility', (req, res) => {
  const versions = normalizedOrders[req.params.shipmentid];
  if (!versions) return res.status(404).json({ error: 'Shipment not found' });
  const current = getCurrent(versions);
  if (!current.routing) return res.status(404).json({ error: 'No routing data. Run POST /orders/refresh-routing first.' });
  res.json({ shipmentid: req.params.shipmentid, feasibility: current.routing });
});

// =============================================================
// START SERVER
// =============================================================
app.listen(PORT, () => {
  console.log(`🚀 Gateway API running on http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/orders/sync`);
  console.log(`   GET  http://localhost:${PORT}/orders`);
  console.log(`   GET  http://localhost:${PORT}/market/usd-cop`);
});
