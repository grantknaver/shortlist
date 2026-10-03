/**
 * Explainable, deterministic, configurable scoring. No black box.
 *
 * score = Σ(weight_i × signal_i)/Σweight × 100          (weighted average)
 *       + Σ cross-signal bonuses (e.g. aging roof AND storm exposure)
 *       × confidence adjustment                          (low-confidence data scores lower)
 *       → clamped to 0..100 → tier
 */
import type { Candidate, ScoringConfig, ScoredCandidate, SignalResult, ScoreBreakdownItem } from './types.js';

export function mergeScoring(base: ScoringConfig, override?: Partial<ScoringConfig>): ScoringConfig {
  if (!override) return base;
  return {
    weights: { ...base.weights, ...(override.weights ?? {}) },
    crossSignals: override.crossSignals ?? base.crossSignals,
    penalties: override.penalties ?? base.penalties,
    relativeTiers: override.relativeTiers ?? base.relativeTiers,
    tiers: override.tiers ?? base.tiers,
    confidenceFloor: override.confidenceFloor ?? base.confidenceFloor,
  };
}

export function scoreCandidate<C extends Candidate>(
  candidate: C,
  signals: Record<string, SignalResult>,
  cfg: ScoringConfig,
): Omit<ScoredCandidate<C>, 'headline' | 'reasons' | 'angle' | 'display'> {
  const entries = Object.entries(cfg.weights).filter(([id, w]) => w > 0 && signals[id]);
  const totalW = entries.reduce((s, [, w]) => s + w, 0) || 1;

  const breakdown: ScoreBreakdownItem[] = entries.map(([id, w]) => {
    const s = signals[id];
    const weight = w / totalW;
    return { signal: id, label: s.label, weight, score: s.score, points: +(weight * s.score * 100).toFixed(1) };
  });
  let raw = breakdown.reduce((s, b) => s + b.points, 0);

  const crossSignalsApplied: ScoredCandidate['crossSignalsApplied'] = [];
  for (const rule of cfg.crossSignals) {
    const ok = rule.requires.every(
      (r) => (signals[r.signal]?.score ?? 0) >= r.minScore && (!r.mustFire || signals[r.signal]?.fired),
    );
    if (ok) {
      raw += rule.bonus;
      crossSignalsApplied.push({ id: rule.id, label: rule.label, bonus: rule.bonus });
    }
  }

  const penaltiesApplied: { id: string; label: string; points: number }[] = [];
  for (const pen of cfg.penalties ?? []) {
    if (signals[pen.signal]?.fired) {
      raw -= pen.points;
      penaltiesApplied.push({ id: pen.id, label: pen.label, points: pen.points });
    }
  }

  // confidence weighted by each signal's contribution
  const contrib = breakdown.reduce((s, b) => s + b.points, 0) || 1;
  const confidence =
    breakdown.reduce((s, b) => s + b.points * (signals[b.signal].confidence ?? 1), 0) / contrib;
  const adj = cfg.confidenceFloor + (1 - cfg.confidenceFloor) * confidence;
  const score = Math.round(Math.max(0, Math.min(100, raw * adj)));

  const tier = [...cfg.tiers].sort((a, b) => b.min - a.min).find((t) => score >= t.min)?.label ?? 'Low';
  return { candidate, signals, breakdown, crossSignalsApplied, penaltiesApplied, confidence: +confidence.toFixed(2), score, tier };
}

/**
 * Assign tiers by rank within qualified results + evidence requirements.
 * `kept` must be sorted best-first.
 */
export function assignRelativeTiers<C extends Candidate>(
  kept: ScoredCandidate<C>[],
  tiers: import('./types.js').RelativeTier[],
  meets: (s: ScoredCandidate<C>, requirement: string) => boolean,
) {
  const n = kept.length;
  const bands = tiers.map((t) => ({ ...t, maxRank: Math.max(1, Math.ceil((n * t.topPercent) / 100)) }));
  kept.forEach((s, i) => {
    const rank = i + 1;
    const skipped: string[] = [];
    let assigned = bands[bands.length - 1].label;
    for (const b of bands) {
      if (rank > b.maxRank) continue;
      if (b.requirement && !meets(s, b.requirement)) {
        skipped.push(b.label);
        continue;
      }
      assigned = b.label;
      break;
    }
    s.tier = assigned;
    if (skipped.length) s.tierNote = `Rank #${rank} but did not meet evidence requirements for: ${skipped.join(', ')}`;
  });
}
