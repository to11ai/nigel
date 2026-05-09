import { createHash } from "node:crypto";

export function computeInvalidationKeys(
  files: Record<string, string | Buffer | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, contents] of Object.entries(files)) {
    if (contents === null) continue;
    const buf =
      typeof contents === "string" ? Buffer.from(contents, "utf-8") : contents;
    out[path] = createHash("sha256").update(buf).digest("hex");
  }
  return out;
}

export function hashInvalidationKeys(keys: Record<string, string>): string {
  const sorted = Object.keys(keys)
    .sort()
    .map((k) => [k, keys[k]] as const);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
