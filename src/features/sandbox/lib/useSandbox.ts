import { computed, onUnmounted, ref } from "vue";
import type { Game, RecipeId } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { simulate, impactSet } from "../model/engine";
import { autoPlan } from "../model/planner";
import { buildContentionDemo, type ContentionDemo } from "../model/demo";
import {
  adoptPlan,
  createRunner,
  type PlanRunner,
  type RunnerState,
} from "../model/adopt";
import type {
  AdoptionResult,
  SandboxReport,
  SandboxStep,
  StepType,
} from "../model/types";

let idSeq = 1;
const allocId = () => idSeq++;

export function useSandbox(game: Game) {
  const steps = ref<SandboxStep[]>([]);
  const changedIds = ref<number[]>([]);
  const heatImpact = ref<number[]>([]);
  const conflictImpact = ref<number[]>([]);
  const lastAdoption = ref<AdoptionResult | null>(null);
  const runnerState = ref<RunnerState>({
    active: false,
    total: 0,
    done: 0,
    stale: [],
  });
  let runner: PlanRunner | null = null;

  const demo = ref<ContentionDemo | null>(null);
  const demoVariant = ref<"good" | "bad">("good");

  const report = computed<SandboxReport>(() =>
    simulate(game, steps.value, demo.value?.options),
  );
  const demoReport = computed(() => {
    if (!demo.value) return null;
    const list =
      demoVariant.value === "good" ? demo.value.good : demo.value.bad;
    return simulate(game, list, demo.value.options);
  });

  function markChanged(id: number) {
    changedIds.value = [id];
    const impact = impactSet(steps.value, id);
    heatImpact.value = impact.heat;
    conflictImpact.value = impact.conflicts;
  }

  function addStepsForOrder(orderId: number, recipe: RecipeId) {
    if (runnerState.value.active) return;
    const t = Math.max(game.time, Math.ceil(game.time));
    const target = recipes[recipe].target;
    const stoveId = recipes[recipe].station === "pot" ? 3 : 1;
    const group: SandboxStep[] = [
      mk("prep", orderId, recipe, null, t),
      mk("cook", orderId, recipe, stoveId, t),
      mk("lift", orderId, recipe, stoveId, t + target),
      mk("plate", orderId, recipe, null, t + target + 1),
      mk("deliver", orderId, recipe, null, t + target + 2),
    ];
    steps.value = [...steps.value, ...group];
    markChanged(group[0].id);
  }

  function removeOrderSteps(orderId: number) {
    if (runnerState.value.active) return;
    steps.value = steps.value.filter((s) => s.orderId !== orderId);
    changedIds.value = [];
    heatImpact.value = [];
    conflictImpact.value = [];
  }

  function updateStep(id: number, patch: Partial<SandboxStep>) {
    if (runnerState.value.active) return;
    steps.value = steps.value.map((s) => (s.id === id ? { ...s, ...patch } : s));
    markChanged(id);
  }

  function removeStep(id: number) {
    if (runnerState.value.active) return;
    steps.value = steps.value.filter((s) => s.id !== id);
    changedIds.value = [];
  }

  function clearAll() {
    if (runnerState.value.active) return;
    steps.value = [];
    changedIds.value = [];
    heatImpact.value = [];
    conflictImpact.value = [];
    lastAdoption.value = null;
  }

  function runAuto(orderIds: number[]) {
    if (runnerState.value.active) return { skipped: [] };
    const { steps: generated, skipped } = autoPlan(game, orderIds, allocId);
    const existing = new Set(steps.value.map((s) => s.orderId));
    const fresh = generated.filter((s) => !existing.has(s.orderId));
    steps.value = [...steps.value, ...fresh].sort(
      (a, b) => a.at - b.at || a.id - b.id,
    );
    changedIds.value = fresh.map((s) => s.id);
    return { skipped };
  }

  function adopt(): AdoptionResult | { error: string } {
    if (runnerState.value.active) return { error: "已有计划正在执行中" };
    if (demo.value) return { error: "演示场景为虚拟数据，不能采用到实战" };
    const r = report.value;
    if (r.prefix === 0)
      return {
        error: "没有可执行的连续前缀：请先修正沙盘里的红色步骤",
      };
    const result = adoptPlan(game, steps.value, r.prefix);
    // 沙盘只保留未被接纳的步骤，已接纳的交给执行器
    steps.value = result.kept;
    lastAdoption.value = result;
    runner = createRunner(game, result.queue, (s) => {
      runnerState.value = s;
    });
    runner.onStaleRest((rest) => {
      // 失效步骤的剩余链条退回沙盘，供调整后再次采用
      steps.value = [...steps.value, ...rest].sort(
        (a, b) => a.at - b.at || a.id - b.id,
      );
    });
    return result;
  }

  function openDemo() {
    demo.value = buildContentionDemo(game);
    demoVariant.value = "good";
  }
  function closeDemo() {
    demo.value = null;
  }
  function toggleDemoVariant() {
    demoVariant.value = demoVariant.value === "good" ? "bad" : "good";
  }

  function reset() {
    runner?.stop();
    runner = null;
    steps.value = [];
    changedIds.value = [];
    heatImpact.value = [];
    conflictImpact.value = [];
    lastAdoption.value = null;
    runnerState.value = { active: false, total: 0, done: 0, stale: [] };
    demo.value = null;
  }

  onUnmounted(() => runner?.stop());

  return {
    steps,
    report,
    changedIds,
    heatImpact,
    conflictImpact,
    runnerState,
    lastAdoption,
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
    reset,
  };
}

function mk(
  type: StepType,
  orderId: number,
  recipe: RecipeId,
  stoveId: number | null,
  at: number,
): SandboxStep {
  return { id: allocId(), type, orderId, recipe, stoveId, at };
}
