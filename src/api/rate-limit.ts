// /mandates and /agents/register are called anonymously by the storefront itself — every
// shopper registers their own agent and mandate in-browser, with no login anywhere in this
// product. A reviewer-session gate there would break that flow, not just block abuse. The
// honest minimal mitigation for "an anonymous caller can manufacture unlimited human-authorized
// state" is a cap on how fast one caller can do it, not a login the product doesn't otherwise have.
//
// In-memory, single-process — matches InMemoryInvestigationQueue's own assumption elsewhere in
// this codebase. A real multi-instance deployment would need this backed by Redis instead.
export function createRateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();

  return function allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= opts.max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}
