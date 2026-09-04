import { z } from "zod";

const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  OPENROUTER_API_KEY: optionalString,
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  // gemini-2.5-flash and gemini-2.0-flash are both retired; 3.6-flash is the successor.
  AGENT_MODEL: z.string().default("minimax/minimax-m3:free"),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  MERCHANT_REF: z.string().default("acme_subscriptions"),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  AGENT_STEP_BUDGET: z.coerce.number().int().positive().default(6),
  AGENT_SESSION_CAP_USD: z.coerce.number().positive().default(0.5),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("localhost"),
  DEMO_ACCESS_TOKEN: optionalString,
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
