/**
 * Auth.js v5 configuration with the D1 adapter.
 *
 * Prerequisites:
 *   - D1 tables created by migrations/0001_init.sql (users, accounts, sessions, verification_tokens)
 *   - Google OAuth credentials in env (AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET)
 *   - AUTH_TRUST_HOST=true because Workers don't expose a stable Host header
 */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { D1Adapter } from "@auth/d1-adapter";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const { handlers, signIn, signOut, auth } = NextAuth(() => {
  const { env } = getCloudflareContext();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: D1Adapter(env.DB as any),
    providers: [
      Google({
        clientId: env.AUTH_GOOGLE_ID,
        clientSecret: env.AUTH_GOOGLE_SECRET,
      }),
    ],
    session: { strategy: "database" },
    trustHost: env.AUTH_TRUST_HOST === "true" || Boolean(env.AUTH_TRUST_HOST),
    secret: env.AUTH_SECRET,
  };
});
