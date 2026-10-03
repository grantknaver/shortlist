/**
 * ROOFING VERTICAL PACK — plugs roofing sources, signals, scoring defaults and presentation
 * into the generic core pipeline.
 */
import fs from 'node:fs';
import type { RunContext } from '../../core/context.js';
import { resolveServerPath } from '../../core/config.js';
import type { ScoringConfig, SourceStatus } from '../../core/types.js';
import type { PermitRecord, PermitSource, PropertyRecord, PropertySource, WeatherEvent, WeatherSource } from '../../core/sources.js';
import type { VerticalPack } from '../../core/vertical.js';
import { mergeScoring } from '../../core/scoring.js';
import { distanceMi, clusterPoints } from '../../core/geo.js';
import { iemLsrSource } from '../../adapters/iemLsr.js';
import { arcgisPermitSource } from '../../adapters/arcgisPermits.js';
import { arcgisPropertySource } from '../../adapters/arcgisProperties.js';
import { csvPermitSource, csvPropertySource, csvWeatherSource } from '../../adapters/csvSources.js';
import { portlandMapsPermitSource, portlandMapsPropertySource } from '../../adapters/portlandMaps.js';
import { derivePropertiesFromPermits, normAddress, permitKey } from '../../adapters/permitDerivedProperties.js';
import { DEFAULT_FILTERS, DEFAULT_SCORING, DEFAULT_TUNING, WEATHER_LABELS } from './defaults.js';
import { PointIndex, classifyPermit, clusterEvents, matchStorms, neighborReroofRate } from './matching.js';
import { effectivePermitDate } from '../../core/sources.js';
import { ROOF_SIGNALS, magnitudeLabel, roofAgeInfo } from './signals.js';
import { buildDemo, demoSources } from './demo.js';
import type { PermitStructure, RoofCandidate, RoofFilters, RoofSignalCtx, RoofTuning } from './types.js';

const ROOF_CATEGORIES = new Set(['inactive-roof-application', 'reroof', 'possible-roof-work', 'house-construction', 'accessory-construction', 'legacy-alteration', 'roof-repair', 'accessory-roof', 'partial-roof-addition', 'solar']);

// ---------- config resolution ----------
function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over as T) ?? base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function resolveFilters(ctx: RunContext): RoofFilters {
  const f = { ...DEFAULT_FILTERS, ...(ctx.customer.filters as Partial<RoofFilters>), ...(ctx.filters as Partial<RoofFilters>) };
  f.limit = Math.min(Number(f.limit) || 25, ctx.customer.maxResultsPerRun, ctx.customer.plan === 'sample' ? 10 : Infinity);
  return f;
}

export function resolveTuning(ctx: RunContext): RoofTuning {
  return deepMerge(deepMerge(DEFAULT_TUNING, ctx.market.settings.tuning ?? {}), ctx.customer.tuning);
}

function signalCtx(ctx: RunContext): RoofSignalCtx {
  const cov = (ctx.market.settings.reroofPermitCoverage as 'full' | 'partial') ?? 'partial';
  return {
    filters: resolveFilters(ctx),
    tuning: resolveTuning(ctx),
    now: ctx.now,
    permitCoverage: cov,
    permitCoverageNote:
      (ctx.market.settings.reroofPermitCoverageNote as string) ??
      (cov === 'full' ? 'Residential reroofs require permits in this market.' : 'Most residential reroofs in this market do not require a permit, so permit history may be incomplete.'),
    permitStructure: ctx.market.settings.permitStructure as PermitStructure | undefined,
    targetZips: ctx.serviceArea.zips,
    serviceRadiusMi: ctx.serviceArea.radiusMi,
    propertyTypes: ctx.customer.propertyTypes,
  };
}

// ---------- adapter resolution ----------
const WEATHER: Record<string, WeatherSource> = { 'iem-lsr': iemLsrSource, csv: csvWeatherSource };
const PERMITS: Record<string, PermitSource> = { arcgis: arcgisPermitSource, csv: csvPermitSource, portlandmaps: portlandMapsPermitSource };
const PROPERTIES: Record<string, PropertySource | 'from-permits'> = {
  arcgis: arcgisPropertySource,
  portlandmaps: portlandMapsPropertySource,
  csv: csvPropertySource,
  'from-permits': 'from-permits',
};

async function tryFetch<T>(ctx: RunContext, meta: { id: string; label: string; mode: SourceStatus['mode'] }, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    const rows = await fn();
    ctx.sources.push({ ...meta, ok: true, records: rows.length });
    return rows;
  } catch (e) {
    const msg = (e as Error).message;
    ctx.sources.push({ ...meta, ok: false, records: 0, note: msg });
    ctx.warnings.push(`${meta.label}: ${msg}`);
    // Live runs never continue on partial data: a missing source would silently change every score.
    if (ctx.mode === 'live') throw new Error(`Live source failed — ${meta.label}: ${msg}`);
    return [];
  }
}

// ---------- pack ----------
export const roofingPack: VerticalPack<RoofCandidate, RoofSignalCtx> = {
  id: 'roofing',
  label: 'Shortlist — Roofing',
  defaultFilters: DEFAULT_FILTERS as unknown as Record<string, unknown>,
  disclaimers: [
    'These are prospecting opportunities, not inbound leads.',
    'Severe-weather exposure means an official report was made near the property. It does not confirm roof damage.',
    'Roof age is estimated from public permit/property records and may be incomplete.',
  ],

  buildScoring(ctx): ScoringConfig {
    const f = resolveFilters(ctx);
    const cfg = mergeScoring(DEFAULT_SCORING, ctx.customer.scoring as Partial<ScoringConfig>);
    const w = { ...cfg.weights };
    // "no newer reroof" only means something where reroofs are permitted
    if ((ctx.market.settings.reroofPermitCoverage ?? 'partial') !== 'full') w.no_newer_reroof = (w.no_newer_reroof ?? 0) * 0.3;
    if (f.prioritizeRecentStorm) for (const k of ['storm_exposure', 'storm_recency', 'storm_severity']) w[k] = (w[k] ?? 0) * 1.4;
    const t = resolveTuning(ctx);
    const penalties = (cfg.penalties ?? []).map((p) =>
      p.id === 'possible_legacy_roof_work' ? { ...p, points: t.legacyAlteration.penaltyPoints } : p.id === 'possible_parcel_change' ? { ...p, points: t.parcelChange.penaltyPoints } : p,
    );
    return { ...cfg, weights: w, penalties };
  },

  async gather(ctx) {
    const sctx = signalCtx(ctx);
    const f = sctx.filters;
    const t = sctx.tuning;
    const area = ctx.serviceArea;

    let weatherSrc: WeatherSource, permitSrc: PermitSource, propertySrc: PropertySource | 'from-permits';
    let scenarios = new Map<string, string>();
    if (ctx.mode === 'demo') {
      const d = buildDemo(ctx.market.id, area.center, ctx.now, ctx.market.name.split(',')[0]);
      const s = demoSources(d);
      weatherSrc = s.weather;
      permitSrc = s.permit;
      propertySrc = s.property;
      scenarios = d.scenarios;
    } else {
      const src = ctx.market.sources;
      weatherSrc = WEATHER[src.weather];
      permitSrc = PERMITS[src.permit];
      propertySrc = PROPERTIES[src.property];
      if (!weatherSrc || !permitSrc || !propertySrc) throw new Error(`Market ${ctx.market.id} has unknown source ids: ${JSON.stringify(src)}`);
    }

    // 1. weather (deterministic; filtered to area + allowed types)
    const since = new Date(ctx.now.getTime() - f.stormLookbackDays * 86400000);
    const rawEvents = await tryFetch<WeatherEvent>(ctx, weatherSrc, () => weatherSrc.fetchEvents({ since, until: ctx.now }, ctx));
    const events = rawEvents.filter(
      (e) => f.weatherTypes.includes(e.type) && distanceMi(e.location, area.center) <= area.radiusMi + f.maxDistanceMi,
    );
    // cluster related reports into events; credibility is computed per event
    const clusters = clusterEvents(events, t);

    // 2. permits (bulk sources now; lookup sources later in enrichment)
    let permits: PermitRecord[] = [];
    if (permitSrc.kind === 'bulk' && permitSrc.fetchAll) {
      permits = await tryFetch(ctx, permitSrc, () => permitSrc.fetchAll!({ since: new Date('1980-01-01') }, ctx));
      for (const p of permits) p.category = classifyPermit(p, t, sctx.permitStructure);
    }

    // 3. properties
    let properties: PropertyRecord[];
    if (propertySrc === 'from-permits') {
      properties = derivePropertiesFromPermits(permits, ctx.market.name.split(',')[0]);
      ctx.sources.push({ id: 'derived-properties', label: 'Properties derived from permit locations', mode: 'live', ok: true, records: properties.length });
      if (ctx.market.csv.properties && fs.existsSync(resolveServerPath(ctx.market.csv.properties))) {
        // optional assessor CSV enriches year built / type by parcel or address
        const extra = await tryFetch(ctx, csvPropertySource, () => csvPropertySource.fetchProperties({ maxRecords: 1e6 }, ctx));
        const byKey = new Map(extra.map((p) => [permitKey(p), p]));
        properties = properties.map((p) => {
          const m = byKey.get(permitKey(p));
          return m ? { ...p, yearBuilt: m.yearBuilt ?? p.yearBuilt, propertyType: m.propertyType !== 'unknown' ? m.propertyType : p.propertyType, zip: m.zip ?? p.zip, sqft: m.sqft ?? p.sqft } : p;
        });
      }
    } else {
      const ps = propertySrc;
      const focusAreas = clusterPoints(events.map((e) => e.location), f.maxDistanceMi);
      focusAreas.push({ center: area.center, radiusMi: area.radiusMi });
      properties = await tryFetch(ctx, ps, () => ps.fetchProperties({ focusAreas, maxRecords: t.maxProperties }, ctx));
    }

    // 4. join permits → properties (parcel id, then normalized address)
    const byParcel = new Map<string, PermitRecord[]>();
    const byAddr = new Map<string, PermitRecord[]>();
    for (const p of permits) {
      if (!ROOF_CATEGORIES.has(p.category ?? '')) continue;
      if (p.parcelId) (byParcel.get(p.parcelId) ?? byParcel.set(p.parcelId, []).get(p.parcelId)!).push(p);
      if (p.address) {
        const k = normAddress(p.address);
        (byAddr.get(k) ?? byAddr.set(k, []).get(k)!).push(p);
      }
    }

    // 5. candidates + deterministic spatial matching
    const zips = new Set(area.zips);
    const dwelling = new Set(sctx.permitStructure?.dwellingUseTypes ?? []);
    // KNOWN residential reroofs by parcel (effective date = issue ?? application), for post-storm reroof RATES
    const knownReroofs = permits.filter((p) => p.category === 'reroof' && (!p.useType || !dwelling.size || dwelling.has(p.useType)));
    const reroofDatesByParcel = new Map<string, string[]>();
    for (const p of knownReroofs) {
      const d = effectivePermitDate(p).date;
      if (!p.parcelId || !d) continue;
      (reroofDatesByParcel.get(p.parcelId) ?? reroofDatesByParcel.set(p.parcelId, []).get(p.parcelId)!).push(d);
    }
    const homeIdx = new PointIndex(properties);
    const candidates: RoofCandidate[] = [];
    for (const prop of properties) {
      if (!prop.location) continue;
      const matched = new Map<string, PermitRecord>();
      for (const p of (prop.parcelId && byParcel.get(prop.parcelId)) || []) matched.set(p.id, p);
      for (const p of byAddr.get(normAddress(prop.address)) ?? []) matched.set(p.id, p);
      const stormMatches = matchStorms(prop.location, clusters, f, t, ctx.now);
      const neighborReroofs = stormMatches[0]
        ? neighborReroofRate(prop.location, prop.parcelId, stormMatches[0], homeIdx, reroofDatesByParcel, ctx.now, t, sctx.permitStructure?.descriptionsReliableFrom)
        : undefined;
      candidates.push({
        id: prop.id,
        label: prop.address,
        location: prop.location,
        attributes: {
          property: prop,
          permits: [...matched.values()],
          permitsChecked: permitSrc.kind === 'bulk',
          stormMatches,
          neighborReroofs,
          serviceDistanceMi: distanceMi(prop.location, area.center),
          inTargetZip: !!prop.zip && zips.has(prop.zip),
          isDemo: ctx.mode === 'demo',
          demoScenario: scenarios.get(prop.id),
        },
        evidence: [],
      });
    }

    return {
      candidates,
      signalCtx: sctx,
      evidenceCounts: {
        'weather reports (in area, matching types)': events.length,
        'storm events (clustered)': clusters.length,
        'credible storm events': clusters.filter((c) => c.credibility >= 0.6 && !c.uncorroborated).length,
        'known residential reroof permits': knownReroofs.length,
        'known reroofs dated by application date (no issue date)': knownReroofs.filter((p) => !p.issuedDate && p.appliedDate).length,
        'permits ignored as inactive (canceled/withdrawn/expired application)': permits.filter((p) => p.category === 'inactive').length,
        'possible roof work permits (ambiguous)': permits.filter((p) => p.category === 'possible-roof-work').length,
        'solar installation permits': permits.filter((p) => p.category === 'solar').length,
        'permits (all)': permits.length,
        'permits (roof-relevant)': permits.filter((p) => ROOF_CATEGORIES.has(p.category ?? '')).length,
        properties: properties.length,
      },
    };
  },

  enrich: {
    budget: (ctx) => (ctx.mode === 'live' && PERMITS[ctx.market.sources.permit]?.kind === 'lookup' ? resolveTuning(ctx).permitEnrichBudget : 0),
    async run(top, ctx, sctx) {
      const src = PERMITS[ctx.market.sources.permit];
      if (!src?.fetchFor) return {} as Record<string, number>;
      const permits = await tryFetch(ctx, src, () => src.fetchFor!(top.map((c) => c.attributes.property), ctx));
      for (const p of permits) p.category = classifyPermit(p, sctx.tuning, sctx.permitStructure);
      for (const c of top) {
        c.attributes.permits = permits.filter((p) => p.parcelId === c.attributes.property.parcelId && ROOF_CATEGORIES.has(p.category ?? ''));
        c.attributes.permitsChecked = true;
      }
      return { 'permits looked up (top candidates)': permits.length };
    },
  },

  signals: ROOF_SIGNALS,

  gate(s, ctx, sctx) {
    const a = s.candidate.attributes;
    const f = sctx.filters;
    if (a.serviceDistanceMi > sctx.serviceRadiusMi && !a.inTargetZip) return 'Outside service area';
    const t = a.property.propertyType;
    if (t !== 'unknown' && !sctx.propertyTypes.includes(t)) return 'Property type not targeted';
    const info = s.signals.roof_age.detail as { basis: string; years?: number } | undefined;
    if (info?.basis === 'reroof-permit' && (info.years ?? 99) < f.minYearsSinceReroof) return `Reroof permit within ${f.minYearsSinceReroof} yrs (likely already served)`;
    const roof = s.signals.roof_age.fired;
    const storm = s.signals.storm_exposure.fired;
    if (f.requireAgingRoof && !roof) return 'No confident aging-roof signal';
    if (f.requireMultipleSignals && !(roof && storm)) return 'Needs both aging-roof and storm signals';
    if (!roof && !storm && s.signals.roof_age.score < 0.45) return 'No meaningful signal';
    return null;
  },

  tierRequirement(s, req, sctx) {
    const sig = s.signals;
    const info = sig.roof_age.detail as { status?: string } | undefined;
    const clearRoof = sig.roof_age.fired && info?.status !== 'possible-prior-roof-work';
    // Very High: confident aging roof + credible severe storm; no ambiguity flags. Neighborhood rate corroborates via score, not as a gate.
    if (req === 'very-high')
      return clearRoof && !sig.possible_parcel_change.fired && sig.roof_age.confidence >= 0.75 && sig.storm_exposure.fired && sig.storm_severity.score >= 0.6;
    if (req === 'high') return clearRoof && (sig.storm_exposure.fired || sig.neighborhood_reroofs.fired);
    if (req === 'medium') return sig.roof_age.fired || sig.storm_exposure.fired;
    return true;
  },

  explain(s, ctx, sctx) {
    const a = s.candidate.attributes;
    const sig = s.signals;
    const roof = sig.roof_age.fired;
    const storm = sig.storm_exposure.fired;
    const hood = sig.neighborhood_reroofs.fired;
    const info = roofAgeInfo(s.candidate, sctx);
    const m = a.stormMatches[0];
    const possible = info.status === 'possible-prior-roof-work';

    const parts: string[] = [];
    if (roof && !possible) parts.push('Older roof (no known reroof)');
    else if (roof && possible) parts.push('Older roof, but possible prior roof work');
    else if (info.years && info.years >= sctx.filters.minYearsSinceReroof) parts.push('Possibly older roof (low-confidence estimate)');
    if (m) parts.push(`${storm ? 'credible' : 'weak/uncorroborated'} ${WEATHER_LABELS[m.event.type].toLowerCase()} exposure`);
    if (hood && a.neighborReroofs) parts.push(`unusually high nearby post-storm reroof rate (${(a.neighborReroofs.r025.rate * 100).toFixed(0)}% vs ${(a.neighborReroofs.r025.baselineRate * 100).toFixed(0)}% before)`);
    if (info.parcelChange.length) parts.push('possible parcel change');
    const headline = parts.length ? parts.join(' + ').replace(/^./, (c) => c.toUpperCase()) : 'Weak signals';

    const reasons = [
      ...sig.roof_age.facts,
      ...(sctx.permitCoverage === 'full' ? sig.no_newer_reroof.facts.slice(0, 1) : []),
      ...(m ? [...sig.storm_exposure.facts.slice(0, 1), ...sig.storm_exposure.facts.slice(2), ...sig.storm_recency.facts, ...sig.storm_severity.facts] : sig.storm_exposure.facts),
      ...sig.neighborhood_reroofs.facts,
      ...s.crossSignalsApplied.map((c) => `${c.label} (+${c.bonus})`),
      ...(s.penaltiesApplied ?? []).map((p) => `${p.label} (−${p.points})`),
    ];

    let angle: string;
    const when = m ? `${m.daysAgo} days ago` : '';
    if (roof && storm && m)
      angle = `Offer a free roof inspection: ${WEATHER_LABELS[m.event.type].toLowerCase()} was reported nearby ${when}${hood ? ' and several neighbors have since reroofed' : ''}; roof appears ~${info.years} yrs old. Frame it as a check-up, not a damage claim.`;
    else if (storm && m) angle = `Post-storm inspection offer referencing the ${WEATHER_LABELS[m.event.type].toLowerCase()} reported in the area ${when}. Don't lead with roof age.`;
    else if (roof) angle = `Roof-age check-in: roof appears ~${info.years} yrs old. Offer a pre-season inspection / replacement estimate.`;
    else angle = 'Low priority: include in general neighborhood canvassing only.';

    const display = {
      isDemo: a.isDemo,
      demoScenario: a.demoScenario,
      roofStatus: info.status,
      roofBasis: info.basis,
      roofLabel: info.label,
      lastKnownReroof: info.lastReroofYear ?? null,
      originalConstructionPermit: info.houseConstructionYear ?? null,
      houseConstructionPermitId: info.houseConstructionPermitId ?? null,
      yearBuilt: info.yearBuilt ?? null,
      estRoofAgeYears: info.years ?? null,
      roofConfidence: sig.roof_age.confidence,
      possibleRoofWork: info.possibleRoofWork,
      otherRoofPermits: info.otherRoofPermits,
      parcelChange: info.parcelChange,
      lastReroof: info.lastReroof ?? null,
      ignoredAccessoryPermits: info.ignoredAccessoryPermits,
      rejectedHousePermits: info.rejectedHousePermits,
      solar: info.solar ?? null,
      noNewerReroof: sig.no_newer_reroof.facts[0],
      neighborReroofs: a.neighborReroofs ?? null,
      storm: m
        ? {
            type: WEATHER_LABELS[m.event.type],
            date: m.event.date.slice(0, 10),
            daysAgo: m.daysAgo,
            magnitude: magnitudeLabel(m),
            qualifier: m.event.qualifier,
            reporter: m.event.reporterType,
            distanceMi: m.distanceMi,
            severity: +m.severity.toFixed(2),
            severityCapped: m.severityCapped,
            eventId: m.cluster.id,
            eventReports: m.cluster.reportCount,
            eventCredibility: m.cluster.credibility,
            credible: storm,
            remark: m.event.remark,
            source: m.event.source,
            sourceUrl: m.event.sourceUrl,
            otherEvents: a.stormMatches.length - 1,
          }
        : null,
      propertyIndicators: [
        a.property.propertyType !== 'unknown' ? a.property.propertyType : null,
        a.property.yearBuilt ? `Built ${a.property.yearBuilt}` : null,
        a.property.sqft ? `${a.property.sqft.toLocaleString()} sq ft` : null,
        `${a.serviceDistanceMi.toFixed(1)} mi from service center`,
        a.inTargetZip ? `Target ZIP ${a.property.zip}` : null,
      ].filter(Boolean),
      permits: a.permits.map((p) => ({ id: p.id, year: (p.issuedDate ?? p.finalDate)?.slice(0, 4), category: p.category, description: p.description })),
      signalsFired: [roof && 'aging-roof', possible && 'possible-prior-roof-work', info.parcelChange.length && 'possible-parcel-change', info.solar && 'solar', storm && 'credible-storm', hood && 'high-neighbor-reroof-rate'].filter(Boolean),
    };
    return { headline, reasons, angle, display };
  },

  maskLabel: (label) => label.replace(/^\d+/, (n) => `${n[0]}${'x'.repeat(Math.max(0, n.length - 1))}`),

  csvColumns: [
    { header: 'Rank', get: (r) => r.rank },
    { header: 'Priority', get: (r) => r.tier },
    { header: 'Score', get: (r) => r.score },
    { header: 'Address', get: (r) => r.candidate.label },
    { header: 'City', get: (r) => r.candidate.attributes.property.city },
    { header: 'ZIP', get: (r) => r.candidate.attributes.property.zip },
    { header: 'Latitude', get: (r) => r.candidate.location?.lat },
    { header: 'Longitude', get: (r) => r.candidate.location?.lon },
    { header: 'Why it surfaced', get: (r) => r.headline },
    { header: 'Roof age basis', get: (r) => String(r.display.roofLabel ?? '') },
    { header: 'Last known reroof', get: (r) => (r.display.lastKnownReroof as number) ?? '' },
    { header: 'Est. roof age (yrs)', get: (r) => (r.display.estRoofAgeYears as number) ?? '' },
    { header: 'Roof-age confidence', get: (r) => r.signals.roof_age.confidence },
    { header: 'Roof status', get: (r) => String(r.display.roofStatus ?? '') },
    { header: 'Storm type', get: (r) => (r.display.storm as any)?.type ?? '' },
    { header: 'Storm date', get: (r) => (r.display.storm as any)?.date ?? '' },
    { header: 'Storm magnitude', get: (r) => (r.display.storm as any)?.magnitude ?? '' },
    { header: 'Distance to report (mi)', get: (r) => (r.display.storm as any)?.distanceMi ?? '' },
    { header: 'Nearby post-storm reroof rate (0.25 mi)', get: (r) => { const n = r.display.neighborReroofs as any; return n ? `${n.r025.reroofed}/${n.r025.eligible} (${(n.r025.rate * 100).toFixed(1)}%; prior ${(n.r025.baselineRate * 100).toFixed(1)}%)` : ''; } },
    { header: 'Reasons', get: (r) => r.reasons.join(' | ') },
    { header: 'Suggested angle', get: (r) => r.angle },
    { header: 'Data confidence', get: (r) => r.confidence },
    { header: 'Demo data', get: (r) => (r.candidate.attributes.isDemo ? 'YES (fictional)' : '') },
  ],
};
