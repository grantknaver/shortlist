/** Run the pipeline in demo mode for each service area and print a ranked table. */
import { findCustomerById, getMarket } from '../src/core/config.js';
import { createContext } from '../src/core/context.js';
import { runPipeline } from '../src/core/pipeline.js';
import { VERTICALS } from '../src/verticals/registry.js';

const c = findCustomerById(process.argv[2] ?? 'demo')!;
const mode = (process.argv[3] as 'demo' | 'live') ?? 'demo';
for (const area of c.serviceAreas) {
  const ctx = createContext({ customer: c, serviceArea: area, market: getMarket(area.market), filters: {}, mode });
  const r = await runPipeline(VERTICALS.roofing, ctx, { limit: 50, minScore: 0 });
  console.log(`\n=== ${area.label} (${mode}) — ${r.results.length} results, excluded:`, r.stats.excluded);
  for (const x of r.results)
    console.log(
      `${String(x.rank).padStart(2)} ${x.tier.padEnd(9)} ${String(x.score).padStart(3)} conf=${x.confidence} ${x.candidate.label.padEnd(28)} | ${x.headline} | ${x.display.demoScenario ?? ''}`,
    );
  if (r.warnings.length) console.log('warnings:', r.warnings);
}
