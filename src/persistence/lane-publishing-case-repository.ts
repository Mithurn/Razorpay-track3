import type { CaseRepository, NewCase, RoomMetrics, SimilarCaseSummary } from "../domain/ports.js";
import type { EventLog } from "../domain/ports.js";
import type { Lane, RecoveryCase } from "../domain/case.js";

// Wraps a CaseRepository so every lane change is also a durable, auditable event — the same
// pattern PublishingEventLog uses for the event log itself. Without this, moveLane is a bare SQL
// UPDATE: the two call sites that move a lane (the pipeline's own turn, and a human decision on
// an escalated case) would each have to remember to append the fact themselves, and a lane
// change would not be part of the canonical event stream at all. This makes it impossible to
// move a lane without the move also being recorded.
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

  create(newCase: NewCase): Promise<RecoveryCase> {
    return this.inner.create(newCase);
  }

  byId(id: string): Promise<RecoveryCase | null> {
    return this.inner.byId(id);
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
