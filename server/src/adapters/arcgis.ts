/**
 * Shared ArcGIS FeatureServer query helper (paginated, cached). Most US city/county open-data
 * portals (ArcGIS Hub) expose layers this way, so adapters for new markets are mostly config.
 */
import type { RunContext } from '../core/context.js';
import { httpGet } from '../core/http.js';

export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: any;
}

export async function arcgisQueryAll(
  layerUrl: string,
  opts: { where: string; outFields: string; returnGeometry: boolean; orderBy?: string; pageSize?: number; maxPages?: number; ttlSec?: number },
  ctx: RunContext,
): Promise<ArcgisFeature[]> {
  const pageSize = opts.pageSize ?? 2000;
  const out: ArcgisFeature[] = [];
  for (let page = 0; page < (opts.maxPages ?? 200); page++) {
    const params = new URLSearchParams({
      where: opts.where,
      outFields: opts.outFields,
      returnGeometry: String(opts.returnGeometry),
      outSR: '4326',
      orderByFields: opts.orderBy ?? 'OBJECTID ASC',
      resultOffset: String(page * pageSize),
      resultRecordCount: String(pageSize),
      f: 'json',
    });
    const url = `${layerUrl.replace(/\/$/, '')}/query?${params}`;
    const { body, cached } = await httpGet(url, { ttlSec: opts.ttlSec ?? 24 * 3600 });
    if (!cached) ctx.externalCalls++;
    const json = JSON.parse(body);
    if (json.error) throw new Error(`ArcGIS error (${layerUrl}): ${json.error.message ?? JSON.stringify(json.error)}`);
    const feats: ArcgisFeature[] = json.features ?? [];
    out.push(...feats);
    if (feats.length < pageSize && !json.exceededTransferLimit) return out;
  }
  throw new Error(`ArcGIS pagination limit reached for ${layerUrl} — refusing to return a partial dataset`);
}

/** Point geometry or average of the first polygon ring (adequate for parcel-scale matching). */
export function geomPoint(geom: any): { lat: number; lon: number } | undefined {
  if (!geom) return undefined;
  if (Number.isFinite(geom.x) && Number.isFinite(geom.y)) return { lat: geom.y, lon: geom.x };
  const ring = geom.rings?.[0];
  if (Array.isArray(ring) && ring.length) {
    const pts = ring.slice(0, -1).length ? ring.slice(0, -1) : ring;
    return {
      lat: pts.reduce((s: number, p: number[]) => s + p[1], 0) / pts.length,
      lon: pts.reduce((s: number, p: number[]) => s + p[0], 0) / pts.length,
    };
  }
  return undefined;
}

/** Stable, auditable link to a single record. */
export function recordUrl(layerUrl: string, field: string, value: string) {
  const p = new URLSearchParams({ where: `${field}='${value.replace(/'/g, "''")}'`, outFields: '*', f: 'json' });
  return `${layerUrl.replace(/\/$/, '')}/query?${p}`;
}
