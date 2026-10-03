/**
 * LIVE AUDIT RUN — runs the engine against live sources and dumps every qualified candidate with
 * its full raw evidence so each result can be checked against source records.
 *
 *   npx tsx scripts/audit.ts <serviceAreaId> <outDir> [--no-neighborhood]
 * --no-neighborhood is a diagnostic ablation (neighborhood weight + bonus off) used only to
 * measure how much that signal changes ranking.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findCustomerByKey, getMarket } from '../src/core/config.js';
import { createContext } from '../src/core/context.js';
import { runPipeline } from '../src/core/pipeline.js';
import { VERTICALS } from '../src/verticals/registry.js';
import { DEFAULT_SCORING } from '../src/verticals/roofing/defaults.js';
import type { RoofCandidate } from '../src/verticals/roofing/types.js';
import type { ScoredCandidate } from '../src/core/types.js';

const args = process.argv.slice(2);
const areaId = args[0] ?? 'bend';
const outDir = args[1] ?? 'audit';
const ablate = args.includes('--no-neighborhood');
const countMode = args.includes('--neighborhood-count');
const base = findCustomerByKey('demo')!;
const customer = {
  ...base,
  maxResultsPerRun: 1e9,
  scoring: ablate
    ? { weights: { neighborhood_reroofs: 0 }, crossSignals: DEFAULT_SCORING.crossSignals.filter((c) => c.id !== 'storm_plus_neighbor_reroofs') }
    : base.scoring,
  tuning: countMode ? { neighborhood: { mode: 'count' } } : base.tuning,
};
const area = customer.serviceAreas.find((a) => a.id === areaId)!;
const ctx = createContext({ customer: customer as any, serviceArea: area, market: getMarket(area.market), filters: {}, mode: 'live' });
const r = await runPipeline(VERTICALS.roofing, ctx, { limit: 1e9, minScore: 35 });

const tiers: Record<string, number> = {};
for (const x of r.results) tiers[x.tier] = (tiers[x.tier] ?? 0) + 1;
const scores = r.results.map((x) => x.score).sort((a, b) => a - b);
const q = (p: number) => scores[Math.min(scores.length - 1, Math.floor((p / 100) * scores.length))];
const hist: Record<string, number> = {};
for (const sc of scores) {
  const b = `${Math.floor(sc / 10) * 10}-${Math.floor(sc / 10) * 10 + 9}`;
  hist[b] = (hist[b] ?? 0) + 1;
}

function row(x: ScoredCandidate<RoofCandidate>) {
  const a = x.candidate.attributes;
  const d = x.display as any;
  return {
    rank: x.rank,
    tier: x.tier,
    tierNote: x.tierNote,
    score: x.score,
    confidence: x.confidence,
    headline: x.headline,
    address: x.candidate.label,
    taxlot: a.property.parcelId,
    lat: x.candidate.location?.lat,
    lon: x.candidate.location?.lon,
    parcelUrl: a.property.sourceUrl,
    yearBuilt: a.property.yearBuilt ?? null,
    roofStatus: d.roofStatus,
    roofBasis: d.roofBasis,
    estRoofAgeYears: d.estRoofAgeYears,
    roofConfidence: x.signals.roof_age.confidence,
    houseConstructionPermit: d.houseConstructionPermitId ? { id: d.houseConstructionPermitId, year: d.originalConstructionPermit } : null,
    lastKnownReroof: d.lastKnownReroof,
    lastReroof: d.lastReroof,
    possibleRoofWork: d.possibleRoofWork,
    otherRoofPermits: d.otherRoofPermits,
    parcelChange: d.parcelChange,
    ignoredAccessoryPermits: d.ignoredAccessoryPermits,
    rejectedHousePermits: d.rejectedHousePermits,
    solar: d.solar,
    newerReroofPermitExists: x.signals.no_newer_reroof.score === 0,
    permits: a.permits.map((p) => ({ id: p.id, category: p.category, issued: p.issuedDate?.slice(0, 10), applied: p.appliedDate?.slice(0, 10), status: p.status, workClass: p.workClass, useType: p.useType, desc: p.description, url: p.sourceUrl })),
    neighborhoodSignal: { score: +x.signals.neighborhood_reroofs.score.toFixed(3), fired: x.signals.neighborhood_reroofs.fired, detail: x.signals.neighborhood_reroofs.detail },
    storm: d.storm,
    neighborReroofs: a.neighborReroofs ?? null,
    serviceDistanceMi: +a.serviceDistanceMi.toFixed(2),
    signalsFired: d.signalsFired,
    breakdown: Object.fromEntries(x.breakdown.map((b) => [b.signal, { score: +b.score.toFixed(3), points: b.points }])),
    crossSignals: x.crossSignalsApplied.map((cs) => `${cs.id}+${cs.bonus}`),
    penalties: (x.penaltiesApplied ?? []).map((p) => `${p.id}-${p.points}`),
    reasons: x.reasons,
  };
}

const rows = r.results.map(row);
fs.mkdirSync(outDir, { recursive: true });
const summary = {
  runId: r.runId,
  generatedAt: r.generatedAt,
  ablation: ablate ? 'neighborhood_reroofs weight=0 and its cross-signal removed' : countMode ? 'neighborhood scored by RAW COUNT (previous method) instead of rate' : null,
  filters: { ...VERTICALS.roofing.defaultFilters },
  serviceArea: area,
  stats: r.stats,
  qualified: r.results.length,
  tiers,
  scoreDistribution: { min: scores[0], p25: q(25), median: q(50), p75: q(75), p90: q(90), p98: q(98), max: scores[scores.length - 1], histogram: hist },
  sources: r.sources,
  warnings: r.warnings,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, 'top100_evidence.json'), JSON.stringify(rows.slice(0, 100), null, 2));
fs.writeFileSync(path.join(outDir, 'ranking.json'), JSON.stringify(rows.map((x) => ({ rank: x.rank, taxlot: x.taxlot, score: x.score, tier: x.tier, roofStatus: x.roofStatus, signalsFired: x.signalsFired, nbr: x.neighborReroofs?.within025 ?? 0, nbrRate: x.neighborReroofs?.r025?.rate ?? 0, nbrBase: x.neighborReroofs?.r025?.baselineRate ?? 0, nbrFired: x.neighborhoodSignal.fired, stormEvent: x.storm?.eventId ?? null }))));
console.log(JSON.stringify(summary, null, 2));
