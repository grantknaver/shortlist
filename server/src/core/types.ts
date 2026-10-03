/**
 * CORE ENGINE TYPES — vertical-agnostic.
 *
 * Nothing in /core knows about roofs. A vertical (roofing, salons, chiropractors…)
 * supplies source adapters, signal definitions, scoring defaults, prompts and
 * presentation. The core runs the pipeline:
 *
 *   sources → normalize → candidates → (enrich) → signals → score → gate/rank → explain → results
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type Confidence = 'high' | 'medium' | 'low';

/** A single, source-attributed fact attached to a candidate. Claude may only reason over these. */
export interface Evidence {
  id: string;
  /** e.g. 'permit', 'weather-report', 'assessor', 'web-context' */
  kind: string;
  /** adapter id, e.g. 'portlandmaps-permit', 'iem-lsr', 'demo' */
  source: string;
  sourceUrl?: string;
  /** ISO date of the underlying fact */
  date?: string;
  location?: GeoPoint;
  summary: string;
  data: Record<string, unknown>;
  confidence: Confidence;
}

/** Something we might prospect: a property, a business, a household… */
export interface Candidate<A = any> {
  id: string;
  label: string; // display name / address
  location?: GeoPoint;
  attributes: A;
  evidence: Evidence[];
}

export interface SignalResult {
  id: string;
  label: string;
  /** 0..1 strength of this signal */
  score: number;
  /** true when the signal is meaningfully present (used for "multiple signals" gating + headlines) */
  fired: boolean;
  /** 0..1 how much we trust the inputs */
  confidence: number;
  /** human-readable, factual statements derived from evidence */
  facts: string[];
  detail?: Record<string, unknown>;
}

export interface SignalDefinition<C extends Candidate = Candidate, Ctx = unknown> {
  id: string;
  label: string;
  compute(candidate: C, ctx: Ctx): SignalResult;
}

export interface CrossSignalRule {
  id: string;
  label: string;
  /** every listed signal must have score >= minScore (and be fired, if mustFire) */
  requires: { signal: string; minScore: number; mustFire?: boolean }[];
  /** points (0..100 scale) added to the final score */
  bonus: number;
}

export interface Tier {
  label: string;
  min: number;
}

export interface PenaltyRule {
  id: string;
  label: string;
  /** applied when this signal fired */
  signal: string;
  points: number;
}

/**
 * Relative tiering: tiers are assigned by rank within the qualified results AND per-tier
 * evidence requirements (checked by the vertical). A candidate that is inside a tier's
 * percentile band but fails its requirements falls to the next tier it qualifies for.
 */
export interface RelativeTier {
  label: string;
  /** cumulative top-percent of qualified results (e.g. 1.5 = top 1.5%) */
  topPercent: number;
  /** requirement id evaluated by the vertical's tierRequirement() */
  requirement?: string;
}

export interface ScoringConfig {
  /** relative weights per signal id; normalized at run time */
  weights: Record<string, number>;
  crossSignals: CrossSignalRule[];
  penalties?: PenaltyRule[];
  relativeTiers?: RelativeTier[];
  tiers: Tier[];
  /** final = raw * (confidenceFloor + (1-confidenceFloor) * weightedConfidence) */
  confidenceFloor: number;
}

export interface ScoreBreakdownItem {
  signal: string;
  label: string;
  weight: number; // normalized 0..1
  score: number; // 0..1
  points: number; // contribution on 0..100 scale
}

export interface ScoredCandidate<C extends Candidate = Candidate> {
  candidate: C;
  signals: Record<string, SignalResult>;
  breakdown: ScoreBreakdownItem[];
  crossSignalsApplied: { id: string; label: string; bonus: number }[];
  penaltiesApplied?: { id: string; label: string; points: number }[];
  /** why the candidate did not receive a higher tier (relative tiering) */
  tierNote?: string;
  confidence: number;
  score: number; // 0..100
  tier: string;
  rank?: number;
  /** deterministic explanation; always present */
  headline: string;
  reasons: string[];
  angle: string;
  /** vertical-specific display fields (e.g. last reroof, storm date) */
  display: Record<string, unknown>;
  /** optional Claude-polished text; never replaces the facts */
  ai?: { summary: string; angle: string; model: string };
}

export interface RunStats {
  candidatesScanned: number;
  evidenceItems: Record<string, number>;
  excluded: Record<string, number>;
  passedFilters: number;
  returned: number;
  durationMs: number;
}

export interface SourceStatus {
  id: string;
  label: string;
  ok: boolean;
  records: number;
  mode: 'live' | 'demo' | 'csv' | 'cache';
  note?: string;
}

export interface RunResult<C extends Candidate = Candidate> {
  runId: string;
  generatedAt: string;
  mode: 'demo' | 'live';
  vertical: string;
  market: { id: string; name: string };
  customerId: string;
  plan: string;
  filters: Record<string, unknown>;
  stats: RunStats;
  sources: SourceStatus[];
  warnings: string[];
  disclaimers: string[];
  results: ScoredCandidate<C>[];
}
