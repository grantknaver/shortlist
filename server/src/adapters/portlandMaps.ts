/**
 * PortlandMaps API adapters (City of Portland). Requires a free server key:
 * email maps@portlandoregon.gov, subject "PortlandMaps API Key Request".
 *
 *  - Assessor API  → PropertySource (year_built, lat/lon, sqft; filter built_before + geometry)
 *  - Permit API    → PermitSource 'lookup' (per-property history; used in budgeted enrichment)
 *
 * IMPORTANT (Portland): most residential reroofs do NOT require a permit, so permit history is
 * incomplete for roofs. The market is configured with permitCoverage 'partial' accordingly.
 *
 * Response shapes are parsed defensively; verify field names on first live call with the key.
 */
import type { PermitRecord, PermitSource, PropertyRecord, PropertySource } from '../core/sources.js';
import type { RunContext } from '../core/context.js';
import { httpGet } from '../core/http.js';
import { bboxAround } from '../core/geo.js';
import { env } from '../env.js';
import { normalizePropertyType } from './csvSources.js';

const BASE = 'https://www.portlandmaps.com/api';

function rowsOf(json: any): any[] {
  if (Array.isArray(json)) return json;
  return json?.results ?? json?.data ?? json?.features?.map((f: any) => f.attributes ?? f.properties) ?? [];
}

function requireKey() {
  if (!env.PORTLANDMAPS_API_KEY) throw new Error('PORTLANDMAPS_API_KEY not set (request one from maps@portlandoregon.gov)');
}

export const portlandMapsPropertySource: PropertySource = {
  id: 'portlandmaps-assessor',
  label: 'PortlandMaps Assessor API',
  mode: 'live',
  async fetchProperties(q, ctx: RunContext) {
    requireKey();
    const areas = q.focusAreas?.length ? q.focusAreas : [{ center: ctx.serviceArea.center, radiusMi: ctx.serviceArea.radiusMi }];
    const out = new Map<string, PropertyRecord>();
    for (const a of areas) {
      const b = bboxAround(a.center, a.radiusMi);
      const geometry = JSON.stringify({
        rings: [[[b.minLon, b.minLat], [b.maxLon, b.minLat], [b.maxLon, b.maxLat], [b.minLon, b.maxLat], [b.minLon, b.minLat]]],
        spatialReference: { wkid: 4326 },
      });
      for (let page = 1; page <= 5 && out.size < q.maxRecords; page++) {
        const params = new URLSearchParams({ api_key: env.PORTLANDMAPS_API_KEY, geometry, count: '1000', page: String(page), format: 'json' });
        if (q.builtBefore) params.set('built_before', String(q.builtBefore));
        const { body, cached } = await httpGet(`${BASE}/assessor/?${params}`, { ttlSec: 7 * 86400 });
        if (!cached) ctx.externalCalls++;
        const rows = rowsOf(JSON.parse(body));
        for (const r of rows) {
          const lat = Number(r.latitude);
          const lon = Number(r.longitude);
          const id = String(r.property_id ?? r.state_id ?? r.address);
          out.set(id, {
            id,
            parcelId: r.property_id ? String(r.property_id) : undefined,
            address: String(r.address ?? ''),
            city: r.city,
            zip: r.zip_code ? String(r.zip_code) : undefined,
            location: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined,
            yearBuilt: r.year_built ? Number(r.year_built) : undefined,
            propertyType: normalizePropertyType(r.property_type ?? r.prop_code_desc ?? r.property_use),
            sqft: r.square_feet ? Number(r.square_feet) : undefined,
            source: 'portlandmaps-assessor',
            sourceUrl: r.property_id ? `https://www.portlandmaps.com/detail/property/${r.property_id}_did/` : undefined,
          });
        }
        if (rows.length < 1000) break;
      }
    }
    return [...out.values()].slice(0, q.maxRecords);
  },
};

export const portlandMapsPermitSource: PermitSource = {
  id: 'portlandmaps-permits',
  label: 'PortlandMaps Permit API',
  mode: 'live',
  kind: 'lookup',
  async fetchFor(properties, ctx: RunContext) {
    requireKey();
    const out: PermitRecord[] = [];
    for (const p of properties) {
      if (!p.parcelId) continue;
      const params = new URLSearchParams({ api_key: env.PORTLANDMAPS_API_KEY, property_id: p.parcelId, count: '200', format: 'json' });
      try {
        const { body, cached } = await httpGet(`${BASE}/permit/?${params}`, { ttlSec: 86400 });
        if (!cached) ctx.externalCalls++;
        for (const r of rowsOf(JSON.parse(body))) {
          out.push({
            id: String(r.application_number ?? r.ivr_number ?? Math.random()),
            parcelId: p.parcelId,
            address: r.address ?? p.address,
            location: p.location,
            issuedDate: r.issued ? new Date(r.issued).toISOString() : undefined,
            finalDate: r.final ? new Date(r.final).toISOString() : undefined,
            type: [r.type, r.work].filter(Boolean).join(' / '),
            description: String(r.description ?? ''),
            status: r.status,
            source: 'portlandmaps-permits',
          });
        }
      } catch (e) {
        ctx.warnings.push(`Permit lookup failed for ${p.address}: ${(e as Error).message}`);
      }
    }
    return out;
  },
};
