import { describe, expect, test } from "bun:test";
import {
  formatScope,
  parseScope,
  ToolConnectionValidationError,
  validateConfigForKind,
  validateSecretsForKind,
} from "./types";

describe("validateConfigForKind — postgres", () => {
  test("accepts a minimal valid config and applies defaults", () => {
    const config = validateConfigForKind("postgres", {
      host: "db.example.com",
      database: "appdb",
      user: "reader",
    });
    expect(config.port).toBe(5432);
    expect(config.sslMode).toBe("require");
    expect(config.readOnly).toBe(true);
    expect(config.defaultStatementTimeoutMs).toBe(30_000);
    expect(config.defaultRowLimit).toBe(1000);
  });

  test("rejects missing required fields with a typed error", () => {
    expect(() => validateConfigForKind("postgres", { host: "h" })).toThrow(
      ToolConnectionValidationError,
    );
  });

  test("rejects out-of-range port", () => {
    expect(() =>
      validateConfigForKind("postgres", {
        host: "h",
        database: "d",
        user: "u",
        port: 70000,
      }),
    ).toThrow(ToolConnectionValidationError);
  });
});

describe("validateSecretsForKind — postgres", () => {
  test("accepts a non-empty password", () => {
    expect(validateSecretsForKind("postgres", { password: "p" })).toBeTruthy();
  });

  test("rejects an empty password", () => {
    expect(() => validateSecretsForKind("postgres", { password: "" })).toThrow(
      ToolConnectionValidationError,
    );
  });
});

describe("validateConfigForKind — mcp", () => {
  test("accepts http transport with url", () => {
    const config = validateConfigForKind("mcp", {
      transport: "http",
      url: "https://mcp.example.com/sse",
    });
    expect(config.transport).toBe("http");
    if (config.transport === "http") {
      expect(config.url).toBe("https://mcp.example.com/sse");
      expect(config.defaultTimeoutMs).toBe(60_000);
    }
  });

  test("accepts stdio transport with command", () => {
    const config = validateConfigForKind("mcp", {
      transport: "stdio",
      command: "pulumi-mcp",
      args: ["--cloud-url", "https://api.pulumi.com"],
    });
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.command).toBe("pulumi-mcp");
      expect(config.args).toEqual(["--cloud-url", "https://api.pulumi.com"]);
    }
  });

  test("rejects http transport without url", () => {
    expect(() => validateConfigForKind("mcp", { transport: "http" })).toThrow(
      ToolConnectionValidationError,
    );
  });

  test("rejects stdio transport without command", () => {
    expect(() => validateConfigForKind("mcp", { transport: "stdio" })).toThrow(
      ToolConnectionValidationError,
    );
  });

  test("rejects http transport with empty url string", () => {
    expect(() =>
      validateConfigForKind("mcp", { transport: "http", url: "" }),
    ).toThrow(ToolConnectionValidationError);
  });
});

describe("validateConfigForKind — slack", () => {
  test("accepts a channel-only config", () => {
    const config = validateConfigForKind("slack", { channel: "#ops" });
    expect(config.channel).toBe("#ops");
  });
});

describe("validateSecretsForKind — slack", () => {
  test("rejects a non-URL webhook", () => {
    expect(() =>
      validateSecretsForKind("slack", { webhookUrl: "not a url" }),
    ).toThrow(ToolConnectionValidationError);
  });

  test("accepts a valid webhook URL", () => {
    expect(
      validateSecretsForKind("slack", {
        webhookUrl: "https://hooks.slack.com/services/T/B/X",
      }),
    ).toBeTruthy();
  });
});

describe("parseScope / formatScope", () => {
  test("parses 'global'", () => {
    expect(parseScope("global")).toEqual({ kind: "global" });
  });

  test("parses 'specialist:<name>'", () => {
    expect(parseScope("specialist:coder")).toEqual({
      kind: "specialist",
      specialistName: "coder",
    });
  });

  test("rejects an unknown form", () => {
    expect(() => parseScope("everyone")).toThrow(ToolConnectionValidationError);
  });

  test("rejects 'specialist:' with empty name", () => {
    expect(() => parseScope("specialist:")).toThrow(
      ToolConnectionValidationError,
    );
  });

  test("formatScope roundtrips parseScope", () => {
    for (const raw of ["global", "specialist:coder", "specialist:planner"]) {
      expect(formatScope(parseScope(raw))).toBe(raw);
    }
  });
});
