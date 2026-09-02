import type { CaseRepository, AttemptRepository, EventLog, OutcomeResolver } from "../domain/ports.js";
import type { Lane, RecoveryCase } from "../domain/case.js";
import type { Attempt, Clock } from "../domain/attempt.js";
import type { AgentProposal, RecoveryAction } from "../domain/recovery-action.js";
import { safetyGate, DEFAULT_LIMITS, type SafetyLimits, type GateContext } from "../safety/safety-gate.js";
import { AttemptExecutor } from "../execution/attempt-executor.js";
import type { PaymentGateway } from "../domain/gateway.js";
import { runRecoveryAgent, type AgentConfig, type AgentEvents } from "../agent/recovery-agent.js";
import type { AgentDeps } from "../agent/tools.js";
import { buildAgentDeps, type BuildDeps } from "./agent-deps.js";

export type AgentRunner = (deps: AgentDeps, events: AgentEvents) => Promise<AgentProposal>;

export function agentRunnerFor(config: AgentConfig): AgentRunner {
  return (deps, events) => runRecoveryAgent(deps, config, events);
}

// One turn of the recovery loop for a single case: diagnose, gate, attempt, then say what
// should happen next. Orchestration only; the decision rules are in safetyGate and the money
// handling in the executor.

const HOUR_MS = 3_600_000;
const DEFAULT_RESCHEDULE_HOURS = 12;
const SETTLEMENT_RECHECK_HOURS = 2;

export type StepOutcome =
  | { kind: "resolved"; lane: Extract<Lane, "RECOVERED" | "ESCALATED" | "WRITTEN_OFF"> }
  | { kind: "reschedule"; delayMs: number; reason: string }
  | { kind: "awaiting_settlement"; delayMs: number };

export type PipelineDeps = BuildDeps & {
  cases: CaseRepository;
  attempts: AttemptRepository;
  events: EventLog;
  gateway: PaymentGateway;
  outcomeResolver: OutcomeResolver;
  clock: Clock;
  runAgent: AgentRunner;
  limits?: SafetyLimits;
  riskHoldForCase?: (kase: RecoveryCase) => boolean;
};

export class RecoveryPipeline {
  private readonly executor: AttemptExecutor;
  private readonly limits: SafetyLimits;

  constructor(private readonly deps: PipelineDeps) {
    this.executor = new AttemptExecutor(deps.attempts, deps.events, deps.gateway, deps.outcomeResolver);
    this.limits = deps.limits ?? DEFAULT_LIMITS;
  }

  async step(caseId: string, agentEvents: AgentEvents = {}): Promise<StepOutcome> {
    const kase = await this.deps.cases.byId(caseId);
    if (!kase) throw new Error(`pipeline: no case ${caseId}`);

    const priorAttempts = await this.deps.attempts.listByCase(caseId);
    const attemptNo = priorAttempts.filter((a) => a.status !== "SKIPPED").length + 1;

    await this.enter(kase, "DIAGNOSING");
    await this.deps.events.append({ caseId, type: "INVESTIGATION_STARTED", payload: { attemptNo } });

    const agentDeps = await buildAgentDeps(kase, priorAttempts, this.deps);
    const proposal = await this.deps.runAgent(agentDeps, agentEvents);
    await this.deps.events.append({
      caseId,
      type: proposal.degraded ? "AGENT_DEGRADED" : "AGENT_PROPOSED",
      payload: {
        rootCause: proposal.diagnosisRootCause,
        confidence: proposal.confidence,
        action: proposal.action,
        reasoning: proposal.reasoning,
        toolCalls: proposal.toolCalls,
      },
    });

    await this.enter(kase, "DECIDING");
    const gate = this.applyGate(kase, proposal, priorAttempts, attemptNo);
    await this.deps.events.append({ caseId, type: "GATE_APPLIED", payload: gate.event });

    if (gate.kind === "skip") {
      await this.enter(kase, "RETRY_SCHEDULED");
      return { kind: "reschedule", delayMs: gate.delayMs, reason: gate.reason };
    }

    await this.enter(kase, "ATTEMPTING");
    const attempt = await this.executor.execute({
      caseId,
      attemptNo,
      rootCause: proposal.diagnosisRootCause ?? "technical",
      action: gate.action,
      reasoning: proposal.reasoning,
      amountPaise: kase.amountPaise,
      currency: kase.currency,
      scheduledFor: scheduledFor(gate.action, this.deps.clock),
      clamp: gate.clamp,
    });

    return this.afterAttempt(kase, gate.action, attempt, attemptNo);
  }

  private applyGate(kase: RecoveryCase, proposal: AgentProposal, prior: Attempt[], attemptNo: number) {
    const ctx: GateContext = {
      case: kase,
      attemptNo,
      hoursSinceLastAttempt: hoursSinceLastAttempt(prior, this.deps.clock),
      riskHold: proposal.diagnosisRootCause === "risk_hold" || (this.deps.riskHoldForCase?.(kase) ?? false),
    };
    const result = safetyGate(proposal.action, ctx, this.limits);

    if (result.outcome === "skip") {
      return {
        kind: "skip" as const,
        delayMs: this.limits.cooldownHours * HOUR_MS,
        reason: result.reason,
        event: { outcome: "skip", reason: result.reason },
      };
    }
    return {
      kind: "act" as const,
      action: result.action,
      clamp: result.outcome === "clamp" ? { reason: result.reason } : null,
      event: {
        outcome: result.outcome,
        proposed: proposal.action.kind,
        applied: result.action.kind,
        reason: result.outcome === "clamp" ? result.reason : null,
      },
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

    // The attempt failed. The gate escalates once attemptNo passes the cap; short of that, retry.
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
      payload: reason ? { lane, reason } : { lane },
    });
    return { kind: "resolved", lane };
  }

  private async enter(kase: RecoveryCase, lane: Lane): Promise<void> {
    if (kase.lane === lane) return;
    if (await this.deps.cases.moveLane(kase.id, kase.lane, lane)) kase.lane = lane;
  }
}

function scheduledFor(action: RecoveryAction, clock: Clock): string | null {
  if (action.kind !== "RETRY_SCHEDULED") return null;
  return new Date(clock.now().getTime() + action.atHoursFromNow * HOUR_MS).toISOString();
}

function rescheduleDelay(action: RecoveryAction): number {
  return (action.kind === "RETRY_SCHEDULED" ? action.atHoursFromNow : DEFAULT_RESCHEDULE_HOURS) * HOUR_MS;
}

function hoursSinceLastAttempt(prior: Attempt[], clock: Clock): number | null {
  const moneyMoves = prior.filter((a) => a.status !== "SKIPPED");
  const last = moneyMoves.at(-1);
  if (!last) return null;
  return (clock.now().getTime() - Date.parse(last.createdAt)) / HOUR_MS;
}
