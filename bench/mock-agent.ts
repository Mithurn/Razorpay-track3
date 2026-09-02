import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRunner } from "../src/worker/pipeline.js";
import type { AgentProposal } from "../src/domain/recovery-action.js";

// Record real agent turns once, replay them for free. Keyed by the case's customerRef plus its
// attempt number, so a re-plan on attempt 2 is a distinct recorded turn.

type Cache = Record<string, AgentProposal>;

function key(customerRef: string, attemptNo: number): string {
  return `${customerRef}#${attemptNo}`;
}

export function recordingRunner(inner: AgentRunner, path: string): AgentRunner {
  const cache: Cache = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return async (deps, events) => {
    const k = key(deps.kase.customerRef, deps.priorAttempts.length + 1);
    if (cache[k]) return cache[k]!;
    const proposal = await inner(deps, events);
    cache[k] = proposal;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
    return proposal;
  };
}

export function replayRunner(path: string): AgentRunner {
  if (!existsSync(path)) throw new Error(`--mock needs a recorded run at ${path}; run once without --mock first`);
  const cache: Cache = JSON.parse(readFileSync(path, "utf8"));
  return async (deps) => {
    const k = key(deps.kase.customerRef, deps.priorAttempts.length + 1);
    const hit = cache[k];
    if (hit) return hit;
    // A case that reached an attempt the recording never saw — degrade rather than call the model.
    return {
      action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 },
      diagnosisRootCause: null,
      confidence: 0,
      reasoning: "no recorded turn for this step",
      toolCalls: 0,
      degraded: true,
    };
  };
}
