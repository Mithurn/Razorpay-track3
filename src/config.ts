import { z } from "zod";

// A present-but-empty env var (the shape .env.example ships optional keys in) must read the same
// as unset, or `.optional()` alone doesn't do what it looks like it does.
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  // Optional so the fixed-schedule bench arm and offline tooling run without a model key; the
  // agent paths fail loudly at model construction if the one they need is missing.
  OPENROUTER_API_KEY: optionalString,
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  // Default is a $0 free-tier model so an accidental run cannot spend. Override to
  // google/gemini-2.5-flash for the headline eval (still free-tier; guard with --cap-usd).
  AGENT_MODEL: z.string().default("minimax/minimax-m3:free"),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  // One Razorpay account, one merchant, until real multi-tenancy exists.
  MERCHANT_REF: z.string().default("acme_subscriptions"),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  AGENT_STEP_BUDGET: z.coerce.number().int().positive().default(6),
  // Hard ceiling on model spend for the whole server process. The agent throws past this.
  AGENT_SESSION_CAP_USD: z.coerce.number().positive().default(0.5),
  PORT: z.coerce.number().int().positive().default(3000),
  // Shared-secret bearer token gating the mutating case routes (recover/decision/simulate-
  // capture). Not required so a fresh clone's config still parses; the routes stay closed until
  // it's set, never open by omission.
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
