/**
 * SOURCE ADAPTER CONTRACTS.
 *
 * Each adapter turns one external system (an API, a CSV, demo data) into a
 * normalized record type. Swapping "Portland permits" for "Bend permits" or
 * "NWS reports via IEM" for "SPC CSV" means writing one adapter, nothing else.
 *
 * Record types are generic (property, permit, weather event) so other verticals
 * can reuse them.
 *
 * Deferred contracts (defined when those features are built):
 *   SearchSource (Perplexity), AIProvider (Claude explanations/outreach)
 */
import type { GeoPoint } from './types.js';
import type { RunContext } from './context.js';

export interface SourceMeta {
  id: string;
  label: string;
  mode: 'live' | 'demo' | 'csv';
}

// ---------- Property ----------
export interface PropertyRecord {
  id: string;
  /** assessor/parcel id when known — used to join permits */
  parcelId?: string;
  address: string;
  city?: string;
  zip?: string;
  location?: GeoPoint;
  yearBuilt?: number;
  /** 'residential' | 'multifamily' | 'commercial' | 'other' | 'unknown' */
  propertyType: string;
  sqft?: number;
  source: string;
  sourceUrl?: string;
}

export interface PropertyQuery {
  /** Optional areas to focus on (e.g. around storm reports) to limit API load */
  focusAreas?: { center: GeoPoint; radiusMi: number }[];
  builtBefore?: number;
  maxRecords: number;
}

export interface PropertySource extends SourceMeta {
  fetchProperties(q: PropertyQuery, ctx: RunContext): Promise<PropertyRecord[]>;
}

// ---------- Permit ----------
export interface PermitRecord {
  id: string;
  parcelId?: string;
  address?: string;
  location?: GeoPoint;
  issuedDate?: string; // ISO
  /** application/submittal date — used when the source has no issue date yet */
  appliedDate?: string; // ISO
  finalDate?: string; // ISO
  type: string;
  /** structured work class when the source has one (e.g. 'New Construction/Installation') */
  workClass?: string;
  /** structured use/occupancy type when the source has one (e.g. 'Single Family Dwelling') */
  useType?: string;
  description: string;
  status?: string;
  /** assigned by the vertical's classifier, e.g. 'reroof', 'new-construction', 'solar', 'other' */
  category?: string;
  source: string;
  sourceUrl?: string;
}

export interface PermitSource extends SourceMeta {
  /**
   * 'bulk'    — returns the market's whole permit history in one pull (open-data feeds, CSV).
   * 'lookup'  — needs per-property lookups (e.g. PortlandMaps API); used in the budgeted enrichment stage.
   */
  kind: 'bulk' | 'lookup';
  fetchAll?(q: { since: Date }, ctx: RunContext): Promise<PermitRecord[]>;
  fetchFor?(properties: PropertyRecord[], ctx: RunContext): Promise<PermitRecord[]>;
}

// ---------- Weather ----------
export type WeatherType = 'hail' | 'tstm_wind' | 'wind' | 'tornado' | 'ice' | 'snow' | 'other';

export interface WeatherEvent {
  id: string;
  type: WeatherType;
  rawType: string;
  /** ISO timestamp */
  date: string;
  location: GeoPoint;
  magnitude?: number;
  unit?: string; // 'in' | 'mph' | 'kt'
  remark?: string;
  city?: string;
  county?: string;
  /** report remark mentions damage (trees down, structures, etc.) */
  damageMentioned: boolean;
  /** report remark explicitly mentions roofs (some roof in the area — not this property) */
  roofMentioned: boolean;
  /** how precisely the location represents the event footprint */
  precision: 'point-report' | 'polygon' | 'county';
  /** magnitude measured by an instrument vs estimated by an observer */
  qualifier?: 'measured' | 'estimated' | 'unknown';
  /** reporter type, e.g. 'Trained Spotter', 'Mesonet', 'Public' */
  reporterType?: string;
  source: string;
  sourceUrl?: string;
}

export interface WeatherSource extends SourceMeta {
  fetchEvents(q: { since: Date; until: Date }, ctx: RunContext): Promise<WeatherEvent[]>;
}

/** Chronology for permits: issue date, else application date, else final date — with the date type retained. */
export function effectivePermitDate(p: PermitRecord): { date?: string; source: 'issued' | 'applied' | 'finaled' | 'none' } {
  if (p.issuedDate) return { date: p.issuedDate, source: 'issued' };
  if (p.appliedDate) return { date: p.appliedDate, source: 'applied' };
  if (p.finalDate) return { date: p.finalDate, source: 'finaled' };
  return { source: 'none' };
}
