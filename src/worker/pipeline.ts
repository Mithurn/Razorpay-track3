import type { CaseRepository, AttemptRepository, EventLog, NotificationPort, OutcomeResolver } from "../domain/ports.js";
import type { Lane, RecoveryCase } from "../domain/case.js";
import type { Attempt, Clock } from "../domain/attempt.js";
import type { AgentProposal, RecoveryAction } from "../domain/recovery-action.js";
import { safetyGate, DEFAULT_LIMITS, msUntilContactWindowOpens, type SafetyLimits } from "../safety/safety-gate.js";
import { AttemptExecutor } from "../execution/attempt-executor.js";
import type { PaymentGateway } from "../domain/gateway.js";
import type { AgentEvents } from "../agent/recovery-agent.js";
import type { AgentDeps } from "../agent/tools.js";
import { reconstructAction } from "../execution/action-codec.js";
import { TERMINAL_LANES, IN_FLIGHT_LANES } from "../domain/case.js";
import { buildAgentDeps, type BuildDeps } from "./agent-deps.js";
import { StopRegistry, type StopRequest } from "./stop-registry.js";
import { directedProposal, pendingDirective, type HumanDirective } from "./human-directive.js";
import { buildGateContext } from "./gate-context.js";

export type AgentRunner = (deps: AgentDeps, events: AgentEvents) => Promise<AgentProposal>;

const HOUR_MS = 3_600_000;
const DEFAULT_RESCHEDULE_HOURS = 12;
const SETTLEMENT_RECHECK_HOURS = 2;

type TerminalLane = Extract<Lane, "RECOVERED" | "ESCALATED" | "WRITTEN_OFF" | "STOPPED">;

export type StepOutcome =
  | { kind: "resolved"; lane: TerminalLane }
  | { kind: "reschedule"; delayMs: number; reason: string }
  | { kind: "awaiting_settlement"; delayMs: number }
  // Another worker already claimed this case's turn (concurrent queue jobs); this one bows out.
  | { kind: "not_claimed" };

export type PipelineDeps = BuildDeps & {
  cases: CaseRepository;
  attempts: AttemptRepository;
  events: EventLog;
  gateway: PaymentGateway;
  outcomeResolver: OutcomeResolver;
  notifier: NotificationPort;
  clock: Clock;
  runAgent: AgentRunner;
  limits?: SafetyLimits;
  riskHoldForCase?: (kase: RecoveryCase) => boolean;
  hardDeclineForCase?: (kase: RecoveryCase) => boolean;
  stopRegistry?: StopRegistry;
};

export class RecoveryPipeline {
  private readonly executor: AttemptExecutor;
  private readonly limits: SafetyLimits;
  private readonly stopRegistry: StopRegistry;

  constructor(private readonly deps: PipelineDeps) {
    this.executor = new AttemptExecutor(deps.attempts, deps.events, deps.gateway, deps.outcomeResolver, deps.notifier);
    this.limits = deps.limits ?? DEFAULT_LIMITS;
    this.stopRegistry = deps.stopRegistry ?? new StopRegistry();
  }

  // An idle/parked case resolves to STOPPED immediately; an in-flight one waits for its own
  // next checkpoint.
  async requestStop(caseId: string, request: StopRequest): Promise<void> {
    this.stopRegistry.stopCase(caseId, request);
    const kase = await this.deps.cases.byId(caseId);
    if (kase && !IN_FLIGHT_LANES.includes(kase.lane) && !TERMINAL_LANES.includes(kase.lane)) {
      await this.stop(kase, request);
    }
  }

  async requestStopAll(request: StopRequest): Promise<{ stoppedNow: number }> {
    this.stopRegistry.stopAll(request);
    const live = await this.deps.cases.listLive();
    let stoppedNow = 0;
    for (const kase of live) {
      if (!IN_FLIGHT_LANES.includes(kase.lane) && !TERMINAL_LANES.includes(kase.lane)) {
        await this.stop(kase, request);
        stoppedNow++;
      }
    }
    return { stoppedNow };
  }

  resumeAll(): void {
    this.stopRegistry.resumeAll();
  }

  isBraked(): boolean {
    return this.stopRegistry.isBraked();
  }

  async advance(
    caseId: string,
    agentEvents: AgentEvents = {},
    opts: { reclaim?: boolean } = {},
  ): Promise<StepOutcome> {
    const kase = await this.deps.cases.byId(caseId);
    if (!kase) throw new Error(`pipeline: no case ${caseId}`);
    if (TERMINAL_LANES.includes(kase.lane)) return { kind: "resolved", lane: kase.lane as TerminalLane };

    const attempts = await this.deps.attempts.listByCase(caseId);
    // A crash may have left the lane un-updated after a webhook already settled the money.
    if (attempts.some((a) => a.status === "RECOVERED")) return this.resolve(kase, "RECOVERED");
    const parked = attempts.filter((a) => a.status === "PENDING" || a.status === "AWAITING_RECONCILIATION");
    for (const attempt of parked) {
      const settled = await this.executor.settle(attempt, kase, reconstructAction(attempt.action));
      if (settled.status === "RECOVERED") return this.resolve(kase, "RECOVERED");
      if (settled.status === "PENDING" || settled.status === "AWAITING_RECONCILIATION") {
        return { kind: "awaiting_settlement", delayMs: SETTLEMENT_RECHECK_HOURS * HOUR_MS };
      }
    }

    return this.step(caseId, agentEvents, opts.reclaim ?? false);
  }

  async step(caseId: string, agentEvents: AgentEvents = {}, reclaim = false): Promise<StepOutcome> {
    const kase = await this.deps.cases.byId(caseId);
    if (!kase) throw new Error(`pipeline: no case ${caseId}`);

    const stopBefore = this.stopRegistry.check(caseId);
    if (stopBefore) return this.stop(kase, stopBefore);

    if (kase.lane === "DIAGNOSING") {
      if (!reclaim) return { kind: "not_claimed" };
    } else if (!(await this.enter(kase, "DIAGNOSING"))) {
      return { kind: "not_claimed" };
    }

    const priorAttempts = await this.deps.attempts.listByCase(caseId);
    const attemptNo = priorAttempts.filter((a) => a.status !== "SKIPPED").length + 1;

    await this.deps.events.append({
      caseId,
      type: "INVESTIGATION_STARTED",
      payload: { attemptNo, activity: "investigate" },
    });

    const directive = await pendingDirective(this.deps.events, caseId, priorAttempts);
    const proposal = directive
      ? directedProposal(directive)
      : await this.deps.runAgent(await buildAgentDeps(kase, priorAttempts, this.deps), agentEvents);

    await this.deps.events.append(
      directive
        ? {
            caseId,
            type: "AGENT_SKIPPED_HUMAN_DIRECTED",
            payload: {
              action: proposal.action,
              approver: directive.approver,
              directedAt: directive.at,
              activity: "propose",
            },
          }
        : {
            caseId,
            type: proposal.degraded ? "AGENT_DEGRADED" : "AGENT_PROPOSED",
            payload: {
              rootCause: proposal.diagnosisRootCause,
              confidence: proposal.confidence,
              action: proposal.action,
              reasoning: proposal.reasoning,
              toolCalls: proposal.toolCalls,
              activity: "propose",
            },
          },
    );

    // A stop requested while the agent call was in flight must land before the gate or executor run.
    const stopAfter = this.stopRegistry.check(caseId);
    if (stopAfter) return this.stop(kase, stopAfter);

    await this.enter(kase, "DECIDING");
    const gate = this.applyGate(kase, proposal, priorAttempts, attemptNo, directive);
    await this.deps.events.append({
      caseId,
      type: "GATE_APPLIED",
      payload: { ...gate.event, activity: "gate" },
    });

    if (gate.kind === "skip") {
      await this.enter(kase, "RETRY_SCHEDULED");
      return { kind: "reschedule", delayMs: gate.delayMs, reason: gate.reason };
    }

    await this.enter(kase, "ATTEMPTING");
    const attempt = await this.executor.execute({
      caseId,
      attemptNo,
      rootCause: proposal.diagnosisRootCause,
      action: gate.action,
      reasoning: proposal.reasoning,
      amountPaise: kase.amountPaise,
      currency: kase.currency,
      scheduledFor: scheduledFor(gate.action, this.deps.clock),
      clamp: gate.clamp,
      createdAt: this.deps.clock.now().toISOString(),
    });

    return this.afterAttempt(kase, gate.action, attempt, attemptNo);
  }

  private applyGate(
    kase: RecoveryCase,
    proposal: AgentProposal,
    prior: Attempt[],
    attemptNo: number,
    directive: HumanDirective | null,
  ) {
    const ctx = buildGateContext(
      kase,
      proposal,
      prior,
      attemptNo,
      directive,
      this.deps.clock,
      this.deps.riskHoldForCase,
      this.deps.hardDeclineForCase,
    );
    const result = safetyGate(proposal.action, ctx, this.limits);

    const event = {
      outcome: result.outcome,
      rule: result.outcome === "allow" ? null : result.rule,
      detail: result.outcome === "allow" ? null : result.detail,
      proposed: proposal.action.kind,
      applied: result.outcome === "skip" ? null : result.action.kind,
    };

    if (result.outcome === "skip") {
      const delayMs =
        result.rule === "contact_window" ? msUntilContactWindowOpens(ctx.now) : this.limits.cooldownHours * HOUR_MS;
      return { kind: "skip" as const, delayMs, reason: result.detail, event };
    }
    return {
      kind: "act" as const,
      action: result.action,
      clamp: result.outcome === "clamp" ? { reason: result.detail } : null,
      event,
    };
  }

  private async afterAttempt(
    kase: RecoveryCase,
    action: RecoveryAction,
    attempt: Attempt,
    attemptNo: number,
  ): Promise<StepOutcome> {
    if (attempt.status === "RECOVERED") return this.resolve(kase, "RECOVERED");
    if (action.kind === "ESCALATE") return this.resolve(kase, "ESCALATED");
    if (action.kind === "WRITE_OFF") return this.resolve(kase, "WRITTEN_OFF");

    if (attempt.status === "PENDING" || attempt.status === "AWAITING_RECONCILIATION") {
      return { kind: "awaiting_settlement", delayMs: SETTLEMENT_RECHECK_HOURS * HOUR_MS };
    }

    if (attemptNo >= this.limits.maxAttempts) {
      return this.resolve(kase, "ESCALATED", "attempts exhausted");
    }
    await this.enter(kase, "RETRY_SCHEDULED");
    return { kind: "reschedule", delayMs: rescheduleDelay(action), reason: "attempt failed" };
  }

  private async resolve(
    kase: RecoveryCase,
    lane: Extract<Lane, "RECOVERED" | "ESCALATED" | "WRITTEN_OFF">,
    reason?: string,
  ): Promise<StepOutcome> {
    await this.enter(kase, lane);
    await this.deps.events.append({
      caseId: kase.id,
      type: "CASE_RESOLVED",
      payload: { ...(reason ? { lane, reason } : { lane }), activity: "outcome" },
    });
    return { kind: "resolved", lane };
  }

  private async stop(kase: RecoveryCase, request: StopRequest): Promise<StepOutcome> {
    await this.enter(kase, "STOPPED");
    await this.deps.events.append({
      caseId: kase.id,
      type: "CASE_STOPPED",
      payload: { reason: request.reason, note: request.note ?? null, activity: "outcome" },
    });
    return { kind: "resolved", lane: "STOPPED" };
  }

  private async enter(kase: RecoveryCase, lane: Lane): Promise<boolean> {
    if (kase.lane === lane) return true;
    const moved = await this.deps.cases.moveLane(kase.id, kase.lane, lane);
    if (moved) kase.lane = lane;
    return moved;
  }
}

function scheduledFor(action: RecoveryAction, clock: Clock): string | null {
  if (action.kind !== "RETRY_SCHEDULED") return null;
  return new Date(clock.now().getTime() + action.atHoursFromNow * HOUR_MS).toISOString();
}

function rescheduleDelay(action: RecoveryAction): number {
  return (action.kind === "RETRY_SCHEDULED" ? action.atHoursFromNow : DEFAULT_RESCHEDULE_HOURS) * HOUR_MS;
}
