-- Recovery Room schema. Domain tables are mutable (lane/outcome move forward via CAS);
-- the two *_events tables are append-only, enforced at the DB-role level (GRANT below),
-- with an integration test that tries UPDATE/DELETE as the app role and expects failure.

-- ── Recovery domain ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recovery_runs (
  id          UUID PRIMARY KEY,
  label       TEXT,
  arm         TEXT NOT NULL CHECK (arm IN ('fixed', 'agent')),
  config      JSONB NOT NULL DEFAULT '{}',
  summary     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recovery_cases (
  id                 UUID PRIMARY KEY,
  run_id             UUID REFERENCES recovery_runs(id),   -- NULL = a live case, not part of a batch
  merchant_ref       TEXT NOT NULL,
  customer_ref       TEXT NOT NULL,
  original_payment_id TEXT,
  original_order_id  TEXT,
  amount_paise       BIGINT NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'INR',
  failure_code       TEXT NOT NULL,       -- e.g. BAD_REQUEST_ERROR, GATEWAY_ERROR
  failure_reason     TEXT NOT NULL,       -- e.g. payment_failed, international_transaction_not_allowed
  failure_source     TEXT,                -- bank | gateway | business
  failed_at          TIMESTAMPTZ NOT NULL,
  customer_history   JSONB NOT NULL DEFAULT '[]',  -- prior payments for this customer
  ground_truth       JSONB,               -- eval only: { recoverable, viaAction, atHour, selfRecovers }
  lane               TEXT NOT NULL DEFAULT 'INCOMING' CHECK (lane IN (
                       'INCOMING','DIAGNOSING','DECIDING','ATTEMPTING',
                       'RECOVERED','RETRY_SCHEDULED','ESCALATED','WRITTEN_OFF')),
  recovered_paise    BIGINT NOT NULL DEFAULT 0,   -- summed from real captures only
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_run ON recovery_cases (run_id);
CREATE INDEX IF NOT EXISTS idx_cases_lane ON recovery_cases (lane);

CREATE TABLE IF NOT EXISTS recovery_attempts (
  id               UUID PRIMARY KEY,
  case_id          UUID NOT NULL REFERENCES recovery_cases(id),
  attempt_no       INT NOT NULL,
  root_cause       TEXT NOT NULL,        -- the agent's diagnosis
  action           TEXT NOT NULL CHECK (action IN (
                     'RETRY_NOW','RETRY_SCHEDULED','PAYMENT_LINK','CUSTOMER_NUDGE',
                     'ESCALATE','WRITE_OFF')),
  agent_reasoning  TEXT,
  scheduled_for    TIMESTAMPTZ,
  idempotency_key  TEXT NOT NULL UNIQUE, -- one attempt == one key == at most one Razorpay order
  correlation_id   UUID,                 -- links to executor_jobs when the action moves money
  clamped          BOOLEAN NOT NULL DEFAULT false,   -- guardrails altered the agent's proposal
  clamp_reason     TEXT,
  outcome          TEXT NOT NULL DEFAULT 'PENDING' CHECK (outcome IN (
                     'PENDING','RECOVERED','FAILED','SKIPPED')),
  outcome_detail   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_attempts_case ON recovery_attempts (case_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_due ON recovery_attempts (scheduled_for) WHERE outcome = 'PENDING';

-- Append-only audit tape. Every diagnosis, decision, tool call, clamp, execution, human action.
CREATE TABLE IF NOT EXISTS recovery_events (
  id         BIGSERIAL PRIMARY KEY,
  case_id    UUID NOT NULL,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recovery_events_case ON recovery_events (case_id, id);

-- ── Executor (carried from Aegis, unchanged: exactly-once + reconciliation) ─────

CREATE TABLE IF NOT EXISTS executor_jobs (
  correlation_id UUID PRIMARY KEY,
  state          TEXT NOT NULL,
  order_id       TEXT,
  payment_id     TEXT,
  attempt        INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_events (
  id            BIGSERIAL PRIMARY KEY,
  correlation_id UUID NOT NULL,
  event         TEXT NOT NULL,
  state         TEXT,
  razorpay_ref  TEXT,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── App role: append-only enforced here, not in application code ────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recovery_app') THEN
    CREATE ROLE recovery_app LOGIN PASSWORD 'recovery_dev';
  END IF;
END
$$;

GRANT SELECT, INSERT ON recovery_events, execution_events, webhook_events TO recovery_app;
GRANT SELECT, INSERT, UPDATE ON recovery_cases, recovery_attempts, recovery_runs, executor_jobs TO recovery_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO recovery_app;
GRANT USAGE ON SCHEMA public TO recovery_app;
