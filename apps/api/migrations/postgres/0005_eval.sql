-- 0005_eval.sql (Postgres)
--
-- Phase 7 — eval contract.
--
-- Per-namespace golden sets, runs, and per-question results.
-- Tenants register a set, kick off a run, then poll for results.

CREATE TABLE eval_sets (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    namespace_id    TEXT NOT NULL,
    name            TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    UNIQUE(tenant_id, namespace_id, name)
);
CREATE INDEX idx_eval_sets_namespace ON eval_sets(namespace_id);

CREATE TABLE eval_questions (
    id                   TEXT PRIMARY KEY,
    eval_set_id          TEXT NOT NULL REFERENCES eval_sets(id),
    question             TEXT NOT NULL,
    expected_answer      TEXT,
    must_cite_chunk_ids  JSONB,                  -- array of strings
    judge_overrides      JSONB,                  -- object: judge_id → prompt
    created_at           BIGINT NOT NULL
);
CREATE INDEX idx_eval_questions_set ON eval_questions(eval_set_id);

CREATE TABLE eval_runs (
    id                  TEXT PRIMARY KEY,
    eval_set_id         TEXT NOT NULL REFERENCES eval_sets(id),
    tenant_id           TEXT NOT NULL,
    status              TEXT NOT NULL,          -- pending | running | completed | failed
    started_at          BIGINT,
    completed_at        BIGINT,
    num_questions       BIGINT NOT NULL,
    num_passed          BIGINT NOT NULL DEFAULT 0,
    num_failed          BIGINT NOT NULL DEFAULT 0,
    error_message       TEXT,
    created_at          BIGINT NOT NULL,
    inference_provider  TEXT,
    inference_model     TEXT,
    provider_key_id     TEXT,
    config_json         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_eval_runs_set ON eval_runs(eval_set_id);
CREATE INDEX idx_eval_runs_tenant_status ON eval_runs(tenant_id, status);

CREATE TABLE eval_results (
    id                  TEXT PRIMARY KEY,
    eval_run_id         TEXT NOT NULL REFERENCES eval_runs(id),
    question_id         TEXT NOT NULL REFERENCES eval_questions(id),
    passed              BOOLEAN NOT NULL,        -- SQLite stored 0|1 INTEGER; Postgres uses native BOOLEAN
    scores_json         JSONB NOT NULL,          -- { judge_id: int 1..5 }
    query_event_id      TEXT,
    error_message       TEXT,
    created_at          BIGINT NOT NULL
);
CREATE INDEX idx_eval_results_run ON eval_results(eval_run_id);
