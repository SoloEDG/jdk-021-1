<script setup lang="ts">
import { computed, ref } from "vue";
import type { Game } from "../../../shared/types";
import { recipes, ingredients } from "../../../shared/catalog";
import { useSandbox } from "../lib/useSandbox";
import StepTable from "./StepTable.vue";
import DemoDialog from "./DemoDialog.vue";
import type { AdoptionResult } from "../model/types";

const props = defineProps<{ game: Game }>();
const {
  steps,
  report,
  changedIds,
  heatImpact,
  conflictImpact,
  runnerState,
  demo,
  demoVariant,
  demoReport,
  addStepsForOrder,
  removeOrderSteps,
  updateStep,
  removeStep,
  clearAll,
  runAuto,
  adopt,
  openDemo,
  closeDemo,
  toggleDemoVariant,
} = useSandbox(props.game);

const autoMsg = ref("");
const adoptMsg = ref<{ ok: boolean; text: string } | null>(null);

const candidateOrders = computed(() =>
  props.game.orders.filter(
    (o) => o.status === "waiting" || o.status === "accepted",
  ),
);
const plannedOrderIds = computed(() => new Set(steps.value.map((s) => s.orderId)));
const isAdoptError = (
  r: AdoptionResult | { error: string },
): r is { error: string } => "error" in r;

function addOrder(id: number, recipe: Game["orders"][number]["recipe"]) {
  addStepsForOrder(id, recipe);
  autoMsg.value = "";
}
function runAutoPlan() {
  const ids = candidateOrders.value.map((o) => o.id);
  const { skipped } = runAuto(ids);
  autoMsg.value = skipped.length
    ? `自动排程跳过 ${skipped.length} 单：${skipped.map((s) => s.message).join("；")}`
    : "自动排程完成，所有候选订单均已排入。";
}
function adoptPrefix() {
  const r = adopt();
  if (isAdoptError(r)) {
    adoptMsg.value = { ok: false, text: r.error };
  } else {
    adoptMsg.value = {
      ok: true,
      text: `已采用连续前缀 ${r.adopted} 步，${r.kept.length ? `其余 ${r.kept.length} 步留在沙盘` : "全部步骤已交给执行器"}。`,
    };
  }
}
function fmt(t: number) {
  return `${Math.round(t * 10) / 10}s`;
}
function abandonOf(orderId: number) {
  return report.value.abandoned.filter((x) => x.orderId === orderId);
}
</script>

<template>
  <section class="panel sandbox-panel">
    <div class="section-heading">
      <div>
        <span class="eyebrow">04 / PRE-SHIFT SANDBOX</span>
        <h2>
          排程沙盘 <span class="small">SIMULATE BEFORE COMMIT</span>
        </h2>
      </div>
      <div class="sb-actions">
        <button class="tiny soft" @click="openDemo()">争锅演示</button>
        <button class="tiny soft" :disabled="runnerState.active" @click="runAutoPlan">
          自动排程
        </button>
        <button class="tiny" :disabled="runnerState.active" @click="clearAll">
          清空沙盘
        </button>
      </div>
    </div>

    <!-- 运行时执行器状态 -->
    <div
      v-if="runnerState.total"
      class="sb-runner"
      :class="{ running: runnerState.active }"
    >
      <span class="sb-pulse"></span>
      <template v-if="runnerState.active">
        计划执行中 {{ runnerState.done }} / {{ runnerState.total }}
        步，营业继续，每步执行前复查资源
      </template>
      <template v-else>
        计划已结束：成功 {{ runnerState.done }} 步，失效
        {{ runnerState.stale.length }} 步
        <ul v-if="runnerState.stale.length">
          <li v-for="(x, i) in runnerState.stale" :key="i">
            ⚠ {{ recipes[x.step.recipe].name }} 的{{ x.step.type }}步骤失效：{{ x.message }}
          </li>
        </ul>
      </template>
    </div>

    <!-- 候选订单与放弃原因 -->
    <div class="sb-orders">
      <article
        v-for="o in candidateOrders"
        :key="o.id"
        class="sb-order"
        :class="{
          planned: plannedOrderIds.has(o.id),
          lost: abandonOf(o.id).length > 0,
        }"
      >
        <div>
          <b>{{ recipes[o.recipe].icon }} {{ recipes[o.recipe].name }}</b>
          <small
            >#{{ o.id }} · {{ o.guest }} · 截止 {{ fmt(o.deadline) }} ·
            ¥{{ recipes[o.recipe].price }}</small
          >
        </div>
        <div class="sb-order-btns">
          <button
            class="tiny"
            :disabled="plannedOrderIds.has(o.id) || runnerState.active"
            @click="addOrder(o.id, o.recipe)"
          >
            排入五步
          </button>
          <button
            class="tiny soft"
            :disabled="!plannedOrderIds.has(o.id) || runnerState.active"
            @click="removeOrderSteps(o.id)"
          >
            移出
          </button>
        </div>
        <p v-for="a in abandonOf(o.id)" :key="a.reason" class="sb-abandon">
          放弃原因（{{ a.reason }}）：{{ a.message }}
        </p>
      </article>
      <p v-if="!candidateOrders.length" class="empty">当前没有可排的活跃订单。</p>
    </div>

    <!-- 汇总指标 -->
    <div class="sb-summary">
      <div><small>预计可保收入</small><b>¥{{ report.revenue }}</b></div>
      <div>
        <small>可交付 / 已排订单</small
        ><b>{{ report.feasibleCount }} / {{ report.plannedCount }}</b>
      </div>
      <div>
        <small>连续可执行前缀</small
        ><b>{{ report.prefix }} / {{ report.steps.length }} 步</b>
      </div>
      <div v-if="heatImpact.length" class="sb-hint heat-hint">
        🔥 高亮步骤的火候/冷却随本次修改变化
      </div>
      <div v-if="conflictImpact.length" class="sb-hint clash-hint">
        ⛓ 高亮步骤与修改步骤存在灶台争用
      </div>
    </div>

    <!-- 库存覆盖 -->
    <div class="sb-stock">
      <span
        v-for="row in report.stock"
        :key="row.ingredient"
        class="sb-stock-row"
        :class="{ bad: !row.ok }"
      >
        {{ ingredients[row.ingredient].icon }} {{ ingredients[row.ingredient].name }}
        <b>
          可用 {{ row.available }} · 沙盘计划 {{ row.planned }} ·
          {{ row.ok ? "覆盖✓" : "不足✕" }}</b
        >
      </span>
    </div>

    <p v-if="autoMsg" class="sb-auto-msg">{{ autoMsg }}</p>

    <StepTable
      :game="game"
      :report="report"
      :steps="steps"
      :changed-ids="changedIds"
      :heat-impact="heatImpact"
      :conflict-impact="conflictImpact"
      :locked="runnerState.active"
      @update="(id, patch) => updateStep(id, patch)"
      @remove="(id) => removeStep(id)"
    />

    <!-- 采用控制 -->
    <div class="sb-adopt">
      <div>
        <p>
          采用时按当前营业时刻复查：库存、灶台（在灶食品不可抢占）、订单状态与容量。只接纳仍可执行的连续前缀，其余步骤留在沙盘；执行中若资源变化，失效步骤会停下并退回，不会挤掉已下锅的菜。
        </p>
        <p v-if="adoptMsg" :class="adoptMsg.ok ? 'ok-text' : 'bad-text'">
          {{ adoptMsg.text }}
        </p>
      </div>
      <button
        class="sb-adopt-btn"
        :disabled="!steps.length || runnerState.active"
        @click="adoptPrefix"
      >
        采用可执行前缀
      </button>
    </div>

    <DemoDialog
      v-if="demo"
      :game="game"
      :demo="demo"
      :variant="demoVariant"
      :report="demoReport!"
      @close="closeDemo"
      @toggle="toggleDemoVariant"
    />
  </section>
</template>
