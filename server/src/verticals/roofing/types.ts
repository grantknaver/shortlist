import type { Candidate } from '../../core/types.js';
import type { PermitRecord, PropertyRecord, WeatherEvent, WeatherType } from '../../core/sources.js';

/** A cluster of related storm reports (same hazard family, close in time and space). */
export interface StormEventCluster {
  id: string;
  family: 'hail' | 'wind' | 'tornado' | 'ice' | 'snow' | 'other';
  start: string;
  end: string;
  reports: WeatherEvent[];
  /** distinct report locations after de-duplication */
  reportCount: number;
  /** distinct reporter types (spotter, mesonet, public…) */
  independentSources: number;
  anyMeasured: boolean;
  anyDamageRemark: boolean;
  maxMagnitude?: number;
  /** 0..1 how much we trust that a damaging event happened */
  credibility: number;
  /** single, estimated, no damage, uncorroborated → severity capped */
  uncorroborated: boolean;
}

export interface StormMatch {
  /** nearest report of the matched event */
  event: WeatherEvent;
  cluster: StormEventCluster;
  distanceMi: number;
  proximity: number; // 0..1
  recency: number; // 0..1
  /** severity of the nearest report, after the credibility cap */
  severity: number;
  rawSeverity: number;
  severityCapped: boolean;
  composite: number;
  daysAgo: number;
}

export interface RateRing {
  eligible: number;
  reroofed: number;
  rate: number;
  baselineReroofed: number;
  baselineRate: number;
}

export interface NeighborReroofs {
  /** event the counts are relative to */
  eventId: string;
  since: string;
  baselineWindow: string;
  baselineScaled: boolean;
  r025: RateRing;
  r05: RateRing;
  /** raw counts (kept for comparison/diagnostics) */
  within025: number;
  within05: number;
  sample: { id: string; issued?: string; distanceMi: number; address?: string }[];
}

/** KNOWN REROOF vs POSSIBLE PRIOR ROOF WORK vs NO KNOWN REROOF — materially different states. */
export type RoofStatus = 'known-reroof' | 'possible-prior-roof-work' | 'no-known-reroof';

export interface RoofAttributes {
  property: PropertyRecord;
  /** roofing-relevant permits (classified) */
  permits: PermitRecord[];
  /** whether a permit lookup was actually performed for this property */
  permitsChecked: boolean;
  stormMatches: StormMatch[];
  neighborReroofs?: NeighborReroofs;
  serviceDistanceMi: number;
  inTargetZip: boolean;
  isDemo: boolean;
  demoScenario?: string;
}

export type RoofCandidate = Candidate<RoofAttributes>;

export interface RoofFilters {
  minYearsSinceReroof: number;
  stormLookbackDays: number;
  weatherTypes: WeatherType[];
  /** 0..1 */
  minSeverity: number;
  maxDistanceMi: number;
  limit: number;
  minScore: number;
  prioritizeRecentStorm: boolean;
  requireAgingRoof: boolean;
  requireMultipleSignals: boolean;
}

export type PermitCoverage = 'full' | 'partial';
export type RoofAgeBasis = 'reroof-permit' | 'house-construction-permit' | 'year-built' | 'unknown';
export interface BasisRule {
  confidence: number;
  maxScore: number;
  canFire: boolean;
}

/** How a market's permit data is structured (drives dwelling vs accessory attribution). */
export interface PermitStructure {
  newConstructionWorkClasses: string[];
  dwellingUseTypes: string[];
  alterationWorkClasses: string[];
  /** permits issued before this date usually have no description (legacy system) */
  descriptionsReliableFrom?: string;
  /** statuses meaning the work never happened (ignored entirely) */
  inactiveStatuses?: string[];
  /** statuses meaning issued but lapsed (completion unknown) */
  expiredStatuses?: string[];
}

export interface RoofTuning {
  roofAgeCurve: [number, number][];
  /** homes younger than this with no reroof permit are assumed to be on their original roof */
  originalRoofMaxAge: number;
  roofAgeBasis: Record<PermitCoverage, Record<RoofAgeBasis, BasisRule>>;
  /** house construction permit must be within ± this many years of assessor year built */
  houseYearTolerance: number;
  /** confidence used when a house permit exists but no assessor year is available to cross-check */
  houseBasisNoAssessorConfidence: number;
  legacyAlteration: {
    /** roof-age confidence is capped at this when a possible legacy roof-work permit exists */
    confidenceCap: number;
    /** points subtracted from the final score (see scoring penalties) */
    penaltyPoints: number;
    /** alterations sooner than this after construction/last reroof are not treated as possible roof work */
    minYearsAfterRoofStart: number;
  };
  solar: { scoreCap: number; confidenceCap: number };
  recency: { maxDays: number; weight: number }[];
  recencyOlderWeight: number;
  proximity: { fullScoreMi: number; edgeScore: number };
  severity: {
    hailIn: [number, number][];
    windMph: [number, number][];
    iceIn: [number, number][];
    snowIn: [number, number][];
    tornado: number;
    damageReportFloor: number;
    roofMentionBonus: number;
    unknownMagnitude: number;
  };
  stormClustering: {
    /** reports within this many hours and miles of each other (same hazard family) form one event */
    hours: number;
    miles: number;
    /** severity cap for single, estimated, no-damage, uncorroborated reports */
    uncorroboratedSeverityCap: number;
  };
  neighborhood: {
    radiusMi: number;
    contextRadiusMi: number;
    /** 'rate' (share of eligible homes, vs local baseline) or 'count' (raw count; diagnostics only) */
    mode: 'rate' | 'count';
    /** excess post-storm reroof rate (post − baseline) → 0..1 */
    excessRateCurve: [number, number][];
    /** raw count → 0..1 (count mode only) */
    countCurve: [number, number][];
    /** minimum eligible homes in the 0.25-mi ring for full confidence */
    minEligible: number;
    /** fires when excess rate ≥ this, post ≥ lift × baseline, and ≥ minReroofed homes */
    fireExcessRate: number;
    fireLift: number;
    fireMinReroofed: number;
    /** weight of the 0.25-mi ring vs the 0.5-mi ring */
    innerWeight: number;
  };
  parcelChange: { confidenceCap: number; penaltyPoints: number };
  permitKeywords: { reroof: string[]; roofRepair: string[]; solar: string[] };
  permitKeywordsNewConstruction: string[];
  /** max per-property permit lookups per live run (lookup-type permit sources only) */
  permitEnrichBudget: number;
  maxProperties: number;
}

export interface RoofSignalCtx {
  filters: RoofFilters;
  tuning: RoofTuning;
  now: Date;
  /** how reliably this market records residential reroofs as permits */
  permitCoverage: PermitCoverage;
  permitCoverageNote: string;
  permitStructure?: PermitStructure;
  targetZips: string[];
  serviceRadiusMi: number;
  propertyTypes: string[];
}
