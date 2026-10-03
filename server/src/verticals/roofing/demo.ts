/**
 * DEMO DATASET — fictional properties, permits and storm reports, generated relative to the
 * selected market's center and to "today", so a demo always looks current and runs instantly.
 *
 * Scenarios are designed to make cross-signaling visible:
 *   old roof only · storm exposure only · old roof + storm · extremely strong multi-signal
 *   + properties that get excluded (recent reroof, commercial, outside service area).
 */
import type { GeoPoint } from '../../core/types.js';
import type { PermitRecord, PermitSource, PropertyRecord, PropertySource, WeatherEvent, WeatherSource, WeatherType } from '../../core/sources.js';

const STREETS: Record<string, string[]> = {
  'bend-or': ['NE Butler Market Rd', 'NW Shevlin Park Rd', 'SE Reed Market Rd', 'NE Purcell Blvd', 'SW Century Dr', 'NE 27th St', 'SE 15th St', 'NW Galveston Ave', 'NE Neff Rd', 'SW Brookswood Blvd', 'SE Wilson Ave', 'NW Mt Washington Dr', 'SE Murphy Rd', 'NE 8th St', 'SW Simpson Ave'],
  'portland-or': ['SE Woodstock Blvd', 'NE Fremont St', 'SE Division St', 'N Lombard St', 'NE Sandy Blvd', 'SE Holgate Blvd', 'NE Killingsworth St', 'SW Multnomah Blvd', 'SE Foster Rd', 'NE Glisan St', 'N Willamette Blvd', 'SE Powell Blvd', 'NE Prescott St', 'SW Capitol Hwy', 'SE Flavel St'],
};

/** offset (east, north) in miles → lat/lon */
function off(c: GeoPoint, eastMi: number, northMi: number): GeoPoint {
  return { lat: +(c.lat + northMi / 69).toFixed(5), lon: +(c.lon + eastMi / (69 * Math.cos((c.lat * Math.PI) / 180))).toFixed(5) };
}
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86400000).toISOString();
const yearsAgoDate = (now: Date, y: number, month = 6) => new Date(Date.UTC(now.getUTCFullYear() - y, month - 1, 15)).toISOString();

interface EventSpec {
  key: string;
  at: [number, number];
  type: WeatherType;
  raw: string;
  days: number;
  mag?: number;
  unit?: string;
  remark: string;
  damage?: boolean;
  roof?: boolean;
}

const EVENTS: EventSpec[] = [
  { key: 'E1', at: [2.0, -2.5], type: 'hail', raw: 'HAIL', days: 12, mag: 1.25, unit: 'in', remark: 'Half-dollar size hail covered the ground for several minutes. Report via trained spotter.' },
  { key: 'E2', at: [-4.0, 3.0], type: 'tstm_wind', raw: 'TSTM WND DMG', days: 27, mag: 64, unit: 'mph', remark: 'Large tree limbs down and shingles blown off a home. Estimated 64 mph gust.', damage: true, roof: true },
  { key: 'E3', at: [5.0, 4.0], type: 'wind', raw: 'NON-TSTM WND GST', days: 70, mag: 58, unit: 'mph', remark: 'Measured gust at a mesonet station.' },
  { key: 'E4', at: [-3.5, -5.0], type: 'ice', raw: 'FREEZING RAIN', days: 240, mag: 0.4, unit: 'in', remark: 'Ice accumulation on trees and power lines; several trees down.', damage: true },
  { key: 'E5', at: [-6.5, -1.0], type: 'hail', raw: 'HAIL', days: 20, mag: 0.5, unit: 'in', remark: 'Pea to marble size hail.' },
  { key: 'E6', at: [0.5, 6.5], type: 'snow', raw: 'HEAVY SNOW', days: 300, mag: 14, unit: 'in', remark: '24-hour snowfall total.' },
  { key: 'E7', at: [6.0, -5.0], type: 'tstm_wind', raw: 'TSTM WND GST', days: 5, mag: 45, unit: 'mph', remark: 'Measured gust.' },
];

type PermitSpec = { kind: 'reroof' | 'new' | 'solar' | 'remodel'; yearsAgo: number };
interface PropSpec {
  n: number;
  near?: string; // event key
  at: [number, number]; // offset from event (or center)
  yearBuilt?: number;
  type?: string;
  permits: PermitSpec[];
  scenario: string;
}

const PROPS: PropSpec[] = [
  // Extremely strong multi-signal
  { n: 2417, near: 'E1', at: [0.2, 0.1], yearBuilt: 1979, permits: [{ kind: 'reroof', yearsAgo: 24 }], scenario: 'Extremely strong: old roof + recent close hail' },
  { n: 1893, near: 'E2', at: [0.1, -0.2], yearBuilt: 1984, permits: [{ kind: 'reroof', yearsAgo: 22 }], scenario: 'Extremely strong: old roof + damaging wind w/ roof damage reported nearby' },
  { n: 3120, near: 'E1', at: [-0.3, 0.2], permits: [{ kind: 'new', yearsAgo: 26 }], scenario: 'Strong: original roof (new-construction permit) + recent hail' },
  { n: 755, near: 'E1', at: [0.6, -0.4], yearBuilt: 1990, permits: [{ kind: 'reroof', yearsAgo: 19 }], scenario: 'Old roof + recent hail' },
  // Old roof + storm (moderate)
  { n: 628, near: 'E3', at: [0.8, 0.3], yearBuilt: 1982, permits: [{ kind: 'reroof', yearsAgo: 20 }], scenario: 'Old roof + wind event ~2 months ago' },
  { n: 4410, near: 'E4', at: [0.4, 0.4], yearBuilt: 1975, permits: [{ kind: 'reroof', yearsAgo: 23 }], scenario: 'Old roof + ice storm ~8 months ago' },
  { n: 2290, near: 'E6', at: [0.3, -0.2], permits: [{ kind: 'new', yearsAgo: 24 }], scenario: 'Original roof + heavy snow ~10 months ago' },
  // Old roof only
  { n: 1507, at: [1.0, 1.5], yearBuilt: 1972, permits: [{ kind: 'reroof', yearsAgo: 27 }], scenario: 'Old roof only (no qualifying storm nearby)' },
  { n: 3346, at: [-1.0, -0.5], permits: [{ kind: 'new', yearsAgo: 25 }], scenario: 'Old roof only (original roof)' },
  { n: 912, at: [-1.5, -0.3], yearBuilt: 1987, permits: [{ kind: 'reroof', yearsAgo: 18 }], scenario: 'Old roof only' },
  // Storm only
  { n: 2011, near: 'E1', at: [0.1, -0.2], permits: [{ kind: 'new', yearsAgo: 10 }], scenario: 'Storm exposure only (roof ~10 yrs)' },
  { n: 1450, near: 'E2', at: [-0.3, 0.1], permits: [{ kind: 'new', yearsAgo: 12 }], scenario: 'Storm exposure only (roof ~12 yrs)' },
  // Year-built only (tests market permit coverage handling)
  { n: 3877, near: 'E2', at: [0.5, 0.5], yearBuilt: 2000, permits: [], scenario: 'Year built only (no permits) + storm' },
  // Unknown roof age (old home, no roof permits)
  { n: 5102, near: 'E1', at: [0.4, 0.3], yearBuilt: 1958, permits: [{ kind: 'remodel', yearsAgo: 15 }], scenario: 'Old home, roof age unknown + recent hail' },
  // Solar = roof likely redone before panels
  { n: 2675, near: 'E1', at: [-0.5, -0.3], yearBuilt: 1995, permits: [{ kind: 'new', yearsAgo: 31 }, { kind: 'solar', yearsAgo: 6 }], scenario: 'Old home w/ solar added 6 yrs ago + hail' },
  // Excluded
  { n: 1834, near: 'E1', at: [0.0, 0.3], yearBuilt: 1981, permits: [{ kind: 'reroof', yearsAgo: 2 }], scenario: 'EXCLUDED: reroofed 2 yrs ago (likely already served)' },
  { n: 400, near: 'E2', at: [0.2, 0.2], type: 'commercial', permits: [{ kind: 'reroof', yearsAgo: 21 }], scenario: 'EXCLUDED: commercial' },
  { n: 7788, at: [16, 9], yearBuilt: 1980, permits: [{ kind: 'reroof', yearsAgo: 25 }], scenario: 'EXCLUDED: outside service area' },
  { n: 3009, near: 'E7', at: [0.1, 0.1], permits: [{ kind: 'new', yearsAgo: 8 }], scenario: 'Weak: minor gust, newer roof' },
  { n: 1266, at: [-1.5, 0.8], permits: [{ kind: 'reroof', yearsAgo: 9 }], scenario: 'EXCLUDED: reroofed 9 yrs ago' },
  { n: 2934, at: [-0.5, 1.0], permits: [{ kind: 'new', yearsAgo: 6 }], scenario: 'Weak: new home' },
];

const PERMIT_TEXT: Record<PermitSpec['kind'], { type: string; description: string }> = {
  reroof: { type: 'Residential Building / Reroof', description: 'Reroof: tear-off and replace composition shingles' },
  new: { type: 'Residential Building / New Construction', description: 'New single family dwelling' },
  solar: { type: 'Residential Building / Solar', description: 'Install roof-mounted solar photovoltaic system' },
  remodel: { type: 'Residential Building / Alteration', description: 'Kitchen remodel, interior alterations' },
};

export function buildDemo(marketId: string, center: GeoPoint, now: Date, city: string) {
  const streets = STREETS[marketId] ?? STREETS['bend-or'];
  const evAt = new Map<string, GeoPoint>();
  const events: WeatherEvent[] = EVENTS.map((e) => {
    const loc = off(center, e.at[0], e.at[1]);
    evAt.set(e.key, loc);
    return {
      id: `demo_${e.key}`,
      type: e.type,
      rawType: e.raw,
      date: daysAgo(now, e.days),
      location: loc,
      magnitude: e.mag,
      unit: e.unit,
      remark: e.remark,
      city,
      damageMentioned: !!e.damage,
      roofMentioned: !!e.roof,
      precision: 'point-report',
      source: 'DEMO storm report',
    };
  });

  const properties: PropertyRecord[] = [];
  const permits: PermitRecord[] = [];
  const scenarios = new Map<string, string>();
  PROPS.forEach((p, i) => {
    const base = p.near ? evAt.get(p.near)! : center;
    const loc = off(base, p.at[0], p.at[1]);
    const id = `demo_p${i + 1}`;
    const address = `${p.n} ${streets[i % streets.length]}`;
    properties.push({
      id,
      parcelId: id,
      address,
      city,
      location: loc,
      yearBuilt: p.yearBuilt,
      propertyType: p.type ?? 'residential',
      sqft: 1400 + ((i * 137) % 1600),
      source: 'demo',
    });
    scenarios.set(id, p.scenario);
    p.permits.forEach((pm, j) => {
      const txt = PERMIT_TEXT[pm.kind];
      const issued = yearsAgoDate(now, pm.yearsAgo, 3 + ((i + j) % 8));
      permits.push({
        id: `D${String(now.getUTCFullYear() - pm.yearsAgo).slice(2)}-${String(100000 + i * 31 + j).slice(1)}`,
        parcelId: id,
        address,
        location: loc,
        issuedDate: issued,
        finalDate: new Date(new Date(issued).getTime() + 40 * 86400000).toISOString(),
        type: txt.type,
        description: txt.description,
        status: 'Final',
        source: 'demo',
      });
    });
  });
  return { events, properties, permits, scenarios };
}

export function demoSources(d: ReturnType<typeof buildDemo>) {
  const weather: WeatherSource = { id: 'demo-weather', label: 'Demo storm reports', mode: 'demo', fetchEvents: async () => d.events };
  const property: PropertySource = { id: 'demo-properties', label: 'Demo properties', mode: 'demo', fetchProperties: async () => d.properties };
  const permit: PermitSource = { id: 'demo-permits', label: 'Demo permits', mode: 'demo', kind: 'bulk', fetchAll: async () => d.permits };
  return { weather, property, permit };
}
