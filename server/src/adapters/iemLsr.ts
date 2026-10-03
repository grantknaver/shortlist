/**
 * WeatherSource: official NWS Local Storm Reports (LSRs), served as GeoJSON by the
 * Iowa Environmental Mesonet (IEM) archive. Free, no key, near-real-time, point locations.
 *
 *   https://mesonet.agron.iastate.edu/geojson/lsr.geojson?wfos=PDT&sts=...&ets=...
 *
 * Precision: an LSR location is the reported spot (often "2 NW Bend"), roughly 0.5–2 mi.
 * These are reports of weather/damage in an area — NOT confirmation that any specific roof was damaged.
 *
 * Upgrade path: swap in MRMS MESH hail swaths or NWS warning polygons behind the same interface.
 */
import type { WeatherEvent, WeatherSource, WeatherType } from '../core/sources.js';
import type { RunContext } from '../core/context.js';
import { httpGet } from '../core/http.js';

const TYPE_MAP: Record<string, WeatherType> = {
  HAIL: 'hail',
  'TSTM WND DMG': 'tstm_wind',
  'TSTM WND GST': 'tstm_wind',
  DOWNBURST: 'tstm_wind',
  'NON-TSTM WND DMG': 'wind',
  'NON-TSTM WND GST': 'wind',
  'HIGH SUST WINDS': 'wind',
  TORNADO: 'tornado',
  'FREEZING RAIN': 'ice',
  'ICE STORM': 'ice',
  SNOW: 'snow',
  'HEAVY SNOW': 'snow',
  BLIZZARD: 'snow',
};

const DAMAGE_RE = /\b(damage|damaged|tree[s]? (down|fell|fallen|blown)|downed|uproot|power lines? down|debris|destroyed|collapsed|siding|shingle|structure)\b/i;
const ROOF_RE = /\b(roof|roofs|shingles?)\b/i;

export function normalizeLsrType(typetext: string): WeatherType | null {
  return TYPE_MAP[typetext.trim().toUpperCase()] ?? null;
}

export function mapLsrFeature(f: any): WeatherEvent | null {
  const p = f?.properties ?? {};
  const type = normalizeLsrType(String(p.typetext ?? ''));
  if (!type) return null;
  const lat = Number(p.lat ?? f.geometry?.coordinates?.[1]);
  const lon = Number(p.lon ?? f.geometry?.coordinates?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const remark = p.remark ? String(p.remark) : undefined;
  const mag = p.magnitude === null || p.magnitude === '' || p.magnitude === undefined ? undefined : Number(p.magnitude);
  const rawUnit = String(p.unit ?? '').toUpperCase();
  const unit = rawUnit === 'MPH' ? 'mph' : rawUnit === 'KTS' || rawUnit === 'KT' ? 'kt' : rawUnit === 'INCH' || rawUnit === 'INCHES' ? 'in' : rawUnit.toLowerCase() || undefined;
  const valid = String(p.valid ?? '');
  return {
    id: `lsr_${p.wfo ?? ''}_${valid}_${lat.toFixed(3)}_${lon.toFixed(3)}_${type}`,
    type,
    rawType: String(p.typetext),
    date: valid.endsWith('Z') ? valid : `${valid}Z`,
    location: { lat, lon },
    magnitude: Number.isFinite(mag) ? mag : undefined,
    unit,
    remark,
    city: p.city,
    county: p.county,
    damageMentioned: (!!remark && DAMAGE_RE.test(remark)) || String(p.typetext).includes('DMG'),
    roofMentioned: !!remark && ROOF_RE.test(remark),
    precision: 'point-report',
    qualifier: p.qualifier === 'M' ? 'measured' : p.qualifier === 'E' ? 'estimated' : 'unknown',
    reporterType: p.source ? String(p.source) : undefined,
    source: 'NWS Local Storm Report (via IEM)',
    sourceUrl: p.product_id ? `https://mesonet.agron.iastate.edu/p.php?pid=${p.product_id}` : undefined,
  };
}

const fmt = (d: Date) => d.toISOString().slice(0, 16) + 'Z';

export const iemLsrSource: WeatherSource = {
  id: 'iem-lsr',
  label: 'NWS Local Storm Reports (IEM archive)',
  mode: 'live',
  async fetchEvents(q, ctx: RunContext) {
    const wfos = (ctx.market.settings.nwsOffices as string[] | undefined) ?? [];
    if (!wfos.length) throw new Error('market.settings.nwsOffices not configured');
    const url = `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?wfos=${wfos.join(',')}&sts=${fmt(q.since)}&ets=${fmt(q.until)}`;
    // cache 15 min; key on the hour so button mashing doesn't refetch
    const { body, cached } = await httpGet(url, { ttlSec: 900, cacheKeyUrl: url.replace(/ets=[^&]+/, `ets=${fmt(q.until).slice(0, 13)}`) });
    if (!cached) ctx.externalCalls++;
    const json = JSON.parse(body);
    const events = (json.features ?? []).map(mapLsrFeature).filter(Boolean) as WeatherEvent[];
    return events;
  },
};
