import { describe, expect, test } from "bun:test";
import { type LinearCommand, parseLinearCommand } from "./command-parser";

describe("parseLinearCommand", () => {
  test("parses each registered command with no argument", () => {
    const commands: LinearCommand[] = [
      "approve",
      "reject",
      "resume",
      "cancel",
      "run",
    ];
    for (const c of commands) {
      expect(parseLinearCommand(`/${c}`)).toEqual({ command: c, arg: "" });
    }
  });

  test("captures the argument after the command", () => {
    expect(parseLinearCommand("/reject not what we wanted")).toEqual({
      command: "reject",
      arg: "not what we wanted",
    });
  });

  test("is case-insensitive on the command word", () => {
    expect(parseLinearCommand("/Approve")).toEqual({
      command: "approve",
      arg: "",
    });
    expect(parseLinearCommand("/APPROVE")).toEqual({
      command: "approve",
      arg: "",
    });
  });

  test("tolerates leading whitespace", () => {
    expect(parseLinearCommand("   /resume after lunch")).toEqual({
      command: "resume",
      arg: "after lunch",
    });
  });

  test("requires the command on the FIRST non-empty line", () => {
    // Command in the middle of prose must not match.
    expect(parseLinearCommand("hey team\n/approve")).toBeNull();
  });

  test("skips leading blank lines then matches first content line", () => {
    expect(parseLinearCommand("\n\n/cancel timed out")).toEqual({
      command: "cancel",
      arg: "timed out",
    });
  });

  test("returns null for unknown commands", () => {
    expect(parseLinearCommand("/foo bar")).toBeNull();
    expect(parseLinearCommand("/")).toBeNull();
  });

  test("returns null for empty body", () => {
    expect(parseLinearCommand("")).toBeNull();
    expect(parseLinearCommand("   \n\n  ")).toBeNull();
  });

  test("requires word boundary after the command — '/approveplz' is not '/approve'", () => {
    expect(parseLinearCommand("/approveplz")).toBeNull();
  });

  test("handles Windows-style line endings", () => {
    expect(parseLinearCommand("/run\r\nmore text")).toEqual({
      command: "run",
      arg: "",
    });
  });
});
