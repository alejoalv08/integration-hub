# Data Quality Report — Listado Ordenes.json

## 1. Dataset Overview

| Metric | Value |
|--------|-------|
| Total records | 10 |
| Unique shipment IDs | 8 |
| Duplicate records | 2 |

---

## 2. Duplicate Shipment IDs

| Shipment ID | Occurrences | Selected as Current (rule: latest hour_end) |
|-------------|-------------|---------------------------------------------|
| SHP-001 | 2 | Record with `hour_end: 2025-06-01T09:00:00Z` |
| SHP-005 | 2 | Record with `hour_end: 2025-06-05T06:20:00Z` |

**Rule applied:** The record with the latest `hour_end` timestamp is treated as the current version. All versions are preserved in history for audit purposes.

---

## 3. Missing Fields Analysis

| Field | Missing Count | % Missing | Affected Shipments |
|-------|--------------|-----------|--------------------|
| `date1` (pickup_date) | 1 | 10% | SHP-004 |
| `time1` (pickup_time) | 1 | 10% | SHP-004 |
| `date2` (delivery_date) | 1 | 10% | SHP-004 |
| `time2` (delivery_time) | 1 | 10% | SHP-004 |
| `driver_id` | 1 | 10% | SHP-003 |
| `additional_charge_1` | 5 | 50% | SHP-002, SHP-004, SHP-006, SHP-008 |
| `rampfilter1` | 1 | 10% | SHP-004 |
| `rampfilter2` | 6 | 60% | SHP-002, SHP-003, SHP-004, SHP-006, SHP-008 |

**Impact:**
- SHP-004 has no schedule data → `feasible: null` with reason `insufficient_schedule_data`
- SHP-003 has no driver assigned → `driver_id: null` in normalized output
- Missing `additional_charge_1` → treated as `0` in total calculations

---

## 4. Dirty Data

### 4a. Weights with Units

All weight values in the dataset include the unit suffix `lbs`:

| Shipment ID | Raw Value | Parsed Value |
|-------------|-----------|--------------|
| SHP-001 | `"10000lbs"` | `10000` |
| SHP-002 | `"500lbs"` | `500` |
| SHP-003 | `"20000lbs"` | `20000` |
| SHP-004 | `"8000lbs"` | `8000` |
| SHP-005 | `"15000lbs"` | `15000` |
| SHP-006 | `"3000lbs"` | `3000` |
| SHP-007 | `"30000lbs"` | `30000` |
| SHP-008 | `"12000lbs"` | `12000` |

**Rule applied:** Extract numeric part using regex `/([\d.]+)/` → stored as `weight_lbs`.

### 4b. Non-numeric Pieces

| Shipment ID | Raw Value | Parsed Value | Reason |
|-------------|-----------|--------------|--------|
| SHP-002 | `"five"` | `null` | Text word, not a number |
| SHP-006 | `"N/A"` | `null` | Not applicable marker |

**Rule applied:** `parseFloat()` is used. If result is `NaN`, `pieces_count` is set to `null`. Raw value is always preserved in `pieces_raw`.

---

## 5. Normalization Rules & Decisions

### Container Parsing
Raw value like `"CONT-A123"` is split into:
- `letters`: `"CONT-A"` (all non-numeric characters)
- `numbers`: `"123"` (all numeric characters)

### Ramp Filters
`rampfilter1` and `rampfilter2` are unified into a single `ramp_filters[]` array. Null values are excluded.

### Financial Calculations
- `total_usd = rate_usd + fuelsurcharge_usd + sum(additional_charges_usd)`
- All string values parsed with `parseFloat()`, defaulting to `0` if null/invalid
- COP values calculated using live USD→COP rate from `open.er-api.com`

### Processing Time
`processing_seconds = (hour_end - hour_init)` in seconds. Null if either timestamp is missing.

### Duplicate Resolution
- Strategy: **latest `hour_end` wins** (most recently processed record is current)
- All versions stored in memory for full audit trail
- `GET /orders/:shipmentid` → current only
- `GET /orders/:shipmentid/history` → all versions

### SLA Feasibility
- `available_min = (delivery_due - pickup_at)` in minutes
- `feasible = (travel_min + service_time_min) <= available_min`
- `service_time_min = 60` (configurable via `SERVICE_TIME_MIN` env variable)
- Returns `null` if any schedule field is missing
