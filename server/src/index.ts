import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { customersWithoutKeys, findCustomerByKey, getMarket, loadConfig, type CustomerConfig } from './core/config.js';
import { createContext } from './core/context.js';
import { runPipeline } from './core/pipeline.js';
import { toCsv } from './core/csv.js';
import { usageFor } from './core/usage.js';
import type { RunResult } from './core/types.js';
import { VERTICALS } from './verticals/registry.js';

const app = express();
app.use(cors({ origin: env.CORS_ORIGINS }));
app.use(express.json({ limit: '1mb' }));

// Keep recent runs in memory for export (MVP; persisted history deferred)
const runs = new Map<string, RunResult>();
function remember(r: RunResult) {
  runs.set(r.runId, r);
  if (runs.size > 50) runs.delete(runs.keys().next().value!);
}

function auth(req: express.Request, res: express.Response): CustomerConfig | null {
  const key = (req.header('x-customer-key') ?? (req.query.key as string | undefined))?.trim();
  const c = findCustomerByKey(key);
  if (!c) {
    res.status(401).json({ error: 'Invalid or missing access key' });
    return null;
  }
  return c;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/session', (req, res) => {
  const c = auth(req, res);
  if (!c) return;
  const pack = VERTICALS[c.vertical];
  res.json({
    customer: { id: c.id, name: c.name, plan: c.plan, features: c.features },
    vertical: { id: pack.id, label: pack.label, disclaimers: pack.disclaimers },
    serviceAreas: c.serviceAreas.map((a) => {
      const m = getMarket(a.market);
      return {
        id: a.id,
        label: a.label,
        market: { id: m.id, name: m.name, notes: m.notes, reroofPermitCoverage: m.settings.reroofPermitCoverage ?? 'partial' },
      };
    }),
    defaultFilters: { ...pack.defaultFilters, ...c.filters },
    usage: usageFor(c.id),
  });
});

app.post('/api/runs', async (req, res) => {
  const c = auth(req, res);
  if (!c) return;
  const pack = VERTICALS[c.vertical];
  const body = req.body ?? {};
  const mode: 'demo' | 'live' = body.mode === 'live' && c.features.liveData ? 'live' : 'demo';
  const area = c.serviceAreas.find((a) => a.id === body.serviceAreaId) ?? c.serviceAreas[0];
  try {
    const market = getMarket(area.market);
    const filters = { ...(body.filters ?? {}) };
    const ctx = createContext({ customer: c, serviceArea: area, market, filters, mode });
    const f = { ...pack.defaultFilters, ...c.filters, ...filters } as { limit: number; minScore: number };
    const limit = Math.min(Number(f.limit) || 25, c.maxResultsPerRun, c.plan === 'sample' ? 10 : Infinity);
    const result = await runPipeline(pack, ctx, { limit, minScore: Number(f.minScore) || 0 });
    remember(result);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/runs/:id/export.csv', (req, res) => {
  const c = auth(req, res);
  if (!c) return;
  if (c.plan === 'sample' || !c.features.export) return res.status(403).json({ error: 'Export is not included in the free sample.' });
  const run = runs.get(req.params.id);
  if (!run || run.customerId !== c.id) return res.status(404).json({ error: 'Run not found (runs are kept in memory; rerun and export again).' });
  const pack = VERTICALS[run.vertical];
  const ids = typeof req.query.ids === 'string' && req.query.ids ? new Set(req.query.ids.split(',')) : null;
  const rows = ids ? run.results.filter((r) => ids.has(r.candidate.id)) : run.results;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="opportunities-${run.market.id}-${run.generatedAt.slice(0, 10)}.csv"`);
  res.send(toCsv(rows, pack.csvColumns));
});

loadConfig();
app.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`);
  const missing = customersWithoutKeys();
  if (missing.length) console.warn(`[auth] no access key set (customer cannot sign in): ${missing.join(', ')}`);
});
