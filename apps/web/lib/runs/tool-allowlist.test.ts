import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { filterAgentTools } from "./tool-allowlist";

describe("filterAgentTools", () => {
  const allTools = {
    read: { _kind: "tool" },
    write: { _kind: "tool" },
    edit: { _kind: "tool" },
    grep: { _kind: "tool" },
    glob: { _kind: "tool" },
    bash: { _kind: "tool" },
    task: { _kind: "tool" },
    skill: { _kind: "tool" },
    web_fetch: { _kind: "tool" },
    todo_write: { _kind: "tool" },
    ask_user_question: { _kind: "tool" },
    dispatch_specialist: { _kind: "tool" },
    database_query: { _kind: "tool" },
    clickhouse_query: { _kind: "tool" },
    redis_command: { _kind: "tool" },
  };

  test("file expands to read+write+edit", () => {
    const out = filterAgentTools(["file"], allTools as unknown as ToolSet);
    expect(Object.keys(out).sort()).toEqual(["edit", "read", "write"]);
  });

  test("search expands to grep+glob", () => {
    const out = filterAgentTools(["search"], allTools as unknown as ToolSet);
    expect(Object.keys(out).sort()).toEqual(["glob", "grep"]);
  });

  test("file_read expands to read only (no write or edit)", () => {
    const out = filterAgentTools(["file_read"], allTools as unknown as ToolSet);
    expect(Object.keys(out).sort()).toEqual(["read"]);
  });

  test("reviewer allowlist [file_read, search] yields read+glob+grep", () => {
    const out = filterAgentTools(
      ["file_read", "search"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["glob", "grep", "read"]);
  });

  test("shell expands to bash", () => {
    const out = filterAgentTools(["shell"], allTools as unknown as ToolSet);
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("git expands to bash (no structured git tool yet)", () => {
    const out = filterAgentTools(["git"], allTools as unknown as ToolSet);
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("web expands to web_fetch", () => {
    const out = filterAgentTools(["web"], allTools as unknown as ToolSet);
    expect(Object.keys(out).sort()).toEqual(["web_fetch"]);
  });

  test("dispatch_specialist expands to dispatch_specialist tool", () => {
    const out = filterAgentTools(
      ["dispatch_specialist"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["dispatch_specialist"]);
  });

  test("database_query expands to database_query tool", () => {
    const out = filterAgentTools(
      ["database_query"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["database_query"]);
  });

  test("clickhouse_query expands to clickhouse_query tool", () => {
    const out = filterAgentTools(
      ["clickhouse_query"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["clickhouse_query"]);
  });

  test("redis_command expands to redis_command tool", () => {
    const out = filterAgentTools(
      ["redis_command"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["redis_command"]);
  });

  test("data-analyst allowlist yields the multi-engine analyst tool surface", () => {
    const out = filterAgentTools(
      [
        "file_read",
        "search",
        "database_query",
        "clickhouse_query",
        "redis_command",
      ],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual([
      "clickhouse_query",
      "database_query",
      "glob",
      "grep",
      "read",
      "redis_command",
    ]);
  });

  test("planner allowlist yields the planner tool surface", () => {
    const out = filterAgentTools(
      ["file", "search", "shell", "git", "web", "dispatch_specialist"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual([
      "bash",
      "dispatch_specialist",
      "edit",
      "glob",
      "grep",
      "read",
      "web_fetch",
      "write",
    ]);
  });

  test("multiple categories deduplicate (shell+git both include bash)", () => {
    const out = filterAgentTools(
      ["shell", "git"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("coder allowlist [file, search, shell, git] yields six tools", () => {
    const out = filterAgentTools(
      ["file", "search", "shell", "git"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });

  test("unknown category is silently ignored", () => {
    const out = filterAgentTools(
      ["bogus", "shell"],
      allTools as unknown as ToolSet,
    );
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("empty allowlist yields empty tool set", () => {
    expect(filterAgentTools([], allTools as unknown as ToolSet)).toEqual({});
  });
});
