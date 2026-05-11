import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// AES-256-GCM. 32-byte key, 12-byte nonce, 16-byte auth tag. The
// secret payload is JSON-stringified before encryption so callers can
// pass arbitrary structured secrets (e.g. `{ password, ca_cert }`
// for Postgres, `{ token }` for an API).

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENV_VAR = "TOOL_CONNECTIONS_ENC_KEY";

// Single error class covering every failure mode of the encryption
// module so the file stays under the "one class per file" lint cap.
// Discriminate via `code` when you need to react to a specific cause.
export class ToolConnectionsCryptoError extends Error {
  readonly code: "key_missing" | "key_invalid" | "decrypt_failed";
  constructor(
    code: "key_missing" | "key_invalid" | "decrypt_failed",
    message: string,
  ) {
    super(message);
    this.name = "ToolConnectionsCryptoError";
    this.code = code;
  }
}

export type EncryptedSecrets = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: 1;
};

// Loads the encryption key. Cached after first call within the
// process. Throws (rather than returning null) so callers don't
// have to handle a missing key — encryption is mandatory and any
// code path that tries to read or write tool_connections without it
// is a deployment bug, not a runtime degradation.
let cachedKey: Buffer | null = null;

export function loadEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[ENV_VAR];
  if (!raw) {
    throw new ToolConnectionsCryptoError(
      "key_missing",
      `${ENV_VAR} is not set. Generate a key with \`openssl rand -base64 32\` and set it in the environment before using tool connections.`,
    );
  }
  let bytes: Buffer;
  try {
    // Accept both base64 and base64url so operators don't have to
    // worry about which encoding their key-generation tool emits.
    bytes = Buffer.from(raw, "base64");
    if (bytes.length !== KEY_BYTES) {
      bytes = Buffer.from(raw, "base64url");
    }
  } catch (err) {
    throw new ToolConnectionsCryptoError(
      "key_invalid",
      `${ENV_VAR} is set but failed to decode: ${err instanceof Error ? err.message : String(err)}. The value must be 32 bytes encoded as base64 or base64url.`,
    );
  }
  if (bytes.length !== KEY_BYTES) {
    throw new ToolConnectionsCryptoError(
      "key_invalid",
      `${ENV_VAR} is set but invalid: expected ${KEY_BYTES} bytes after base64 decode, got ${bytes.length}.`,
    );
  }
  cachedKey = bytes;
  return bytes;
}

// Test-only. Resets the cached key so tests can rotate the env var
// between cases without process restart.
export function resetEncryptionKeyCacheForTests(): void {
  cachedKey = null;
}

export function encryptSecrets(plaintext: unknown): EncryptedSecrets {
  const key = loadEncryptionKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_BYTES) {
    // Defensive; AES-GCM always returns a 16-byte tag.
    throw new Error(
      `unexpected GCM auth tag length: ${authTag.length} (wanted ${AUTH_TAG_BYTES})`,
    );
  }
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: 1,
  };
}

export function decryptSecrets<T = unknown>(input: EncryptedSecrets): T {
  if (input.keyVersion !== 1) {
    throw new ToolConnectionsCryptoError(
      "decrypt_failed",
      `unsupported key version ${input.keyVersion}; this build only knows version 1`,
    );
  }
  const key = loadEncryptionKey();
  const nonce = Buffer.from(input.nonce, "base64");
  const ciphertext = Buffer.from(input.ciphertext, "base64");
  const authTag = Buffer.from(input.authTag, "base64");
  if (nonce.length !== NONCE_BYTES) {
    throw new ToolConnectionsCryptoError(
      "decrypt_failed",
      `nonce length ${nonce.length} (wanted ${NONCE_BYTES})`,
    );
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new ToolConnectionsCryptoError(
      "decrypt_failed",
      `auth tag length ${authTag.length} (wanted ${AUTH_TAG_BYTES})`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // GCM throws on auth-tag mismatch. Surface a typed error so the
    // caller can distinguish "key wrong" / "ciphertext tampered" from
    // an actual JSON parse failure below.
    throw new ToolConnectionsCryptoError(
      "decrypt_failed",
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (err) {
    throw new ToolConnectionsCryptoError(
      "decrypt_failed",
      `decrypted bytes are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Compares two base64-encoded blobs without leaking length-mismatch
// timing. Exposed because some callers want to know whether a
// re-encrypt would actually change the stored row.
export function ciphertextEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
