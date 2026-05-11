import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  ciphertextEquals,
  decryptSecrets,
  encryptSecrets,
  loadEncryptionKey,
  resetEncryptionKeyCacheForTests,
  ToolConnectionsCryptoError,
} from "./encryption";

const VALID_KEY_B64 = randomBytes(32).toString("base64");

const ORIGINAL_KEY = process.env.TOOL_CONNECTIONS_ENC_KEY;

beforeEach(() => {
  process.env.TOOL_CONNECTIONS_ENC_KEY = VALID_KEY_B64;
  resetEncryptionKeyCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.TOOL_CONNECTIONS_ENC_KEY;
  } else {
    process.env.TOOL_CONNECTIONS_ENC_KEY = ORIGINAL_KEY;
  }
  resetEncryptionKeyCacheForTests();
});

describe("loadEncryptionKey", () => {
  test("throws ToolConnectionsCryptoError when env var unset", () => {
    delete process.env.TOOL_CONNECTIONS_ENC_KEY;
    resetEncryptionKeyCacheForTests();
    expect(() => loadEncryptionKey()).toThrow(ToolConnectionsCryptoError);
  });

  test("throws ToolConnectionsCryptoError on wrong length", () => {
    process.env.TOOL_CONNECTIONS_ENC_KEY =
      Buffer.from("short").toString("base64");
    resetEncryptionKeyCacheForTests();
    expect(() => loadEncryptionKey()).toThrow(ToolConnectionsCryptoError);
  });

  test("accepts a 32-byte base64-encoded key", () => {
    const key = loadEncryptionKey();
    expect(key.length).toBe(32);
  });

  test("caches the decoded key across calls", () => {
    const a = loadEncryptionKey();
    const b = loadEncryptionKey();
    expect(a).toBe(b);
  });
});

describe("encryptSecrets / decryptSecrets", () => {
  test("roundtrips an arbitrary JSON value", () => {
    const payload = { password: "p@ss", extra: ["a", "b"], n: 7 };
    const encrypted = encryptSecrets(payload);
    expect(encrypted.keyVersion).toBe(1);
    const decoded = decryptSecrets<typeof payload>(encrypted);
    expect(decoded).toEqual(payload);
  });

  test("produces a different nonce + ciphertext on each call (same input)", () => {
    const a = encryptSecrets({ password: "x" });
    const b = encryptSecrets({ password: "x" });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("decrypt throws ToolConnectionsCryptoError on auth-tag tamper", () => {
    const encrypted = encryptSecrets({ password: "x" });
    const tamperedTag = Buffer.from(encrypted.authTag, "base64");
    tamperedTag[0] ^= 0xff;
    expect(() =>
      decryptSecrets({
        ...encrypted,
        authTag: tamperedTag.toString("base64"),
      }),
    ).toThrow(ToolConnectionsCryptoError);
  });

  test("decrypt throws ToolConnectionsCryptoError on ciphertext tamper", () => {
    const encrypted = encryptSecrets({ password: "x" });
    const tampered = Buffer.from(encrypted.ciphertext, "base64");
    tampered[0] ^= 0xff;
    expect(() =>
      decryptSecrets({
        ...encrypted,
        ciphertext: tampered.toString("base64"),
      }),
    ).toThrow(ToolConnectionsCryptoError);
  });

  test("decrypt throws ToolConnectionsCryptoError when key has changed", () => {
    const encrypted = encryptSecrets({ password: "x" });
    process.env.TOOL_CONNECTIONS_ENC_KEY = randomBytes(32).toString("base64");
    resetEncryptionKeyCacheForTests();
    expect(() => decryptSecrets(encrypted)).toThrow(ToolConnectionsCryptoError);
  });

  test("decrypt rejects unsupported key version", () => {
    const encrypted = encryptSecrets({ password: "x" });
    expect(() =>
      decryptSecrets({ ...encrypted, keyVersion: 2 as unknown as 1 }),
    ).toThrow(ToolConnectionsCryptoError);
  });
});

describe("ciphertextEquals", () => {
  test("returns true for identical inputs", () => {
    const a = encryptSecrets({ x: 1 });
    expect(ciphertextEquals(a.ciphertext, a.ciphertext)).toBe(true);
  });

  test("returns false for different lengths", () => {
    expect(
      ciphertextEquals(
        Buffer.from("aa").toString("base64"),
        Buffer.from("bbbb").toString("base64"),
      ),
    ).toBe(false);
  });

  test("returns false for same length but different bytes", () => {
    expect(
      ciphertextEquals(
        Buffer.from([1, 2, 3, 4]).toString("base64"),
        Buffer.from([1, 2, 3, 5]).toString("base64"),
      ),
    ).toBe(false);
  });
});
