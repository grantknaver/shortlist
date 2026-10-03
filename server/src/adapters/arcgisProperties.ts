/**
 * PropertySource: residential parcels assembled from ArcGIS layers, joined by parcel id.
 *   parcels      (required) — the property universe + fallback location (polygon centroid)
 *   addresses    (optional) — situs address + precise point location
 *   improvements (optional) — assessor year built / sqft / class
 *
 * Configured in market.settings.arcgisProperties. For Bend: City BLIS parcels + City site
 * address points + Deschutes County assessor improvements.
 */
import type { PropertyRecord, PropertySource } from '../core/sources.js';
import type { RunContext } from '../core/context.js';
import { arcgisQueryAll, geomPoint, recordUrl } from './arcgis.js';

interface Cfg {
  parcels: { url: string; where: string; idField: string; typeField?: string; typeValue?: string };
  addresses?: { url: string; where: string; parcelField: string; addressField: string; zipField?: string; cityField?: string };
  improvements?: { url: string; where: string; parcelField: string; yearBuiltField: string; sqftField?: string; classField?: string };
}

const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v).trim() || undefined);

export const arcgisPropertySource: PropertySource = {
  id: 'arcgis-properties',
  label: 'Parcels + addresses + assessor (ArcGIS)',
  mode: 'live',
  async fetchProperties(q, ctx: RunContext) {
    const cfg = ctx.market.settings.arcgisProperties as Cfg | undefined;
    if (!cfg?.parcels?.url) throw new Error('market.settings.arcgisProperties not configured');

    const parcels = await arcgisQueryAll(cfg.parcels.url, { where: cfg.parcels.where, outFields: [cfg.parcels.idField, cfg.parcels.typeField].filter(Boolean).join(','), returnGeometry: true }, ctx);

    const addrBy = new Map<string, { address: string; zip?: string; city?: string; loc?: { lat: number; lon: number } }>();
    if (cfg.addresses) {
      const a = cfg.addresses;
      const rows = await arcgisQueryAll(a.url, { where: a.where, outFields: [a.parcelField, a.addressField, a.zipField, a.cityField].filter(Boolean).join(','), returnGeometry: true }, ctx);
      for (const r of rows) {
        const pid = str(r.attributes[a.parcelField]);
        const address = str(r.attributes[a.addressField]);
        if (!pid || !address) continue;
        const prev = addrBy.get(pid);
        // deterministic choice when a parcel has several address points: shortest (no unit), then alphabetical
        if (!prev || address.length < prev.address.length || (address.length === prev.address.length && address < prev.address))
          addrBy.set(pid, { address, zip: a.zipField ? str(r.attributes[a.zipField]) : undefined, city: a.cityField ? str(r.attributes[a.cityField]) : undefined, loc: geomPoint(r.geometry) });
      }
    }

    const imprBy = new Map<string, { yearBuilt?: number; sqft?: number; cls?: string }>();
    if (cfg.improvements) {
      const m = cfg.improvements;
      const rows = await arcgisQueryAll(m.url, { where: m.where, outFields: [m.parcelField, m.yearBuiltField, m.sqftField, m.classField].filter(Boolean).join(','), returnGeometry: false }, ctx);
      for (const r of rows) {
        const pid = str(r.attributes[m.parcelField]);
        if (!pid) continue;
        const yb = Number(r.attributes[m.yearBuiltField]);
        imprBy.set(pid, {
          yearBuilt: Number.isFinite(yb) && yb > 1800 ? yb : undefined,
          sqft: m.sqftField && Number.isFinite(Number(r.attributes[m.sqftField])) ? Number(r.attributes[m.sqftField]) : undefined,
          cls: m.classField ? str(r.attributes[m.classField]) : undefined,
        });
      }
    }

    const out: PropertyRecord[] = [];
    let noAddress = 0;
    for (const p of parcels) {
      const pid = str(p.attributes[cfg.parcels.idField]);
      if (!pid) continue;
      const addr = addrBy.get(pid);
      if (!addr) {
        noAddress++;
        continue; // can't prospect a parcel without a situs address
      }
      const impr = imprBy.get(pid);
      out.push({
        id: pid,
        parcelId: pid,
        address: addr.address,
        city: addr.city,
        zip: addr.zip,
        location: addr.loc ?? geomPoint(p.geometry),
        yearBuilt: impr?.yearBuilt,
        propertyType: cfg.parcels.typeValue ?? 'unknown',
        sqft: impr?.sqft,
        source: 'arcgis-properties',
        sourceUrl: recordUrl(cfg.parcels.url, cfg.parcels.idField, pid),
      });
    }
    if (noAddress) ctx.warnings.push(`${noAddress} residential parcels skipped: no site address point`);
    return out.slice(0, q.maxRecords);
  },
};
