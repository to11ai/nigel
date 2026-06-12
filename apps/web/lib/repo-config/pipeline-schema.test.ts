import { describe, expect, test } from "bun:test";
import { parseNigelYaml, RepoConfigParseError } from "./parse";

describe("pipeline schema", () => {
  test("parses a multi-phase pipeline with gates, when, parallel, and on_terminal", () => {
    const yaml = `
version: 1
pipeline:
  phases:
    - id: implement
      specialist: coder
      sandbox_policy: inherit
    - id: ui-proof
      specialist: visual-prover
      sandbox_policy: fresh
      when: "touches_frontend"
    - id: validate
      specialist: adversarial-reviewer
      sandbox_policy: fresh_clean
      independent: true
      gate: { required: true, on_fail: stop }
    - id: checks
      parallel:
        - { specialist: linter, sandbox_policy: fresh }
        - { specialist: type-checker, sandbox_policy: fresh }
        - { specialist: e2e-tester, sandbox_policy: fresh, local_stack_profile: e2e }
      gate: { required: true, on_fail: repair, max_repairs: 2, repair_with: coder }
  on_terminal:
    babysit: true
    finalize: { teardown: true, linear_done: true, delete_branch: true }
`;
    const cfg = parseNigelYaml(yaml);
    const phases = cfg.pipeline?.phases ?? [];
    expect(phases.map((p) => p.id)).toEqual([
      "implement",
      "ui-proof",
      "validate",
      "checks",
    ]);
    // defaults applied
    expect(phases[2]?.independent).toBe(true);
    expect(phases[2]?.gate?.required).toBe(true);
    expect(phases[2]?.gate?.on_fail).toBe("stop");
    expect(phases[3]?.parallel).toHaveLength(3);
    expect(phases[3]?.gate?.repair_with).toBe("coder");
    expect(cfg.pipeline?.on_terminal?.babysit).toBe(true);
    expect(cfg.pipeline?.on_terminal?.finalize?.delete_branch).toBe(true);
  });

  test("defaults: independent false, gate omitted is allowed, budget_usd in dollars", () => {
    const cfg = parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: implement
      specialist: coder
      budget_usd: 5
`);
    const phase = cfg.pipeline?.phases[0];
    expect(phase?.independent).toBe(false);
    expect(phase?.budget_usd).toBe(5);
    expect(phase?.gate).toBeUndefined();
  });

  test("rejects a phase that sets neither specialist nor parallel", () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: empty
`),
    ).toThrow(RepoConfigParseError);
  });

  test("rejects a phase that sets BOTH specialist and parallel", () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: both
      specialist: coder
      parallel:
        - { specialist: linter }
        - { specialist: type-checker }
`),
    ).toThrow(RepoConfigParseError);
  });

  test("rejects a parallel block with fewer than 2 steps", () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: checks
      parallel:
        - { specialist: linter }
`),
    ).toThrow(RepoConfigParseError);
  });

  test("rejects duplicate phase ids", () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: dup
      specialist: coder
    - id: dup
      specialist: linter
`),
    ).toThrow(RepoConfigParseError);
  });

  test("rejects an invalid sandbox_policy", () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: implement
      specialist: coder
      sandbox_policy: privileged
`),
    ).toThrow(RepoConfigParseError);
  });

  test('rejects on_fail: "repair" without repair_with', () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: checks
      specialist: linter
      gate: { on_fail: repair, max_repairs: 2 }
`),
    ).toThrow(RepoConfigParseError);
  });

  test('accepts on_fail: "repair" when repair_with is set', () => {
    const cfg = parseNigelYaml(`
version: 1
pipeline:
  phases:
    - id: checks
      specialist: linter
      gate: { on_fail: repair, max_repairs: 2, repair_with: coder }
`);
    expect(cfg.pipeline?.phases[0]?.gate?.repair_with).toBe("coder");
  });

  test("rejects an empty phases array", () => {
    expect(() =>
      parseNigelYaml(`
version: 1
pipeline:
  phases: []
`),
    ).toThrow(RepoConfigParseError);
  });

  test("a config with no pipeline parses (pipeline is optional)", () => {
    const cfg = parseNigelYaml("version: 1\n");
    expect(cfg.pipeline).toBeUndefined();
  });
});
