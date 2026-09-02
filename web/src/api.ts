import type { CaseDetail, RecoveryCase, RunSummary, StreamEvent } from "./types.js";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const listCases = () => get<{ cases: RecoveryCase[] }>("/cases").then((r) => r.cases);
export const queue = () => get<{ cases: RecoveryCase[] }>("/queue").then((r) => r.cases);
export const caseDetail = (id: string) => get<CaseDetail>(`/cases/${id}`);
export const scoreboard = () =>
  get<Record<string, { summary: RunSummary }>>("/scoreboard").then((r) => ({
    agent: r.agent?.summary,
    fixed: r.fixed?.summary,
  }));

export async function recover(id: string): Promise<void> {
  await fetch(`${BASE}/cases/${id}/recover`, { method: "POST" });
}

export async function decide(
  id: string,
  body: { decision: "approve" | "redirect" | "write_off"; redirectTo?: string },
): Promise<void> {
  await fetch(`${BASE}/cases/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// SSE reader as an async generator: fetch -> reader -> split on \n\n -> JSON.parse the data line.
export async function* streamCase(id: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${BASE}/cases/${id}/stream`, { signal, headers: { accept: "text/event-stream" } });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(6)) as StreamEvent;
      } catch {
        /* keep-alive comment or partial */
      }
    }
  }
}
