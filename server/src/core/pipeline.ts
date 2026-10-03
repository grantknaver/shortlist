/**
 * The generic run pipeline. One "Find Opportunities" press = one runPipeline() call.
 *
 *   gather (pull → normalize → candidates → spatial match)
 *   → preliminary score → budgeted enrichment → rescore
 *   → explain → gate → rank → results
 */
import type { RunContext } from './context.js';
import type { Candidate, RunResult, ScoredCandidate, SignalResult } from './types.js';
import type { VerticalPack } from './vertical.js';
import { assignRelativeTiers, scoreCandidate } from './scoring.js';
import { recordRun } from './usage.js';

export interface PipelineOptions {
  limit: number;
  minScore: number;
}

function computeSignals<C extends Candidate, S>(pack: VerticalPack<C, S>, c: C, sctx: S) {
  const out: Record<string, SignalResult> = {};
  for (const def of pack.signals) out[def.id] = def.compute(c, sctx);
  return out;
}

export async function runPipeline<C extends Candidate, S>(
  pack: VerticalPack<C, S>,
  ctx: RunContext,
  opts: PipelineOptions,
): Promise<RunResult<C>> {
  const t0 = Date.now();
  const scoring = pack.buildScoring(ctx);

  const { candidates, signalCtx, evidenceCounts } = await pack.gather(ctx);
  ctx.log(`gathered ${candidates.length} candidates`);

  let scored = candidates.map((c) => scoreCandidate(c, computeSignals(pack, c, signalCtx), scoring));

  if (pack.enrich) {
    const k = pack.enrich.budget(ctx);
    const top = [...scored].sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.candidate);
    if (top.length) {
      const counts = await pack.enrich.run(top, ctx, signalCtx);
      for (const [key, v] of Object.entries(counts)) evidenceCounts[key] = (evidenceCounts[key] ?? 0) + v;
      const ids = new Set(top.map((c) => c.id));
      scored = scored.map((s) =>
        ids.has(s.candidate.id) ? scoreCandidate(s.candidate, computeSignals(pack, s.candidate, signalCtx), scoring) : s,
      );
    }
  }

  const excluded: Record<string, number> = {};
  const kept: ScoredCandidate<C>[] = [];
  for (const s of scored) {
    const full = { ...s, ...pack.explain(s, ctx, signalCtx) } as ScoredCandidate<C>;
    const reason = pack.gate(full, ctx, signalCtx) ?? (full.score < opts.minScore ? 'Below minimum score' : null);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    else kept.push(full);
  }

  kept.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.candidate.id.localeCompare(b.candidate.id));
  if (scoring.relativeTiers?.length)
    assignRelativeTiers(kept, scoring.relativeTiers, (s, req) => (pack.tierRequirement ? pack.tierRequirement(s, req, signalCtx) : true));
  const results = kept.slice(0, opts.limit).map((r, i) => ({ ...r, rank: i + 1 }));

  if (ctx.customer.maskAddresses)
    for (const r of results) r.candidate = { ...r.candidate, label: pack.maskLabel(r.candidate.label) };

  recordRun(ctx.customer.id, { runId: ctx.runId, mode: ctx.mode, results: results.length, externalCalls: ctx.externalCalls });

  return {
    runId: ctx.runId,
    generatedAt: ctx.now.toISOString(),
    mode: ctx.mode,
    vertical: pack.id,
    market: { id: ctx.market.id, name: ctx.market.name },
    customerId: ctx.customer.id,
    plan: ctx.customer.plan,
    filters: ctx.filters,
    stats: {
      candidatesScanned: candidates.length,
      evidenceItems: evidenceCounts,
      excluded,
      passedFilters: kept.length,
      returned: results.length,
      durationMs: Date.now() - t0,
    },
    sources: ctx.sources,
    warnings: ctx.warnings,
    disclaimers: pack.disclaimers,
    results,
  };
}
