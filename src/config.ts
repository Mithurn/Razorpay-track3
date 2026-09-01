import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
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
