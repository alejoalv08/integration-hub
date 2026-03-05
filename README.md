# Integration Hub — Customer Integration Specialist Technical Test

A two-service Node.js Integration Hub that consumes raw logistics orders, normalizes them, enriches them with live exchange rates, geocoding, and routing data, and determines delivery feasibility.

---

## Architecture

```
[Listado Ordenes.json]
        ↓
┌─────────────────────┐
│  Service A          │  Port 3001
│  Source API         │  Serves raw order data
└─────────────────────┘
        ↓
┌─────────────────────┐     → Exchange Rate API (open.er-api.com)
│  Service B          │     → Geocoding API     (geoapify.com)
│  Gateway API        │     → Routing API       (project-osrm.org)
│  Normalized +       │
│  Enriched Data      │  Port 3002
└─────────────────────┘
        ↓
   Postman / Browser
```

---

## Project Structure

```
integration-hub/
├── source-api/
│   ├── index.js          ← Service A (Raw Orders API)
│   ├── package.json
│   └── node_modules/
├── gateway-api/
│   ├── index.js          ← Service B (Gateway API)
│   ├── .env              ← Environment variables (not committed)
│   ├── package.json
│   └── node_modules/
├── data/
│   └── Listado Ordenes.json
├── docs/
│   └── DATA_QUALITY.md
├── postman/
│   └── collection.json
└── README.md
```

---

## Setup (≤ 10 minutes)

### Prerequisites
- Node.js v18+ ([nodejs.org](https://nodejs.org))
- A free Geoapify API key ([geoapify.com](https://geoapify.com)) — no credit card required

### 1. Clone or download the project

```bash
cd C:\Users\<your-username>
# Place the integration-hub folder here
```

### 2. Install dependencies for Service A

```bash
cd integration-hub/source-api
npm install
```

### 3. Install dependencies for Service B

```bash
cd ../gateway-api
npm install
```

### 4. Configure environment variables

Create a `.env` file inside `gateway-api/`:

```bash
# gateway-api/.env
SOURCE_API_URL=http://localhost:3001
GEOAPIFY_API_KEY=your_geoapify_key_here
PORT=3002
SERVICE_TIME_MIN=60
```

> ⚠️ Make sure there are no spaces around the `=` sign and no quotes around values.

### 5. Run both services (in separate terminals)

**Terminal 1 — Source API:**
```bash
cd integration-hub/source-api
node index.js
# 🚀 Source API running on http://localhost:3001
```

**Terminal 2 — Gateway API:**
```bash
cd integration-hub/gateway-api
node index.js
# 🚀 Gateway API running on http://localhost:3002
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SOURCE_API_URL` | URL of the Source API | `http://localhost:3001` |
| `GEOAPIFY_API_KEY` | Geoapify free tier API key | — |
| `PORT` | Gateway API port | `3002` |
| `SERVICE_TIME_MIN` | Service time buffer in minutes (pickup + delivery) | `60` |

---

## API Reference

### Service A — Source API (Port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/raw/orders` | List all raw orders. Filters: `customer_code`, `order_type`, `shipmentid`, `limit`, `offset` |
| GET | `/raw/orders/:shipmentid` | Get all occurrences of a shipment (including duplicates) |
| POST | `/raw/simulate-refresh` | Simulate pricing update from source using live USD→COP rate |

### Service B — Gateway API (Port 3002)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/orders/sync` | Fetch from Source API and normalize all orders |
| GET | `/orders` | List normalized orders. Filters: `customer_code`, `order_type`, `ramp_filter`, `date_from`, `date_to`, `limit`, `offset` |
| GET | `/orders/:shipmentid` | Get current version of a shipment |
| GET | `/orders/:shipmentid/history` | Get all versions of a shipment (audit trail) |
| GET | `/market/usd-cop` | Get cached USD→COP exchange rate |
| POST | `/orders/refresh-pricing` | Recalculate COP values using live exchange rate |
| POST | `/orders/refresh-routing` | Geocode addresses + calculate routes + SLA. Params: `shipmentid`, `limit`, `offset` |
| GET | `/orders/:shipmentid/route` | Get distance/time for a shipment |
| GET | `/orders/:shipmentid/feasibility` | Get SLA feasibility for a shipment |

---

## Usage Examples

### Full workflow (recommended order):

```bash
# 1. Sync orders from Source API
POST http://localhost:3002/orders/sync

# 2. Refresh pricing (USD → COP)
POST http://localhost:3002/orders/refresh-pricing

# 3. Calculate routing for a specific shipment
POST http://localhost:3002/orders/refresh-routing?shipmentid=SHP-001

# 4. View results
GET http://localhost:3002/orders/SHP-001
GET http://localhost:3002/orders/SHP-001/route
GET http://localhost:3002/orders/SHP-001/feasibility
```

### Filtering orders:

```bash
# Filter by customer
GET http://localhost:3002/orders?customer_code=CUST-A

# Filter by order type
GET http://localhost:3002/orders?order_type=FTL

# Filter by date range
GET http://localhost:3002/orders?date_from=2025-06-01&date_to=2025-06-05

# Filter by ramp
GET http://localhost:3002/orders?ramp_filter=RAMP-WEST

# Pagination
GET http://localhost:3002/orders?limit=5&offset=0
```

---

## Key Design Decisions

### Duplicate Handling
The dataset contains repeated `shipmentid` values. The **current** version is determined by the record with the **latest `hour_end`** timestamp. `GET /orders/:shipmentid` returns only the current version, while `GET /orders/:shipmentid/history` returns all versions for audit purposes.

### Pricing
Exchange rates are fetched from `open.er-api.com` (no API key required) and cached in memory. COP values are calculated as:
- `rate_cop = round(rate_usd × usd_cop, 2)`
- `fuelsurcharge_cop = round(fuelsurcharge_usd × usd_cop, 2)`
- `total_usd = rate_usd + fuelsurcharge_usd + sum(additional_charges_usd)`
- `total_cop = round(total_usd × usd_cop, 2)`

### SLA Feasibility
```
available_min = delivery_due - pickup_at (in minutes)
feasible = (travel_min + service_time_min) <= available_min
```
If schedule data is missing, `feasible` returns `null` with reason `insufficient_schedule_data`.

### Geocoding Cache
Address → coordinates results are cached in memory to avoid redundant API calls and respect Geoapify's rate limits (3,000 credits/day).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `injecting env (0)` | Check `.env` file has no spaces around `=` signs |
| `Geocoding failed 401` | Invalid or missing `GEOAPIFY_API_KEY` in `.env` |
| `Cannot find module` | Run `npm install` inside the correct folder |
| `EADDRINUSE: port already in use` | Another process is using port 3001 or 3002. Kill it or change the port in `.env` |
| `Shipment not found` | Run `POST /orders/sync` first before querying the Gateway |
| No routing data | Run `POST /orders/refresh-routing` before accessing `/route` or `/feasibility` |

---

## External APIs Used

| API | Purpose | Auth |
|-----|---------|------|
| [open.er-api.com](https://open.er-api.com/v6/latest/USD) | USD→COP exchange rate | None required |
| [Geoapify](https://geoapify.com) | Address → GPS coordinates | Free API key |
| [OSRM](https://router.project-osrm.org) | Road distance & duration | None required |

---

## Bonus Features Implemented
- ✅ Geocoding cache (avoids redundant API calls)
- ✅ In-memory pricing cache
- ✅ Detailed error messages and HTTP status codes
- ✅ Duplicate detection and audit history
- ✅ Configurable service time via environment variable
