import type { Game, Order } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import type { SandboxStep } from "./types";
import {
  MAX_DISHES,
  MAX_PORTIONS,
  MIN_SERVE_QUALITY,
  T1,
  T2,
} from "./engine";
import { cooledQuality } from "../../service/lib/freshness";
import { quality } from "../../kitchen/lib/heat";

export interface SkipInfo {
  orderId: number;
  reason: "deadline" | "stock" | "capacity" | "station";
  message: string;
}
export interface PlanResult {
  steps: SandboxStep[];
  skipped: SkipInfo[];
}

interface TimedEvent {
  at: number;
  delta: number;
}

/**
 * 贪心自动排程：按截止时间排序但不盲从——排不进的订单跳过并记录原因，
 * 后面的订单继续尝试。备料可提前到当前时刻，与开火时刻拆开。
 */
export function autoPlan(
  g: Game,
  orderIds: number[],
  allocId: () => number,
): PlanResult {
  const steps: SandboxStep[] = [];
  const skipped: SkipInfo[] = [];

  const orders = orderIds
    .map((id) => g.orders.find((o) => o.id === id))
    .filter((o): o is Order => !!o && (o.status === "waiting" || o.status === "accepted"))
    .sort((a, b) => a.deadline - b.deadline);

  // 灶台最早释放时刻：实战在灶菜按目标火候估算，计划菜随排程顺延
  const stoveFree = new Map<number, number>();
  for (const s of g.stoves) {
    stoveFree.set(
      s.id,
      s.portion
        ? Math.max(g.time, s.started + recipes[s.portion.recipe].target)
        : g.time,
    );
  }
  // 可自由安排的库存（实战备料/在灶占用的份视为已消耗）
  const stockLeft: Record<string, number> = {
    beef: g.stock.beef,
    noodle: g.stock.noodle,
    greens: g.stock.greens,
  };
  for (const p of g.portions) stockLeft[recipes[p.recipe].ingredient]--;
  for (const s of g.stoves)
    if (s.portion) stockLeft[recipes[s.portion.recipe].ingredient]--;

  const portionEvents: TimedEvent[] = [];
  const counterEvents: TimedEvent[] = [];
  const countAt = (events: TimedEvent[], t: number, base: number) =>
    base + events.filter((e) => e.at <= t + 1e-6).reduce((n, e) => n + e.delta, 0);

  for (const o of orders) {
    const r = recipes[o.recipe];
    const candidates = g.stoves.filter((s) => s.kind === r.station);
    let committed = false;
    let lastReason: SkipInfo | null = null;

    for (const stove of [...candidates].sort(
      (a, b) => (stoveFree.get(a.id) ?? 0) - (stoveFree.get(b.id) ?? 0),
    )) {
      const cookAt = Math.max(g.time, stoveFree.get(stove.id) ?? g.time);
      const liftAt = cookAt + r.target;
      const plateAt = liftAt + T1;
      const deliverAt = liftAt + T1 + T2;
      const q = cooledQuality(
        quality(o.recipe, r.target),
        liftAt,
        deliverAt,
      );

      if (deliverAt > o.deadline + 1e-6) {
        lastReason = {
          orderId: o.id,
          reason: "deadline",
          message: `最早 ${Math.round(deliverAt)}s 交付，晚于截止 ${o.deadline}s`,
        };
        continue;
      }
      if (q < MIN_SERVE_QUALITY) {
        lastReason = {
          orderId: o.id,
          reason: "deadline",
          message: `按此时段交付品质仅 ${q}，会被拒收`,
        };
        continue;
      }
      if (stockLeft[r.ingredient] < 1) {
        lastReason = {
          orderId: o.id,
          reason: "stock",
          message: `${r.name}所需食材库存已被实战与其它计划占满`,
        };
        continue;
      }
      if (countAt(counterEvents, liftAt, g.dishes.length) >= MAX_DISHES) {
        lastReason = {
          orderId: o.id,
          reason: "capacity",
          message: "出餐台 8 份容量在起锅时刻将满",
        };
        continue;
      }
      // 备料拆分：优先当前时刻备料，备料台满则顺延到下一次开火腾位之后
      const prepAt = pickPrepTime(g, portionEvents, cookAt);
      if (prepAt === null || prepAt > cookAt + 1e-6) {
        lastReason = {
          orderId: o.id,
          reason: "capacity",
          message: "备料台 6 份容量无法在开火前安排出备料时刻",
        };
        continue;
      }

      // 提交本单五步
      pushStep(steps, allocId, "prep", o, null, prepAt);
      pushStep(steps, allocId, "cook", o, stove.id, cookAt);
      pushStep(steps, allocId, "lift", o, stove.id, liftAt);
      pushStep(steps, allocId, "plate", o, null, plateAt);
      pushStep(steps, allocId, "deliver", o, null, deliverAt);

      stockLeft[r.ingredient]--;
      portionEvents.push({ at: prepAt, delta: 1 });
      portionEvents.push({ at: cookAt, delta: -1 });
      counterEvents.push({ at: liftAt, delta: 1 });
      counterEvents.push({ at: deliverAt, delta: -1 });
      stoveFree.set(stove.id, liftAt);
      committed = true;
      break;
    }
    if (!committed && lastReason) skipped.push(lastReason);
  }
  return { steps: steps.sort((a, b) => a.at - b.at || a.id - b.id), skipped };
}

function pickPrepTime(
  g: Game,
  events: TimedEvent[],
  cookAt: number,
): number | null {
  const base = g.portions.length;
  const countAt = (t: number) =>
    base + events.filter((e) => e.at <= t + 1e-6).reduce((n, e) => n + e.delta, 0);
  const candidates = [g.time, ...events.map((e) => e.at).filter((t) => t <= cookAt + 1e-6)];
  for (const t of [...new Set(candidates)].sort((a, b) => a - b)) {
    if (countAt(t) < MAX_PORTIONS) return t;
  }
  return null;
}

function pushStep(
  list: SandboxStep[],
  allocId: () => number,
  type: SandboxStep["type"],
  o: Order,
  stoveId: number | null,
  at: number,
) {
  list.push({ id: allocId(), type, orderId: o.id, recipe: o.recipe, stoveId, at });
}
