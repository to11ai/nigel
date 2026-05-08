import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { GithubProfile } from "better-auth/social-providers";
import { nanoid } from "nanoid";
import { deriveAuthUsername } from "@/lib/auth/username";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

function normalizeHost(value?: string): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(
      value.startsWith("http://") || value.startsWith("https://")
        ? value
        : `https://${value}`,
    ).host;
  } catch {
    return null;
  }
}

function getWildcardHostPattern(host: string): string | null {
  const hostname = host.split(":")[0];
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("[")
  ) {
    return null;
  }

  return `*.${host}`;
}

function getAuthBaseURLFallback(): string | undefined {
  return (
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined)
  );
}

function getAllowedAuthHosts(): string[] {
  const hosts = new Set<string>(["localhost:3000", "127.0.0.1:3000"]);

  for (const value of [
    process.env.BETTER_AUTH_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    const host = normalizeHost(value);
    if (!host) {
      continue;
    }

    hosts.add(host);

    const wildcardPattern = getWildcardHostPattern(host);
    if (wildcardPattern) {
      hosts.add(wildcardPattern);
    }
  }

  return [...hosts];
}

function mapGitHubProfileToUser(profile: GithubProfile): { username: string } {
  return {
    username: deriveAuthUsername({
      id: profile.id,
      username: profile.login,
      email: profile.email,
      name: profile.name,
    }),
  };
}

// When NIGEL_ALLOWED_GITHUB_ORG is set, sign-in is restricted to active
// members of that org. The user's OAuth access token (with read:org scope)
// is used to query GET /user/memberships/orgs/{org}, which returns the
// caller's own membership regardless of visibility (so private members are
// admitted). 200 + state="active" → allowed; anything else → rejected.
async function assertGithubOrgMembership(
  accessToken: string,
  org: string,
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
    {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nigel",
      },
    },
  );

  if (res.status === 404) {
    throw new Error(`Sign-in restricted to members of the ${org} GitHub org.`);
  }
  if (!res.ok) {
    throw new Error(
      `GitHub org membership check failed: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { state?: string };
  if (body.state !== "active") {
    throw new Error(
      `GitHub org membership for ${org} is not active (state=${body.state ?? "unknown"}).`,
    );
  }
}

const authBaseURLFallback = getAuthBaseURLFallback();
const authAllowedHosts = getAllowedAuthHosts();

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: {
    allowedHosts: authAllowedHosts,
    ...(authBaseURLFallback ? { fallback: authBaseURLFallback } : {}),
  },

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      users: schema.users,
      auth_sessions: schema.authSessions,
      account: schema.accounts,
      verification: schema.verification,
    },
  }),

  user: {
    modelName: "users",
    fields: {
      image: "avatarUrl",
    },
    additionalFields: {
      username: { type: "string", required: true },
      lastLoginAt: { type: "date", required: false },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            username: deriveAuthUsername(user),
          },
        }),
      },
    },
    session: {
      // Runs on every sign-in (each fresh OAuth completion creates a new
      // session row). account.create.before would only fire on the user's
      // very first sign-in — once an account row exists, subsequent logins
      // would skip the check, allowing a user removed from the org to keep
      // signing in.
      create: {
        before: async (session) => {
          const allowedOrg = process.env.NIGEL_ALLOWED_GITHUB_ORG?.trim();
          if (!allowedOrg) {
            return { data: session };
          }
          // getAccessToken returns null when the user has no linked github
          // account (e.g., signed in via a different provider). In that case
          // we have nothing to check — pass through. When the user does have
          // a github account, validate org membership against the decrypted
          // access token.
          const tokenResult = await auth.api.getAccessToken({
            body: { providerId: "github", userId: session.userId },
          });
          if (!tokenResult?.accessToken) {
            return { data: session };
          }
          await assertGithubOrgMembership(tokenResult.accessToken, allowedOrg);
          return { data: session };
        },
      },
    },
  },

  session: {
    modelName: "auth_sessions",
  },

  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: ["github"],
      allowDifferentEmails: true,
    },
  },

  socialProviders: {
    github: {
      clientId: process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      // read:org is required for the org-membership check in the
      // account.create.before hook above.
      scope: ["read:user", "user:email", "read:org"],
      mapProfileToUser: mapGitHubProfileToUser,
    },
  },

  advanced: {
    database: {
      generateId: () => nanoid(),
    },
  },
});
