export type StopRequest = { reason: string; note?: string };

export interface StopStore {
  stopCase(caseId: string, request: StopRequest): Promise<void>;
  stopAll(request: StopRequest): Promise<void>;
  resumeAll(): Promise<void>;
  check(caseId: string): Promise<StopRequest | null>;
  isBraked(): Promise<boolean>;
}

export class InMemoryStopStore implements StopStore {
  private readonly perCase = new Map<string, StopRequest>();
  private global: StopRequest | null = null;

  async stopCase(caseId: string, request: StopRequest): Promise<void> {
    this.perCase.set(caseId, request);
  }

  async stopAll(request: StopRequest): Promise<void> {
    this.global = request;
  }

  async resumeAll(): Promise<void> {
    this.global = null;
  }

  async check(caseId: string): Promise<StopRequest | null> {
    return this.global ?? this.perCase.get(caseId) ?? null;
  }

  async isBraked(): Promise<boolean> {
    return this.global !== null;
  }
}
