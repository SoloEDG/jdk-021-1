import type {
  Game,
  Ingredient,
  Order,
  RecipeId,
} from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { quality } from "../../kitchen/lib/heat";
import { cooledQuality } from "../../service/lib/freshness";
import type {
  AbandonedOrder,
  IssueCode,
  OrderPlan,
  SandboxReport,
  SandboxStep,
  SimStep,
  StepType,
  StockUse,
} from "./types";

export const STEP_LABEL: Record<StepType, string> = {
  prep: "备料",
  cook: "占锅",
  lift: "起锅",
  plate: "装盘",
  deliver: "交付",
};

export const ISSUE_LABEL: Record<IssueCode, string> = {
  past: "时刻已过",
  "order-gone": "客人已离店",
  "order-served": "订单已交付",
  station: "设备不匹配",
  "stove-busy": "灶台被占",
  "stove-live": "灶台实战占用中",
  "no-portion": "缺少前置备料",
  stock: "库存不足",
  "prep-capacity": "备料台将满",
  "counter-capacity": "出餐台将满",
  chain: "前置步骤失效",
  deadline: "赶不上截止时间",
  quality: "交付品质过低",
  "duplicate-plan": "订单已有同类步骤",
};

const T1 = 1; // 起锅→装盘
const T2 = 1; // 装盘→交付
const MIN_SERVE_QUALITY = 30;
const MAX_PORTIONS = 6;
const MAX_DISHES = 8;

export interface SimOptions {
  /** 演示用虚拟订单：只参与沙盘推演，采用时会被拦截 */
  extraOrders?: Order[];
  /** 演示用虚拟灶台占用（如另一口锅被占），按实战占用处理，不可抢占 */
  extraStoveBusy?: { stoveId: number; until: number; label: string }[];
  /** 演示用虚拟库存，只在本次推演中生效 */
  extraStock?: Partial<Record<Ingredient, number>>;
}

interface PortionState {
  orderId: number;
  recipe: RecipeId;
  alive: boolean;
}

export function simulate(
  g: Game,
  steps: SandboxStep[],
  opts: SimOptions = {},
): SandboxReport {
  const extra = opts.extraOrders ?? [];
  const allOrders = [...g.orders, ...extra];
  const orderById = new Map(allOrders.map((o) => [o.id, o]));
  const isDemo = (id: number) => extra.some((o) => o.id === id);
  const stockBase: Record<Ingredient, number> = {
    beef: g.stock.beef + (opts.extraStock?.beef ?? 0),
    noodle: g.stock.noodle + (opts.extraStock?.noodle ?? 0),
    greens: g.stock.greens + (opts.extraStock?.greens ?? 0),
  };
  // 同刻步骤按阶段顺序排序，保证“先备料后占锅、先起锅后装盘”的连锁依赖成立
  const stageRank: Record<StepType, number> = {
    prep: 0,
    cook: 1,
    lift: 2,
    plate: 3,
    deliver: 4,
  };
  const sorted = [...steps].sort(
    (a, b) => a.at - b.at || stageRank[a.type] - stageRank[b.type] || a.id - b.id,
  );

  // 同一订单同一阶段只允许一条步骤（同一份食材不能排给两单的前置防线之一）
  const dupSeen = new Set<string>();

  // 沙盘内部状态
  const portions = new Map<number, PortionState>();
  const stoveUntil = new Map<number, number>(); // 沙盘计划占用到何时
  const stoveLiveUntil = new Map<number, number>(); // 实战在灶占用的最早释放时刻
  const counter = g.dishes.length;
  let counterCount = counter;
  const stockPlanned = { beef: 0, noodle: 0, greens: 0 } as Record<
    Ingredient,
    number
  >;
  const stockShort = new Set<Ingredient>();

  for (const s of g.stoves) {
    if (s.portion) {
      const t = recipes[s.portion.recipe].target;
      stoveLiveUntil.set(s.id, Math.max(g.time, s.started + t));
    }
  }
  for (const busy of opts.extraStoveBusy ?? []) {
    stoveLiveUntil.set(
      busy.stoveId,
      Math.max(stoveLiveUntil.get(busy.stoveId) ?? -Infinity, busy.until),
    );
  }

  const sims: SimStep[] = [];
  // 订单级状态
  const orderState = new Map<
    number,
    {
      delivered: boolean;
      deliveredAt?: number;
      serveQuality?: number;
      revenue?: number;
      blockers: string[];
      timeline: OrderPlan["timeline"];
    }
  >();
  const stateOf = (id: number) => {
    let s = orderState.get(id);
    if (!s) {
      s = {
        delivered: false,
        blockers: [],
        timeline: [],
      };
      orderState.set(id, s);
    }
    return s;
  };

  function addIssue(
    sim: SimStep,
    code: IssueCode,
    message: string,
    ref?: number | string,
  ) {
    sim.issues.push({ code, message, ref });
    const o = orderById.get(sim.step.orderId);
    if (o) stateOf(o.id).blockers.push(message);
  }

  for (const step of sorted) {
    const sim: SimStep = { step, issues: [] };
    const order = orderById.get(step.orderId);
    const r = recipes[step.recipe];
    const st = stateOf(step.orderId);
    st.timeline.push({
      type: step.type,
      at: step.at,
      stoveId: step.stoveId,
    });

    // —— 通用检查 ——
    if (step.at < g.time - 1e-6) {
      addIssue(sim, "past", `计划时刻 ${fmt(step.at)} 已早于当前营业时刻`);
    }
    if (!order) {
      addIssue(sim, "order-gone", "订单已不存在");
    } else if (!isDemo(order.id)) {
      if (order.status === "left") {
        addIssue(
          sim,
          "order-gone",
          `${order.guest} 已于 ${fmt(order.deadline)} 离店`,
          order.id,
        );
      } else if (order.status === "served") {
        addIssue(sim, "order-served", "该订单已经交付完成", order.id);
      }
    }
    const key = `${step.orderId}:${step.type}`;
    if (dupSeen.has(key)) {
      addIssue(sim, "duplicate-plan", "同一订单存在重复步骤");
    } else {
      dupSeen.add(key);
    }

    // —— 分类型检查与状态推进（无错误才推进，失效步骤不消耗虚拟资源）——
    if (sim.issues.length === 0 && order) {      if (step.type === "prep") {
        if (portions.size >= MAX_PORTIONS) {
          addIssue(
            sim,
            "prep-capacity",
            "备料台将达到 6 份上限，先安排下锅腾位",
          );
        } else {
          const ing = r.ingredient;
          const liveReserved = countLiveReserved(g, ing);
          if (
            stockBase[ing] - liveReserved - stockPlanned[ing] < 1 ||
            stockShort.has(ing)
          ) {
            stockShort.add(ing);
            addIssue(
              sim,
              "stock",
              `库存 ${ingName(ing)} 不足以覆盖计划消耗（可用 ${stockBase[ing] - liveReserved} 份）`,
              ing,
            );
          } else {
            stockPlanned[ing]++;
            portions.set(step.id, {
              orderId: step.orderId,
              recipe: step.recipe,
              alive: true,
            });
          }
        }
      } else if (step.type === "cook") {
        const stove = g.stoves.find((x) => x.id === step.stoveId);
        const p = takePortion(portions, step.orderId, step.recipe);
        if (!p) {
          addIssue(
            sim,
            "no-portion",
            "没有可下锅的备料：先排备料，且一份食材只能归一单",
          );
        } else if (!stove) {
          addIssue(sim, "station", "灶台不存在");
        } else if (r.station !== stove.kind) {
          addIssue(
            sim,
            "station",
            `${r.name}只能用${stove.kind === "pot" ? "汤锅" : "煎锅"}`,
            stove.id,
          );
        } else {
          const live = stoveLiveUntil.get(stove.id);
          const busyUntil = stoveUntil.get(stove.id) ?? -Infinity;
          if (live !== undefined && step.at < live - 1e-6) {
            addIssue(
              sim,
              "stove-live",
              `${stoveName(stove)}实战烹饪中，最早 ${fmt(live)} 才释放，不能挤掉在灶食品`,
              `live-stove-${stove.id}`,
            );
          } else if (step.at < busyUntil - 1e-6) {
            addIssue(
              sim,
              "stove-busy",
              `${stoveName(stove)}在 ${fmt(busyUntil)} 前被沙盘上一道菜占用`,
              busyUntil,
            );
          } else {
            p.alive = false;
            stoveUntil.set(stove.id, step.at + r.target);
          }
        }
      } else if (step.type === "lift") {
        const stove = g.stoves.find((x) => x.id === step.stoveId);
        const cookedAt = findCookAt(sorted, step);
        if (!stove) {
          addIssue(sim, "station", "灶台不存在");
        } else if (cookedAt === undefined) {
          addIssue(sim, "chain", "缺少时刻不晚于本步骤的占锅步骤");
        } else if (counterCount >= MAX_DISHES) {
          addIssue(
            sim,
            "counter-capacity",
            "出餐台将达到 8 份上限，先安排装盘/交付腾位",
          );
        } else {
          const q = quality(step.recipe, step.at - cookedAt);
          sim.liftQuality = q;
          sim.cooldown = step.at - cookedAt;
          counterCount++;
        }
      } else if (step.type === "plate") {
        // 前置起锅必须时刻不晚于本步骤（同刻按阶段顺序也已排在前面）
        const liftedAt = findPriorStageAt(sorted, step, "lift");
        if (liftedAt === undefined) {
          addIssue(sim, "chain", "缺少时刻不晚于本步骤的起锅步骤");
        } else {
          sim.cooldown = step.at - liftedAt;
        }
      } else if (step.type === "deliver") {
        const platedAt = findPriorStageAt(sorted, step, "plate");
        const liftedAt = findPriorStageAt(sorted, step, "lift");
        const cookedAt = findPriorStageAt(sorted, step, "cook");
        if (platedAt === undefined || liftedAt === undefined) {
          addIssue(sim, "chain", "缺少起锅或装盘步骤");
        } else {
          const liftQ = quality(
            step.recipe,
            liftedAt - (cookedAt ?? liftedAt),
          );
          const q = cooledQuality(liftQ, liftedAt, step.at);
          sim.serveQuality = q;
          sim.cooldown = step.at - liftedAt;
          if (order && step.at > order.deadline + 1e-6) {
            addIssue(
              sim,
              "deadline",
              `${fmt(step.at)} 交付已晚于客人截止 ${fmt(order.deadline)}`,
              order.id,
            );
          } else if (q < MIN_SERVE_QUALITY) {
            addIssue(
              sim,
              "quality",
              `冷却后品质仅 ${q}，低于 ${MIN_SERVE_QUALITY} 会被拒收`,
            );
          } else {
            const base = Math.round((r.price * q) / 100);
            sim.revenue = base;
            st.delivered = true;
            st.deliveredAt = step.at;
            st.serveQuality = q;
            st.revenue = base;
            counterCount--;
          }
        }
      }
    }

    sims.push(sim);
  }

  // —— 汇总每单计划 ——
  const includedOrders = new Set(steps.map((s) => s.orderId));
  const plans: OrderPlan[] = [];
  const abandoned: AbandonedOrder[] = [];
  let revenue = 0;
  let feasibleCount = 0;

  const candidateOrders = allOrders.filter(
    (o) =>
      isDemo(o.id) ||
      o.status === "waiting" ||
      o.status === "accepted",
  );

  for (const o of candidateOrders) {
    const st = orderState.get(o.id);
    const included = includedOrders.has(o.id);
    const feasible = !!st?.delivered && st.blockers.length === 0;
    if (feasible) {
      revenue += st!.revenue!;
      feasibleCount++;
    }
    plans.push({
      orderId: o.id,
      recipe: o.recipe,
      guest: o.guest,
      deadline: o.deadline,
      price: recipes[o.recipe].price,
      included,
      feasible,
      deliveredAt: st?.deliveredAt,
      serveQuality: st?.serveQuality,
      revenue: st?.revenue,
      timeline: st?.timeline ?? [],
      blockers: st?.blockers ?? [],
    });
    if (!included) {
      abandoned.push({
        orderId: o.id,
        reason: "not-selected",
        message: `${o.guest} 的${recipes[o.recipe].name}未排入沙盘（可手动加入或用自动排程）`,
      });
    } else if (!feasible) {
      abandoned.push({
        orderId: o.id,
        ...classifyAbandon(o, st?.blockers ?? []),
      });
    }
  }

  // —— 库存覆盖报告（计划消耗必须能被库存覆盖）——
  const stock: StockUse[] = (["beef", "noodle", "greens"] as Ingredient[]).map(
    (ing) => {
      const live = countLiveReserved(g, ing);
      const planned = stockPlanned[ing];
      const available = stockBase[ing] - live;
      return {
        ingredient: ing,
        need: planned,
        planned,
        live,
        available,
        ok: !stockShort.has(ing) && available >= planned,
      };
    },
  );

  // —— 连续可执行前缀：排序后从头数，第一条出错步骤截断 ——
  let prefix = 0;
  for (const sim of sims) {
    if (sim.issues.length) break;
    prefix++;
  }

  return {
    steps: sims,
    plans,
    abandoned,
    stock,
    revenue,
    feasibleCount,
    plannedCount: includedOrders.size,
    prefix,
    stale: [],
    generatedAt: g.time,
  };
}

/** 受某步骤修改影响的其它步骤：同订单连锁步骤（火候/冷却）+ 同灶台设备冲突 */
export function impactSet(
  steps: SandboxStep[],
  changedId: number,
): { heat: number[]; conflicts: number[] } {
  const changed = steps.find((s) => s.id === changedId);
  if (!changed) return { heat: [], conflicts: [] };
  const heat = steps
    .filter(
      (s) =>
        s.id !== changedId &&
        s.orderId === changed.orderId &&
        (s.type === "lift" || s.type === "plate" || s.type === "deliver"),
    )
    .map((s) => s.id);
  const conflicts = steps
    .filter(
      (s) =>
        s.id !== changedId &&
        s.stoveId !== null &&
        s.stoveId === changed.stoveId,
    )
    .map((s) => s.id);
  return { heat, conflicts };
}

// ——————————————— 内部工具 ———————————————

function takePortion(
  portions: Map<number, PortionState>,
  orderId: number,
  recipe: RecipeId,
): PortionState | undefined {
  for (const p of portions.values()) {
    if (p.alive && p.orderId === orderId && p.recipe === recipe) {
      return p;
    }
  }
  return undefined;
}

function findCookAt(sorted: SandboxStep[], step: SandboxStep) {
  return findPriorStageAt(sorted, step, "cook");
}

/** 查找同订单同菜品、时刻不晚于当前步骤的最近一个指定阶段 */
function findPriorStageAt(
  sorted: SandboxStep[],
  step: SandboxStep,
  type: StepType,
) {
  const found = sorted
    .filter(
      (s) =>
        s.orderId === step.orderId &&
        s.recipe === step.recipe &&
        s.type === type &&
        s.at <= step.at + 1e-6,
    )
    .sort((a, b) => b.at - a.at)[0];
  return found?.at;
}

/** 实战中已经占用的食材：已扣库存做成的备料 + 在灶上的份 */
function countLiveReserved(g: Game, ing: Ingredient): number {
  const fromPortions = g.portions.filter(
    (p) => recipes[p.recipe].ingredient === ing,
  ).length;
  const fromStoves = g.stoves.filter(
    (s) => s.portion && recipes[s.portion.recipe].ingredient === ing,
  ).length;
  return fromPortions + fromStoves;
}

function classifyAbandon(
  o: Order,
  blockers: string[],
): { reason: AbandonedOrder["reason"]; message: string } {
  const text = blockers.join("|");
  const name = recipes[o.recipe].name;
  if (text.includes("库存"))
    return { reason: "stock", message: `${name}：库存无法覆盖备料消耗` };
  if (text.includes("备料台") || text.includes("出餐台"))
    return { reason: "capacity", message: `${name}：备料台/出餐台容量受限` };
  if (text.includes("设备") || text.includes("灶台"))
    return {
      reason: "station",
      message: `${name}：灶台争用无解（${blockers[0] ?? "设备冲突"}）`,
    };
  if (text.includes("品质"))
    return { reason: "quality", message: `${name}：火候/冷却后品质不达标` };
  if (text.includes("截止") || text.includes("离店"))
    return {
      reason: "deadline",
      message: `${name}：最早可交付时刻仍晚于 ${fmt(o.deadline)}`,
    };
  return { reason: "chain", message: `${name}：${blockers[0] ?? "步骤链不完整"}` };
}

function stoveName(s: { id: number; kind: "pan" | "pot" }) {
  return `${s.kind === "pan" ? "煎锅" : "汤锅"}0${s.id}`;
}
function ingName(i: Ingredient) {
  return { beef: "牛肉", noodle: "面条", greens: "时蔬" }[i];
}
function fmt(t: number) {
  return `${Math.round(t * 10) / 10}s`;
}

export { T1, T2, MIN_SERVE_QUALITY, MAX_PORTIONS, MAX_DISHES };
