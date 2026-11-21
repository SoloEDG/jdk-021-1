/**
 * 排程沙盘引擎的独立验证脚本（不依赖浏览器/DOM）。
 * 经 esbuild 打包后用 node 运行：
 *   npx esbuild scripts/sandbox-check.ts --bundle --platform=node --format=esm --outfile=/tmp/sb-check.mjs && node /tmp/sb-check.mjs
 */
import { createGame } from "../src/shared/initial";
import { simulate } from "../src/features/sandbox/model/engine";
import { autoPlan } from "../src/features/sandbox/model/planner";
import { buildContentionDemo } from "../src/features/sandbox/model/demo";
import { adoptPlan, createRunner } from "../src/features/sandbox/model/adopt";
import type { SandboxStep } from "../src/features/sandbox/model/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✕ ${name} ${detail}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let idc = 1000;
const nid = () => idc++;
function S(
  type: SandboxStep["type"],
  orderId: number,
  recipe: SandboxStep["recipe"],
  stoveId: number | null,
  at: number,
): SandboxStep {
  return { id: nid(), type, orderId, recipe, stoveId, at };
}
function fiveSteps(
  orderId: number,
  recipe: SandboxStep["recipe"],
  stoveId: number,
  start: number,
  target: number,
): SandboxStep[] {
  return [
    S("prep", orderId, recipe, null, start),
    S("cook", orderId, recipe, stoveId, start),
    S("lift", orderId, recipe, stoveId, start + target),
    S("plate", orderId, recipe, null, start + target + 1),
    S("deliver", orderId, recipe, null, start + target + 2),
  ];
}

async function main() {
  console.log("1) 争锅演示：只有一种顺序能保住两单");
  {
    const g = createGame();
    const demo = buildContentionDemo(g);
    const good = simulate(g, demo.good, demo.options);
    const bad = simulate(g, demo.bad, demo.options);
    check("正确顺序两单都可交付", good.feasibleCount === 2, `got ${good.feasibleCount}`);
    check(
      "正确顺序保住两单收入",
      good.revenue > 0 && good.plans.filter((p) => p.orderId < 0).every((p) => p.feasible),
    );
    check("错误顺序只能保 1 单", bad.feasibleCount === 1, `got ${bad.feasibleCount}`);
    const lostSalad = bad.abandoned.find((a) => a.orderId === -902);
    check(
      "被放弃订单给出 deadline 原因而非仅按截止排序",
      !!lostSalad && lostSalad.reason === "deadline",
      JSON.stringify(lostSalad),
    );
    check(
      "错误顺序中沙拉步骤报冲突",
      bad.steps.some((s) => s.step.orderId === -902 && s.issues.length > 0),
    );
  }

  console.log("2) 库存必须覆盖计划消耗");
  {
    const g = createGame();
    g.stock = { beef: 1, noodle: 5, greens: 6 };
    g.orders.push({
      id: 501,
      recipe: "steak",
      guest: "甲",
      arrived: 0,
      deadline: 90,
      status: "waiting",
    });
    const steps = [
      ...fiveSteps(1, "steak", 1, 2, 12),
      ...fiveSteps(501, "steak", 2, 2, 12),
    ];
    const r = simulate(g, steps);
    const beef = r.stock.find((x) => x.ingredient === "beef")!;
    check("库存行标记不足", beef.ok === false, JSON.stringify(beef));
    check(
      "第二单备料报 stock",
      r.steps.some((s) => s.step.orderId === 501 && s.issues.some((i) => i.code === "stock")),
    );
    check("被放弃订单原因为 stock", r.abandoned.some((a) => a.reason === "stock"));
    // 同刻备料按阶段排序，第一份备料成功、第二份失败，前缀在第 2 步截断
    check("连续前缀在库存出错处截断", r.prefix === 1, `got ${r.prefix}`);
  }

  console.log("3) 设备规则：意面只能汤锅，煎锅争用检测");
  {
    const g = createGame();
    const r = simulate(g, fiveSteps(2, "pasta", 1, 2, 10));
    check("意面占煎锅报 station", r.steps.some((s) => s.issues.some((i) => i.code === "station")));

    const g2 = createGame();
    const overlap = [
      ...fiveSteps(1, "steak", 1, 2, 12),
      ...fiveSteps(3, "salad", 1, 5, 6),
    ];
    const r2 = simulate(g2, overlap);
    check("同锅时间重叠报 stove-busy", r2.steps.some((s) => s.issues.some((i) => i.code === "stove-busy")));
  }

  console.log("4) 火候与冷却：起锅品质和交付冷却独立计算");
  {
    const g = createGame();
    const steps = [
      S("prep", 1, "steak", null, 2),
      S("cook", 1, "steak", 1, 2),
      S("lift", 1, "steak", 1, 20),
      S("plate", 1, "steak", null, 21),
      S("deliver", 1, "steak", null, 40),
    ];
    const r = simulate(g, steps);
    const lift = r.steps.find((s) => s.step.type === "lift")!;
    const deliver = r.steps.find((s) => s.step.type === "deliver")!;
    check("久煮起锅品质下降为 28", lift.liftQuality === 28, `got ${lift.liftQuality}`);
    check(
      "冷却后品质过低触发拒收",
      (deliver.serveQuality ?? 99) < 30 && deliver.issues.some((i) => i.code === "quality"),
      `q=${deliver.serveQuality}`,
    );
  }

  console.log("5) 采用：只接纳连续前缀，失效步骤留在沙盘");
  {
    const g = createGame();
    const goodSteps = fiveSteps(3, "salad", 1, 2, 6);
    const r = simulate(g, goodSteps);
    check("完整五步全部可执行", r.prefix === 5);
    const adoption = adoptPlan(g, goodSteps, r.prefix);
    check("采用 5 步、无遗留", adoption.adopted === 5 && adoption.kept.length === 0);

    const broken = [...goodSteps];
    // 中间断裂：装盘时刻(7)早于起锅时刻(8)，排序后第 3 步即断裂，前缀为 2
    broken[3] = { ...broken[3], at: 7 };
    const r2 = simulate(g, broken);
    check("断裂计划前缀停在出错步骤前", r2.prefix === 2, `got ${r2.prefix}`);
    const a2 = adoptPlan(g, broken, r2.prefix);
    check("仅前 2 步进执行队列，其余留在沙盘", a2.queue.length === 2 && a2.kept.length === 3);
  }

  console.log("6) 运行时执行器：资源失效时不抢占在灶食品");
  {
    const g = createGame();
    g.running = true;
    g.stock.greens = 6;
    const plan = fiveSteps(3, "salad", 1, 3, 6);
    const runner = createRunner(g, plan, () => {});
    let rest: SandboxStep[] = [];
    runner.onStaleRest((x) => (rest = x));
    g.stoves[0].portion = { id: 999, recipe: "steak", preparedAt: 0 };
    g.stoves[0].started = 0;
    g.time = 3.1;
    await sleep(300);
    check("执行器判定失效并停止", runner.state.active === false);
    check("失效原因指向灶台占用", runner.state.stale.some((x) => x.message.includes("灶台")));
    check("剩余步骤退回沙盘", rest.length > 0);
    check("在灶牛排未被挤掉", g.stoves[0].portion?.id === 999);
    runner.stop();
  }

  console.log("7) 自动排程：跳过赶不上的单并给出原因，后续订单继续排");
  {
    const g = createGame();
    g.orders = [
      { id: 1, recipe: "steak", guest: "甲", arrived: 0, deadline: 5, status: "waiting" },
      { id: 2, recipe: "pasta", guest: "乙", arrived: 0, deadline: 80, status: "waiting" },
      { id: 3, recipe: "salad", guest: "丙", arrived: 0, deadline: 80, status: "waiting" },
    ];
    const { steps, skipped } = autoPlan(g, [1, 2, 3], nid);
    check("不可能的单被跳过", skipped.some((s) => s.orderId === 1 && s.reason === "deadline"));
    check("后面的两单仍然排入", new Set(steps.map((s) => s.orderId)).size === 2);
    const r = simulate(g, steps);
    check("自动排程结果自身可执行", r.prefix === steps.length && r.feasibleCount === 2);
  }

  console.log("8) 拆分备料与开火：备料可早于下锅");
  {
    const g = createGame();
    const steps = [
      S("prep", 3, "salad", null, 1),
      S("cook", 3, "salad", 1, 8),
      S("lift", 3, "salad", 1, 14),
      S("plate", 3, "salad", null, 15),
      S("deliver", 3, "salad", null, 16),
    ];
    const r = simulate(g, steps);
    check("备料提前于开火仍可执行", r.prefix === 5);
  }

  console.log("9) 采用时复查：营业中库存被消耗后计划失效");
  {
    const g = createGame();
    g.running = true;
    g.stock.beef = 1;
    const plan = fiveSteps(1, "steak", 1, 2, 12);
    const runner = createRunner(g, plan, () => {});
    let rest: SandboxStep[] = [];
    runner.onStaleRest((x) => (rest = x));
    g.stock.beef = 0;
    g.time = 2.1;
    await sleep(300);
    check("库存失效被拦截", runner.state.stale.some((x) => x.message.includes("库存")));
    check("后续步骤退回沙盘", rest.length === 4, `got ${rest.length}`);
    runner.stop();
  }

  console.log("10) 端到端：健康计划被采用后逐步执行并产生销售收入");
  {
    const g = createGame();
    g.running = true;
    g.time = 1;
    const plan = fiveSteps(3, "salad", 1, 2, 6);
    const runner = createRunner(g, plan, () => {});
    let rest: SandboxStep[] = [];
    runner.onStaleRest((x) => (rest = x));
    // 逐拍推进时钟，模拟真实营业：执行器在每个计划时刻触发对应步骤
    for (const t of [2, 2.2, 8, 8.2, 9, 10, 11]) {
      g.time = t;
      await sleep(120);
    }
    check("执行器正常结束", runner.state.active === false);
    check("5 步全部成功", runner.state.done === 5 && runner.state.stale.length === 0,
      JSON.stringify(runner.state.stale));
    check("没有步骤退回", rest.length === 0);
    const order3 = g.orders.find((o) => o.id === 3)!;
    check("沙拉订单已交付", order3.status === "served");
    check("账本产生一笔销售", g.entries.some((e) => e.kind === "sale"));
    check("库存消耗一份时蔬", g.stock.greens === 5);
    runner.stop();
  }

  console.log("11) 采用新鲜度：营业推进后，过期步骤不能进入执行队列");
  {
    const g = createGame();
    g.time = 10; // 营业已进行到 10s
    const plan = fiveSteps(3, "salad", 1, 2, 6); // 计划从 2s 开始，已整体过期
    const r = simulate(g, plan);
    const adoption = adoptPlan(g, plan, r.prefix);
    check("过期步骤全部留在沙盘", adoption.queue.length === 0 && adoption.kept.length === 5);
    check(
      "失效提示指向时刻或不可执行",
      adoption.stale.every((x) => x.message.includes("营业时刻") || x.message.includes("不可执行")),
    );
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
}

main();
