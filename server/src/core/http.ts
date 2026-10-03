/**
 * Small fetch wrapper: timeout, polite User-Agent, and an on-disk TTL cache so
 * repeated button presses don't hammer public APIs (or cost money).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../env.js';

const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');

export async function httpGet(
  url: string,
  opts: { ttlSec?: number; headers?: Record<string, string>; cacheKeyUrl?: string } = {},
): Promise<{ body: string; cached: boolean }> {
  const key = crypto.createHash('sha1').update(opts.cacheKeyUrl ?? url).digest('hex');
  const file = path.join(CACHE_DIR, `${key}.txt`);
  if (opts.ttlSec && fs.existsSync(file)) {
    const age = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
    if (age < opts.ttlSec) return { body: fs.readFileSync(file, 'utf8'), cached: true };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `OpportunityFinder/0.1 (${env.CONTACT_EMAIL})`, Accept: 'application/json', ...opts.headers },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${body.slice(0, 200)}`);
    if (opts.ttlSec) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, body);
    }
    return { body, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function httpPostJson(url: string, headers: Record<string, string>, payload: unknown, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}
