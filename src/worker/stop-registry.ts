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

  resumeAll(): void {
    this.global = null;
  }

  check(caseId: string): StopRequest | null {
    return this.global ?? this.perCase.get(caseId) ?? null;
  }

  isBraked(): boolean {
    return this.global !== null;
  }
}
