import type { CaseDetail, RecoveryCase, RoomMetrics, RoomStreamEvent, RunSummary, StreamEvent } from "./types.js";

const BASE = "/api";

export type RuntimeConfig = {
  model: string;
  deadlineMs: number;
  stepBudget: number;
  limits: { maxAttempts: number; maxExposurePaise: number; cooldownHours: number };
  razorpayKeyId: string;
};

export type AuditVerify = { enforced: boolean; role: string; error?: string };

export type PayInfo =
  | { payable: false }
  | { payable: true; kind: "order"; orderId: string; amountPaise: number; currency: string }
  | { payable: true; kind: "payment_link"; url: string; amountPaise: number };

async function readError(res: Response, path: string): Promise<Error> {
  const body = await res.json().catch(() => null);
  const detail = body && typeof body.error === "string" ? body.error : null;
  return new Error(detail ?? `${path}: ${res.status}`);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw await readError(res, path);
  return res.json() as Promise<T>;
}

// Every caller of post(), and the one GET route below that mutates state, hits a route gated by
// DEMO_ACCESS_TOKEN on the server; the token is exposed to the client under the VITE_ prefix Vite
// requires for env vars reaching the browser.
const DEMO_ACCESS_TOKEN = import.meta.env.VITE_DEMO_ACCESS_TOKEN as string | undefined;

const authHeaders = (): Record<string, string> =>
  DEMO_ACCESS_TOKEN ? { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } : {};

async function post<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, path);
  return res.json() as Promise<T>;
}

// /cases/:id/audit/verify is the one GET route still gated by the token — it runs a live UPDATE
// probe against the DB role.
async function getAuthed<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw await readError(res, path);
  return res.json() as Promise<T>;
}

export const listCases = () => get<{ cases: RecoveryCase[] }>("/cases").then((r) => r.cases);
export const queue = () => get<{ cases: RecoveryCase[] }>("/queue").then((r) => r.cases);
export const caseDetail = (id: string) => get<CaseDetail>(`/cases/${id}`);
export const scoreboard = () =>
  get<Record<string, { summary: RunSummary }>>("/scoreboard").then((r) => ({
    agent: r.agent?.summary,
    fixed: r.fixed?.summary,
    rules: r.rules?.summary,
  }));

export const runtimeConfig = () => get<RuntimeConfig>("/config");
export const payInfo = (id: string) => get<PayInfo>(`/cases/${id}/pay`);
export const verifyAudit = (id: string) => getAuthed<AuditVerify>(`/cases/${id}/audit/verify`);
export const metrics = () => get<RoomMetrics>("/metrics");

export async function recover(id: string): Promise<void> {
  await post(`/cases/${id}/recover`);
}

export async function simulateCapture(id: string): Promise<void> {
  await post(`/cases/${id}/simulate-capture`);
}

export async function decide(
  id: string,
  body: { decision: "approve" | "redirect" | "write_off"; redirectTo?: string },
): Promise<void> {
  await post(`/cases/${id}/decision`, body);
}

// Safe-checkpoint stop: never aborts a call already in flight to Razorpay or the model, only
// prevents the next action. Global (`stopAll`) is the room-wide emergency brake; `resumeAll`
// lifts it — neither touches a case already resolved to STOPPED, which is one-way for now.
export async function stopCase(id: string, note?: string): Promise<void> {
  await post(`/cases/${id}/stop`, note ? { note } : undefined);
}

export async function stopAll(note?: string): Promise<{ stoppedNow: number }> {
  return post(`/stop`, note ? { note } : undefined);
}

export async function resumeAll(): Promise<void> {
  await post(`/resume`);
}

// SSE reader as an async generator: fetch -> reader -> split on \n\n -> JSON.parse the data line.
async function* readSse<T>(path: string, signal: AbortSignal): AsyncGenerator<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { accept: "text/event-stream" } });
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
        yield JSON.parse(line.slice(6)) as T;
      } catch {
        /* keep-alive comment or partial */
      }
    }
  }
}

export const streamCase = (id: string, signal: AbortSignal) => readSse<StreamEvent>(`/cases/${id}/stream`, signal);
export const streamRoom = (signal: AbortSignal) => readSse<RoomStreamEvent>("/stream", signal);
