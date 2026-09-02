import { z } from "zod";
import { hasToolCall, stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { rootCause as rootCauseEnum } from "../domain/failure.js";
import type { AgentProposal, RecoveryAction } from "../domain/recovery-action.js";
import { recoveryAction } from "../domain/recovery-action.js";
import { buildTools, type AgentDeps } from "./tools.js";
import { SYSTEM_PROMPT, caseBrief } from "./prompt.js";

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
  onToolCall?: (name: string) => void;
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

  const tools = { ...buildTools(deps), submit_proposal: submit };
  let toolCalls = 0;

  try {
    const result = streamText({
      model: config.model,
      system: SYSTEM_PROMPT,
      prompt: caseBrief(deps.kase),
      tools,
      abortSignal: AbortSignal.timeout(config.deadlineMs),
      stopWhen: [stepCountIs(config.stepBudget), hasToolCall("submit_proposal")],
      prepareStep: ({ stepNumber }) =>
        stepNumber >= config.stepBudget - 1
          ? { toolChoice: { type: "tool", toolName: "submit_proposal" }, activeTools: ["submit_proposal"] }
          : {},
      onStepFinish: (step) => {
        for (const call of step.toolCalls) {
          if (call.toolName !== "submit_proposal") {
            toolCalls++;
            events.onToolCall?.(call.toolName);
          }
        }
      },
    });

    for await (const delta of result.textStream) events.onReasoningDelta?.(delta);

    const calls = await result.toolCalls;
    const conclusion = calls.find((c) => c.toolName === "submit_proposal");
    if (!conclusion) return degrade("no proposal", toolCalls);

    const input = proposalInput.safeParse(conclusion.input);
    if (!input.success) return degrade("malformed proposal", toolCalls);

    const action = toAction(input.data);
    if (!action) return degrade("invalid action", toolCalls);

    return {
      action,
      diagnosisRootCause: input.data.rootCause,
      confidence: input.data.confidence,
      reasoning: input.data.reasoning,
      toolCalls,
      degraded: false,
    };
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "deadline" : "error";
    return degrade(reason, toolCalls);
  }
}
