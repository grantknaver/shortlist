import type { ScoringConfig } from '../../core/types.js';
import type { RoofFilters, RoofTuning } from './types.js';

export const DEFAULT_FILTERS: RoofFilters = {
  minYearsSinceReroof: 15,
  stormLookbackDays: 730,
  weatherTypes: ['hail', 'tstm_wind', 'wind', 'tornado', 'ice', 'snow'],
  minSeverity: 0.3,
  maxDistanceMi: 3,
  limit: 25,
  minScore: 35,
  prioritizeRecentStorm: false,
  requireAgingRoof: false,
  requireMultipleSignals: false,
};

export const DEFAULT_TUNING: RoofTuning = {
  // years since reroof → 0..1
  roofAgeCurve: [
    [10, 0],
    [15, 0.45],
    [20, 0.75],
    [25, 0.95],
    [30, 1],
  ],
  originalRoofMaxAge: 35,
  roofAgeBasis: {
    // Markets where residential reroofs require permits (e.g. Bend)
    full: {
      'reroof-permit': { confidence: 0.9, maxScore: 1, canFire: true },
      'house-construction-permit': { confidence: 0.8, maxScore: 1, canFire: true },
      // year built alone is never a high-confidence roof age, even here
      'year-built': { confidence: 0.45, maxScore: 0.6, canFire: false },
      unknown: { confidence: 0.25, maxScore: 0.3, canFire: false },
    },
    // Markets where most residential reroofs are NOT permitted (e.g. Portland)
    partial: {
      'reroof-permit': { confidence: 0.85, maxScore: 1, canFire: true },
      'house-construction-permit': { confidence: 0.4, maxScore: 0.5, canFire: false },
      'year-built': { confidence: 0.3, maxScore: 0.5, canFire: false },
      unknown: { confidence: 0.2, maxScore: 0.3, canFire: false },
    },
  },
  houseYearTolerance: 2,
  houseBasisNoAssessorConfidence: 0.6,
  legacyAlteration: { confidenceCap: 0.5, penaltyPoints: 12, minYearsAfterRoofStart: 8 },
  solar: { scoreCap: 0.4, confidenceCap: 0.4 },
  recency: [
    { maxDays: 30, weight: 1 },
    { maxDays: 90, weight: 0.8 },
    { maxDays: 365, weight: 0.5 },
    { maxDays: 730, weight: 0.25 },
  ],
  recencyOlderWeight: 0.1,
  proximity: { fullScoreMi: 0.5, edgeScore: 0.2 },
  severity: {
    hailIn: [
      [0.25, 0.15],
      [0.75, 0.45],
      [1.0, 0.65],
      [1.25, 0.8],
      [1.75, 1],
    ],
    windMph: [
      [40, 0.15],
      [50, 0.4],
      [58, 0.65],
      [70, 0.85],
      [80, 1],
    ],
    iceIn: [
      [0.1, 0.3],
      [0.25, 0.6],
      [0.5, 0.85],
      [0.75, 1],
    ],
    snowIn: [
      [4, 0.15],
      [8, 0.3],
      [12, 0.5],
      [18, 0.7],
    ],
    tornado: 1,
    damageReportFloor: 0.7,
    roofMentionBonus: 0.1,
    unknownMagnitude: 0.45,
  },
  stormClustering: { hours: 6, miles: 10, uncorroboratedSeverityCap: 0.5 },
  neighborhood: {
    radiusMi: 0.25,
    contextRadiusMi: 0.5,
    mode: 'rate',
    excessRateCurve: [
      [0, 0],
      [0.03, 0.25],
      [0.08, 0.6],
      [0.15, 0.85],
      [0.25, 1],
    ],
    countCurve: [
      [0, 0],
      [1, 0.4],
      [3, 0.75],
      [6, 1],
    ],
    minEligible: 10,
    fireExcessRate: 0.05,
    fireLift: 2,
    fireMinReroofed: 2,
    innerWeight: 0.7,
  },
  parcelChange: { confidenceCap: 0.6, penaltyPoints: 8 },
  permitKeywords: {
    reroof: ['reroof', 're-roof', 're roof', 'roof replacement', 'replace roof', 'tear off', 'tear-off', 'new roof', 'roof covering', 'reroofing'],
    roofRepair: ['roof repair', 'dry rot', 'rafter', 'roof framing', 'roof structure'],
    solar: ['solar', 'photovoltaic', ' pv '],
  },
  permitKeywordsNewConstruction: ['new single family', 'new sfr', 'new sfd', 'new dwelling', 'new residence', 'new construction', 'new home', 'single family dwelling - new', 'new 1 & 2 family', 'new one and two family'],
  permitEnrichBudget: 60,
  maxProperties: 3000,
};

export const DEFAULT_SCORING: ScoringConfig = {
  weights: {
    roof_age: 35,
    no_newer_reroof: 10,
    storm_exposure: 16,
    storm_recency: 10,
    storm_severity: 12,
    neighborhood_reroofs: 9,
    property_fit: 5,
    service_area_fit: 5,
  },
  crossSignals: [
    {
      id: 'aging_roof_plus_storm',
      label: 'Cross-signal: aging roof + severe-weather exposure',
      requires: [
        { signal: 'roof_age', minScore: 0.55, mustFire: true },
        { signal: 'storm_exposure', minScore: 0.3, mustFire: true },
        { signal: 'storm_severity', minScore: 0.4 },
      ],
      bonus: 10,
    },
    {
      id: 'storm_plus_neighbor_reroofs',
      label: 'Cross-signal: aging roof + credible storm + unusually high nearby post-storm reroof rate',
      requires: [
        { signal: 'roof_age', minScore: 0.55, mustFire: true },
        { signal: 'storm_exposure', minScore: 0.3, mustFire: true },
        { signal: 'neighborhood_reroofs', minScore: 0.4, mustFire: true },
      ],
      bonus: 5,
    },
    {
      id: 'fresh_severe_on_old_roof',
      label: 'Cross-signal: recent, severe, close event on an old roof',
      requires: [
        { signal: 'roof_age', minScore: 0.75, mustFire: true },
        { signal: 'storm_exposure', minScore: 0.6, mustFire: true },
        { signal: 'storm_recency', minScore: 0.8 },
        { signal: 'storm_severity', minScore: 0.65 },
      ],
      bonus: 6,
    },
  ],
  penalties: [
    {
      id: 'possible_legacy_roof_work',
      label: 'Possible prior roof work (unlabeled legacy alteration permit)',
      signal: 'possible_legacy_roof_work',
      points: 12,
    },
    {
      id: 'possible_parcel_change',
      label: 'Possible parcel change (newer dwelling permit on the parcel)',
      signal: 'possible_parcel_change',
      points: 8,
    },
  ],
  // fixed thresholds kept as a fallback label; relative tiers below decide the final tier
  tiers: [
    { label: 'Very High', min: 80 },
    { label: 'High', min: 65 },
    { label: 'Medium', min: 45 },
    { label: 'Low', min: 0 },
  ],
  relativeTiers: [
    { label: 'Very High', topPercent: 1.5, requirement: 'very-high' },
    { label: 'High', topPercent: 8, requirement: 'high' },
    { label: 'Medium', topPercent: 40, requirement: 'medium' },
    { label: 'Low', topPercent: 100 },
  ],
  confidenceFloor: 0.75,
};

export const WEATHER_LABELS: Record<string, string> = {
  hail: 'Hail',
  tstm_wind: 'Thunderstorm wind',
  wind: 'Damaging wind (non-thunderstorm)',
  tornado: 'Tornado',
  ice: 'Ice / freezing rain',
  snow: 'Heavy snow',
  other: 'Other severe weather',
};
