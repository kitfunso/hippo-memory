/** Test wall-clock budgets, scaled by UI_PERF_BUDGET_SCALE on hardware slower than a dev machine (the CI ui job sets it). */
export function perfBudgetMs(ms: number): number {
  const scale = Number(process.env.UI_PERF_BUDGET_SCALE);
  return scale > 0 ? ms * scale : ms;
}
