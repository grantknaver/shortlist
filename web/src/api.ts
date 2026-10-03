/** Thin API client. No secrets here — only the customer's access key, sent as a header. */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface ServiceAreaInfo {
  id: string;
  label: string;
  market: { id: string; name: string; notes: string[]; reroofPermitCoverage: 'full' | 'partial' };
}

export interface Session {
  customer: { id: string; name: string; plan: 'full' | 'sample'; features: { export: boolean; liveData: boolean } };
  vertical: { id: string; label: string; disclaimers: string[] };
  serviceAreas: ServiceAreaInfo[];
  defaultFilters: Filters;
  usage: { month: string; runs: number };
}

export interface Filters {
  minYearsSinceReroof: number;
  stormLookbackDays: number;
  weatherTypes: string[];
  minSeverity: number;
  maxDistanceMi: number;
  limit: number;
  minScore: number;
  prioritizeRecentStorm: boolean;
  requireAgingRoof: boolean;
  requireMultipleSignals: boolean;
}

export interface StormDisplay {
  type: string;
  date: string;
  daysAgo: number;
  magnitude: string;
  distanceMi: number;
  severity: number;
  remark?: string;
  source: string;
  sourceUrl?: string;
  otherReports: number;
}

export interface Result {
  rank: number;
  score: number;
  tier: string;
  confidence: number;
  headline: string;
  reasons: string[];
  angle: string;
  candidate: { id: string; label: string; location?: { lat: number; lon: number }; attributes: { property: { city?: string; zip?: string } } };
  breakdown: { signal: string; label: string; weight: number; score: number; points: number }[];
  crossSignalsApplied: { id: string; label: string; bonus: number }[];
  display: {
    isDemo: boolean;
    demoScenario?: string;
    roofBasis: string;
    roofLabel: string;
    lastKnownReroof: number | null;
    originalConstructionPermit: number | null;
    yearBuilt: number | null;
    estRoofAgeYears: number | null;
    roofConfidence: number;
    noNewerReroof: string;
    storm: StormDisplay | null;
    propertyIndicators: string[];
    permits: { id: string; year?: string; category?: string; description: string }[];
    signalsFired: string[];
  };
}

export interface RunResult {
  runId: string;
  generatedAt: string;
  mode: 'demo' | 'live';
  market: { id: string; name: string };
  plan: string;
  stats: {
    candidatesScanned: number;
    evidenceItems: Record<string, number>;
    excluded: Record<string, number>;
    passedFilters: number;
    returned: number;
    durationMs: number;
  };
  sources: { id: string; label: string; ok: boolean; records: number; mode: string; note?: string }[];
  warnings: string[];
  disclaimers: string[];
  results: Result[];
}

async function call<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-customer-key': key, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  session: (key: string) => call<Session>(key, '/api/session'),
  run: (key: string, body: { mode: 'demo' | 'live'; serviceAreaId: string; filters: Filters }) =>
    call<RunResult>(key, '/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  async exportCsv(key: string, runId: string, ids?: string[]) {
    const q = ids?.length ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
    const res = await fetch(`${BASE}/api/runs/${runId}/export.csv${q}`, { headers: { 'x-customer-key': key } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Export failed');
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'opportunities.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};
