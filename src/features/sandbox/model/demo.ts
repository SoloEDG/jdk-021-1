import type { Game, Order } from "../../../shared/types";
import type { SandboxStep } from "./types";
import type { SimOptions } from "./engine";
import { T1, T2 } from "./engine";

export interface ContentionDemo {
  title: string;
  narrative: string;
  options: SimOptions;
  orders: Order[];
  good: SandboxStep[];
  bad: SandboxStep[];
  goodNarrative: string;
  badNarrative: string;
}

/**
 * 两道菜争同一口锅、只有一种顺序能同时保住两单的演示：
 * 另一口煎锅正在实战烹饪（不可抢占），牛排 12s、沙拉 6s。
 * 先做耗时短的沙拉，两单都能赶上；先做牛排，沙拉超时离店。
 */
export function buildContentionDemo(g: Game): ContentionDemo {
  const now = g.time;
  const steakDeadline = now + 30;
  const saladDeadline = now + 18;
  const orders: Order[] = [
    {
      id: -901,
      recipe: "steak",
      guest: "演示·林小姐",
      arrived: now,
      deadline: steakDeadline,
      status: "waiting",
    },
    {
      id: -902,
      recipe: "salad",
      guest: "演示·小陈",
      arrived: now,
      deadline: saladDeadline,
      status: "waiting",
    },
  ];
  // 另一口煎锅（取 id 较大的那口）在演示期间被占
  const otherPan = [...g.stoves].reverse().find((s) => s.kind === "pan");
  const busyStoveId = otherPan?.id ?? 2;
  const useStoveId = g.stoves.find(
    (s) => s.kind === "pan" && s.id !== busyStoveId,
  )?.id ?? 1;
  const options: SimOptions = {
    extraOrders: orders,
    extraStock: { beef: 2, greens: 2 },
    extraStoveBusy: [
      {
        stoveId: busyStoveId,
        until: now + 40,
        label: "另一口煎锅实战烹饪中（不可抢占）",
      },
    ],
  };

  // 正确顺序：先沙拉（6s）后牛排（12s），交付 7s 与 20s，都在截止前
  const good: SandboxStep[] = [
    step(-1001, "prep", -902, "salad", null, now),
    step(-1002, "cook", -902, "salad", useStoveId, now),
    step(-1003, "lift", -902, "salad", useStoveId, now + 6),
    step(-1004, "plate", -902, "salad", null, now + 6 + T1),
    step(-1005, "deliver", -902, "salad", null, now + 6 + T1 + T2),
    step(-1011, "prep", -901, "steak", null, now),
    step(-1012, "cook", -901, "steak", useStoveId, now + 6),
    step(-1013, "lift", -901, "steak", useStoveId, now + 6 + 12),
    step(-1014, "plate", -901, "steak", null, now + 6 + 12 + T1),
    step(-1015, "deliver", -901, "steak", null, now + 6 + 12 + T1 + T2),
  ];

  // 错误顺序：先牛排后沙拉，沙拉最早 19s 交付 > 截止 18s，被放弃
  const bad: SandboxStep[] = [
    step(-2001, "prep", -901, "steak", null, now),
    step(-2002, "cook", -901, "steak", useStoveId, now),
    step(-2003, "lift", -901, "steak", useStoveId, now + 12),
    step(-2004, "plate", -901, "steak", null, now + 12 + T1),
    step(-2005, "deliver", -901, "steak", null, now + 12 + T1 + T2),
    step(-2011, "prep", -902, "salad", null, now),
    step(-2012, "cook", -902, "salad", useStoveId, now + 12),
    step(-2013, "lift", -902, "salad", useStoveId, now + 12 + 6),
    step(-2014, "plate", -902, "salad", null, now + 12 + 6 + T1),
    step(-2015, "deliver", -902, "salad", null, now + 12 + 6 + T1 + T2),
  ];

  return {
    title: "争锅演示：一口煎锅，两道菜，顺序定生死",
    narrative:
      "另一口煎锅正在烹饪且不可抢占。牛排需 12 秒、沙拉需 6 秒；沙拉客人 18 秒后离店，牛排客人 30 秒后离店。",
    options,
    orders,
    good,
    bad,
    goodNarrative:
      "先短后长：沙拉 8s 交付、牛排 20s 交付，两单都在截止前完成，收入全保。",
    badNarrative:
      "先长后短：牛排 14s 交付没问题，但沙拉最早 19s 才能交付，超过 18s 截止，只能放弃。",
  };
}

function step(
  id: number,
  type: SandboxStep["type"],
  orderId: number,
  recipe: SandboxStep["recipe"],
  stoveId: number | null,
  at: number,
): SandboxStep {
  return { id, type, orderId, recipe, stoveId, at };
}
