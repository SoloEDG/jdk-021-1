<script setup lang="ts">
import { computed } from "vue";
import type { Game } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { STEP_LABEL } from "../model/engine";
import type {
  SandboxReport,
  SandboxStep,
  SimStep,
} from "../model/types";

const props = defineProps<{
  game: Game;
  report: SandboxReport;
  steps: SandboxStep[];
  changedIds: number[];
  heatImpact: number[];
  conflictImpact: number[];
  locked: boolean;
}>();
const emit = defineEmits<{
  update: [id: number, patch: Partial<SandboxStep>];
  remove: [id: number];
}>();

const simById = computed(
  () => new Map(props.report.steps.map((s) => [s.step.id, s])),
);
const issueSet = computed(() => {
  const m = new Map<number, string[]>();
  for (const s of props.report.steps) {
    if (s.issues.length) m.set(s.step.id, s.issues.map((i) => i.message));
  }
  return m;
});
const sorted = computed(() =>
  [...props.steps].sort((a, b) => a.at - b.at || a.id - b.id),
);
const panIds = computed(() =>
  props.game.stoves.filter((s) => s.kind === "pan").map((s) => s.id),
);
const potIds = computed(() =>
  props.game.stoves.filter((s) => s.kind === "pot").map((s) => s.id),
);

function stoveOptions(step: SandboxStep) {
  return recipes[step.recipe].station === "pot" ? potIds.value : panIds.value;
}
function badge(sim: SimStep | undefined) {
  if (!sim) return "";
  if (sim.step.type === "lift")
    return sim.liftQuality !== undefined ? `起锅品质 ${sim.liftQuality}` : "";
  if (sim.step.type === "deliver")
    return sim.serveQuality !== undefined
      ? `交付品质 ${sim.serveQuality}${sim.revenue !== undefined ? ` · +¥${sim.revenue}` : ""}`
      : "";
  if (sim.step.type === "plate" && sim.cooldown !== undefined)
    return `离起锅 ${sim.cooldown}s`;
  return "";
}
</script>

<template>
  <div class="sb-table" role="table" aria-label="沙盘步骤表">
    <div class="sb-row sb-head" role="row">
      <span>时刻</span><span>阶段</span><span>订单 / 菜品</span
      ><span>灶台</span><span>推演结果</span><span></span>
    </div>
    <div
      v-for="step in sorted"
      :key="step.id"
      class="sb-row"
      role="row"
      :class="{
        bad: issueSet.has(step.id),
        changed: changedIds.includes(step.id),
        heat: heatImpact.includes(step.id),
        clash: conflictImpact.includes(step.id),
      }"
    >
      <span class="sb-time">
        <input
          type="number"
          min="0"
          step="0.5"
          :value="step.at"
          :disabled="locked"
          @change="
            emit('update', step.id, {
              at: Math.max(0, Number(($event.target as HTMLInputElement).value)),
            })
          "
        /><small>s</small>
      </span>
      <span class="sb-stage">{{ STEP_LABEL[step.type] }}</span>
      <span class="sb-dish">
        <b>{{ recipes[step.recipe].icon }} {{ recipes[step.recipe].name }}</b>
        <small>#{{ String(step.orderId).replace("-", "演") }}</small>
      </span>
      <span>
        <select
          v-if="step.type === 'cook' || step.type === 'lift'"
          :value="step.stoveId ?? ''"
          :disabled="locked"
          @change="
            emit('update', step.id, {
              stoveId: Number(($event.target as HTMLSelectElement).value),
            })
          "
        >
          <option v-for="id in stoveOptions(step)" :key="id" :value="id">
            {{ recipes[step.recipe].station === "pan" ? "煎锅" : "汤锅" }}0{{ id }}
          </option>
        </select>
        <em v-else class="muted">—</em>
      </span>
      <span class="sb-result">
        <template v-if="issueSet.has(step.id)">
          <i v-for="(m, i) in issueSet.get(step.id)" :key="i" class="sb-err">⚠ {{ m }}</i>
        </template>
        <template v-else>
          <i class="sb-ok">✓ 可执行</i>
          <small v-if="badge(simById.get(step.id)!)">{{
            badge(simById.get(step.id)!)
          }}</small>
        </template>
      </span>
      <span>
        <button
          class="sb-x"
          :disabled="locked"
          @click="emit('remove', step.id)"
          title="删除步骤"
        >
          ×
        </button>
      </span>
    </div>
    <p v-if="!sorted.length" class="empty">
      沙盘还是空的：从左侧订单加入五步计划，或点“自动排程”。
    </p>
  </div>
</template>
