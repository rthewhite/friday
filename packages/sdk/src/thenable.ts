/** True for promises and other thenables: what sync-only callbacks (transactions, migrations, prompt providers) must not return. */
export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}
