import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { Candidate, ScoredCandidate } from './types.js';
import type { CsvColumn } from './vertical.js';

export function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8');
  return parse(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
}

export function toCsv<C extends Candidate>(rows: ScoredCandidate<C>[], cols: CsvColumn<C>[]): string {
  return stringify([cols.map((c) => c.header), ...rows.map((r) => cols.map((c) => c.get(r) ?? ''))]);
}
