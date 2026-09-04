import { z } from "zod";
import { hasToolCall, stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { rootCause as rootCauseEnum } from "../domain/failure.js";
import type { AgentProposal, RecoveryAction } from "../domain/recovery-action.js";
import { recoveryAction } from "../domain/recovery-action.js";
import { buildTools, type AgentDeps } from "./tools.js";
import { SYSTEM_PROMPT, caseBrief } from "./prompt.js";

export type ToolSource = "local" | "razorpay-live";
export type ToolCall = { name: string; callId: string; args: unknown };
export type ToolResult = { name: string; callId: string; source: ToolSource; raw: unknown; ms: number };

// check_bank_downtime hits the live Razorpay downtime feed; everything else is a local read.
const LIVE_TOOLS = new Set(["check_bank_downtime"]);
const sourceOf = (name: string): ToolSource => (LIVE_TOOLS.has(name) ? "razorpay-live" : "local");

export const proposalInput = z.object({
  rootCause: rootCauseEnum,
  confidence: z.number().min(0).max(1),
  actionKind: z.enum(["RETRY_NOW", "RETRY_SCHEDULED", "PAYMENT_LINK", "CUSTOMER_NUDGE", "ESCALATE", "WRITE_OFF"]),
  retryDelayHours: z.number().positive().max(720).optional(),
  paymentLinkRail: z.enum(["card", "netbanking"]).optional(),
  nudgeChannel: z.enum(["email", "sms"]).optional(),
  reason: z.string().max(300).optional(),
  reasoning: z.string().min(20).max(1500),
});

export type AgentConfig = {
  model: LanguageModel;
  stepBudget: number;
  deadlineMs: number;
};

export type AgentEvents = {
  onReasoningDelta?: (text: string) => void;
  // Awaited so a durable TOOL_CALLED record always commits before its TOOL_RESULT.
  onToolCall?: (call: ToolCall) => void | Promise<void>;
  onToolResult?: (result: ToolResult) => void | Promise<void>;
  onConcluded?: (proposal: AgentProposal) => void;
};

const SAFE_FALLBACK: RecoveryAction = { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 };

export function degrade(reason: string, toolCalls: number): AgentProposal {
  return {
    action: SAFE_FALLBACK,
    diagnosisRootCause: null,
    confidence: 0,
    reasoning: `Investigation did not conclude (${reason}); falling back to a scheduled retry in 48h.`,
    toolCalls,
    degraded: true,
  };
}

export function toAction(input: z.infer<typeof proposalInput>): RecoveryAction | null {
  const draft: Record<string, unknown> = { kind: input.actionKind };
  if (input.actionKind === "RETRY_SCHEDULED") draft.atHoursFromNow = input.retryDelayHours ?? 48;
  if (input.actionKind === "PAYMENT_LINK") draft.rail = input.paymentLinkRail ?? "card";
  if (input.actionKind === "CUSTOMER_NUDGE") draft.channel = input.nudgeChannel ?? "email";
  if (input.actionKind === "ESCALATE" || input.actionKind === "WRITE_OFF") {
    draft.reason = input.reason?.trim() || "agent did not give a reason";
  }
  const parsed = recoveryAction.safeParse(draft);
  return parsed.success ? parsed.data : null;
}

export async function runRecoveryAgent(
  deps: AgentDeps,
  config: AgentConfig,
  events: AgentEvents = {},
): Promise<AgentProposal> {
  const submit = tool({
    description: "Conclude the investigation with your recovery decision. Call this exactly once.",
    inputSchema: proposalInput,
    execute: async () => ({ received: true }),
  });

  let toolCalls = 0;

  // Fired from here, not onStepFinish, so onToolCall lands before onToolResult for the same call.
  const investigationTools = Object.fromEntries(
    Object.entries(buildTools(deps)).map(([name, t]) => [
      name,
      {
        ...t,
        execute: async (args: unknown, opts: unknown) => {
          const callId = (opts as { toolCallId: string }).toolCallId;
          toolCalls++;
          await events.onToolCall?.({ name, callId, args });
          const start = performance.now();
          const raw = await (t.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, opts);
          await events.onToolResult?.({
            name,
            callId,
            source: sourceOf(name),
            raw,
            ms: Math.round(performance.now() - start),
          });
          return raw;
        },
      },
    ]),
  );
  const tools = { ...investigationTools, submit_proposal: submit };

  try {
    const result = streamText({
      model: config.model,
      system: SYSTEM_PROMPT,
      prompt: caseBrief(deps.kase, deps.priorAttempts.length),
      tools,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(config.deadlineMs),
      stopWhen: [stepCountIs(config.stepBudget), hasToolCall("submit_proposal")],
      prepareStep: ({ stepNumber }) =>
        stepNumber >= config.stepBudget - 1
          ? { toolChoice: { type: "tool", toolName: "submit_proposal" }, activeTools: ["submit_proposal"] }
          : {},
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta" || part.type === "reasoning-delta") {
        events.onReasoningDelta?.(part.text);
      } else if (part.type === "error") {
        throw part.error;
      }
    }

    const calls = await result.toolCalls;
    const conclusion = calls.find((c) => c.toolName === "submit_proposal");
    if (!conclusion) return degrade("no proposal", toolCalls);

    const input = proposalInput.safeParse(conclusion.input);
    if (!input.success) return degrade("malformed proposal", toolCalls);

    const action = toAction(input.data);
    if (!action) return degrade("invalid action", toolCalls);

    const proposal: AgentProposal = {
      action,
      diagnosisRootCause: input.data.rootCause,
      confidence: input.data.confidence,
      reasoning: input.data.reasoning,
      toolCalls,
      degraded: false,
    };
    events.onConcluded?.(proposal);
    return proposal;
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? "deadline"
        : `error: ${err instanceof Error ? err.message : String(err)}`;
    const fallback = degrade(reason, toolCalls);
    events.onConcluded?.(fallback);
    return fallback;
  }
}
