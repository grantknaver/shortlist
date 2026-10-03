/**
 * Deterministic matching + normalization helpers for the roofing vertical.
 * Storm exposure, event clustering and neighborhood counts are computed geometrically here —
 * never guessed by an LLM.
 */
import { distanceMi, interp, clamp01 } from '../../core/geo.js';
import type { GeoPoint } from '../../core/types.js';
import { effectivePermitDate, type PermitRecord, type WeatherEvent } from '../../core/sources.js';
import { classifyRoofText, isSolarInstall, normalizePermitText } from './roofText.js';
import type { NeighborReroofs, PermitStructure, RoofFilters, RoofTuning, StormEventCluster, StormMatch } from './types.js';

// ---------------------------------------------------------------- severity
export function severityOf(e: WeatherEvent, t: RoofTuning): number {
  const s = t.severity;
  let v: number;
  const m = e.magnitude;
  switch (e.type) {
    case 'hail':
      v = m ? interp(m, s.hailIn) : s.unknownMagnitude;
      break;
    case 'tstm_wind':
    case 'wind':
      v = m && e.unit?.toLowerCase().includes('mph') ? interp(m, s.windMph) : m && e.unit?.toLowerCase() === 'kt' ? interp(m * 1.15078, s.windMph) : s.unknownMagnitude;
      break;
    case 'ice':
      v = m ? interp(m, s.iceIn) : s.unknownMagnitude;
      break;
    case 'snow':
      v = m ? interp(m, s.snowIn) : 0.25;
      break;
    case 'tornado':
      v = s.tornado;
      break;
    default:
      v = 0.2;
  }
  if (e.damageMentioned) v = Math.max(v, s.damageReportFloor);
  if (e.roofMentioned) v += s.roofMentionBonus;
  return clamp01(v);
}

export function recencyOf(daysAgo: number, t: RoofTuning): number {
  for (const b of [...t.recency].sort((a, c) => a.maxDays - c.maxDays)) if (daysAgo <= b.maxDays) return b.weight;
  return t.recencyOlderWeight;
}

export function proximityOf(d: number, maxDistanceMi: number, t: RoofTuning): number {
  if (d <= t.proximity.fullScoreMi) return 1;
  if (d > maxDistanceMi) return 0;
  const span = Math.max(0.01, maxDistanceMi - t.proximity.fullScoreMi);
  return 1 - ((d - t.proximity.fullScoreMi) / span) * (1 - t.proximity.edgeScore);
}

// ---------------------------------------------------------------- event clustering + credibility
const FAMILY: Record<string, StormEventCluster['family']> = { hail: 'hail', tstm_wind: 'wind', wind: 'wind', tornado: 'tornado', ice: 'ice', snow: 'snow' };

/** Drop exact duplicates (e.g. a TSTM gust report that "corrects" a NON-TSTM report at the same station/time). */
export function dedupeReports(events: WeatherEvent[]): WeatherEvent[] {
  const seen = new Map<string, WeatherEvent>();
  for (const e of events) {
    const k = `${FAMILY[e.type] ?? e.type}|${e.date.slice(0, 16)}|${e.location.lat.toFixed(3)}|${e.location.lon.toFixed(3)}|${e.magnitude ?? ''}`;
    const prev = seen.get(k);
    // keep the thunderstorm classification / the one with a remark
    if (!prev || (e.type === 'tstm_wind' && prev.type !== 'tstm_wind') || (!prev.remark && e.remark)) seen.set(k, e);
  }
  return [...seen.values()];
}

export function clusterEvents(reports: WeatherEvent[], t: RoofTuning): StormEventCluster[] {
  const sorted = dedupeReports(reports).sort((a, b) => a.date.localeCompare(b.date));
  const hrs = t.stormClustering.hours * 3600000;
  const groups: WeatherEvent[][] = [];
  for (const e of sorted) {
    const fam = FAMILY[e.type] ?? 'other';
    const g = groups.find(
      (grp) =>
        (FAMILY[grp[0].type] ?? 'other') === fam &&
        grp.some((o) => Math.abs(new Date(o.date).getTime() - new Date(e.date).getTime()) <= hrs && distanceMi(o.location, e.location) <= t.stormClustering.miles),
    );
    if (g) g.push(e);
    else groups.push([e]);
  }
  return groups.map((grp, i) => {
    const locs = new Set(grp.map((e) => `${e.location.lat.toFixed(2)},${e.location.lon.toFixed(2)}`));
    const sources = new Set(grp.map((e) => e.reporterType ?? 'unknown'));
    const anyMeasured = grp.some((e) => e.qualifier === 'measured');
    const anyDamage = grp.some((e) => e.damageMentioned);
    const reportCount = locs.size;
    // credibility: corroboration, measurement, damage remarks, independent reporters
    let cred = 0.35;
    cred += Math.min(0.3, 0.1 * (reportCount - 1));
    if (anyMeasured) cred += 0.15;
    if (anyDamage) cred += 0.15;
    if (sources.size >= 2) cred += 0.1;
    const mags = grp.map((e) => e.magnitude).filter((m): m is number => m !== undefined);
    return {
      id: `${FAMILY[grp[0].type] ?? 'other'}_${grp[0].date.slice(0, 10)}_${i}`,
      family: FAMILY[grp[0].type] ?? 'other',
      start: grp[0].date,
      end: grp[grp.length - 1].date,
      reports: grp,
      reportCount,
      independentSources: sources.size,
      anyMeasured,
      anyDamageRemark: anyDamage,
      maxMagnitude: mags.length ? Math.max(...mags) : undefined,
      credibility: +clamp01(cred).toFixed(2),
      uncorroborated: reportCount === 1 && !anyMeasured && !anyDamage,
    };
  });
}

export function matchStorms(
  loc: GeoPoint | undefined,
  clusters: StormEventCluster[],
  f: RoofFilters,
  t: RoofTuning,
  now: Date,
): StormMatch[] {
  if (!loc) return [];
  const out: StormMatch[] = [];
  for (const c of clusters) {
    // nearest report of this event
    let best: { e: WeatherEvent; d: number } | undefined;
    for (const e of c.reports) {
      const d = distanceMi(loc, e.location);
      if (!best || d < best.d) best = { e, d };
    }
    if (!best || best.d > f.maxDistanceMi) continue;
    const daysAgo = Math.max(0, (now.getTime() - new Date(best.e.date).getTime()) / 86400000);
    if (daysAgo > f.stormLookbackDays) continue;
    const rawSeverity = severityOf(best.e, t);
    const severityCapped = c.uncorroborated && rawSeverity > t.stormClustering.uncorroboratedSeverityCap;
    const severity = severityCapped ? t.stormClustering.uncorroboratedSeverityCap : rawSeverity;
    if (severity < f.minSeverity) continue;
    const proximity = proximityOf(best.d, f.maxDistanceMi, t);
    const recency = recencyOf(daysAgo, t);
    out.push({
      event: best.e,
      cluster: c,
      distanceMi: +best.d.toFixed(2),
      proximity,
      recency,
      severity,
      rawSeverity,
      severityCapped,
      composite: proximity * recency * severity * (0.5 + 0.5 * c.credibility),
      daysAgo: Math.round(daysAgo),
    });
  }
  return out.sort((a, b) => b.composite - a.composite);
}

// ---------------------------------------------------------------- neighborhood post-storm reroof RATE
/** Grid index over points (properties) for fast radius queries. */
export class PointIndex<T extends { location?: GeoPoint }> {
  private cells = new Map<string, T[]>();
  private static cell = 0.01; // ~0.7 mi
  constructor(items: T[]) {
    for (const it of items) {
      if (!it.location) continue;
      const k = this.key(it.location.lat, it.location.lon);
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(it);
    }
  }
  private key(lat: number, lon: number) {
    return `${Math.floor(lat / PointIndex.cell)}|${Math.floor(lon / PointIndex.cell)}`;
  }
  near(loc: GeoPoint, radiusMi: number): { it: T; d: number }[] {
    const out: { it: T; d: number }[] = [];
    const cy = Math.floor(loc.lat / PointIndex.cell);
    const cx = Math.floor(loc.lon / PointIndex.cell);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const it of this.cells.get(`${cy + dy}|${cx + dx}`) ?? []) {
          const d = distanceMi(loc, it.location!);
          if (d <= radiusMi) out.push({ it, d });
        }
    return out;
  }
}

/**
 * Share of eligible nearby homes (same residential universe) with a KNOWN reroof after the storm,
 * vs. the share in an equal-length window immediately before the storm (local baseline).
 */
export function neighborReroofRate(
  loc: GeoPoint,
  selfParcel: string | undefined,
  match: StormMatch,
  homes: PointIndex<{ parcelId?: string; location?: GeoPoint; address: string }>,
  reroofDatesByParcel: Map<string, string[]>,
  now: Date,
  t: RoofTuning,
  reliableFrom?: string,
): NeighborReroofs {
  const start = match.cluster.start;
  const L = now.getTime() - new Date(start).getTime();
  const baseEnd = new Date(start).getTime();
  let baseStart = baseEnd - L;
  let baselineScale = 1;
  if (reliableFrom && baseStart < new Date(reliableFrom).getTime()) {
    const clipped = new Date(reliableFrom).getTime();
    baselineScale = L / Math.max(1, baseEnd - clipped);
    baseStart = clipped;
  }
  const ring = (r: number) => {
    const ns = homes.near(loc, r).filter(({ it }) => it.parcelId && it.parcelId !== selfParcel);
    let post = 0;
    let base = 0;
    const sample: NeighborReroofs['sample'] = [];
    for (const { it, d } of ns) {
      const dates = reroofDatesByParcel.get(it.parcelId!) ?? [];
      const inPost = dates.find((x) => x >= start && new Date(x).getTime() <= now.getTime());
      const inBase = dates.some((x) => new Date(x).getTime() >= baseStart && new Date(x).getTime() < baseEnd);
      if (inPost) {
        post++;
        if (sample.length < 6) sample.push({ id: it.parcelId!, issued: inPost.slice(0, 10), distanceMi: +d.toFixed(2), address: it.address });
      }
      if (inBase) base++;
    }
    const n = ns.length;
    return { n, post, base, postRate: n ? post / n : 0, baseRate: n ? Math.min(1, (base * baselineScale) / n) : 0, sample };
  };
  const r1 = ring(t.neighborhood.radiusMi);
  const r2 = ring(t.neighborhood.contextRadiusMi);
  return {
    eventId: match.cluster.id,
    since: start.slice(0, 10),
    baselineWindow: `${new Date(baseStart).toISOString().slice(0, 10)}..${new Date(baseEnd).toISOString().slice(0, 10)}`,
    baselineScaled: baselineScale !== 1,
    r025: { eligible: r1.n, reroofed: r1.post, rate: +r1.postRate.toFixed(4), baselineReroofed: r1.base, baselineRate: +r1.baseRate.toFixed(4) },
    r05: { eligible: r2.n, reroofed: r2.post, rate: +r2.postRate.toFixed(4), baselineReroofed: r2.base, baselineRate: +r2.baseRate.toFixed(4) },
    within025: r1.post,
    within05: r2.post,
    sample: r1.sample,
  };
}

// ---------------------------------------------------------------- permit classification
/**
 * Categories:
 *   inactive               — canceled / withdrawn / voided / expired application (ignored)
 *   reroof                 — KNOWN REROOF: complete roof replacement of the dwelling
 *   possible-roof-work     — roof work mentioned but scope/structure ambiguous, or reroof permit expired
 *   legacy-alteration      — alteration with no meaningful description, any date (POSSIBLE prior roof work)
 *   inactive-roof-application — canceled/withdrawn/expired-application reroof (shown, never counted)
 *   house-construction     — new construction of the dwelling itself (structured use type)
 *   accessory-construction — new construction of anything else on the parcel (never used for roof age)
 *   solar                  — actual solar/PV installation (negations handled)
 *   roof-repair, accessory-roof, partial-roof-addition, other
 */
export function classifyPermit(p: PermitRecord, t: RoofTuning, ps?: PermitStructure): string {
  const status = (p.status ?? '').trim();
  if (ps?.inactiveStatuses?.includes(status)) {
    // never counted, but an abandoned/canceled reroof application is still shown to the roofer
    const r = p.description.trim() ? classifyRoofText(p.description).cls : null;
    return r && r !== 'roof-equipment' ? 'inactive-roof-application' : 'inactive';
  }
  const desc = p.description.trim();
  if (ps && p.workClass && ps.newConstructionWorkClasses.includes(p.workClass))
    return p.useType && ps.dwellingUseTypes.includes(p.useType) ? 'house-construction' : 'accessory-construction';

  const roof = desc ? classifyRoofText(desc).cls : null;
  if (roof === 'known-reroof') {
    const nonDwelling = !!(ps && p.useType && !ps.dwellingUseTypes.includes(p.useType));
    if (nonDwelling) return 'possible-roof-work'; // e.g. coded commercial/multifamily: not clearly this dwelling
    if (ps?.expiredStatuses?.includes(status)) return 'possible-roof-work'; // issued but expired: completion unknown
    return 'reroof';
  }
  if (roof === 'possible-roof-work') return 'possible-roof-work';
  if (roof === 'roof-repair' || roof === 'accessory-roof' || roof === 'partial-roof-addition') return roof;
  if (desc && isSolarInstall(desc)) return 'solar';

  if (ps && p.workClass) {
    // An alteration with no meaningful description is POSSIBLE prior roof work regardless of date
    // (no fragile description-era cutoff). "Meaningful" = more than clerk initials / boilerplate notes.
    if (ps.alterationWorkClasses.includes(p.workClass) && !hasMeaningfulDescription(desc)) return 'legacy-alteration';
  } else if (t.permitKeywordsNewConstruction.some((k) => ` ${p.type} ${desc} `.toLowerCase().includes(k))) return 'house-construction'; // unstructured sources (CSV/demo)
  return 'other';
}

/** Clerk initials / boilerplate left after normalization are not a work description. */
const CLERK_TOKENS = new Set(['sn', 'sf', 'chw', 'mpaule', 'joc', 'rjwb', 'woz', 'cob', 'water', 'no', 'expired', 'expireds', 'conditions', 'drone', 'ok', 'authorized', 'approved', 'none', 'n/a', 'na']);
export function hasMeaningfulDescription(desc: string): boolean {
  const words = normalizePermitText(desc).split(' ').filter((w) => w.length > 1 && !CLERK_TOKENS.has(w));
  return words.length >= 2;
}
