import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  OPENROUTER_API_KEY: z.string().min(1),
  AGENT_MODEL: z.string().default("openai/gpt-5.6-luna"),
  AGENT_MODEL_CHEAP: z.string().default("qwen/qwen3-32b"),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_STEP_BUDGET: z.coerce.number().int().positive().default(6),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
