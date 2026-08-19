/**
 * Next boot hook. The node-only work lives in instrumentation-node.ts —
 * see its header for why the split (edge bundle must never resolve
 * child_process).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
