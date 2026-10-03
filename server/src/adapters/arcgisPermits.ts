/**
 * PermitSource (bulk): any ArcGIS FeatureServer permit layer, configured by field mapping in the
 * market JSON (market.settings.arcgisPermits). A new city = new config, not new code.
 */
import type { PermitRecord, PermitSource } from '../core/sources.js';
import type { RunContext } from '../core/context.js';
import { arcgisQueryAll, geomPoint, recordUrl } from './arcgis.js';

export interface ArcgisPermitConfig {
  url: string;
  where?: string;
  dateField: string;
  fields: Partial<Record<'id' | 'parcelId' | 'address' | 'type' | 'subtype' | 'description' | 'issued' | 'applied' | 'finaled' | 'status', string>>;
  pageSize?: number;
  maxPages?: number;
}

function toIso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function mapArcgisPermit(attrs: Record<string, unknown>, geom: unknown, cfg: ArcgisPermitConfig): PermitRecord {
  const f = cfg.fields;
  const g = (k: keyof ArcgisPermitConfig['fields']) => {
    const v = f[k] ? attrs[f[k] as string] : undefined;
    return typeof v === 'string' ? v.trim() : v;
  };
  const type = [g('type'), g('subtype')].filter(Boolean).join(' / ');
  const id = String(g('id') ?? attrs.OBJECTID ?? '');
  return {
    id,
    parcelId: g('parcelId') ? String(g('parcelId')) : undefined,
    address: g('address') ? String(g('address')) : undefined,
    location: geomPoint(geom),
    issuedDate: toIso(g('issued')),
    appliedDate: toIso(g('applied')),
    finalDate: toIso(g('finaled')),
    type: type || 'Permit',
    workClass: g('type') ? String(g('type')) : undefined,
    useType: g('subtype') ? String(g('subtype')) : undefined,
    description: String(g('description') ?? ''),
    status: g('status') ? String(g('status')) : undefined,
    source: 'arcgis-permits',
    sourceUrl: f.id && id ? recordUrl(cfg.url, f.id, id) : cfg.url,
  };
}

export const arcgisPermitSource: PermitSource = {
  id: 'arcgis-permits',
  label: 'City open-data permits (ArcGIS)',
  mode: 'live',
  kind: 'bulk',
  async fetchAll(q, ctx: RunContext) {
    const cfg = ctx.market.settings.arcgisPermits as ArcgisPermitConfig | undefined;
    if (!cfg?.url || cfg.url.includes('REPLACE')) throw new Error('market.settings.arcgisPermits.url not configured');
    const since = q.since.toISOString().slice(0, 10);
    const where = `(${cfg.where ?? '1=1'}) AND (${cfg.dateField} >= DATE '${since}' OR ${cfg.dateField} IS NULL)`;
    const feats = await arcgisQueryAll(cfg.url, { where, outFields: '*', returnGeometry: true, pageSize: cfg.pageSize, maxPages: cfg.maxPages }, ctx);
    return feats.map((ft) => mapArcgisPermit(ft.attributes ?? {}, ft.geometry, cfg));
  },
};
