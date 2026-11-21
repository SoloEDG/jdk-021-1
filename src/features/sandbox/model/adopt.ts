import type { Game, RecipeId, RecipeId as Rid } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { prepare } from "../../pantry/model/inventory";
import { accept } from "../../orders/model/orders";
import { cook, lift } from "../../kitchen/model/cooking";
import { plate } from "../../service/model/plating";
import { deliver } from "../../service/model/delivery";
import type {
  AdoptionResult,
  SandboxStep,
  StepType,
} from "./types";

interface QueuedStep {
  step: SandboxStep;
  portionId?: number;
  dishId?: number;
}

export interface RunnerState {
  active: boolean;
  total: number;
  done: number;
  stale: { step: SandboxStep; message: string }[];
}

/**
 * 采用计划：只接纳推演报告中仍可执行的连续前缀，
 * 且前缀中的每一步在“当前营业时刻”仍然新鲜；其余步骤原样留在沙盘供继续调整。
 */
export function adoptPlan(
  g: Game,
  steps: SandboxStep[],
  reportPrefix: number,
): AdoptionResult {
  const sorted = [...steps].sort((a, b) => a.at - b.at || a.id - b.id);
  const kept: SandboxStep[] = [];
  const stale: AdoptionResult["stale"] = [];
  const queue: SandboxStep[] = [];

  sorted.forEach((step, i) => {
    const staleAtAdopt = step.at < g.time - 1e-6;
    if (i < reportPrefix && !staleAtAdopt) {
      queue.push(step);
    } else {
      kept.push(step);
      const message = staleAtAdopt
        ? `计划时刻 ${Math.round(step.at * 10) / 10}s 已早于当前营业时刻，需重新排期`
        : "位于失效步骤之后或本身不可执行，留在沙盘继续调整";
      stale.push({ step, message });
    }
  });

  return { adopted: queue.length, stale, kept, queue };
}

export interface PlanRunner {
  state: RunnerState;
  /** 失效时回调：参数为未执行的剩余步骤，应退回沙盘 */
  onStaleRest: (handler: (rest: SandboxStep[]) => void) => void;
  stop: () => void;
}

/**
 * 运行时执行器：营业继续进行，每 100ms 复查一次现场资源。
 * 任何一步复查不过：本步不执行、后续全部退回沙盘，绝不动在灶食品。
 */
export function createRunner(
  g: Game,
  initial: SandboxStep[],
  onUpdate: (s: RunnerState) => void,
): PlanRunner {
  let queue: QueuedStep[] = initial.map((step) => ({ step }));
  const stale: RunnerState["stale"] = [];
  let restHandler: (rest: SandboxStep[]) => void = () => {};
  let done = 0;
  const state: RunnerState = {
    active: queue.length > 0,
    total: initial.length,
    done: 0,
    stale,
  };

  const emit = () => {
    state.done = done;
    state.active = queue.length > 0;
    onUpdate({ active: state.active, total: state.total, done, stale: [...stale] });
  };
  emit();

  const timer = setInterval(() => {
    if (!g.running || g.ended || queue.length === 0) return;
    // 同一 tick 内依次执行所有到时步骤，按时间顺序；遇到未到时刻的队首即结束本轮
    while (queue.length) {
      const head = queue[0];
      if (head.step.at > g.time + 1e-6) break;
      queue.shift();
      const fail = execute(g, head, queue);
      if (fail) {
        stale.push({ step: head.step, message: fail });
        const rest = queue.map((q) => q.step);
        queue = [];
        done = state.total - stale.length - rest.length;
        clearInterval(timer);
        state.active = false;
        emit();
        restHandler(rest);
        return;
      }
      done++;
    }
    emit();
    if (queue.length === 0) {
      clearInterval(timer);
      state.active = false;
      emit();
    }
  }, 100);

  return {
    state,
    onStaleRest: (handler) => {
      restHandler = handler;
    },
    stop: () => {
      clearInterval(timer);
      state.active = false;
      emit();
    },
  };
}

/** 执行单步并做现场复查；返回错误信息表示该步骤已失效。
 *  成功产生的备料/菜品 id 沿同订单后续步骤链传递，避免被实战选中状态干扰。 */
function execute(g: Game, q: QueuedStep, rest: QueuedStep[]): string {
  const s = q.step;
  const order = g.orders.find((o) => o.id === s.orderId);
  if (!order) return "订单已不存在";
  if (order.status === "left") return "客人已离店";
  if (order.status === "served") return "订单已交付";
  if (order.recipe !== s.recipe) return "订单菜品与计划不符";
  /** 把 id 传递给同订单的下一步（cook→lift→plate→deliver） */
  const pass = (patch: Partial<QueuedStep>) => {
    const next = rest.find((x) => x.step.orderId === s.orderId);
    if (next) Object.assign(next, patch);
  };

  switch (s.type as StepType) {
    case "prep":
      if (g.stock[recipes[s.recipe].ingredient] < 1)
        return "采用后库存已被实战消耗，食材不足";
      if (g.portions.length >= 6) return "备料台已满（6 份）";
      prepare(g, s.recipe);
      q.portionId = g.portions[g.portions.length - 1]?.id;
      pass({ portionId: q.portionId });
      return "";
    case "cook": {
      const stove = g.stoves.find((x) => x.id === s.stoveId);
      if (!stove) return "灶台不存在";
      if (recipes[s.recipe].station !== stove.kind) return "设备不匹配";
      if (stove.portion)
        return "灶台仍被在灶食品占用（释放前不可抢占），计划时刻失效";
      const portion =
        g.portions.find((p) => p.id === q.portionId) ??
        g.portions.find((p) => p.recipe === (s.recipe as Rid));
      if (!portion) return "备料已被实战用掉，无份可下锅";
      cook(g, portion.id, stove.id);
      return "";
    }
    case "lift": {
      const stove = g.stoves.find((x) => x.id === s.stoveId);
      if (!stove?.portion) return "灶台上没有计划中的菜（可能已被手动起锅）";
      if (stove.portion.recipe !== s.recipe) return "灶台上的菜品与计划不符";
      lift(g, stove.id);
      q.dishId = g.dishes[g.dishes.length - 1]?.id;
      pass({ dishId: q.dishId });
      return "";
    }
    case "plate": {
      const dish =
        g.dishes.find((d) => d.id === q.dishId && d.stage === "counter") ??
        g.dishes.find(
          (d) => d.recipe === (s.recipe as RecipeId) && d.stage === "counter",
        );
      if (!dish) return "出餐台上找不到待装盘的菜";
      plate(g, dish.id);
      q.dishId = dish.id;
      pass({ dishId: dish.id });
      return "";
    }
    case "deliver": {
      if (order.status === "waiting") accept(g, order.id);
      const dish = g.dishes.find(
        (d) => d.id === q.dishId && d.stage === "plated",
      );
      if (!dish) return "找不到已装盘的菜，交付中止";
      g.selectedDish = dish.id;
      g.selectedOrder = order.id;
      const before: string = order.status;
      deliver(g);
      const after: string = order.status;
      if (after !== "served" && before === "accepted")
        return g.notice || "交付被拒收（品质或上菜校验未通过）";
      return "";
    }
  }
}
