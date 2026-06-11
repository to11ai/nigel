import { describe, expect, test } from "bun:test";
import {
  buildDockerStartupSteps,
  buildDockerTeardownSteps,
  CA_CONTAINER_PATH,
  CA_OVERRIDE_PATH,
  PROXY_CA_HOST_PATH,
  type RepoDocker,
} from "./docker-bootstrap";

function cmdOf(step: string | { cmd: string }): string {
  return typeof step === "string" ? step : step.cmd;
}

const withCompose: RepoDocker = {
  compose_file: "docker-compose.test.yaml",
  mount_proxy_ca: true,
};

describe("buildDockerStartupSteps", () => {
  test("always installs docker, boots dockerd detached, then waits for readiness", () => {
    const steps = buildDockerStartupSteps({ mount_proxy_ca: true });
    const cmds = steps.map(cmdOf);

    expect(cmds[0]).toBe("sudo dnf install -y docker");
    // install is bounded + retried (transient registry/network failures)
    expect(steps[0]).toMatchObject({ retry: 2, timeout_seconds: 180 });
    // dockerd is backgrounded so the step returns immediately
    expect(cmds[1]).toContain("nohup dockerd");
    expect(cmds[1]).toContain("&");
    // readiness is a bounded poll, not a fixed sleep
    expect(cmds[2]).toContain("until sudo docker info");
    expect(steps[2]).toMatchObject({ timeout_seconds: 60 });
  });

  test("honors custom install/ready timeouts", () => {
    const steps = buildDockerStartupSteps({
      mount_proxy_ca: false,
      install_timeout_seconds: 600,
      ready_timeout_seconds: 120,
    });
    expect(steps[0]).toMatchObject({ timeout_seconds: 600 });
    expect(steps[2]).toMatchObject({ timeout_seconds: 120 });
  });

  test("without a compose_file it stops after booting the daemon", () => {
    const steps = buildDockerStartupSteps({ mount_proxy_ca: true });
    expect(steps).toHaveLength(3);
    expect(steps.map(cmdOf).some((c) => c.includes("compose"))).toBe(false);
  });

  test("with a compose_file it installs the compose plugin (absent on AL2023), pinned + checksum-verified", () => {
    const cmds = buildDockerStartupSteps(withCompose).map(cmdOf);
    const plugin = cmds.find((c) => c.includes("cli-plugins/docker-compose"));
    expect(plugin).toBeDefined();
    // pinned version, not a floating `latest`
    expect(plugin).toContain("releases/download/v");
    expect(plugin).not.toContain("releases/latest/download");
    // digest verified before the binary is made executable
    expect(plugin).toMatch(/sha256sum -c -[\s\S]*chmod \+x/);
  });

  test("with a compose_file it generates a CA override then brings the stack up", () => {
    const steps = buildDockerStartupSteps(withCompose);
    const cmds = steps.map(cmdOf);

    const override = cmds.find((c) => c.includes(CA_OVERRIDE_PATH));
    expect(override).toBeDefined();
    // enumerates services and mounts the host CA into each
    expect(override).toContain(
      'docker compose -f "docker-compose.test.yaml" config --services',
    );
    expect(override).toContain(PROXY_CA_HOST_PATH);
    expect(override).toContain(CA_CONTAINER_PATH);
    expect(override).toContain("NODE_EXTRA_CA_CERTS");

    const up = cmds.at(-1) ?? "";
    expect(up).toContain("up -d --wait");
    // up uses both the base file (quoted) and the generated override
    expect(up).toContain('-f "docker-compose.test.yaml"');
    expect(up).toContain(`-f ${CA_OVERRIDE_PATH}`);
  });

  test("mount_proxy_ca:false skips the override and the override -f flag", () => {
    const steps = buildDockerStartupSteps({
      compose_file: "compose.yaml",
      mount_proxy_ca: false,
    });
    const cmds = steps.map(cmdOf);
    expect(cmds.some((c) => c.includes(CA_OVERRIDE_PATH))).toBe(false);
    const up = cmds.at(-1) ?? "";
    expect(up).toBe('sudo docker compose -f "compose.yaml" up -d --wait');
  });
});

describe("buildDockerTeardownSteps", () => {
  test("brings the compose stack down with volumes, using only the base file", () => {
    const steps = buildDockerTeardownSteps(withCompose);
    expect(steps).toEqual([
      'sudo docker compose -f "docker-compose.test.yaml" down -v',
    ]);
  });

  test("no compose_file means nothing to tear down", () => {
    expect(buildDockerTeardownSteps({ mount_proxy_ca: true })).toEqual([]);
  });
});
