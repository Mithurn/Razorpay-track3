-- RecoveryOps schema.
--
-- Mutable state:  recovery_cases, recovery_attempts, recovery_runs  — app role may UPDATE.
-- Append-only:    recovery_events, razorpay_webhooks                — app role may only SELECT/INSERT.
--                 Enforced by GRANT, not convention. A test connects as recovery_app,
--                 tries UPDATE/DELETE, and expects the database to refuse.

CREATE TABLE IF NOT EXISTS recovery_runs (
  id          UUID PRIMARY KEY,
  label       TEXT,
  arm         TEXT        NOT NULL CHECK (arm IN ('fixed', 'agent', 'rules')),
  config      JSONB       NOT NULL DEFAULT '{}',
  summary     JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recovery_cases (
  id                  UUID PRIMARY KEY,
  run_id              UUID REFERENCES recovery_runs(id),  -- NULL = live case
  merchant_ref        TEXT        NOT NULL,
  customer_ref        TEXT        NOT NULL,
  original_payment_id TEXT,
  original_order_id   TEXT,
  amount_paise        BIGINT      NOT NULL,
  currency            TEXT        NOT NULL DEFAULT 'INR',
  failure_code        TEXT        NOT NULL,
  failure_reason      TEXT        NOT NULL,
  failure_source      TEXT,
  failed_at           TIMESTAMPTZ NOT NULL,
  method              TEXT,
  instrument          JSONB,
  customer_history    JSONB       NOT NULL DEFAULT '[]',
  ground_truth        JSONB,                              -- eval only
  lane                TEXT        NOT NULL DEFAULT 'INCOMING' CHECK (lane IN (
                        'INCOMING','DIAGNOSING','DECIDING','ATTEMPTING',
                        'RECOVERED','RETRY_SCHEDULED','ESCALATED','WRITTEN_OFF','STOPPED')),
  recovered_paise     BIGINT      NOT NULL DEFAULT 0,     -- summed from real captures only
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_run  ON recovery_cases (run_id);
CREATE INDEX IF NOT EXISTS idx_cases_lane ON recovery_cases (lane);

ALTER TABLE recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_lane_check;
ALTER TABLE recovery_cases ADD  CONSTRAINT recovery_cases_lane_check CHECK (lane IN (
  'INCOMING','DIAGNOSING','DECIDING','ATTEMPTING',
  'RECOVERED','RETRY_SCHEDULED','ESCALATED','WRITTEN_OFF','STOPPED'));

CREATE TABLE IF NOT EXISTS recovery_attempts (
  id                 UUID PRIMARY KEY,
  case_id            UUID        NOT NULL REFERENCES recovery_cases(id),
  attempt_no         INT         NOT NULL,
  root_cause         TEXT,                               -- NULL = investigation degraded
  action             TEXT        NOT NULL CHECK (action IN (
                       'RETRY_NOW','RETRY_SCHEDULED','PAYMENT_LINK','CUSTOMER_NUDGE',
                       'ESCALATE','WRITE_OFF')),
  agent_reasoning    TEXT,
  scheduled_for      TIMESTAMPTZ,
  idempotency_key    TEXT        NOT NULL UNIQUE,        -- one attempt = one key = at most one Razorpay call
  razorpay_ref       TEXT,
  settled_payment_id TEXT,
  clamped            BOOLEAN     NOT NULL DEFAULT false,
  clamp_reason       TEXT,
  outcome            TEXT        NOT NULL DEFAULT 'PENDING' CHECK (outcome IN (
                       'PENDING','RECOVERED','FAILED','SKIPPED','AWAITING_RECONCILIATION','COMPLETED')),
  outcome_detail     TEXT,
  recovered_paise    BIGINT      NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ,
  UNIQUE (case_id, attempt_no)
);
ALTER TABLE recovery_attempts ALTER COLUMN root_cause DROP NOT NULL;
ALTER TABLE recovery_attempts DROP CONSTRAINT IF EXISTS recovery_attempts_outcome_check;
ALTER TABLE recovery_attempts ADD  CONSTRAINT recovery_attempts_outcome_check CHECK (outcome IN (
  'PENDING','RECOVERED','FAILED','SKIPPED','AWAITING_RECONCILIATION','COMPLETED'));

CREATE INDEX IF NOT EXISTS idx_attempts_case        ON recovery_attempts (case_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_due         ON recovery_attempts (scheduled_for)
  WHERE outcome IN ('PENDING','AWAITING_RECONCILIATION');
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_razorpay_ref ON recovery_attempts (razorpay_ref)
  WHERE razorpay_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS recovery_events (
  id         BIGSERIAL   PRIMARY KEY,
  case_id    UUID        NOT NULL,
  type       TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_case ON recovery_events (case_id, id);

CREATE TABLE IF NOT EXISTS razorpay_webhooks (
  event_id    TEXT        PRIMARY KEY,                   -- dedupe key; duplicate deliveries ignored
  event       TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
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
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public                                   TO recovery_app;
GRANT USAGE                          ON SCHEMA public                                   TO recovery_app;
