/**
 * CSV / manual-import fallbacks for every source kind. When a government source is slow to
 * automate (or needs a key we don't have yet), export its CSV and drop it into data/imports/<market>/.
 * Column names are case-insensitive and accept common aliases.
 *
 * Paths come from market.csv: { properties, permits, weather }.
 */
import fs from 'node:fs';
import type { PermitRecord, PermitSource, PropertyRecord, PropertySource, WeatherEvent, WeatherSource, WeatherType } from '../core/sources.js';
import type { RunContext } from '../core/context.js';
import { readCsv } from '../core/csv.js';
import { resolveServerPath } from '../core/config.js';
import { normalizeLsrType } from './iemLsr.js';

function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k.toLowerCase()];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}
const numOrU = (v?: string) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
const isoOrU = (v?: string) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function csvPath(ctx: RunContext, kind: 'properties' | 'permits' | 'weather') {
  const p = ctx.market.csv[kind];
  if (!p) throw new Error(`market.csv.${kind} not configured`);
  const full = resolveServerPath(p);
  if (!fs.existsSync(full)) throw new Error(`CSV not found: ${p}`);
  return full;
}

export function normalizePropertyType(v?: string): string {
  const s = (v ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/(single|sfr|sfd|residential|res\b|house|dwelling|townhouse|condo)/.test(s) && !/multi|apartment|commercial/.test(s)) return 'residential';
  if (/(multi|duplex|triplex|apartment|plex)/.test(s)) return 'multifamily';
  if (/(commercial|retail|office|industrial|warehouse)/.test(s)) return 'commercial';
  return 'other';
}

export const csvPropertySource: PropertySource = {
  id: 'csv-properties',
  label: 'Property CSV import',
  mode: 'csv',
  async fetchProperties(q, ctx) {
    const rows = readCsv(csvPath(ctx, 'properties'));
    const out: PropertyRecord[] = [];
    for (const r of rows) {
      const lat = numOrU(pick(r, 'lat', 'latitude', 'y'));
      const lon = numOrU(pick(r, 'lon', 'lng', 'longitude', 'x'));
      const address = pick(r, 'address', 'site_address', 'situs_address', 'siteaddress');
      if (!address) continue;
      const yb = numOrU(pick(r, 'year_built', 'yearbuilt', 'yr_built', 'effective_year_built'));
      if (q.builtBefore && yb && yb > q.builtBefore) continue;
      out.push({
        id: pick(r, 'property_id', 'id', 'account', 'propertyid') ?? pick(r, 'parcel_id', 'taxlot', 'maptaxlot') ?? address,
        parcelId: pick(r, 'parcel_id', 'taxlot', 'maptaxlot', 'mapandtaxlot', 'parcel'),
        address,
        city: pick(r, 'city'),
        zip: pick(r, 'zip', 'zip_code', 'zipcode'),
        location: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
        yearBuilt: yb,
        propertyType: normalizePropertyType(pick(r, 'property_type', 'type', 'prop_class', 'use', 'land_use')),
        sqft: numOrU(pick(r, 'sqft', 'square_feet', 'bldg_sqft')),
        source: 'csv-properties',
      });
      if (out.length >= q.maxRecords) break;
    }
    return out;
  },
};

export const csvPermitSource: PermitSource = {
  id: 'csv-permits',
  label: 'Permit CSV import',
  mode: 'csv',
  kind: 'bulk',
  async fetchAll(q, ctx) {
    const rows = readCsv(csvPath(ctx, 'permits'));
    const out: PermitRecord[] = [];
    for (const r of rows) {
      const lat = numOrU(pick(r, 'lat', 'latitude', 'y'));
      const lon = numOrU(pick(r, 'lon', 'lng', 'longitude', 'x'));
      const issued = isoOrU(pick(r, 'issued_date', 'issued', 'issue_date', 'issueddate', 'date_issued'));
      if (issued && new Date(issued) < q.since) continue;
      out.push({
        id: pick(r, 'permit_id', 'permit_number', 'permitnumber', 'application_number', 'id') ?? `csv_${out.length}`,
        parcelId: pick(r, 'parcel_id', 'taxlot', 'maptaxlot', 'mapandtaxlot', 'parcel'),
        address: pick(r, 'address', 'site_address', 'siteaddress', 'location'),
        location: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
        issuedDate: issued,
        finalDate: isoOrU(pick(r, 'final_date', 'finaled', 'finaled_date', 'completed_date')),
        type: [pick(r, 'type', 'permit_type', 'permittype'), pick(r, 'subtype', 'sub_type', 'work_type', 'workclass', 'work_class')].filter(Boolean).join(' / ') || 'Permit',
        description: pick(r, 'description', 'work_description', 'scope', 'project_description', 'work') ?? '',
        status: pick(r, 'status'),
        source: 'csv-permits',
      });
    }
    return out;
  },
};

export const csvWeatherSource: WeatherSource = {
  id: 'csv-weather',
  label: 'Weather CSV import',
  mode: 'csv',
  async fetchEvents(q, ctx) {
    const rows = readCsv(csvPath(ctx, 'weather'));
    const out: WeatherEvent[] = [];
    rows.forEach((r, i) => {
      const date = isoOrU(pick(r, 'date', 'valid', 'begin_date_time', 'datetime'));
      const lat = numOrU(pick(r, 'lat', 'latitude', 'begin_lat'));
      const lon = numOrU(pick(r, 'lon', 'longitude', 'begin_lon'));
      if (!date || lat === undefined || lon === undefined) return;
      if (new Date(date) < q.since || new Date(date) > q.until) return;
      const raw = pick(r, 'type', 'typetext', 'event_type') ?? 'other';
      const type: WeatherType = (normalizeLsrType(raw) ?? (['hail', 'tstm_wind', 'wind', 'tornado', 'ice', 'snow'].includes(raw.toLowerCase()) ? raw.toLowerCase() : 'other')) as WeatherType;
      const remark = pick(r, 'remark', 'remarks', 'event_narrative', 'notes');
      out.push({
        id: `csvwx_${i}`,
        type,
        rawType: raw,
        date,
        location: { lat, lon },
        magnitude: numOrU(pick(r, 'magnitude', 'mag')),
        unit: pick(r, 'unit', 'magnitude_type')?.toLowerCase(),
        remark,
        city: pick(r, 'city'),
        damageMentioned: /damage|tree|down|roof/i.test(remark ?? ''),
        roofMentioned: /roof|shingle/i.test(remark ?? ''),
        precision: 'point-report',
        source: pick(r, 'source') ?? 'Weather CSV import',
      });
    });
    return out;
  },
};
