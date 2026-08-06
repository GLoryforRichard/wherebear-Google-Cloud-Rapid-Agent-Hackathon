/**
 * Cost folding for scan-engine call outcomes.
 *
 * Deliberately dependency-free (no `server-only`, no imports back into
 * openrouter.ts) so it stays unit-testable under `pnpm test:unit` — the same
 * reason bands/box-parser/grid are the other tested modules in this folder.
 * Re-exported from openrouter.ts so call sites keep a single import source.
 */

/** The slice of CallOutcome this module needs. */
interface CostBearing {
  costUsd: number | null;
}

/**
 * Real USD across a set of call outcomes.
 *
 * Returns null only when NOT ONE outcome reported a cost, so "the provider
 * never billed us" stays distinguishable from a genuine $0. That distinction
 * is the whole point of the nullable ai_usage_log.cost_usd column: the
 * tempting `reduce((a, o) => a + (o.costUsd ?? 0), 0)` collapses both cases
 * to 0 and turns an unmetered store into a confident "$0.00".
 */
export function sumCost(outcomes: CostBearing[]): number | null {
  let total: number | null = null;
  for (const o of outcomes) {
    if (o.costUsd === null) continue;
    total = (total ?? 0) + o.costUsd;
  }
  return total;
}
