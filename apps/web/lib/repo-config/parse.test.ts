import { describe, expect, test } from "bun:test";
import { parseNigelYaml, RepoConfigParseError } from "./parse";

describe("parseNigelYaml", () => {
  test("parses a minimal yaml document", () => {
    const config = parseNigelYaml("version: 1\n");
    expect(config.version).toBe(1);
  });

  test("parses the spec example", () => {
    const yaml = `
version: 1
setup:
  - "bun install --frozen-lockfile"
turbo:
  enabled: true
checks:
  lint: { command: "bun run lint" }
`;
    const config = parseNigelYaml(yaml);
    expect(config.checks?.lint?.command).toBe("bun run lint");
    expect(config.turbo?.enabled).toBe(true);
  });

  test("throws RepoConfigParseError on malformed yaml", () => {
    expect(() => parseNigelYaml("version: 1\n  bad: indent")).toThrow(
      RepoConfigParseError,
    );
  });

  test("throws RepoConfigParseError when schema validation fails", () => {
    expect(() => parseNigelYaml("version: 2\n")).toThrow(RepoConfigParseError);
  });

  test("throws RepoConfigParseError when document is not an object", () => {
    expect(() => parseNigelYaml("- 1\n- 2\n")).toThrow(RepoConfigParseError);
  });
});
