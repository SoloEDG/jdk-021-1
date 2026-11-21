import type { Ingredient, RecipeId } from "../../../shared/types";

/** 沙盘步骤类型：备料 → 占锅（下锅）→ 起锅 → 装盘 → 交付 */
export type StepType = "prep" | "cook" | "lift" | "plate" | "deliver";

export interface SandboxStep {
  id: number;
  type: StepType;
  /** 该步骤归属的订单（备料也按订单分配食材，保证一份食材不跨单） */
  orderId: number;
  recipe: RecipeId;
  /** 计划执行时刻（秒，相对营业时钟） */
  at: number;
  /** 占锅 / 起锅步骤使用的灶台 id；其它步骤为 null */
  stoveId: number | null;
}

export type IssueCode =
  | "past"
  | "order-gone"
  | "order-served"
  | "station"
  | "stove-busy"
  | "stove-live"
  | "no-portion"
  | "stock"
  | "prep-capacity"
  | "counter-capacity"
  | "chain"
  | "deadline"
  | "quality"
  | "duplicate-plan";

export interface StepIssue {
  code: IssueCode;
  /** 冲突对象：另一条沙盘步骤 id，或实战灶台/订单 id（字符串前缀区分） */
  ref?: number | string;
  message: string;
}

export interface SimStep {
  step: SandboxStep;
  /** 起锅瞬间品质（仅起锅步骤） */
  liftQuality?: number;
  /** 交付时品质（已扣冷却），仅交付步骤 */
  serveQuality?: number;
  /** 交付预计收入，仅交付步骤 */
  revenue?: number;
  /** 装盘/交付时距起锅的等待秒数，用于展示冷却 */
  cooldown?: number;
  issues: StepIssue[];
}

export type AbandonReason =
  | "deadline"
  | "stock"
  | "capacity"
  | "station"
  | "quality"
  | "chain"
  | "not-selected";

export interface AbandonedOrder {
  orderId: number;
  reason: AbandonReason;
  message: string;
}

export interface StockUse {
  ingredient: Ingredient;
  need: number;
  /** 沙盘计划消耗（仅可执行步骤计入） */
  planned: number;
  /** 实战已经占用：已扣库存 + 在灶上的份 */
  live: number;
  available: number;
  ok: boolean;
}

export interface SandboxReport {
  steps: SimStep[];
  /** 按订单汇总的推演结果 */
  plans: OrderPlan[];
  abandoned: AbandonedOrder[];
  stock: StockUse[];
  revenue: number;
  feasibleCount: number;
  plannedCount: number;
  /** 最长可执行连续前缀长度（steps 数组下标 0..prefix-1 全部无错误） */
  prefix: number;
  /** 采用时被现场情况判失效的步骤 id 列表 */
  stale: number[];
  generatedAt: number;
}

export interface OrderPlan {
  orderId: number;
  recipe: RecipeId;
  guest: string;
  deadline: number;
  price: number;
  included: boolean;
  feasible: boolean;
  deliveredAt?: number;
  serveQuality?: number;
  revenue?: number;
  /** 该订单各阶段时刻，便于 UI 画时间轴 */
  timeline: { type: StepType; at: number; stoveId: number | null }[];
  blockers: string[];
}

export interface AdoptionResult {
  adopted: number;
  stale: { step: SandboxStep; message: string }[];
  /** 采用后仍留在沙盘里的步骤（失效步骤及其后续全部保留） */
  kept: SandboxStep[];
  /** 通过新鲜度校验、交给运行时执行器的连续前缀 */
  queue: SandboxStep[];
}
