// In-memory record of stop requests, checked by the pipeline at safe checkpoints — never used to
// abort an in-flight Razorpay call or a running model request. A stop only ever prevents the
// *next* action from being taken; whatever is already mid-flight settles through the executor's
// normal reconciliation path. Single process, like CaseEventBus: a multi-node deployment would
// need this shared (Redis), not per-process memory.

export type StopRequest = { reason: string; note?: string };

export class StopRegistry {
  private readonly perCase = new Map<string, StopRequest>();
  private global: StopRequest | null = null;

  stopCase(caseId: string, request: StopRequest): void {
    this.perCase.set(caseId, request);
  }

  stopAll(request: StopRequest): void {
    this.global = request;
  }

  // Clears the global brake only. Deliberately does not touch per-case stops or revive cases
  // already resolved to STOPPED — reviving a stopped case is a separate, not-yet-built action.
  resumeAll(): void {
    this.global = null;
  }

  // Global takes precedence: even a case with no per-case stop of its own honors an active
  // emergency stop.
  check(caseId: string): StopRequest | null {
    return this.global ?? this.perCase.get(caseId) ?? null;
  }
}
