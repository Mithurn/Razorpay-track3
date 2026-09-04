// A cheap liveness check for the model provider: one-token completion, short timeout. Used by
// GET /model-health so a demo operator knows the agent path is up before starting a run. A
// "google/" model id is probed against AI Studio directly, the same provider split as agent/model.ts.

export async function checkModelHealth(
  keys: { openRouterApiKey: string | undefined; googleApiKey: string | undefined },
  model: string,
): Promise<{ model: string; reachable: boolean; detail?: string }> {
  if (model.startsWith("google/")) return checkGoogle(keys.googleApiKey, model.slice("google/".length));
  return checkOpenRouter(keys.openRouterApiKey, model);
}

async function checkOpenRouter(
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

async function checkGoogle(
  apiKey: string | undefined,
  model: string,
): Promise<{ model: string; reachable: boolean; detail?: string }> {
  if (!apiKey) return { model: `google/${model}`, reachable: false, detail: "GOOGLE_GENERATIVE_AI_API_KEY not set" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ok" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) return { model: `google/${model}`, reachable: true };
    return { model: `google/${model}`, reachable: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { model: `google/${model}`, reachable: false, detail: err instanceof Error ? err.message : "unknown error" };
  }
}
