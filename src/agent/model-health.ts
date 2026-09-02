// A cheap liveness check for the model provider: one-token completion, short timeout. Used by
// GET /model-health so a demo operator knows the agent path is up before starting a run.

export async function checkModelHealth(
  apiKey: string | undefined,
  model: string,
): Promise<{ model: string; reachable: boolean; detail?: string }> {
  if (!apiKey) return { model, reachable: false, detail: "OPENROUTER_API_KEY not set" };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { model, reachable: true };
    return { model, reachable: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { model, reachable: false, detail: err instanceof Error ? err.message : "unknown error" };
  }
}
