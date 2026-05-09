import { describe, expect, test } from "bun:test";
import {
  computeInvalidationKeys,
  hashInvalidationKeys,
} from "./invalidation-keys";

describe("computeInvalidationKeys", () => {
  test("returns sha256 hex per file", () => {
    const out = computeInvalidationKeys({
      "docker-compose.yaml": "version: '3'\n",
      "package-lock.json": "{}",
    });
    expect(out["docker-compose.yaml"]).toMatch(/^[0-9a-f]{64}$/);
    expect(out["package-lock.json"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("omits null entries", () => {
    const out = computeInvalidationKeys({
      "docker-compose.yaml": "x",
      "missing.txt": null,
    });
    expect(out).not.toHaveProperty("missing.txt");
    expect(out["docker-compose.yaml"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("buffer and string with same bytes hash to the same value", () => {
    const out = computeInvalidationKeys({
      a: "hello",
      b: Buffer.from("hello", "utf-8"),
    });
    expect(out.a).toBe(out.b);
  });

  test("identical content at same path produces stable digest", () => {
    const a = computeInvalidationKeys({ x: "hello" });
    const b = computeInvalidationKeys({ x: "hello" });
    expect(a.x).toBe(b.x);
  });

  test("different content produces different digest", () => {
    const a = computeInvalidationKeys({ x: "hello" });
    const b = computeInvalidationKeys({ x: "world" });
    expect(a.x).not.toBe(b.x);
  });
});

describe("hashInvalidationKeys", () => {
  test("returns sha256 hex", () => {
    expect(hashInvalidationKeys({ "a.txt": "abc" })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is order-independent (sorts keys before hashing)", () => {
    const a = hashInvalidationKeys({
      "a.txt": "h1",
      "b.txt": "h2",
      "c.txt": "h3",
    });
    const b = hashInvalidationKeys({
      "c.txt": "h3",
      "a.txt": "h1",
      "b.txt": "h2",
    });
    expect(a).toBe(b);
  });

  test("differs when any key or value changes", () => {
    const base = hashInvalidationKeys({ "a.txt": "x" });
    expect(base).not.toBe(hashInvalidationKeys({ "a.txt": "y" }));
    expect(base).not.toBe(hashInvalidationKeys({ "b.txt": "x" }));
  });

  test("differs when an entry is added", () => {
    const a = hashInvalidationKeys({ "a.txt": "x" });
    const b = hashInvalidationKeys({ "a.txt": "x", "b.txt": "y" });
    expect(a).not.toBe(b);
  });

  test("empty map has a stable hash", () => {
    expect(hashInvalidationKeys({})).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvalidationKeys({})).toBe(hashInvalidationKeys({}));
  });
});
