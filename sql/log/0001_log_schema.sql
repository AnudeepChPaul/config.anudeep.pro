-- Application and access log store for config.anudeep.pro.
--
-- Apply this file to whichever Postgres CONFIG_LOG_DATABASE_URL names.
-- Local Compose mounts it into log-db as docker-entrypoint-initdb.d on first volume create.
--
-- `request_sid` is this service's correlation key (X-Request-Sid). `request_id` holds the same
-- value so IAM-style queries still work.

CREATE SCHEMA IF NOT EXISTS log;

CREATE TABLE IF NOT EXISTS log.app_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  service_name    text        NOT NULL,
  service_version text,
  environment     text        NOT NULL,
  pid             integer,
  level           integer     NOT NULL,
  level_name      text        NOT NULL,
  message         text        NOT NULL,
  logger          text,
  error_type      text,
  error_stack     text,
  trace_id        text,
  span_id         text,
  request_id      text,
  request_sid     text,
  attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS log.access_log (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz      NOT NULL,
  service_name   text             NOT NULL,
  environment    text             NOT NULL,
  hostname       text,
  method         text             NOT NULL,
  route          text,
  path           text             NOT NULL,
  status_code    integer          NOT NULL,
  duration_ms    double precision NOT NULL,
  response_bytes bigint,
  source_ip      text,
  user_agent     text,
  user_id        text,
  user_email     text,
  service_id     text,
  trace_id       text,
  request_id     text             NOT NULL,
  request_sid    text             NOT NULL
);

CREATE INDEX IF NOT EXISTS app_log_occurred_at_idx  ON log.app_log    (occurred_at DESC);
CREATE INDEX IF NOT EXISTS app_log_level_idx        ON log.app_log    (level, occurred_at DESC);
CREATE INDEX IF NOT EXISTS app_log_logger_idx       ON log.app_log    (logger, occurred_at DESC);
CREATE INDEX IF NOT EXISTS app_log_request_id_idx   ON log.app_log    (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_log_request_sid_idx  ON log.app_log    (request_sid) WHERE request_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_log_trace_id_idx     ON log.app_log    (trace_id)   WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS access_log_occurred_at_idx  ON log.access_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS access_log_status_idx       ON log.access_log (status_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS access_log_request_id_idx   ON log.access_log (request_id);
CREATE INDEX IF NOT EXISTS access_log_request_sid_idx  ON log.access_log (request_sid);
