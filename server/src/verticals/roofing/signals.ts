/**
 * Roofing signal definitions. Each returns a 0..1 score, a confidence, and plain factual statements.
 * Language rule: exposure ≠ damage. We say "reported nearby", never "this roof was damaged".
 */
import type { SignalDefinition, SignalResult } from '../../core/types.js';
import { interp, clamp01 } from '../../core/geo.js';
import { effectivePermitDate, type PermitRecord } from '../../core/sources.js';
import type { RoofAgeBasis, RoofCandidate, RoofSignalCtx, RoofStatus, StormMatch } from './types.js';
import { WEATHER_LABELS } from './defaults.js';

const year = (iso?: string) => (iso ? new Date(iso).getUTCFullYear() : undefined);
const permitYear = (p: PermitRecord) => year(effectivePermitDate(p).date);
const dateNote = (p: PermitRecord) => {
  const e = effectivePermitDate(p);
  return e.source === 'applied' ? ' (application date used; issue date unavailable)' : e.source === 'finaled' ? ' (final date used)' : '';
};

export interface PermitRef {
  id: string;
  year?: number;
  date?: string;
  dateSource: string;
  kind?: string;
  desc?: string;
}
const ref = (p: PermitRecord, kind?: string): PermitRef => {
  const e = effectivePermitDate(p);
  return { id: p.id, year: year(e.date), date: e.date?.slice(0, 10), dateSource: e.source, kind, desc: p.description ? p.description.replace(/\s+/g, ' ').slice(0, 120) : undefined };
};

export interface RoofAgeInfo {
  basis: RoofAgeBasis;
  status: RoofStatus;
  years?: number;
  lastReroofYear?: number;
  lastReroof?: PermitRef;
  houseConstructionYear?: number;
  houseConstructionPermitId?: string;
  /** dwelling permits rejected because their date disagrees with the assessor year built */
  rejectedHousePermits: PermitRef[];
  /** accessory/commercial construction permits on the parcel (never used for roof age) */
  ignoredAccessoryPermits: { id: string; year?: number; type: string }[];
  /** POSSIBLE PRIOR ROOF WORK: unlabeled legacy alterations, ambiguous roof mentions, expired reroof permits */
  possibleRoofWork: PermitRef[];
  /** newer / undated dwelling permits on the parcel that cannot be matched to this residence */
  parcelChange: PermitRef[];
  /** roof-related permits shown to the roofer that do NOT affect the score */
  otherRoofPermits: (PermitRef & { note: string; status?: string })[];
  solarYear?: number;
  solar?: PermitRef;
  yearBuilt?: number;
  label: string;
}

export function roofAgeInfo(c: RoofCandidate, s: RoofSignalCtx): RoofAgeInfo {
  const nowY = s.now.getUTCFullYear();
  const ps = c.attributes.permits.filter((p) => p.category !== 'inactive');
  const byCat = (cat: string) =>
    ps.filter((p) => p.category === cat).map((p) => ({ p, y: permitYear(p) })).sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
  const reroofs = byCat('reroof').filter((r) => r.y !== undefined);
  const solar = byCat('solar')[0];
  const yearBuilt = c.attributes.property.yearBuilt;
  const tol = s.tuning.houseYearTolerance;

  // house construction permit: dwelling use type AND consistent with assessor year built
  const houses = byCat('house-construction');
  const rejectedHousePermits: PermitRef[] = [];
  let house: { p: PermitRecord; y?: number } | undefined;
  for (const h of houses) {
    if (h.y !== undefined && (yearBuilt === undefined || Math.abs(h.y - yearBuilt) <= tol)) {
      if (!house || (yearBuilt !== undefined && Math.abs(h.y - yearBuilt) < Math.abs((house.y ?? 0) - yearBuilt))) house = h;
    } else rejectedHousePermits.push(ref(h.p, 'dwelling permit'));
  }
  // POSSIBLE PARCEL CHANGE: a dwelling permit newer than the matched house (or year built), or undated
  const houseYear = house?.y ?? yearBuilt;
  const parcelChange = houses
    .filter((h) => h !== house && (h.y === undefined || (houseYear !== undefined && h.y > houseYear + tol)))
    .map((h) => ref(h.p, 'newer dwelling permit'));
  const ignoredAccessoryPermits = byCat('accessory-construction').map((a) => ({ id: a.p.id, year: a.y, type: a.p.useType ?? a.p.type }));

  const possibleAfter = (startYear: number | undefined) => [
    ...byCat('legacy-alteration')
      .filter((a) => a.y !== undefined && (startYear === undefined || a.y >= startYear + s.tuning.legacyAlteration.minYearsAfterRoofStart))
      .map((a) => ref(a.p, 'unlabeled legacy alteration')),
    ...byCat('possible-roof-work')
      .filter((a) => a.y !== undefined && (startYear === undefined || a.y > startYear))
      .map((a) => ref(a.p, a.p.status && /expired/i.test(a.p.status) ? 'reroof permit expired (completion unknown)' : 'roof work, scope unclear')),
  ];

  const OTHER_NOTES: Record<string, string> = {
    'partial-roof-addition': 'new roofing on added/partial sections only; existing main roof not identified as replaced',
    'roof-repair': 'roof repair, not a replacement',
    'accessory-roof': 'roof work on an accessory structure (garage/shed/shop/carport), not the dwelling',
    'inactive-roof-application': 'roof-related application canceled/withdrawn/expired before issuance per record; work not confirmed and not counted',
  };
  const otherRoofPermits = c.attributes.permits
    .filter((p) => OTHER_NOTES[p.category ?? ''])
    .map((p) => ({ ...ref(p, p.category), desc: p.description.replace(/\s+/g, ' ').trim().slice(0, 500), status: p.status, note: OTHER_NOTES[p.category!] }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const base = {
    otherRoofPermits,
    rejectedHousePermits,
    ignoredAccessoryPermits,
    parcelChange,
    solarYear: solar?.y,
    solar: solar ? ref(solar.p, 'solar') : undefined,
    yearBuilt,
    houseConstructionYear: house?.y,
    houseConstructionPermitId: house?.p.id,
  };

  // KNOWN REROOF
  if (reroofs[0]) {
    const y = reroofs[0].y!;
    const possible = possibleAfter(y);
    return {
      ...base,
      basis: 'reroof-permit',
      status: possible.length ? 'possible-prior-roof-work' : 'known-reroof',
      years: nowY - y,
      lastReroofYear: y,
      lastReroof: ref(reroofs[0].p, 'known reroof'),
      possibleRoofWork: possible,
      label: `Known reroof permit ${y}`,
    };
  }
  const possibleRoofWork = possibleAfter(houseYear);
  const status: RoofStatus = possibleRoofWork.length ? 'possible-prior-roof-work' : 'no-known-reroof';
  if (house?.y) return { ...base, basis: 'house-construction-permit', status, years: nowY - house.y, possibleRoofWork, label: `Original construction permit ${house.y}` };
  if (yearBuilt && nowY - yearBuilt <= s.tuning.originalRoofMaxAge)
    return { ...base, basis: 'year-built', status, years: nowY - yearBuilt, possibleRoofWork, label: `Assessor year built ${yearBuilt} (no matching house permit)` };
  return { ...base, basis: 'unknown', status, possibleRoofWork, label: yearBuilt ? `Home built ${yearBuilt}; roof replacement date unknown` : 'Roof age unknown' };
}

const roofAge: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'roof_age',
  label: 'Roof age',
  compute(c, s): SignalResult {
    const info = roofAgeInfo(c, s);
    const rule = s.tuning.roofAgeBasis[s.permitCoverage][info.basis];
    const facts: string[] = [];
    let score: number;
    let confidence = rule.confidence;
    let canFire = rule.canFire;
    if (info.basis === 'house-construction-permit' && info.yearBuilt === undefined) confidence = Math.min(confidence, s.tuning.houseBasisNoAssessorConfidence);
    if (info.years !== undefined) {
      score = Math.min(rule.maxScore, interp(info.years, s.tuning.roofAgeCurve));
      if (info.basis === 'reroof-permit')
        facts.push(`KNOWN REROOF: permit ${info.lastReroof!.id} (${info.lastReroof!.date}${info.lastReroof!.dateSource === 'applied' ? ', application date used because issue date was unavailable' : ''}; ~${info.years} yrs ago): "${info.lastReroof!.desc ?? ''}"`);
      else if (info.basis === 'house-construction-permit')
        facts.push(`Original house construction permit ${info.houseConstructionPermitId} (${info.houseConstructionYear})${info.yearBuilt ? `, consistent with assessor year built ${info.yearBuilt}` : ''}; roof possibly ~${info.years} yrs old`);
      else facts.push(`Assessor year built ${info.yearBuilt}; no matching house construction permit, so roof age (up to ~${info.years} yrs) is a low-confidence estimate`);
    } else {
      score = rule.maxScore;
      facts.push(info.yearBuilt ? `Home built ${info.yearBuilt}; no reroof permit on record, current roof age unknown` : 'No roof permit or build year available; roof age unknown');
    }
    if (info.status === 'no-known-reroof' && info.basis !== 'unknown') facts.push('NO KNOWN REROOF on record since then');
    for (const r of info.rejectedHousePermits.filter((r) => !info.parcelChange.some((pc) => pc.id === r.id)))
      facts.push(`House permit ${r.id} (${r.date ?? 'undated'}) not used: inconsistent with assessor year built ${info.yearBuilt}`);
    if (info.ignoredAccessoryPermits.length)
      facts.push(`Ignored for roof age: ${info.ignoredAccessoryPermits.map((a) => `${a.id} (${a.year ?? 'n/a'}, ${a.type})`).join('; ')}`);

    // POSSIBLE PRIOR ROOF WORK
    if (info.status === 'possible-prior-roof-work') {
      confidence = Math.min(confidence, s.tuning.legacyAlteration.confidenceCap);
      for (const a of info.possibleRoofWork)
        facts.push(`POSSIBLE PRIOR ROOF WORK: ${a.date ?? a.year} ${a.kind === 'unlabeled legacy alteration' ? 'alteration permit with no meaningful description' : a.kind} — permit ${a.id}${a.dateSource === 'applied' ? ' (application date)' : ''}${a.desc ? `: "${a.desc}"` : ''}; roof-age confidence reduced`);
    }
    // POSSIBLE PARCEL CHANGE
    if (info.parcelChange.length) {
      confidence = Math.min(confidence, s.tuning.parcelChange.confidenceCap);
      for (const pc of info.parcelChange)
        facts.push(`POSSIBLE PARCEL CHANGE: newer dwelling permit ${pc.id} (${pc.date ?? 'undated'})${pc.desc ? `: "${pc.desc}"` : ''} — may reflect lot split, redevelopment or address change; confidence reduced`);
    }
    // roof-related permit history that does not affect the score — shown so the roofer sees it
    for (const o of info.otherRoofPermits)
      facts.push(`ROOF PERMIT (not counted): ${o.date ?? 'undated'} ${o.id}${o.status ? ` [${o.status}]` : ''}${o.desc ? `: "${o.desc}"` : ''} — ${o.note}`);
    // solar install after the roof date usually means the roof was checked/replaced around then
    const roofYear = info.lastReroofYear ?? info.houseConstructionYear ?? info.yearBuilt;
    if (info.solarYear && (!roofYear || info.solarYear > roofYear)) {
      score = Math.min(score, s.tuning.solar.scoreCap);
      confidence = Math.min(confidence, s.tuning.solar.confidenceCap);
      canFire = false;
      facts.push(`Solar installation permit ${info.solar!.id} (${info.solar!.date}): roof may have been replaced or re-evaluated around then`);
    }
    const fired = canFire && info.years !== undefined && info.years >= s.filters.minYearsSinceReroof && score >= 0.45;
    return { id: 'roof_age', label: 'Roof age', score: clamp01(score), fired, confidence, facts, detail: { ...info } };
  },
};

/** Fires when a permit could represent prior roof work; used as a score penalty. */
const possibleLegacyRoofWork: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'possible_legacy_roof_work',
  label: 'Possible prior roof work',
  compute(c, s) {
    const info = roofAgeInfo(c, s);
    const fired = info.status === 'possible-prior-roof-work';
    return { id: 'possible_legacy_roof_work', label: 'Possible prior roof work', score: fired ? 1 : 0, fired, confidence: 0.5, facts: fired ? info.possibleRoofWork.map((a) => `${a.date ?? a.year} ${a.kind} ${a.id}`) : [] };
  },
};

/** Fires when a newer/undated dwelling permit on the parcel cannot be matched to this residence. */
const possibleParcelChange: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'possible_parcel_change',
  label: 'Possible parcel change',
  compute(c, s) {
    const info = roofAgeInfo(c, s);
    const fired = info.parcelChange.length > 0;
    return { id: 'possible_parcel_change', label: 'Possible parcel change', score: fired ? 1 : 0, fired, confidence: 0.5, facts: fired ? info.parcelChange.map((p) => `${p.id} ${p.date ?? 'undated'}`) : [] };
  },
};

const noNewerReroof: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'no_newer_reroof',
  label: 'No newer reroof record',
  compute(c, s) {
    const nowY = s.now.getUTCFullYear();
    const recent = c.attributes.permits.filter(
      (p) => p.category === 'reroof' && (permitYear(p) ?? 0) > nowY - s.filters.minYearsSinceReroof,
    );
    if (!c.attributes.permitsChecked)
      return { id: 'no_newer_reroof', label: 'No newer reroof record', score: 0.3, fired: false, confidence: 0.2, facts: ['Permit history not checked for this property'] };
    const none = recent.length === 0;
    const facts = none
      ? [`No reroof permit on record in the last ${s.filters.minYearsSinceReroof} yrs`]
      : [`Reroof permit on record within the last ${s.filters.minYearsSinceReroof} yrs`];
    if (none && s.permitCoverage === 'partial') facts.push(s.permitCoverageNote);
    return {
      id: 'no_newer_reroof',
      label: 'No newer reroof record',
      score: none ? 1 : 0,
      fired: none && s.permitCoverage === 'full',
      confidence: s.permitCoverage === 'full' ? 0.85 : 0.3,
      facts,
    };
  },
};

export function magnitudeLabel(m: StormMatch): string {
  const e = m.event;
  if (e.magnitude === undefined) return e.damageMentioned ? 'Damage reported (no magnitude)' : 'Magnitude not reported';
  if (e.type === 'hail') return `${e.magnitude}" hail`;
  if (e.type === 'tstm_wind' || e.type === 'wind') return `${e.magnitude} ${e.unit === 'kt' ? 'kt' : 'mph'} gust`;
  if (e.type === 'ice') return `${e.magnitude}" ice accumulation`;
  if (e.type === 'snow') return `${e.magnitude}" snow`;
  return `${e.magnitude} ${e.unit ?? ''}`.trim();
}

function best(c: RoofCandidate) {
  return c.attributes.stormMatches[0];
}

const noStorm = (id: string, label: string, s: RoofSignalCtx): SignalResult => ({
  id,
  label,
  score: 0,
  fired: false,
  confidence: 0.8,
  facts: id === 'storm_exposure' ? [`No qualifying severe-weather report within ${s.filters.maxDistanceMi} mi in the last ${s.filters.stormLookbackDays} days`] : [],
});

function eventFacts(m: StormMatch): string[] {
  const c = m.cluster;
  const f = [
    `Event ${c.id}: ${c.reportCount} report location(s), ${c.independentSources} reporter type(s), ${c.anyMeasured ? 'measured magnitude' : 'estimated magnitude only'}${c.anyDamageRemark ? ', damage remarks' : ''} — credibility ${c.credibility}`,
  ];
  if (m.severityCapped) f.push(`Single uncorroborated estimated report without damage remarks — severity capped at moderate`);
  return f;
}

const stormExposure: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'storm_exposure',
  label: 'Severe-weather exposure (proximity)',
  compute(c, s) {
    const m = best(c);
    if (!m) return noStorm('storm_exposure', 'Severe-weather exposure (proximity)', s);
    const n = c.attributes.stormMatches.length;
    const facts = [
      `${WEATHER_LABELS[m.event.type]} reported ~${m.distanceMi} mi from property (${magnitudeLabel(m)}, ${m.event.qualifier ?? 'unknown'}, ${m.event.reporterType ?? 'unknown reporter'})`,
      'Report location is approximate (typically within ~1 mi); indicates exposure, not confirmed damage',
      ...eventFacts(m),
    ];
    if (n > 1) facts.push(`${n - 1} other qualifying event(s) nearby in the lookback window`);
    const score = clamp01(m.proximity + Math.min(0.1, 0.03 * (n - 1)));
    const credible = m.cluster.credibility >= 0.6 && !m.severityCapped;
    return {
      id: 'storm_exposure',
      label: 'Severe-weather exposure (proximity)',
      score,
      fired: m.composite >= 0.1 && credible,
      confidence: m.cluster.credibility,
      facts,
      detail: { distanceMi: m.distanceMi, events: n, credibility: m.cluster.credibility, credible },
    };
  },
};

const stormRecency: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'storm_recency',
  label: 'Storm recency',
  compute(c, s) {
    const m = best(c);
    if (!m) return noStorm('storm_recency', 'Storm recency', s);
    return { id: 'storm_recency', label: 'Storm recency', score: m.recency, fired: m.recency >= 0.8, confidence: 0.95, facts: [`Event ${m.daysAgo} days ago (${m.event.date.slice(0, 10)})`] };
  },
};

const stormSeverity: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'storm_severity',
  label: 'Storm severity',
  compute(c, s) {
    const m = best(c);
    if (!m) return noStorm('storm_severity', 'Storm severity', s);
    const facts = [`Nearest report: ${magnitudeLabel(m)}${m.cluster.maxMagnitude !== undefined ? ` (event max ${m.cluster.maxMagnitude})` : ''}`];
    if (m.severityCapped) facts.push(`Severity capped (raw ${m.rawSeverity.toFixed(2)} → ${m.severity.toFixed(2)}): uncorroborated estimate`);
    if (m.event.roofMentioned) facts.push('Official report remarks mention roof/shingle damage in the area (not necessarily this property)');
    else if (m.event.damageMentioned) facts.push('Official report remarks mention damage in the area');
    return { id: 'storm_severity', label: 'Storm severity', score: m.severity, fired: m.severity >= 0.6, confidence: m.event.qualifier === 'measured' ? 0.9 : 0.6, facts };
  },
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Corroboration: did an unusually large SHARE of nearby homes get a KNOWN reroof after the same
 * storm, compared with the same area's share in an equal-length window before the storm?
 */
const neighborhoodReroofs: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'neighborhood_reroofs',
  label: 'Nearby post-storm reroof rate',
  compute(c, s) {
    const n = c.attributes.neighborReroofs;
    const t = s.tuning.neighborhood;
    const empty = { id: 'neighborhood_reroofs', label: 'Nearby post-storm reroof rate', score: 0, fired: false, confidence: 0.8, facts: [] as string[] };
    if (!n) return empty;
    const ev = c.attributes.stormMatches[0];
    const evLabel = ev ? `the ${ev.cluster.start.slice(0, 10)} ${ev.cluster.family} event` : 'the storm';
    const facts = [
      `${n.r025.reroofed} of ${n.r025.eligible} eligible homes within ${t.radiusMi} mi reroofed after ${evLabel} (${pct(n.r025.rate)}); comparable prior period ${n.baselineWindow}: ${pct(n.r025.baselineRate)}${n.baselineScaled ? ' (scaled; permit descriptions start Oct 2020)' : ''}`,
      `${n.r05.reroofed} of ${n.r05.eligible} within ${t.contextRadiusMi} mi (${pct(n.r05.rate)}; prior ${pct(n.r05.baselineRate)})`,
      'Corroborates that nearby roofs were replaced after the same event — not proof this roof was damaged',
    ];
    if (t.mode === 'count') {
      const score = interp(n.within025, t.countCurve);
      return { ...empty, score, fired: n.within025 >= 1, confidence: 0.85, facts, detail: { ...n } };
    }
    const ex1 = Math.max(0, n.r025.rate - n.r025.baselineRate);
    const ex2 = Math.max(0, n.r05.rate - n.r05.baselineRate);
    const reliability = Math.min(1, n.r025.eligible / t.minEligible);
    const score = clamp01((t.innerWeight * interp(ex1, t.excessRateCurve) + (1 - t.innerWeight) * interp(ex2, t.excessRateCurve)) * reliability);
    const lift = n.r025.baselineRate > 0 ? n.r025.rate / n.r025.baselineRate : n.r025.rate > 0 ? Infinity : 0;
    const fired =
      n.r025.eligible >= t.minEligible && n.r025.reroofed >= t.fireMinReroofed && ex1 >= t.fireExcessRate && lift >= t.fireLift;
    return { ...empty, score, fired, confidence: 0.5 + 0.4 * reliability, facts, detail: { ...n, excess025: +ex1.toFixed(4), excess05: +ex2.toFixed(4), lift025: Number.isFinite(lift) ? +lift.toFixed(2) : 'inf' } };
  },
};

const propertyFit: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'property_fit',
  label: 'Property fit',
  compute(c, s) {
    const t = c.attributes.property.propertyType;
    const targeted = s.propertyTypes.includes(t);
    const score = targeted ? 1 : t === 'unknown' ? 0.6 : 0.1;
    return { id: 'property_fit', label: 'Property fit', score, fired: targeted, confidence: t === 'unknown' ? 0.5 : 0.9, facts: [t === 'unknown' ? 'Property type not recorded' : `Property type: ${t}`] };
  },
};

const serviceAreaFit: SignalDefinition<RoofCandidate, RoofSignalCtx> = {
  id: 'service_area_fit',
  label: 'Service-area fit',
  compute(c, s) {
    const d = c.attributes.serviceDistanceMi;
    const inside = d <= s.serviceRadiusMi;
    const score = inside ? 1 - 0.4 * (d / s.serviceRadiusMi) : c.attributes.inTargetZip ? 0.6 : 0;
    const facts = [`${d.toFixed(1)} mi from service-area center (radius ${s.serviceRadiusMi} mi)`];
    if (c.attributes.inTargetZip) facts.push(`In target ZIP ${c.attributes.property.zip}`);
    return { id: 'service_area_fit', label: 'Service-area fit', score: clamp01(score + (c.attributes.inTargetZip ? 0.1 : 0)), fired: inside, confidence: 0.95, facts };
  },
};

export const ROOF_SIGNALS = [roofAge, possibleLegacyRoofWork, possibleParcelChange, noNewerReroof, stormExposure, stormRecency, stormSeverity, neighborhoodReroofs, propertyFit, serviceAreaFit];
