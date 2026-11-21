import type { Dish, Game } from "../../../shared/types";
/**
 * 冷却衰减的纯函数版本：起锅 15 秒后，每多放 1 秒品质 -2。
 * 实战 servingQuality 与排程沙盘共用这一条规则，避免两处口径漂移。
 */
export function cooledQuality(
  qualityAtLift: number,
  cookedAt: number,
  now: number,
) {
  return Math.max(
    0,
    qualityAtLift - Math.floor(Math.max(0, now - cookedAt - 15) * 2),
  );
}
export function servingQuality(g: Game, d: Dish) {
  return cooledQuality(d.quality, d.cookedAt, g.time);
}
export function servicePair(g: Game) {
  return {
    dish: g.dishes.find((d) => d.id === g.selectedDish),
    order: g.orders.find(
      (o) => o.id === g.selectedOrder && o.status === "accepted",
    ),
  };
}
