-- Up Migration

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX batches_created_at_id_idx ON batches (created_at DESC, id DESC);

CREATE TABLE urls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  url           text NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  http_status   int,
  response_ms   int,
  page_title    text,
  error         text,
  attempt       int NOT NULL DEFAULT 0,
  job_id        text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX urls_batch_id_idx ON urls (batch_id);
CREATE INDEX urls_batch_id_status_idx ON urls (batch_id, status);

-- Down Migration

DROP TABLE IF EXISTS urls;
DROP TABLE IF EXISTS batches;
