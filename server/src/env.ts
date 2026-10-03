import 'dotenv/config';

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

/** All secrets live here, server-side only. Nothing in this file is ever sent to the browser. */
export const env = {
  PORT: num(process.env.PORT, 8787),
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),

  PORTLANDMAPS_API_KEY: process.env.PORTLANDMAPS_API_KEY ?? '',

  /** Contact string sent in User-Agent to public weather APIs (NWS/IEM etiquette) */
  CONTACT_EMAIL: process.env.CONTACT_EMAIL ?? 'ops@example.com',
  HTTP_TIMEOUT_MS: num(process.env.HTTP_TIMEOUT_MS, 20000),

  // Deferred until lead quality is validated (not wired yet):
  // ANTHROPIC_API_KEY, PERPLEXITY_API_KEY
};
