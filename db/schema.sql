-- Recovery Room — database schema.
--
-- Two kinds of table:
--   * mutable state    (recovery_cases, recovery_attempts, recovery_runs) — lane/outcome move
--                       forward via compare-and-set; the app role may UPDATE.
--   * append-only audit (recovery_events, razorpay_webhooks) — the app role may only INSERT
--                       and SELECT. Enforced by GRANT, not by application convention. A test
--                       tries UPDATE/DELETE as the app role and expects it to fail.

CREATE TABLE IF NOT EXISTS recovery_runs (
  id          UUID PRIMARY KEY,
  label       TEXT,
  arm         TEXT NOT NULL CHECK (arm IN ('fixed', 'agent', 'rules')),
  config      JSONB NOT NULL DEFAULT '{}',
  summary     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recovery_cases (
  id                  UUID PRIMARY KEY,
  run_id              UUID REFERENCES recovery_runs(id),  -- NULL = a live case
  merchant_ref        TEXT NOT NULL,
  customer_ref        TEXT NOT NULL,
  original_payment_id TEXT,
  original_order_id   TEXT,
  amount_paise        BIGINT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  failure_code        TEXT NOT NULL,
  failure_reason      TEXT NOT NULL,
  failure_source      TEXT,
  failed_at           TIMESTAMPTZ NOT NULL,
  method              TEXT,                -- card / netbanking / upi, from the original payment
  instrument          JSONB,               -- {issuer|bank|vpa_handle: ...}, to match downtime
  customer_history    JSONB NOT NULL DEFAULT '[]',
  ground_truth        JSONB,               -- eval only
  lane                TEXT NOT NULL DEFAULT 'INCOMING' CHECK (lane IN (
                        'INCOMING','DIAGNOSING','DECIDING','ATTEMPTING',
                        'RECOVERED','RETRY_SCHEDULED','ESCALATED','WRITTEN_OFF','STOPPED')),
  recovered_paise     BIGINT NOT NULL DEFAULT 0,   -- summed from real captures only
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_run ON recovery_cases (run_id);
CREATE INDEX IF NOT EXISTS idx_cases_lane ON recovery_cases (lane);

-- Widens the lane CHECK for a table that already existed before STOPPED was added — the inline
-- CHECK above only applies to a table created fresh. Idempotent: safe to re-run.
ALTER TABLE recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_lane_check;
ALTER TABLE recovery_cases ADD CONSTRAINT recovery_cases_lane_check CHECK (lane IN (
  'INCOMING','DIAGNOSING','DECIDING','ATTEMPTING',
  'RECOVERED','RETRY_SCHEDULED','ESCALATED','WRITTEN_OFF','STOPPED'));

CREATE TABLE IF NOT EXISTS recovery_attempts (
  id              UUID PRIMARY KEY,
  case_id         UUID NOT NULL REFERENCES recovery_cases(id),
  attempt_no      INT NOT NULL,
  root_cause      TEXT,                   -- NULL = the investigation degraded before diagnosing
  action          TEXT NOT NULL CHECK (action IN (
                    'RETRY_NOW','RETRY_SCHEDULED','PAYMENT_LINK','CUSTOMER_NUDGE',
                    'ESCALATE','WRITE_OFF')),
  agent_reasoning TEXT,
  scheduled_for   TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,   -- one attempt == one key == at most one Razorpay call
  razorpay_ref    TEXT,                   -- order / payment link id created for this attempt
  settled_payment_id TEXT,                -- the captured payment id, once one is confirmed
  clamped         BOOLEAN NOT NULL DEFAULT false,
  clamp_reason    TEXT,
  outcome         TEXT NOT NULL DEFAULT 'PENDING' CHECK (outcome IN (
                    'PENDING','RECOVERED','FAILED','SKIPPED','AWAITING_RECONCILIATION')),
  outcome_detail  TEXT,
  recovered_paise BIGINT NOT NULL DEFAULT 0,  -- this attempt's real capture; summed into the case
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (case_id, attempt_no)
);
-- A degraded investigation reaches no diagnosis. That has to be representable, or the write path
-- has to invent a cause to satisfy NOT NULL — which is what it used to do, and it scored as a
-- correct diagnosis in the eval. Idempotent: safe to re-run.
ALTER TABLE recovery_attempts ALTER COLUMN root_cause DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_case ON recovery_attempts (case_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_due ON recovery_attempts (scheduled_for)
  WHERE outcome IN ('PENDING','AWAITING_RECONCILIATION');
-- Real Razorpay order/link ids are unique on their own, but nothing in the app enforced it —
-- byRazorpayRef used to be able to return an arbitrary one of several attempts sharing a ref.
-- A webhook naming that ref must resolve to exactly one attempt, never a guess.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_razorpay_ref ON recovery_attempts (razorpay_ref)
  WHERE razorpay_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS recovery_events (
  id         BIGSERIAL PRIMARY KEY,
  case_id    UUID NOT NULL,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_case ON recovery_events (case_id, id);

CREATE TABLE IF NOT EXISTS razorpay_webhooks (
  event_id    TEXT PRIMARY KEY,       -- dedupe key; duplicate deliveries are ignored
  event       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recovery_app') THEN
    CREATE ROLE recovery_app LOGIN PASSWORD 'recovery_dev';
  END IF;
END
$$;

GRANT SELECT, INSERT                 ON recovery_events, razorpay_webhooks              TO recovery_app;
GRANT SELECT, INSERT, UPDATE         ON recovery_cases, recovery_attempts, recovery_runs TO recovery_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO recovery_app;
GRANT USAGE ON SCHEMA public TO recovery_app;
