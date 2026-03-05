// ============================================
// SERVICE A — Source API (Raw Orders)
// Port: 3001
// ============================================

// 1. Import libraries
const express = require('express');
const fs = require('fs');
const path = require('path');

// 2. Create the Express app
const app = express();
app.use(express.json()); // This lets us read JSON in request bodies

// 3. Load the JSON data file into memory when the server starts
//    We go up one folder (../) then into data/
const DATA_FILE = path.join(__dirname, '..', 'data', 'Listado Ordenes.json');

let ordersData = [];

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    ordersData = JSON.parse(raw);
    console.log(`✅ Loaded ${ordersData.length} orders from file`);
  } catch (err) {
    console.error('❌ Error loading data file:', err.message);
  }
}

// Load data immediately when server starts
loadData();

// ============================================
// ENDPOINT 1: GET /raw/orders
// Returns all orders with optional filters
// ============================================
app.get('/raw/orders', (req, res) => {
  // Read query parameters from the URL
  // Example: /raw/orders?customer_code=CUST-A&limit=5
  const { customer_code, order_type, shipmentid, limit, offset } = req.query;

  // Start with all orders
  let results = [...ordersData];

  // Apply filters if provided
  if (customer_code) {
    results = results.filter(o => o.customer_code === customer_code);
  }
  if (order_type) {
    results = results.filter(o => o.order_type === order_type);
  }
  if (shipmentid) {
    results = results.filter(o => o.shipmentid === shipmentid);
  }

  // Apply pagination
  const offsetNum = parseInt(offset) || 0;  // default: start from 0
  const limitNum  = parseInt(limit)  || 100; // default: return up to 100

  const paginated = results.slice(offsetNum, offsetNum + limitNum);

  // Send response
  res.json({
    total: results.length,
    offset: offsetNum,
    limit: limitNum,
    data: paginated
  });
});

// ============================================
// ENDPOINT 2: GET /raw/orders/:shipmentid
// Returns ALL occurrences of a shipment (including duplicates)
// ============================================
app.get('/raw/orders/:shipmentid', (req, res) => {
  const { shipmentid } = req.params;

  const results = ordersData.filter(o => o.shipmentid === shipmentid);

  if (results.length === 0) {
    return res.status(404).json({ error: `Shipment ${shipmentid} not found` });
  }

  res.json({
    shipmentid,
    count: results.length,
    data: results
  });
});

// ============================================
// ENDPOINT 3: POST /raw/simulate-refresh
// Simulates a pricing update from the "source system"
// Fetches live USD→COP rate and updates all orders in memory
// ============================================
app.post('/raw/simulate-refresh', async (req, res) => {
  try {
    // Fetch the live exchange rate (no API key needed!)
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    const rateData = await response.json();

    const usdCopRate = rateData.rates.COP;
    const updatedAt = new Date().toISOString();

    // Update each order in memory with COP values
    ordersData = ordersData.map(order => {
      const rateUsd = parseFloat(order.rate) || 0;
      const fuelUsd = parseFloat(order.fuelsurcharge) || 0;
      const extraUsd = parseFloat(order.additional_charge_1) || 0;
      const totalUsd = rateUsd + fuelUsd + extraUsd;

      return {
        ...order, // keep all existing fields
        rate_cop: Math.round(rateUsd * usdCopRate * 100) / 100,
        fuelsurcharge_cop: Math.round(fuelUsd * usdCopRate * 100) / 100,
        total_usd: totalUsd,
        total_cop: Math.round(totalUsd * usdCopRate * 100) / 100,
        pricing_meta: {
          usd_cop_rate: usdCopRate,
          provider: 'open.er-api.com',
          updated_at: updatedAt
        }
      };
    });

    res.json({
      message: '✅ Pricing refresh simulated successfully',
      usd_cop_rate: usdCopRate,
      updated_at: updatedAt,
      orders_updated: ordersData.length
    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to refresh pricing', details: err.message });
  }
});

// ============================================
// START THE SERVER
// ============================================
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Source API running on http://localhost:${PORT}`);
  console.log(`   GET  http://localhost:${PORT}/raw/orders`);
  console.log(`   GET  http://localhost:${PORT}/raw/orders/:shipmentid`);
  console.log(`   POST http://localhost:${PORT}/raw/simulate-refresh`);
});
