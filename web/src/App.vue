<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api, type Filters, type RunResult, type Session } from './api';
import ResultCard from './components/ResultCard.vue';

const $q = useQuasar();

// ---- access key (from ?key=… or remembered locally) ----
function readKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem('ofKey') ?? '';
  } catch {
    return '';
  }
}
const key = ref(readKey());
const keyInput = ref('');
const session = ref<Session | null>(null);
const loadingSession = ref(false);

async function connect(k: string) {
  loadingSession.value = true;
  try {
    session.value = await api.session(k);
    key.value = k;
    try {
      localStorage.setItem('ofKey', k);
    } catch {
      /* ignore */
    }
    Object.assign(filters, session.value.defaultFilters);
    areaId.value = session.value.serviceAreas[0]?.id ?? '';
    mode.value = session.value.customer.features.liveData ? 'live' : 'demo';
  } catch (e) {
    session.value = null;
    $q.notify({ type: 'negative', message: (e as Error).message });
  } finally {
    loadingSession.value = false;
  }
}
onMounted(() => key.value && connect(key.value));

// ---- run controls ----
const areaId = ref('');
const mode = ref<'demo' | 'live'>('demo');
const filters = reactive<Filters>({
  minYearsSinceReroof: 15,
  stormLookbackDays: 365,
  weatherTypes: ['hail', 'tstm_wind', 'wind', 'tornado', 'ice', 'snow'],
  minSeverity: 0.3,
  maxDistanceMi: 3,
  limit: 25,
  minScore: 35,
  prioritizeRecentStorm: false,
  requireAgingRoof: false,
  requireMultipleSignals: false,
});
const area = computed(() => session.value?.serviceAreas.find((a) => a.id === areaId.value));
const isSample = computed(() => session.value?.customer.plan === 'sample');

const WEATHER_OPTS = [
  { label: 'Hail', value: 'hail' },
  { label: 'Thunderstorm wind', value: 'tstm_wind' },
  { label: 'Damaging wind', value: 'wind' },
  { label: 'Tornado', value: 'tornado' },
  { label: 'Ice / freezing rain', value: 'ice' },
  { label: 'Heavy snow', value: 'snow' },
];
const LOOKBACK_OPTS = [
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
  { label: 'Last 6 months', value: 180 },
  { label: 'Last 12 months', value: 365 },
  { label: 'Last 2 years', value: 730 },
];
const SEVERITY_OPTS = [
  { label: 'Any reported event', value: 0 },
  { label: 'Moderate+', value: 0.3 },
  { label: 'Significant+', value: 0.5 },
  { label: 'Severe only', value: 0.7 },
];
const LIMIT_OPTS = [10, 25, 50, 100];

// ---- run ----
const running = ref(false);
const result = ref<RunResult | null>(null);
const selected = ref<Set<string>>(new Set());
const error = ref('');

// ---- progress while a run is in flight (time-based estimate; the server does not stream progress) ----
const elapsed = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;
const expectedSecs = computed(() => (mode.value === 'live' ? 90 : 3));
const progressPct = computed(() => Math.min(95, Math.round((elapsed.value / expectedSecs.value) * 95)));
const overdue = computed(() => elapsed.value > (mode.value === 'live' ? 120 : 15));
const LIVE_STAGES = [
  { upTo: 0.1, text: 'Pulling National Weather Service storm reports…' },
  { upTo: 0.45, text: 'Loading property records for every single-family home in the area…' },
  { upTo: 0.75, text: 'Loading city permit history (reroofs, new construction, solar)…' },
  { upTo: Infinity, text: 'Cross-checking roofs, storms and neighbor reroofs, then ranking…' },
];
const stageText = computed(() => {
  if (mode.value !== 'live') return 'Scoring demo properties…';
  const f = elapsed.value / expectedSecs.value;
  return LIVE_STAGES.find((st) => f < st.upTo)!.text;
});
function startTicker() {
  elapsed.value = 0;
  const t0 = Date.now();
  ticker = setInterval(() => (elapsed.value = Math.floor((Date.now() - t0) / 1000)), 500);
}
function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = undefined;
}
onUnmounted(stopTicker);

async function run() {
  if (!session.value) return;
  running.value = true;
  error.value = '';
  startTicker();
  try {
    result.value = await api.run(key.value, { mode: mode.value, serviceAreaId: areaId.value, filters: { ...filters } });
    selected.value = new Set();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
    stopTicker();
  }
}

function toggle(id: string) {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
}
function selectAll() {
  selected.value = selected.value.size === result.value?.results.length ? new Set() : new Set(result.value?.results.map((r) => r.candidate.id));
}

async function exportCsv(onlySelected: boolean) {
  if (!result.value) return;
  try {
    await api.exportCsv(key.value, result.value.runId, onlySelected ? [...selected.value] : undefined);
  } catch (e) {
    $q.notify({ type: 'negative', message: (e as Error).message });
  }
}

async function copySelected() {
  const rows = result.value?.results.filter((r) => selected.value.has(r.candidate.id)) ?? [];
  if (!rows.length) return;
  const text = rows
    .map((r) => {
      const s = r.display.storm;
      return [
        `${r.tier.toUpperCase()} (${r.score}) — ${r.candidate.label}`,
        `Why: ${r.headline}`,
        `Roof: ${r.display.roofLabel}${r.display.estRoofAgeYears !== null ? ` (~${r.display.estRoofAgeYears} yrs)` : ''}`,
        s ? `Weather: ${s.type}, ${s.magnitude}, ${s.date} (${s.daysAgo} days ago), ~${s.distanceMi} mi away` : 'Weather: none qualifying nearby',
        `Angle: ${r.angle}`,
      ].join('\n');
    })
    .join('\n\n');
  await navigator.clipboard.writeText(text);
  $q.notify({ type: 'positive', message: `Copied ${rows.length} prospect(s)` });
}

const excludedList = computed(() => Object.entries(result.value?.stats.excluded ?? {}).sort((a, b) => b[1] - a[1]));
const tierCounts = computed(() => {
  const c: Record<string, number> = {};
  for (const r of result.value?.results ?? []) c[r.tier] = (c[r.tier] ?? 0) + 1;
  return c;
});
</script>

<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="bg-grey-10 text-white">
      <q-toolbar>
        <q-icon name="roofing" size="28px" class="q-mr-sm" />
        <q-toolbar-title class="text-weight-bold">SHORTLIST <span class="text-weight-regular text-grey-5">· Roofing</span></q-toolbar-title>
        <template v-if="session">
          <q-badge v-if="isSample" color="amber-8" class="q-mr-sm">FREE SAMPLE · max 5</q-badge>
          <span class="text-caption">{{ session.customer.name }}</span>
        </template>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="page q-pa-md">
        <!-- access -->
        <q-card v-if="!session" flat bordered class="q-pa-lg q-mx-auto" style="max-width: 420px">
          <div class="text-h6 q-mb-sm">Enter your access key</div>
          <q-input v-model="keyInput" outlined dense label="Access key" @keyup.enter="connect(keyInput)" />
          <q-btn class="q-mt-md full-width" color="primary" label="Continue" :loading="loadingSession" @click="connect(keyInput)" />
          <div class="text-caption text-grey-7 q-mt-sm">Demo key: <code>demo</code></div>
        </q-card>

        <template v-else>
          <!-- controls -->
          <q-card flat bordered class="q-mb-md">
            <q-card-section class="row q-col-gutter-md items-end">
              <div class="col-12 col-sm-5">
                <q-select v-model="areaId" :options="session.serviceAreas.map((a) => ({ label: a.label, value: a.id }))" emit-value map-options outlined dense label="City / service area" />
              </div>
              <div class="col-12 col-sm-3">
                <q-btn-toggle v-model="mode" spread no-caps toggle-color="grey-9" :options="[{ label: 'Demo data', value: 'demo' }, { label: 'Live data', value: 'live' }]" />
              </div>
              <div class="col-12 col-sm-4">
                <q-btn class="full-width find-btn" color="deep-orange-8" size="lg" icon="search" label="Find Opportunities" :loading="running" @click="run" />
                <div v-if="mode === 'live'" class="text-caption text-grey-7 text-center q-mt-xs">Live search takes 1–2 minutes</div>
              </div>
            </q-card-section>

            <q-card-section v-if="area" class="q-pt-none">
              <q-banner dense rounded :class="area.market.reroofPermitCoverage === 'full' ? 'bg-green-1 text-green-10' : 'bg-amber-1 text-amber-10'">
                <template #avatar><q-icon :name="area.market.reroofPermitCoverage === 'full' ? 'verified' : 'info'" /></template>
                <b>{{ area.market.name }}:</b>
                {{ area.market.reroofPermitCoverage === 'full'
                  ? 'Residential reroofs require permits here, so reroof history is a strong signal.'
                  : 'Most residential reroofs here are not permitted, so roof-age estimates are lower confidence.' }}
              </q-banner>
            </q-card-section>

            <q-expansion-item dense icon="tune" label="Filters" header-class="text-grey-8">
              <q-card-section class="row q-col-gutter-md">
                <div class="col-12 col-sm-6 col-md-4">
                  <div class="text-caption">Minimum years since reroof: <b>{{ filters.minYearsSinceReroof }}</b></div>
                  <q-slider v-model="filters.minYearsSinceReroof" :min="5" :max="30" :step="1" label />
                </div>
                <div class="col-12 col-sm-6 col-md-4">
                  <q-select v-model="filters.stormLookbackDays" :options="LOOKBACK_OPTS" emit-value map-options outlined dense label="Storm recency" />
                </div>
                <div class="col-12 col-sm-6 col-md-4">
                  <q-select v-model="filters.minSeverity" :options="SEVERITY_OPTS" emit-value map-options outlined dense label="Minimum storm severity" />
                </div>
                <div class="col-12 col-md-8">
                  <q-select v-model="filters.weatherTypes" :options="WEATHER_OPTS" emit-value map-options multiple use-chips outlined dense label="Weather type" />
                </div>
                <div class="col-12 col-sm-6 col-md-4">
                  <div class="text-caption">Max distance to storm report: <b>{{ filters.maxDistanceMi }} mi</b></div>
                  <q-slider v-model="filters.maxDistanceMi" :min="0.5" :max="10" :step="0.5" label />
                </div>
                <div class="col-12 col-sm-6 col-md-4">
                  <q-select v-model="filters.limit" :options="isSample ? [5, 10] : LIMIT_OPTS" outlined dense label="Number of results" />
                </div>
                <div class="col-12 col-sm-6 col-md-4">
                  <div class="text-caption">Minimum score: <b>{{ filters.minScore }}</b></div>
                  <q-slider v-model="filters.minScore" :min="0" :max="90" :step="5" label />
                </div>
                <div class="col-12 col-md-4 column">
                  <q-toggle v-model="filters.prioritizeRecentStorm" label="Prioritize recent storm exposure" dense class="q-mb-xs" />
                  <q-toggle v-model="filters.requireAgingRoof" label="Require aging-roof signal" dense class="q-mb-xs" />
                  <q-toggle v-model="filters.requireMultipleSignals" label="Require multiple signals (roof + storm)" dense />
                </div>
              </q-card-section>
            </q-expansion-item>
          </q-card>

          <q-banner v-if="error" class="bg-red-1 text-red-9 q-mb-md" rounded>{{ error }}</q-banner>

          <!-- progress -->
          <q-card v-if="running" flat bordered class="q-mb-md">
            <q-card-section>
              <div class="row items-center q-mb-sm">
                <q-spinner-dots color="deep-orange-8" size="24px" class="q-mr-sm" />
                <div class="text-subtitle2">{{ stageText }}</div>
                <q-space />
                <div class="text-caption text-grey-8">{{ elapsed }}s</div>
              </div>
              <q-linear-progress :value="progressPct / 100" color="deep-orange-8" rounded size="10px" />
              <div class="text-caption text-grey-7 q-mt-sm">
                <template v-if="!overdue">
                  About {{ progressPct }}% (estimated).
                  <template v-if="mode === 'live'">A live search checks every home in the area and takes 1–2 minutes. Keep this page open.</template>
                </template>
                <template v-else>Taking a little longer than usual. Still working, so please keep this page open.</template>
              </div>
            </q-card-section>
          </q-card>

          <!-- results -->
          <template v-if="result">
            <q-card flat bordered class="q-mb-md">
              <q-card-section class="row items-center q-gutter-sm">
                <div class="text-subtitle1 text-weight-bold col-auto">
                  {{ result.results.length }} opportunities · {{ result.market.name }}
                  <q-badge v-if="result.mode === 'demo'" color="purple" class="q-ml-xs">DEMO DATA</q-badge>
                  <q-badge v-else color="green-8" class="q-ml-xs">LIVE</q-badge>
                </div>
                <q-space />
                <q-btn flat dense no-caps icon="done_all" :label="selected.size === result.results.length ? 'Clear' : 'Select all'" @click="selectAll" />
                <q-btn flat dense no-caps icon="content_copy" :label="`Copy selected (${selected.size})`" :disable="!selected.size" @click="copySelected" />
                <q-btn flat dense no-caps icon="download" label="Export CSV" :disable="isSample" @click="exportCsv(selected.size > 0)">
                  <q-tooltip v-if="isSample">Not included in the free sample</q-tooltip>
                  <q-tooltip v-else>{{ selected.size ? 'Exports selected rows' : 'Exports all rows' }}</q-tooltip>
                </q-btn>
                <q-btn flat dense no-caps icon="refresh" label="Rerun" :loading="running" @click="run" />
              </q-card-section>
              <q-card-section class="q-pt-none text-caption text-grey-8">
                <span v-for="(n, t) in tierCounts" :key="t" class="q-mr-md"><b>{{ n }}</b> {{ t }}</span>
                · scanned {{ result.stats.candidatesScanned.toLocaleString() }} properties
                <span v-for="(n, k) in result.stats.evidenceItems" :key="k"> · {{ n.toLocaleString() }} {{ k }}</span>
                · {{ result.stats.durationMs }} ms
                <div v-if="excludedList.length" class="q-mt-xs">
                  Excluded: <span v-for="[k, n] in excludedList" :key="k" class="q-mr-sm">{{ k }} ({{ n }})</span>
                </div>
                <div class="q-mt-xs">
                  Sources:
                  <span v-for="s in result.sources" :key="s.id" class="q-mr-sm">
                    <q-icon :name="s.ok ? 'check_circle' : 'error'" :color="s.ok ? 'green-7' : 'red-7'" /> {{ s.label }} ({{ s.records }})
                  </span>
                </div>
              </q-card-section>
              <q-card-section v-if="result.warnings.length" class="q-pt-none">
                <q-banner dense rounded class="bg-amber-1 text-amber-10">
                  <div v-for="w in result.warnings" :key="w">{{ w }}</div>
                </q-banner>
              </q-card-section>
            </q-card>

            <div class="disclaimer q-mb-md">
              <q-icon name="info" /> {{ result.disclaimers.join(' ') }}
            </div>

            <ResultCard v-for="r in result.results" :key="r.candidate.id" :r="r" :selected="selected.has(r.candidate.id)" @toggle="toggle(r.candidate.id)" />
            <div v-if="!result.results.length" class="text-grey-7 q-pa-lg text-center">No properties matched. Try loosening the filters.</div>
            <div v-if="isSample && result.results.length" class="text-center q-pa-md text-grey-8">
              This free sample is limited to {{ result.results.length }} opportunities. The full system runs across your whole service area with export.
            </div>
          </template>

          <div v-else-if="!running" class="empty text-center text-grey-7 q-pa-xl">
            <q-icon name="travel_explore" size="48px" />
            <div class="q-mt-sm">Pick a service area and press <b>Find Opportunities</b>.</div>
            <div class="text-caption">Pulls current storm reports + permit history, cross-references them, and ranks properties worth prospecting.</div>
          </div>
        </template>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<style>
body { background: #f6f7f9; }
.page { max-width: 1100px; margin: 0 auto; }
.find-btn { font-weight: 700; letter-spacing: 0.02em; }
.disclaimer { font-size: 12px; color: #4b5563; background: #eef2ff; padding: 8px 12px; border-radius: 6px; }
</style>
