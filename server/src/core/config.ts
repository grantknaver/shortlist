/**
 * Per-market and per-customer configuration, loaded from JSON files.
 * config/markets/<id>.json   — geography + which adapters serve the market
 * config/customers/<id>.json — the roofer's service area, plan, limits, scoring overrides
 *
 * Deliberately file-based: a setup engagement = editing one customer JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const geo = z.object({ lat: z.number(), lon: z.number() });

export const MarketSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  center: geo,
  /** adapter ids per source kind, e.g. { property: 'portlandmaps', permit: 'portlandmaps', weather: 'iem-lsr' } */
  sources: z.record(z.string(), z.string()),
  /** CSV paths (relative to server root) used by csv adapters */
  csv: z.record(z.string(), z.string()).default({}),
  /** vertical/market specific settings (e.g. nwsOffices, reroofPermitCoverage) */
  settings: z.record(z.string(), z.unknown()).default({}),
  notes: z.array(z.string()).default([]),
});
export type MarketConfig = z.infer<typeof MarketSchema>;

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** simple shared-secret access key (MVP; real auth deferred) */
  accessKey: z.string(),
  vertical: z.string(),
  /** 'full' = paying customer; 'sample' = free sales sample (≤10 results, no export) */
  plan: z.enum(['full', 'sample']),
  /** one or more service areas; each is bound to a market (geography + data adapters) */
  serviceAreas: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        market: z.string(),
        center: geo,
        radiusMi: z.number().positive(),
        zips: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  propertyTypes: z.array(z.string()).default(['residential']),
  /** default UI filters (vertical-defined keys) */
  filters: z.record(z.string(), z.unknown()).default({}),
  /** partial override of the vertical's scoring config */
  scoring: z
    .object({
      weights: z.record(z.string(), z.number()).optional(),
      tiers: z.array(z.object({ label: z.string(), min: z.number() })).optional(),
      confidenceFloor: z.number().optional(),
    })
    .default({}),
  /** vertical-specific tuning (roof age curve, storm recency buckets, severity tables…) */
  tuning: z.record(z.string(), z.unknown()).default({}),
  features: z
    .object({
      export: z.boolean().default(true),
      liveData: z.boolean().default(true),
    })
    .default({ export: true, liveData: true }),
  /** hard cap on results per run (sample plan is additionally capped at 10) */
  maxResultsPerRun: z.number().int().positive().default(100),
  /** mask house numbers in results (useful for public sales samples) */
  maskAddresses: z.boolean().default(false),
});
export type CustomerConfig = z.infer<typeof CustomerSchema>;

const ROOT = process.cwd();

function readJsonDir<T>(dir: string, schema: z.ZodType<T>): Map<string, T> {
  const out = new Map<string, T>();
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.json')) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[config] invalid ${dir}/${f}:`, parsed.error.issues);
      continue;
    }
    out.set((parsed.data as { id: string }).id, parsed.data);
  }
  return out;
}

let markets: Map<string, MarketConfig> | null = null;
let customers: Map<string, CustomerConfig> | null = null;

export function loadConfig(force = false) {
  if (!markets || force) markets = readJsonDir('config/markets', MarketSchema);
  if (!customers || force) customers = readJsonDir('config/customers', CustomerSchema);
  return { markets, customers };
}

export function getMarket(id: string): MarketConfig {
  const m = loadConfig().markets.get(id);
  if (!m) throw new Error(`Unknown market: ${id}`);
  return m;
}

export function findCustomerByKey(key: string | undefined): CustomerConfig | undefined {
  if (!key) return undefined;
  for (const c of loadConfig().customers.values()) if (c.accessKey === key) return c;
  return undefined;
}

export function resolveServerPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}
