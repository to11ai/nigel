-- Maintains agent_runs.cost_usd_actual_micros on the root row as the sum of
-- self + all descendants. Fires on insert and on update of cost_usd_actual_micros
-- on any non-root row. Uses root_run_id (denormalized on every Run) to
-- propagate deltas in O(1) instead of walking the parent chain.
CREATE OR REPLACE FUNCTION agent_runs_cost_rollup() RETURNS TRIGGER AS $$
DECLARE
  v_root_id text;
  v_delta_micros integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta_micros := NEW.cost_usd_actual_micros;
    v_root_id := NEW.root_run_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.cost_usd_actual_micros = NEW.cost_usd_actual_micros THEN
      RETURN NEW;
    END IF;
    v_delta_micros := NEW.cost_usd_actual_micros - OLD.cost_usd_actual_micros;
    v_root_id := NEW.root_run_id;
  ELSE
    RETURN NEW;
  END IF;

  -- Self-update on the root row already accounts for its own cost; don't
  -- double-add by propagating to itself.
  IF NEW.id = v_root_id THEN
    RETURN NEW;
  END IF;

  UPDATE agent_runs
    SET cost_usd_actual_micros = cost_usd_actual_micros + v_delta_micros
    WHERE id = v_root_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_runs_cost_rollup_trg
  AFTER INSERT OR UPDATE OF cost_usd_actual_micros ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_cost_rollup();
