/**
 * A VerticalPack is everything that makes the generic engine "roofing" (or "salons"…).
 * The core pipeline only talks to this interface.
 *
 * Deferred extension points (add when lead quality is validated):
 *   - ai: evidence packets + prompts for Claude explanations/outreach
 *   - supplemental: open-web context (Perplexity)
 */
import type { RunContext } from './context.js';
import type { Candidate, ScoredCandidate, ScoringConfig, SignalDefinition } from './types.js';

export interface GatherResult<C extends Candidate, SCtx> {
  candidates: C[];
  /** shared context for signal computation (resolved filters/tuning, etc.) */
  signalCtx: SCtx;
  evidenceCounts: Record<string, number>;
}

export interface CsvColumn<C extends Candidate> {
  header: string;
  get: (r: ScoredCandidate<C>) => string | number | undefined;
}

export type Explained = { headline: string; reasons: string[]; angle: string; display: Record<string, unknown> };

export interface VerticalPack<C extends Candidate = Candidate, SCtx = unknown> {
  id: string;
  label: string;
  defaultFilters: Record<string, unknown>;
  disclaimers: string[];

  buildScoring(ctx: RunContext): ScoringConfig;

  /** Pull + normalize + build candidates (+ deterministic spatial matching). */
  gather(ctx: RunContext): Promise<GatherResult<C, SCtx>>;

  /** Optional budgeted enrichment of top-K preliminary candidates (e.g. per-property permit lookups). */
  enrich?: {
    budget: (ctx: RunContext) => number;
    run: (top: C[], ctx: RunContext, sctx: SCtx) => Promise<Record<string, number>>;
  };

  signals: SignalDefinition<C, SCtx>[];

  /** Return an exclusion reason or null to keep. */
  gate(s: ScoredCandidate<C>, ctx: RunContext, sctx: SCtx): string | null;

  /** Deterministic explanation — the product's "why". */
  explain(s: Omit<ScoredCandidate<C>, keyof Explained>, ctx: RunContext, sctx: SCtx): Explained;

  /** evidence requirement check for relative tiers (e.g. 'very-high', 'high') */
  tierRequirement?(s: ScoredCandidate<C>, requirement: string, sctx: SCtx): boolean;

  maskLabel(label: string): string;
  csvColumns: CsvColumn<C>[];
}
