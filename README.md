# Shortlist — Roofing (MVP)

Shortlist is a prospecting engine with pluggable verticals; roofing is the first. The shared engine lives in `server/src/core` + `server/src/adapters`; roofing-specific logic in `server/src/verticals/roofing`.

A market-configured prospecting system: press **Find Opportunities** and it pulls storm reports and permit/property history, cross-references them deterministically, and ranks the properties most worth prospecting. Every result explains *why* it surfaced.

> Prospect ≠ inbound lead · Storm exposure ≠ confirmed roof damage · Likely opportunity ≠ confirmed need.

## Quick start

```bash
# API
cd server && cp .env.example .env && npm install && npm run dev      # :8787
# UI
cd web && npm install && npm run dev                                  # :5173 (proxies /api)
```

Copy `server/.env.example` to `server/.env` (it sets the local keys `demo` and `sample`), then open `http://localhost:5173/?key=demo`, choose a service area, keep **Demo data**, then press **Find Opportunities**. The `sample` key shows the free-sample experience: at most 5 results and no export.

```bash
cd server
npm test               # unit tests: geo, weather mapping/severity, permit mapping, roof-age basis rules
npm run smoke          # prints ranked demo tables for every service area
npm run smoke -- demo live   # same, using live adapters
```

## Scope of this build

Included: property/permit ingestion, weather exposure, cross-signal scoring, ranked results, demo mode, CSV export, per-customer config, and a basic run log.

Deferred until lead quality is validated: Claude explanations/outreach, Perplexity, usage limits/cost controls, maps, auth, billing, and persisted run history. The contracts for these are noted in `core/vertical.ts` and `core/sources.ts`.

## Markets

| Market | Status | Permit coverage | Roof-age trust |
|---|---|---|---|
| **Bend, OR** | First live validation market | **full**: residential reroofs require permits | Reroof permit or new-construction permit counts as a confident roof age |
| Portland, OR | Supported, lower confidence | **partial**: most residential reroofs need no permit | Only an actual reroof permit counts as confident. A new-construction permit or year built is capped (≤0.5), low-confidence, and never fires the "aging roof" signal or cross-signal bonuses |

Year built **alone** is never a confident roof age in any market (`roofAgeBasis` in `verticals/roofing/defaults.ts`).

### Bend: getting live data (about 30 minutes)

1. **Weather** works out of the box. It uses NWS Pendleton (PDT) Local Storm Reports through the IEM GeoJSON API. No key needed.
2. **Permits (fastest route: CSV).** On data.bendoregon.gov, open *Permit Applications Point* (or *Permitting Table*), download it as CSV, and save it as `server/data/imports/bend-or/permits.csv`. Columns are matched case-insensitively with common aliases (see `templates/permits.template.csv`). The file needs coordinates (`lat/lon`, `latitude/longitude` or `x/y`), an issued date, and type/description text.
3. **Permits (automated route: ArcGIS).** On the same dataset, click *I want to use this → API*, copy the FeatureServer layer URL into `config/markets/bend-or.json → settings.arcgisPermits.url`, fix the `fields` mapping to match the real column names, and set `sources.permit` to `"arcgis"`.
4. **Optional:** a Deschutes County assessor/taxlot CSV at `data/imports/bend-or/properties.csv` adds year built and property type, joined by parcel or address.
5. Run `npm run smoke -- demo live`. Then **check that reroof permits are being classified correctly**: `permitKeywords` in `defaults.ts` matches on type + description text. Adjust it to Bend's actual work-class wording.

### Portland

This needs `PORTLANDMAPS_API_KEY` (free; email maps@portlandoregon.gov with the subject "PortlandMaps API Key Request"). It uses the Assessor API for properties (year built, lat/lon) and the Permit API for per-property permit lookups, limited to the top 60 candidates per run. The response shapes are parsed defensively, so check the field names on the first call.

## How scoring works (all configurable)

```
score = weighted average of signals (0–100)
      + cross-signal bonuses
      × data-confidence adjustment        → tier (Very High ≥80, High ≥65, Medium ≥45)
```

| Signal | Source | Notes |
|---|---|---|
| roof_age | Reroof permit → new-construction permit → year built → unknown | Curve: 10 yrs = 0, 15 = 0.45, 20 = 0.75, 25+ ≈ 1. Trust depends on market coverage |
| no_newer_reroof | Permit history | Full weight only where reroofs are permitted (×0.3 in Portland) |
| storm_exposure | Distance to nearest qualifying report | 1.0 within 0.5 mi, down to 0.2 at max distance |
| storm_recency | Days since report | 0–30 d = 1.0 · 31–90 d = 0.8 · ≤1 yr = 0.5 · ≤2 yr = 0.25 |
| storm_severity | Hail size / gust mph / ice in / snow in / damage remarks | Tables in `defaults.ts` |
| property_fit, service_area_fit | Property type, distance, target ZIPs | |

Cross-signal bonuses: **aging roof + storm exposure** (+10), and **recent, severe, close event on an old roof** (+6). Both require a confident aging-roof signal. Excluded from results: reroof permit within the minimum-years window (likely already served), untargeted property types, and properties outside the service area.

Customer overrides go in `config/customers/<id>.json` (`scoring.weights`, `tuning`, `filters`, `serviceAreas`). A setup engagement means editing that one file.

## Architecture (shared with future verticals)

```
server/src/
  core/        vertical-agnostic: types, pipeline, scoring, geo, config, csv, http cache, run log
  adapters/    reusable sources: IEM storm reports, ArcGIS permits, CSV (props/permits/weather), PortlandMaps
  verticals/
    registry.ts
    roofing/   signals, defaults (weights/tuning), matching, demo data, explanation + CSV columns
web/src/       Vue 3 + Quasar single page (App.vue, ResultCard.vue)
```

To add a salon or chiropractor vertical, create a new `verticals/<name>/` pack with its own sources, signals, defaults, and presentation. The core does not change.

## Data precision (be upfront with customers)

- An NWS Local Storm Report is a **point** (a spotter's or station's location), typically accurate to about 0.5–2 mi. Results say "reported ~0.6 mi from property", never "inside the swath" or "roof damaged".
- Later upgrade: MRMS hail-size grids or NWS warning polygons, added as another `WeatherSource`.

## Deploy

- **API → Render:** `render.yaml` (rootDir `server`). Set `CORS_ORIGINS` to the Pages URL. Attach a disk if you want the run log and imports to survive deploys.
- **UI → Cloudflare Pages:** root `web`, build `npm run build`, output `dist`, env `VITE_API_URL=https://<render-app>.onrender.com`.
- API keys live only in the server environment. The browser only sends the customer access key.

## Access keys

Keys are **not** stored in the repo. Each customer file `server/config/customers/<id>.json` gets its key from the server environment variable `ACCESS_KEY_<ID>` (for example `ACCESS_KEY_DEMO`). On Render, set these under **Environment**. A customer with no key set cannot sign in, and the server logs a warning at startup.

To add a customer: create `config/customers/<id>.json` (no key in it), commit, then add `ACCESS_KEY_<ID>` with a long random value in Render.
