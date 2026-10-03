import fs from 'node:fs';
import { classifyRoofText, isSolarInstall, normalizePermitText } from '../src/verticals/roofing/roofText.js';
const R = JSON.parse(fs.readFileSync('/home/claude/bend-audit/raw/permits_roof_shingle_solar.json', 'utf8'));
const seen = new Set<string>(); const known: string[] = []; const nonSfd: string[] = []; const poss: string[]=[]; const acc:string[]=[]; const solNo:string[]=[];
for (const f of R) {
  const a = f.attributes; const d = (a.ApplicationDescription ?? '').trim(); const n = normalizePermitText(d);
  if (seen.has(n)) continue; seen.add(n);
  const c = classifyRoofText(d).cls;
  if (c === 'known-reroof') { known.push(n.slice(0,110)); if (!/Single Family|Townhome|Duplex/.test(a.UseDesc ?? '')) nonSfd.push(`[${a.UseDesc}] ${n.slice(0,100)}`); }
  if (c === 'possible-roof-work' && /Single Family/.test(a.UseDesc ?? '')) poss.push(n.slice(0,130));
  if (c === 'accessory-roof') acc.push(n.slice(0,110));
  if (/solar|photovolt|\bpv\b/i.test(d) && !isSolarInstall(d)) solNo.push(d.replace(/\s+/g,' ').slice(0,100));
}
const pick = (a: string[], k: number) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / k)) === 0).slice(0, k);
console.log('unique known-reroof texts', known.length); pick(known, 40).forEach((s) => console.log('  K', s));
console.log('known-reroof non-SFD use', nonSfd.length); pick(nonSfd, 12).forEach((s) => console.log('  N', s));
console.log('possible (SFD)', poss.length); pick(poss, 30).forEach((s) => console.log('  P', s));
console.log('accessory', acc.length); acc.forEach((s) => console.log('  A', s));
console.log('solar not-install', solNo.length); pick(solNo, 25).forEach((s) => console.log('  S', s));
