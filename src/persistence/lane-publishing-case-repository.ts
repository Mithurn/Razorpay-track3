import type { CaseRepository, NewCase, RoomMetrics, SimilarCaseSummary } from "../domain/ports.js";
import type { EventLog } from "../domain/ports.js";
import type { Lane, RecoveryCase } from "../domain/case.js";

export class LanePublishingCaseRepository implements CaseRepository {
  constructor(
    private readonly inner: CaseRepository,
    private readonly events: EventLog,
  ) {}

  async moveLane(id: string, from: Lane, to: Lane): Promise<boolean> {
    const moved = await this.inner.moveLane(id, from, to);
    if (moved) {
      await this.events.append({ caseId: id, type: "CASE_LANE_CHANGED", payload: { from, to } });
    }
    return moved;
  }

  async create(newCase: NewCase): Promise<RecoveryCase> {
    const kase = await this.inner.create(newCase);
    await this.events.append({
      caseId: kase.id,
      type: "CASE_CREATED",
      payload: { failureReason: kase.failureReason, amountPaise: kase.amountPaise, merchantRef: kase.merchantRef },
    });
    return kase;
  }

  byId(id: string): Promise<RecoveryCase | null> {
    return this.inner.byId(id);
  }

  byOriginalPaymentId(paymentId: string): Promise<RecoveryCase | null> {
    return this.inner.byOriginalPaymentId(paymentId);
  }

  listByRun(runId: string): Promise<RecoveryCase[]> {
    return this.inner.listByRun(runId);
  }

  listLive(): Promise<RecoveryCase[]> {
    return this.inner.listLive();
  }

  listByLane(lane: Lane): Promise<RecoveryCase[]> {
    return this.inner.listByLane(lane);
  }

  listStaleInLane(lane: Lane, olderThan: Date): Promise<RecoveryCase[]> {
    return this.inner.listStaleInLane(lane, olderThan);
  }

  similarResolved(
    failureReason: string,
    opts: { method: string | null; beforeFailedAt: string; runId: string | null; limit: number },
  ): Promise<SimilarCaseSummary[]> {
    return this.inner.similarResolved(failureReason, opts);
  }

  metrics(): Promise<RoomMetrics> {
    return this.inner.metrics();
  }
}
