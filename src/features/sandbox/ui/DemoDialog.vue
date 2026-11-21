<script setup lang="ts">
import { computed } from "vue";
import type { Game } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { STEP_LABEL } from "../model/engine";
import type { ContentionDemo } from "../model/demo";
import type { SandboxReport } from "../model/types";

const props = defineProps<{
  game: Game;
  demo: ContentionDemo;
  variant: "good" | "bad";
  report: SandboxReport;
}>();
const emit = defineEmits<{ close: []; toggle: [] }>();

const steps = computed(() =>
  props.variant === "good" ? props.demo.good : props.demo.bad,
);
const simById = computed(
  () => new Map(props.report.steps.map((s) => [s.step.id, s])),
);
</script>

<template>
  <div class="sb-overlay" @click.self="emit('close')">
    <div class="sb-modal">
      <header>
        <div>
          <span class="eyebrow">SANDBOX / CONTENTION DEMO</span>
          <h3>{{ demo.title }}</h3>
        </div>
        <button class="sb-x" @click="emit('close')">×</button>
      </header>
      <p class="sb-narrative">{{ demo.narrative }}</p>
      <div class="sb-switch">
        <button :class="{ on: variant === 'good' }" @click="variant !== 'good' && emit('toggle')">
          ✓ 正确顺序（先沙拉后牛排）
        </button>
        <button :class="{ on: variant === 'bad' }" @click="variant !== 'bad' && emit('toggle')">
          ✕ 错误顺序（先牛排后沙拉）
        </button>
      </div>
      <p class="sb-narrative" :class="{ warn: variant === 'bad' }">
        {{ variant === "good" ? demo.goodNarrative : demo.badNarrative }}
      </p>

      <div class="sb-demo-grid">
        <div
          v-for="plan in report.plans"
          :key="plan.orderId"
          class="sb-demo-card"
          :class="{ ok: plan.feasible, lost: !plan.feasible }"
        >
          <strong
            >{{ recipes[plan.recipe].icon }}
            {{ recipes[plan.recipe].name }} ·
            {{ demo.orders.find((o) => o.id === plan.orderId)?.guest }}</strong
          >
          <small>截止 {{ plan.deadline }}s · 售价 ¥{{ plan.price }}</small>
          <template v-if="plan.feasible">
            <b class="ok-text"
              >✓ {{ plan.deliveredAt }}s 交付 · 品质 {{ plan.serveQuality }} ·
              +¥{{ plan.revenue }}</b
            >
          </template>
          <template v-else>
            <b class="bad-text">✕ 放弃：{{ plan.blockers[0] }}</b>
          </template>
          <ul>
            <li v-for="(t, i) in plan.timeline" :key="i">
              {{ STEP_LABEL[t.type] }}
              {{ Math.round(t.at * 10) / 10 }}s
              <em v-if="t.stoveId !== null">· 煎锅0{{ t.stoveId }}</em>
            </li>
          </ul>
        </div>
      </div>

      <div class="sb-table sb-compact">
        <div class="sb-row sb-head">
          <span>时刻</span><span>阶段</span><span>菜品</span
          ><span>灶台</span><span>推演</span>
        </div>
        <div
          v-for="step in steps"
          :key="step.id"
          class="sb-row"
          :class="{ bad: simById.get(step.id)?.issues.length }"
        >
          <span>{{ Math.round(step.at * 10) / 10 }}s</span>
          <span>{{ STEP_LABEL[step.type] }}</span>
          <span>{{ recipes[step.recipe].name }}</span>
          <span v-if="step.stoveId !== null">煎锅0{{ step.stoveId }}</span>
          <span v-else>—</span>
          <span class="sb-result">
            <template v-if="simById.get(step.id)?.issues.length">
              <i class="sb-err">{{
                simById.get(step.id)?.issues.map((x) => x.message).join("；")
              }}</i>
            </template>
            <template v-else>
              <i class="sb-ok">✓</i>
            </template>
          </span>
        </div>
      </div>

      <footer>
        <span>
          预计收入 <b>¥{{ report.revenue }}</b> ·
          可保 {{ report.feasibleCount }} / {{ report.plans.length }} 单
        </span>
        <button class="soft" @click="emit('close')">明白了，关闭演示</button>
      </footer>
    </div>
  </div>
</template>
