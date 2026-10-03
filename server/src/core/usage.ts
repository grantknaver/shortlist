/**
 * Minimal run log per customer per month (data/usage.json).
 * Advanced usage controls / cost limits are deliberately deferred until lead quality is validated.
 * NOTE: on Render, attach a persistent disk or this resets on deploy.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RunLogEntry {
  ts: string;
  runId: string;
  mode: 'demo' | 'live';
  results: number;
  externalCalls: number;
}

type Store = Record<string, Record<string, { runs: number; recent: RunLogEntry[] }>>;

const FILE = path.join(process.cwd(), 'data', 'usage.json');

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function recordRun(customerId: string, entry: Omit<RunLogEntry, 'ts'>) {
  const s = load();
  const month = new Date().toISOString().slice(0, 7);
  const c = (s[customerId] ??= {});
  const m = (c[month] ??= { runs: 0, recent: [] });
  m.runs++;
  m.recent = [{ ts: new Date().toISOString(), ...entry }, ...m.recent].slice(0, 100);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export function usageFor(customerId: string) {
  const month = new Date().toISOString().slice(0, 7);
  return { month, runs: load()[customerId]?.[month]?.runs ?? 0 };
}
