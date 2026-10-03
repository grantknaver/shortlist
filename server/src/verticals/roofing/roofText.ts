/**
 * Permit-description interpretation for roofing.
 *
 * Normalizes free-text permit descriptions (case, punctuation, abbreviations, clerk notes) and
 * classifies the roof-related meaning:
 *
 *   known-reroof        complete / predominant roof replacement of the dwelling
 *   possible-roof-work  roof work is mentioned but the scope is ambiguous
 *   roof-repair         explicitly minor repair
 *   roof-equipment      roof mentioned only as a location for equipment (HVAC, solar, skylight, antenna…)
 *   accessory-roof      roof work on a detached accessory structure
 *   null                not roof related
 *
 * Solar is detected separately with negation handling ("no solar", "no PV", "solar not included").
 */

/** Clerk / system notes that are not part of the work description. */
const NOTE_PATTERNS: RegExp[] = [
  /\*+[^*]*\*+/g, // ***No Conditions/No Expired*** SN, *no solar*
  /\btenant (number|name)\s*:\s*(res|comm)?\b/g,
  /\bno expired?s?\b|\bno conditions?\b|\bnothing expired\b/g,
];

const ABBREV: [RegExp, string][] = [
  [/\broof\s*top\s+units?\b|\brooftop\s+units?\b|\brtu\s*s\b/g, 'rtu'],
  [/\br\s*&\s*r\b/g, 'remove and replace'],
  [/\brep1\b|\brepalce\b|\breplce\b/g, 'replace'],
  [/\breplacement off\b/g, 'replacement of'],
  [/\btear(ing)?[\s-]*off\b/g, 'tearoff'],
  [/\brem\b/g, 'remove'],
  [/\brmv\b/g, 'remove'],
  [/\brepl\b|\brplc\b|\brep\b/g, 'replace'],
  [/\bcomp\b/g, 'composition'],
  [/\basph\b|\bashpalt\b|\basphault\b/g, 'asphalt'],
  [/\barch\b/g, 'architectural'],
  [/\bw\s*\/\s*/g, 'with '],
  [/\bsq\b/g, 'squares'],
  [/\bre[\s-]+roof/g, 'reroof'],
  [/\bre[\s-]+shingl/g, 'reshingl'],
  [/\btear[\s-]*off\b/g, 'tearoff'],
  [/\bpv\b/g, 'photovoltaic'],
  [/&/g, ' and '],
];

export function normalizePermitText(raw: string): string {
  let s = ` ${(raw ?? '').toLowerCase()} `;
  // negated solar mentions are clerk notes, not work (handled before notes are stripped)
  s = s.replace(/\bno\s+(solar|pv|photovoltaic)(\s+panels?)?\b/g, ' ').replace(/\b(solar|pv)\s+(is\s+)?not\s+(included|part of|proposed)\b/g, ' ');
  for (const re of NOTE_PATTERNS) s = s.replace(re, ' ');
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/(\D)\.|\.(\D)/g, '$1 $2'); // periods that are not decimals
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  s = s.replace(/[^a-z0-9./ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

const ROOF = '(roof|roofs|roofing|shingle|shingles|reroof|reroofing|reshingle|reshingling)';
const EQUIPMENT = /\b(roof mount\w*|kw|kwac|kwdc|pipe|exhaust|rtu|rtus|rooftop unit|roof top unit|hvac|heat pump|mini split|condens\w*|furnace|air condition\w*|a\/?c unit|package unit|exhaust fan|vent|vents|roof jack|flue|chimney liner|skylight\w*|solar|photovoltaic|panels?|antenna|satellite|dish|cell|telecom|roof drain\w*|gutter\w*|parapet sign|sign)\b/;
const ACCESSORY = /\b(garage|shed|carport|shop|barn|gazebo|pergola|patio cover|porch cover|detached|accessory (structure|building|dwelling)|adu)\b/;
const DWELLING_REF = /\b(house|home|dwelling|residence|sfd|sfr|main|entire|whole|existing)\b/;

const KNOWN_REROOF: RegExp[] = [
  /\breroof(ing|ed)?\b/,
  /\breshingl(e|ing|ed)\b/,
  new RegExp(`\\b${ROOF}\\s+(replacement|replace|replaced|replacing|overlay|tearoff|over ?lay)\\b`),
  new RegExp(`\\b(replace|replacement|replacing|remove and replace|removal and replacement|remove and install|tearoff and replace|tearoff|changing|change)\\b(\\s+\\S+){0,5}?\\s+${ROOF}\\b`),
  new RegExp(`\\b(remove|removal of|removing|strip|tearoff)\\b(\\s+\\S+){0,4}?\\s+${ROOF}\\b(\\s+\\S+){0,8}?\\s+(install|installing|replace|with|new|and)\\b`),
  new RegExp(`\\b(new|install|installing|installation of)\\s+(\\S+\\s+){0,3}?(composition|asphalt|architectural|laminate|metal|standing seam|cedar|tile|class a)\\s+(\\S+\\s+){0,2}?${ROOF}\\b`),
  /\btearoff\b/,
  new RegExp(`\\b${ROOF}\\s+(covering\\s+)?(removal and replacement|replacement|removed and replaced)\\b`),
  new RegExp(`\\b(old|existing)\\s+${ROOF}\\s+(will be\\s+)?(removed|removal)\\b(\\s+\\S+){0,6}?\\s+(new|install\\w*|replace\\w*)\\b`),
  new RegExp(`\\btear\\s+(\\S+\\s+){0,3}?${ROOF}\\b`),
  new RegExp(`\\binstall\\w*\\b(\\s+\\S+){0,10}?\\s+underlayments?\\b(\\s+\\S+){0,4}?\\s+(and\\s+)?(new\\s+)?(asphalt\\s+|composition\\s+)?(shingles|roofing)\\b`),
];

/** New roof area over an addition / porch / deck / patio — not a replacement of the dwelling roof. */
const PARTIAL_ADDITION = /\b(rooflines?|sun ?room|roof over|extend\w*( the)? roof|roof line|roof frame|covered|cover over|porch|deck|patio|addition|awning|pergola|dormer|vaulted)\b/;

const REPAIR = new RegExp(`\\b${ROOF}\\b.{0,30}\\b(repair|repairs|patch|leak)\\b|\\b(repair|repairs|patch)\\b.{0,30}\\b${ROOF}\\b`);

export type RoofTextClass = 'known-reroof' | 'possible-roof-work' | 'roof-repair' | 'roof-equipment' | 'accessory-roof' | 'partial-roof-addition' | null;

export function classifyRoofText(raw: string): { cls: RoofTextClass; normalized: string; why: string } {
  const n = normalizePermitText(raw);
  if (!new RegExp(`\\b${ROOF}\\b|\\brooflines?\\b|\\breroof|\\breshingl|\\btearoff\\b`).test(n)) return { cls: null, normalized: n, why: 'no roof terms' };

  // a replacement match only counts if equipment is not the object of the verb (e.g. "replace 2 rtu on roof")
  let known: string | undefined;
  for (const re of KNOWN_REROOF) {
    const m = re.exec(n);
    if (m && !EQUIPMENT.test(m[0])) {
      known = m[0];
      break;
    }
  }
  const equipment = EQUIPMENT.test(n);
  const accessory = ACCESSORY.test(n) && !DWELLING_REF.test(n);

  if (known) {
    if (accessory) return { cls: 'accessory-roof', normalized: n, why: `replacement on accessory structure ("${known}")` };
    return { cls: 'known-reroof', normalized: n, why: `"${known}"` };
  }
  if (REPAIR.test(n) && !/\breplace/.test(n)) return { cls: 'roof-repair', normalized: n, why: 'repair language' };
  if (equipment) return { cls: 'roof-equipment', normalized: n, why: 'roof mentioned with equipment' };
  if (accessory) return { cls: 'accessory-roof', normalized: n, why: 'accessory structure' };
  if (PARTIAL_ADDITION.test(n)) return { cls: 'partial-roof-addition', normalized: n, why: 'new roof area over addition/porch/deck' };
  return { cls: 'possible-roof-work', normalized: n, why: 'roof mentioned, scope unclear' };
}

const SOLAR_INSTALL: RegExp[] = [
  /\b(install|installation|installing|add|adding|new|mount|mounted|grid tied|interconnect\w*)\b(\s+\S+){0,6}?\s+(solar|photovoltaic)\b/,
  /\b(solar|photovoltaic)\s+(array|system|panels?|modules?|installation|install|pv|electric|energy)\b/,
  /\b\d+(\.\d+)?\s*kw\b.{0,40}\b(solar|photovoltaic)\b|\b(solar|photovoltaic)\b.{0,40}\b\d+(\.\d+)?\s*kw\b/,
];

/** True only when the record describes a solar/PV installation (negations and clerk notes removed). */
export function isSolarInstall(raw: string): boolean {
  const n = normalizePermitText(raw);
  if (!/\b(solar|photovoltaic)\b/.test(n)) return false;
  if (/\bsolar (hot )?water\b|\bsolar (water )?heat(er|ing)?\b/.test(n)) return false; // thermal water heating, not PV on this roof necessarily
  if (/\b(rough ?in|pre ?wire|prewire)\b/.test(n) && !/\b(install|installation|array|panels?|modules?)\b/.test(n)) return false; // wiring only
  if (/\b(remove|removal|removing|uninstall|decommission)\w*\b(\s+\S+){0,4}?\s+(solar|photovoltaic)\b/.test(n) && !/\breinstall/.test(n)) return false;
  if (ACCESSORY.test(n) && !DWELLING_REF.test(n)) return false; // solar on a detached structure
  // must describe an actual PV system (clerk notes like "**Solar**" or "solar and drone ok" on a reroof are not installs)
  return /\b(photovoltaic|kw|kwac|kwdc|kva|array|panels?|modules?|system|install\w*|prescriptive|presc|prescptve|interconnect\w*|grid)\b/.test(n) || /\d\s*kw/.test(n);
}
