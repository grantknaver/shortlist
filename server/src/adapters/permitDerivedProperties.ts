/**
 * For markets whose open data has good permit history but no convenient property API (e.g. Bend),
 * derive the candidate property universe from permit locations: one property per parcel/address.
 * Can be merged with an assessor CSV later for year-built / property type.
 */
import type { PermitRecord, PropertyRecord } from '../core/sources.js';
import { normalizePropertyType } from './csvSources.js';

export function normAddress(a?: string) {
  return (a ?? '')
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bPLACE\b/g, 'PL')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\s+/g, ' ')
    .trim();
}

export function permitKey(p: { parcelId?: string; address?: string }) {
  return p.parcelId ? `P:${p.parcelId}` : p.address ? `A:${normAddress(p.address)}` : '';
}

export function derivePropertiesFromPermits(permits: PermitRecord[], city?: string): PropertyRecord[] {
  const byKey = new Map<string, PropertyRecord & { _types: string[] }>();
  for (const p of permits) {
    const key = permitKey(p);
    if (!key || !p.location) continue;
    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        id: key,
        parcelId: p.parcelId,
        address: p.address ?? key,
        city,
        location: p.location,
        propertyType: 'unknown',
        source: 'derived-from-permits',
        _types: [],
      };
      byKey.set(key, rec);
    }
    rec._types.push(`${p.type} ${p.description}`);
  }
  return [...byKey.values()].map(({ _types, ...r }) => {
    // infer type from the permit text seen at this address (commercial wins if clearly present)
    const joined = _types.join(' | ');
    const t = /commercial|tenant improvement|retail|office|industrial/i.test(joined)
      ? 'commercial'
      : /multi[- ]?family|apartment|fourplex|triplex/i.test(joined)
        ? 'multifamily'
        : normalizePropertyType(joined);
    return { ...r, propertyType: t };
  });
}
