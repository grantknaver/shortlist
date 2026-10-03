import { describe, it, expect } from 'vitest';
import { distanceMi } from '../src/core/geo.js';
import { mapLsrFeature } from '../src/adapters/iemLsr.js';
import { mapArcgisPermit } from '../src/adapters/arcgisPermits.js';
import { severityOf, matchStorms, classifyPermit, clusterEvents } from '../src/verticals/roofing/matching.js';
import { assignRelativeTiers } from '../src/core/scoring.js';
import { DEFAULT_FILTERS, DEFAULT_TUNING } from '../src/verticals/roofing/defaults.js';
import { ROOF_SIGNALS } from '../src/verticals/roofing/signals.js';
import type { RoofCandidate, RoofSignalCtx } from '../src/verticals/roofing/types.js';
import type { WeatherEvent } from '../src/core/sources.js';

const now = new Date('2026-09-25T12:00:00Z');
const ev = (o: Partial<WeatherEvent>): WeatherEvent => ({
  id: 'e', type: 'hail', rawType: 'HAIL', date: '2026-09-13T00:00:00Z', location: { lat: 44.05, lon: -121.3 },
  damageMentioned: false, roofMentioned: false, precision: 'point-report', source: 't', ...o,
});
const sctx = (coverage: 'full' | 'partial'): RoofSignalCtx => ({
  filters: DEFAULT_FILTERS, tuning: DEFAULT_TUNING, now, permitCoverage: coverage, permitCoverageNote: 'note',
  targetZips: [], serviceRadiusMi: 10, propertyTypes: ['residential'],
});
const cand = (over: Partial<RoofCandidate['attributes']> & { yearBuilt?: number }): RoofCandidate => ({
  id: 'p', label: '1 Test St', location: { lat: 44.05, lon: -121.3 }, evidence: [],
  attributes: {
    property: { id: 'p', address: '1 Test St', propertyType: 'residential', source: 't', yearBuilt: over.yearBuilt, location: { lat: 44.05, lon: -121.3 } },
    permits: [], permitsChecked: true, stormMatches: [], serviceDistanceMi: 1, inTargetZip: false, isDemo: false, ...over,
  },
});
const roofAge = ROOF_SIGNALS.find((s) => s.id === 'roof_age')!;

describe('geo', () => {
  it('computes miles', () => {
    expect(distanceMi({ lat: 45.5152, lon: -122.6784 }, { lat: 44.0582, lon: -121.3153 })).toBeGreaterThan(115);
    expect(distanceMi({ lat: 45.5152, lon: -122.6784 }, { lat: 44.0582, lon: -121.3153 })).toBeLessThan(125);
  });
});

describe('weather', () => {
  it('scales hail/wind severity', () => {
    expect(severityOf(ev({ magnitude: 1.75 }), DEFAULT_TUNING)).toBe(1);
    expect(severityOf(ev({ magnitude: 0.5 }), DEFAULT_TUNING)).toBeLessThan(0.4);
    expect(severityOf(ev({ type: 'wind', magnitude: 58, unit: 'mph' }), DEFAULT_TUNING)).toBeCloseTo(0.65);
    expect(severityOf(ev({ type: 'wind', magnitude: 40, unit: 'mph', damageMentioned: true }), DEFAULT_TUNING)).toBe(0.7);
  });
  it('matches only within distance / lookback / severity', () => {
    const near = ev({ magnitude: 1.25, location: { lat: 44.055, lon: -121.3 } });
    const far = ev({ id: 'far', magnitude: 1.25, location: { lat: 44.2, lon: -121.3 } });
    const old = ev({ id: 'old', magnitude: 1.25, date: '2023-01-01T00:00:00Z' });
    const weak = ev({ id: 'weak', magnitude: 0.25, date: '2026-06-01T00:00:00Z' });
    const m = matchStorms({ lat: 44.05, lon: -121.3 }, clusterEvents([near, far, old, weak], DEFAULT_TUNING), DEFAULT_FILTERS, DEFAULT_TUNING, now);
    expect(m.map((x) => x.event.id)).toEqual(['e']);
    expect(m[0].recency).toBe(1);
  });
  it('maps an IEM LSR feature', () => {
    const e = mapLsrFeature({ properties: { typetext: 'TSTM WND DMG', magnitude: null, unit: '', valid: '2026-07-01T22:10:00', lat: 44.06, lon: -121.31, remark: 'Several trees down, shingles off roof.', wfo: 'PDT' } });
    expect(e?.type).toBe('tstm_wind');
    expect(e?.damageMentioned).toBe(true);
    expect(e?.roofMentioned).toBe(true);
    expect(mapLsrFeature({ properties: { typetext: 'RAIN', lat: 1, lon: 1 } })).toBeNull();
  });
});

describe('permits', () => {
  it('classifies and maps ArcGIS permits', () => {
    const p = mapArcgisPermit({ PermitNumber: 'B1', PermitType: 'Residential', WorkClass: 'Reroof', Description: 'Tear off and reroof', IssuedDate: 1100000000000 }, { x: -121.3, y: 44.05 }, {
      url: 'x', dateField: 'IssuedDate', fields: { id: 'PermitNumber', type: 'PermitType', subtype: 'WorkClass', description: 'Description', issued: 'IssuedDate' },
    });
    expect(p.location).toEqual({ lat: 44.05, lon: -121.3 });
    expect(classifyPermit(p, DEFAULT_TUNING)).toBe('reroof');
    expect(classifyPermit({ ...p, type: 'Residential', description: 'New single family dwelling' }, DEFAULT_TUNING)).toBe('house-construction');
  });
});

describe('roof age basis rules', () => {
  it('reroof permit fires in both markets', () => {
    const c = cand({ permits: [{ id: 'r', type: 'Reroof', description: '', category: 'reroof', issuedDate: '2003-05-01T00:00:00Z', source: 't' }] });
    expect(roofAge.compute(c, sctx('full')).fired).toBe(true);
    expect(roofAge.compute(c, sctx('partial')).fired).toBe(true);
  });
  it('year built alone never fires and stays low-confidence', () => {
    const c = cand({ yearBuilt: 2000 });
    for (const cov of ['full', 'partial'] as const) {
      const r = roofAge.compute(c, sctx(cov));
      expect(r.fired).toBe(false);
      expect(r.confidence).toBeLessThanOrEqual(0.45);
    }
  });
  it('house permit is trusted only where reroofs are permitted', () => {
    const c = cand({ yearBuilt: 2001, permits: [{ id: 'n', type: 'New', description: '', category: 'house-construction', issuedDate: '2001-05-01T00:00:00Z', source: 't' }] });
    expect(roofAge.compute(c, sctx('full')).fired).toBe(true);
    expect(roofAge.compute(c, sctx('partial')).fired).toBe(false);
  });
  it('old home without permits is unknown', () => {
    const r = roofAge.compute(cand({ yearBuilt: 1955 }), sctx('full'));
    expect(r.detail?.basis).toBe('unknown');
    expect(r.fired).toBe(false);
  });
});

const PS = { newConstructionWorkClasses: ['New Construction/Installation'], dwellingUseTypes: ['Single Family Dwelling'], alterationWorkClasses: ['Renovation/Alteration'], descriptionsReliableFrom: '2020-10-01' };
const permit = (o: any) => ({ id: o.id ?? 'x', type: `${o.workClass} / ${o.useType ?? ''}`, workClass: o.workClass, useType: o.useType, description: o.description ?? '', issuedDate: o.issuedDate, category: o.category, source: 't' });

describe('iteration 2 rules', () => {
  it('never takes roof age from sheds / commercial permits', () => {
    expect(classifyPermit(permit({ workClass: 'New Construction/Installation', useType: 'Shop/Garage/Shed/Greenhouse/Carport' }), DEFAULT_TUNING, PS)).toBe('accessory-construction');
    expect(classifyPermit(permit({ workClass: 'New Construction/Installation', useType: 'Commercial or Industrial' }), DEFAULT_TUNING, PS)).toBe('accessory-construction');
    const c = cand({ yearBuilt: 1978, permits: [{ ...permit({ id: 'shed', workClass: 'New Construction/Installation', useType: 'Shop/Garage/Shed/Greenhouse/Carport', issuedDate: '1999-01-01T00:00:00Z' }), category: 'accessory-construction' }] });
    const r = roofAge.compute(c, sctx('full'));
    expect(r.detail?.basis).toBe('unknown');
    expect(r.fired).toBe(false);
  });
  it('rejects a house permit inconsistent with assessor year built', () => {
    const c = cand({ yearBuilt: 1978, permits: [{ ...permit({ id: 'h', workClass: 'New Construction/Installation', useType: 'Single Family Dwelling', issuedDate: '2000-03-01T00:00:00Z' }), category: 'house-construction' }] });
    const r = roofAge.compute(c, sctx('full'));
    expect(r.detail?.basis).not.toBe('house-construction-permit');
    expect((r.detail as any).rejectedHousePermits[0].id).toBe('h');
  });
  it('legacy unlabeled alteration → POSSIBLE PRIOR ROOF WORK, not a known reroof', () => {
    const a = permit({ id: 'alt', workClass: 'Renovation/Alteration', issuedDate: '2016-05-01T00:00:00Z' });
    expect(classifyPermit(a, DEFAULT_TUNING, PS)).toBe('legacy-alteration');
    const c = cand({ yearBuilt: 1999, permits: [
      { ...permit({ id: 'h', workClass: 'New Construction/Installation', useType: 'Single Family Dwelling', issuedDate: '1999-03-01T00:00:00Z' }), category: 'house-construction' },
      { ...a, category: 'legacy-alteration' },
    ] });
    const r = roofAge.compute(c, sctx('full'));
    expect(r.detail?.status).toBe('possible-prior-roof-work');
    expect(r.detail?.basis).toBe('house-construction-permit'); // roof date NOT reset
    expect(r.confidence).toBeLessThanOrEqual(DEFAULT_TUNING.legacyAlteration.confidenceCap);
    expect(r.facts.join(' ')).toMatch(/2016-05-01 alteration permit with no meaningful description/);
  });
  it('caps single, estimated, uncorroborated reports at moderate severity', () => {
    const gust = ev({ id: 'g', type: 'tstm_wind', rawType: 'TSTM WND GST', magnitude: 80, unit: 'mph', qualifier: 'estimated' });
    const [cl] = clusterEvents([gust], DEFAULT_TUNING);
    expect(cl.uncorroborated).toBe(true);
    const m = matchStorms({ lat: 44.05, lon: -121.3 }, [cl], DEFAULT_FILTERS, DEFAULT_TUNING, now)[0];
    expect(m.severity).toBe(DEFAULT_TUNING.stormClustering.uncorroboratedSeverityCap);
    const hail = [0, 1, 2].map((i) => ev({ id: `h${i}`, magnitude: 1.25, qualifier: 'measured', location: { lat: 44.05 + i * 0.02, lon: -121.3 } }));
    const [hc] = clusterEvents(hail, DEFAULT_TUNING);
    expect(hc.reportCount).toBe(3);
    expect(hc.credibility).toBeGreaterThan(cl.credibility);
  });
  it('relative tiers: Very High is a small, requirement-gated slice', () => {
    const kept: any[] = Array.from({ length: 200 }, (_, i) => ({ score: 100 - i * 0.1, ok: i % 2 === 0 }));
    assignRelativeTiers(kept, [{ label: 'Very High', topPercent: 1.5, requirement: 'vh' }, { label: 'High', topPercent: 10 }, { label: 'Low', topPercent: 100 }], (s: any) => s.ok);
    expect(kept.filter((k) => k.tier === 'Very High').length).toBe(2); // ranks 1 and 3 of top 3
    expect(kept[1].tier).toBe('High');
  });
});

import { classifyRoofText, isSolarInstall } from '../src/verticals/roofing/roofText.js';
import { effectivePermitDate } from '../src/core/sources.js';

describe('iteration 3: reroof parser, dates, solar negation', () => {
  const known = [
    'Reroof', 'Re-roof existing house', 'Roof replacement', 'Replace roof', 'removal and replacement of asphalt shingles',
    'Shingle replacement', 'Remove Existing Roofing and install Asphalt Shingles', 'Remove and replace roofing', 'Tear off and install new',
    'TENANT NUMBER: RES TENANT NAME: REPL COMP ROOFING', 'Replace composition roofing', 'New composition shingles', 'roofing replacement',
    'TENANT NAME: REMOVE/REPL SHINGLES', 'Tear off old underlayment and old shingles and install new underlayment and new shingles',
    'old roof will be removed and new roof installed', 'remove and repalce existing roofing with new architectural shingles',
  ];
  for (const k of known) it(`known reroof: ${k}`, () => expect(classifyRoofText(k).cls).toBe('known-reroof'));
  const notReroof: [string, string][] = [
    ['replace 2 rtu s on roof', 'roof-equipment'],
    ['installing 6.44kw solar photovoltaic system on roof of home', 'roof-equipment'],
    ['install skylight in roof', 'roof-equipment'],
    ['repair two roof trusses from tree damage', 'roof-repair'],
    ['reroof garage 900 sf garage', 'accessory-roof'],
    ['construct approx 12x15 roof over existing concrete patio', 'partial-roof-addition'],
    ['new roof', 'possible-roof-work'],
  ];
  for (const [t, c] of notReroof) it(`${c}: ${t}`, () => expect(classifyRoofText(t).cls).toBe(c));
  it('rooftop units are never reroofs', () => expect(classifyRoofText('replace 12 roof top units with new of same size').cls).not.toBe('known-reroof'));
  it('solar negation', () => {
    expect(isSolarInstall('Reroof *No expired or conditions*SF *No solar* *Drone Authorized*SF')).toBe(false);
    expect(isSolarInstall('Replacing roof no solar/drone authorized')).toBe(false);
    expect(isSolarInstall('solar not included')).toBe(false);
    expect(isSolarInstall('no PV')).toBe(false);
    expect(isSolarInstall('reroof of existing residence /solar and drone ok')).toBe(false);
    expect(isSolarInstall('SOLAR ROUGH-IN ONLY')).toBe(false);
    expect(isSolarInstall('7.38 kW solar installation on customer\'s house')).toBe(true);
    expect(isSolarInstall('prescriptive 6.57kw rooftop photovoltaic array')).toBe(true);
    expect(isSolarInstall('TENANT NAME: PRESC SOLAR')).toBe(true);
  });
  it('effective date falls back to application date and says so', () => {
    const e = effectivePermitDate({ id: 'x', type: '', description: '', source: 't', appliedDate: '2025-09-08T00:00:00Z' });
    expect(e).toEqual({ date: '2025-09-08T00:00:00Z', source: 'applied' });
  });
  it('recent reroof with only an application date is a KNOWN REROOF and excluded by basis', () => {
    const p = { id: 'r', type: 'Renovation/Alteration / Single Family Dwelling', workClass: 'Renovation/Alteration', useType: 'Single Family Dwelling', description: 'removal and replacement of asphalt shingles *no solar*', appliedDate: '2025-09-08T00:00:00Z', status: 'Permit(s) Issued', source: 't' };
    expect(classifyPermit(p, DEFAULT_TUNING, PS as any)).toBe('reroof');
    const c = cand({ yearBuilt: 1999, permits: [{ ...p, category: 'reroof' }] });
    const r = roofAge.compute(c, sctx('full'));
    expect(r.detail?.basis).toBe('reroof-permit');
    expect((r.detail as any).years).toBeLessThan(2);
  });
  it('canceled permits are ignored; expired reroof is only possible roof work', () => {
    const base = { id: 'r', type: '', workClass: 'Renovation/Alteration', useType: 'Single Family Dwelling', description: 'reroof', issuedDate: '2022-01-01T00:00:00Z', source: 't' };
    const ps = { ...PS, inactiveStatuses: ['Canceled', 'Withdrawn'], expiredStatuses: ['Expired'] };
    expect(classifyPermit({ ...base, status: 'Canceled' }, DEFAULT_TUNING, ps as any)).toBe('inactive-roof-application');
    expect(classifyPermit({ ...base, description: 'kitchen remodel', status: 'Canceled' }, DEFAULT_TUNING, ps as any)).toBe('inactive');
    expect(classifyPermit({ ...base, status: 'Expired' }, DEFAULT_TUNING, ps as any)).toBe('possible-roof-work');
  });
  it('newer undated dwelling permit on the parcel → possible parcel change', () => {
    const c = cand({ yearBuilt: 2000, permits: [
      { ...permit({ id: 'h', workClass: 'New Construction/Installation', useType: 'Single Family Dwelling', issuedDate: '2000-08-01T00:00:00Z' }), category: 'house-construction' },
      { ...permit({ id: 'new', workClass: 'New Construction/Installation', useType: 'Single Family Dwelling' }), appliedDate: '2025-05-20T00:00:00Z', category: 'house-construction' },
    ] });
    const r = roofAge.compute(c, sctx('full'));
    expect((r.detail as any).parcelChange[0].id).toBe('new');
    expect(r.confidence).toBeLessThanOrEqual(DEFAULT_TUNING.parcelChange.confidenceCap);
  });
});

describe('final pass: boundary + display', () => {
  it('undescribed alteration is possible roof work regardless of date (no 2020 cutoff)', () => {
    const a = permit({ id: 'a', workClass: 'Renovation/Alteration', issuedDate: '2020-10-02T00:00:00Z' });
    expect(classifyPermit(a, DEFAULT_TUNING, PS as any)).toBe('legacy-alteration');
    const b = { ...permit({ id: 'b', workClass: 'Renovation/Alteration', issuedDate: '2023-03-01T00:00:00Z' }), description: '***No Conditions/No Expired*** SN' };
    expect(classifyPermit(b, DEFAULT_TUNING, PS as any)).toBe('legacy-alteration');
    const c = { ...permit({ id: 'c', workClass: 'Renovation/Alteration', issuedDate: '2023-03-01T00:00:00Z' }), description: 'Kitchen remodel, new cabinets' };
    expect(classifyPermit(c, DEFAULT_TUNING, PS as any)).toBe('other');
  });
  it('partial-roof addition is displayed but does not change the score', () => {
    const house = { ...permit({ id: 'h', workClass: 'New Construction/Installation', useType: 'Single Family Dwelling', issuedDate: '1990-03-01T00:00:00Z' }), category: 'house-construction' };
    const add = { ...permit({ id: 'add', workClass: 'Addition', useType: 'Single Family Dwelling', issuedDate: '2025-07-02T00:00:00Z' }), description: 'New roofing materials will be applied only to newly constructed roof sections', category: 'partial-roof-addition' };
    const without = roofAge.compute(cand({ yearBuilt: 1990, permits: [house] }), sctx('full'));
    const withAdd = roofAge.compute(cand({ yearBuilt: 1990, permits: [house, add] }), sctx('full'));
    expect(withAdd.score).toBe(without.score);
    expect(withAdd.confidence).toBe(without.confidence);
    expect(withAdd.facts.join(' ')).toMatch(/ROOF PERMIT \(not counted\).*existing main roof not identified as replaced/);
  });
});
