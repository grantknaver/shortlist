<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Result } from '../api';

const props = defineProps<{ r: Result; selected: boolean }>();
defineEmits<{ (e: 'toggle'): void }>();
const open = ref(false);

const TIER: Record<string, { color: string; label: string }> = {
  'Very High': { color: 'red-8', label: 'VERY HIGH PRIORITY' },
  High: { color: 'orange-8', label: 'HIGH PRIORITY' },
  Medium: { color: 'amber-8', label: 'MEDIUM PRIORITY' },
  Low: { color: 'grey-6', label: 'LOW PRIORITY' },
};
const tier = computed(() => TIER[props.r.tier] ?? TIER.Low);
const d = computed(() => props.r.display);

const roofLine = computed(() => {
  const x = d.value;
  if (x.roofBasis === 'reroof-permit') return `Last known reroof: ${x.lastKnownReroof}`;
  if (x.roofBasis === 'house-construction-permit') return `House construction permit ${x.originalConstructionPermit}${(x as any).roofStatus === 'possible-prior-roof-work' ? ' — possible prior roof work' : ', no known reroof'}`;
  if (x.roofBasis === 'year-built') return `Estimated from year built (${x.yearBuilt})`;
  return x.yearBuilt ? `Built ${x.yearBuilt} — roof age unknown` : 'Roof age unknown';
});
const confLabel = (c: number) => (c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : 'low');
const mapsUrl = computed(() => {
  const l = props.r.candidate.location;
  return l ? `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}` : undefined;
});
</script>

<template>
  <q-card flat bordered class="result" :class="{ selected }">
    <q-card-section class="row items-start no-wrap q-gutter-sm">
      <q-checkbox :model-value="selected" dense @update:model-value="$emit('toggle')" />
      <div class="col">
        <div class="row items-center q-gutter-sm">
          <q-badge :color="tier.color" class="text-weight-bold q-px-sm q-py-xs">{{ tier.label }}</q-badge>
          <q-badge v-if="d.isDemo" outline color="purple">DEMO · fictional</q-badge>
          <span class="text-caption text-grey-7">#{{ r.rank }}</span>
        </div>
        <div class="text-h6 q-mt-xs">
          {{ r.candidate.label }}
          <a v-if="mapsUrl" :href="mapsUrl" target="_blank" rel="noopener" class="text-caption q-ml-xs">map ↗</a>
        </div>
        <div class="text-subtitle2 text-grey-9">
          <q-icon name="bolt" color="orange-8" /> {{ r.headline }}
        </div>
        <div v-if="d.demoScenario" class="text-caption text-purple-7">Demo scenario: {{ d.demoScenario }}</div>
      </div>
      <div class="score text-center">
        <q-circular-progress show-value :value="r.score" size="58px" :thickness="0.18" :color="tier.color" track-color="grey-3" class="text-weight-bold">
          {{ r.score }}
        </q-circular-progress>
        <div class="text-caption text-grey-7">data conf. {{ confLabel(r.confidence) }}</div>
      </div>
    </q-card-section>

    <q-card-section class="row q-col-gutter-md q-pt-none">
      <div class="col-12 col-md-4">
        <div class="label"><q-icon name="roofing" /> Roof</div>
        <div>{{ roofLine }}</div>
        <div v-if="d.estRoofAgeYears !== null">
          ~{{ d.estRoofAgeYears }} yrs
          <q-badge :color="d.roofConfidence >= 0.8 ? 'green-7' : d.roofConfidence >= 0.5 ? 'blue-grey-6' : 'grey-5'" class="q-ml-xs">
            {{ confLabel(d.roofConfidence) }} confidence
          </q-badge>
        </div>
        <div class="text-caption text-grey-8">{{ d.noNewerReroof }}</div>
      </div>
      <div class="col-12 col-md-4">
        <div class="label"><q-icon name="thunderstorm" /> Weather exposure</div>
        <template v-if="d.storm">
          <div>{{ d.storm.type }} — {{ d.storm.magnitude }}</div>
          <div>{{ d.storm.date }} ({{ d.storm.daysAgo }} days ago)</div>
          <div>Reported ~{{ d.storm.distanceMi }} mi from property</div>
          <div v-if="d.storm.otherReports" class="text-caption">+{{ d.storm.otherReports }} other report(s) nearby</div>
        </template>
        <div v-else class="text-grey-7">No qualifying report nearby</div>
      </div>
      <div class="col-12 col-md-4">
        <div class="label"><q-icon name="home" /> Property</div>
        <div v-for="p in d.propertyIndicators" :key="p">{{ p }}</div>
      </div>
    </q-card-section>

    <q-card-section class="q-pt-none">
      <div class="angle"><b>Suggested angle:</b> {{ r.angle }}</div>
    </q-card-section>

    <q-card-actions class="q-pt-none">
      <q-btn flat dense no-caps color="primary" :icon="open ? 'expand_less' : 'expand_more'" :label="open ? 'Hide evidence' : 'Why this property surfaced'" @click="open = !open" />
    </q-card-actions>

    <q-slide-transition>
      <q-card-section v-show="open" class="bg-grey-1">
        <div class="label">Evidence</div>
        <ul class="q-my-xs">
          <li v-for="(x, i) in r.reasons" :key="i">{{ x }}</li>
        </ul>
        <div v-if="d.storm?.remark" class="text-caption q-mb-sm">
          Report remark: “{{ d.storm.remark }}” — {{ d.storm.source }}
          <a v-if="d.storm.sourceUrl" :href="d.storm.sourceUrl" target="_blank" rel="noopener">source ↗</a>
        </div>
        <div v-if="d.permits.length" class="q-mb-sm">
          <div class="label">Roof-relevant permits</div>
          <div v-for="p in d.permits" :key="p.id" class="text-caption">{{ p.year }} · {{ p.category }} · {{ p.description }} ({{ p.id }})</div>
        </div>
        <div class="label">Score breakdown</div>
        <q-markup-table flat dense class="bg-transparent breakdown">
          <tbody>
            <tr v-for="b in r.breakdown" :key="b.signal">
              <td>{{ b.label }}</td>
              <td style="width: 45%"><q-linear-progress :value="b.score" color="primary" track-color="grey-3" rounded size="8px" /></td>
              <td class="text-right">+{{ b.points }}</td>
            </tr>
            <tr v-for="c in r.crossSignalsApplied" :key="c.id">
              <td colspan="2" class="text-orange-9">{{ c.label }}</td>
              <td class="text-right text-orange-9">+{{ c.bonus }}</td>
            </tr>
          </tbody>
        </q-markup-table>
        <div class="text-caption text-grey-7 q-mt-xs">Final score is adjusted by data confidence ({{ r.confidence }}) and capped at 100.</div>
      </q-card-section>
    </q-slide-transition>
  </q-card>
</template>

<style scoped>
.result { margin-bottom: 12px; }
.result.selected { border-color: var(--q-primary); box-shadow: 0 0 0 1px var(--q-primary); }
.label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #6b7280; font-weight: 600; margin-bottom: 2px; }
.angle { background: #fff7ed; border-left: 3px solid #ea580c; padding: 6px 10px; border-radius: 4px; }
.score { min-width: 78px; }
.breakdown td { padding: 2px 6px !important; height: auto !important; }
</style>
