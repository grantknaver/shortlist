import type { CustomerConfig, MarketConfig } from './config.js';
import type { SourceStatus } from './types.js';

export type ServiceArea = CustomerConfig['serviceAreas'][number];

export interface RunContext {
  runId: string;
  now: Date;
  mode: 'demo' | 'live';
  customer: CustomerConfig;
  serviceArea: ServiceArea;
  market: MarketConfig;
  filters: Record<string, unknown>;
  warnings: string[];
  sources: SourceStatus[];
  externalCalls: number;
  log: (msg: string) => void;
}

export function createContext(args: {
  customer: CustomerConfig;
  serviceArea: ServiceArea;
  market: MarketConfig;
  filters: Record<string, unknown>;
  mode: 'demo' | 'live';
  now?: Date;
}): RunContext {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    runId,
    now: args.now ?? new Date(),
    mode: args.mode,
    customer: args.customer,
    serviceArea: args.serviceArea,
    market: args.market,
    filters: args.filters,
    warnings: [],
    sources: [],
    externalCalls: 0,
    log: (msg) => console.log(`[${runId}] ${msg}`),
  };
}
