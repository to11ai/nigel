import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleClient | null = null;

export const db = new Proxy({} as DrizzleClient, {
  get(_, prop) {
    if (!_db) {
      // Vercel's Neon Marketplace integration provisions DATABASE_URL.
      // POSTGRES_URL is the legacy fallback for any pre-integration setups.
      const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
      if (!url) {
        throw new Error(
          "DATABASE_URL (or legacy POSTGRES_URL) environment variable is required",
        );
      }
      const client = postgres(url);
      _db = drizzle(client, { schema });
    }
    return Reflect.get(_db, prop);
  },
});
