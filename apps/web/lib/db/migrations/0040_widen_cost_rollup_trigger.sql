-- After widening cost columns to bigint in 0039, widen the rollup trigger
-- function's delta variable so it doesn't silently truncate large updates.
CREATE OR REPLACE FUNCTION agent_runs_cost_rollup() RETURNS TRIGGER AS $$
DECLARE
  v_root_id text;
  v_delta_micros bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta_micros := NEW.cost_usd_actual_micros;
    v_root_id := NEW.root_run_id;
    -- Skip the no-op propagation when the insert defaults to 0.
    IF v_delta_micros = 0 THEN
      RETURN NEW;
    END IF;
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

-- Re-attach the trigger that 0039 dropped so columns could be widened.
CREATE TRIGGER agent_runs_cost_rollup_trg
  AFTER INSERT OR UPDATE OF cost_usd_actual_micros ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_cost_rollup();
