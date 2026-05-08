-- Phase 1 backfill: every existing workflow_runs row gets a one-to-one
-- agent_runs row so the new abstraction has a coherent history. Old chat
-- code paths stay on workflow_runs; new code paths read agent_runs by
-- the workflow_run_id linkage.
INSERT INTO agent_runs (
  id,
  parent_run_id,
  root_run_id,
  depth,
  trigger_source,
  trigger_ref,
  specialist_id,
  sandbox_policy,
  human_owner_id,
  repo_ref,
  sandbox_id,
  workflow_run_id,
  chat_id,
  budget_usd_cap_micros,
  cost_usd_actual_micros,
  status,
  blocked_reason,
  approval_required,
  created_at,
  started_at,
  ended_at
)
SELECT
  'run_backfill_' || wr.id                                AS id,
  NULL                                                    AS parent_run_id,
  'run_backfill_' || wr.id                                AS root_run_id,
  0                                                       AS depth,
  'chat'                                                  AS trigger_source,
  wr.chat_id                                              AS trigger_ref,
  NULL                                                    AS specialist_id,
  'inherit'                                               AS sandbox_policy,
  wr.user_id                                              AS human_owner_id,
  NULL                                                    AS repo_ref,
  NULL                                                    AS sandbox_id,
  wr.id                                                   AS workflow_run_id,
  wr.chat_id                                              AS chat_id,
  0                                                       AS budget_usd_cap_micros,
  0                                                       AS cost_usd_actual_micros,
  -- workflow_runs.status enum is ('completed', 'aborted', 'failed'); no
  -- ELSE clause — let the insert fail loudly if a new value appears, rather
  -- than silently mapping unknown states to 'completed'.
  CASE wr.status
    WHEN 'completed' THEN 'completed'
    WHEN 'failed'    THEN 'failed'
    WHEN 'aborted'   THEN 'cancelled'
  END                                                     AS status,
  NULL                                                    AS blocked_reason,
  FALSE                                                   AS approval_required,
  wr.started_at                                           AS created_at,
  wr.started_at                                           AS started_at,
  wr.finished_at                                          AS ended_at
FROM workflow_runs wr
ON CONFLICT (id) DO NOTHING;
