// Who is calling. ChatGPT or Claude sends a Clerk OAuth access token: a JWT
// signed with the same keys as the app's session tokens, so the same JWKS
// checks it. What makes it an OAuth token for THIS server is the audience:
// Clerk puts the MCP server URL in `aud` once the server is added under
// Clerk Dashboard -> Agents -> MCP servers. An app session token has no such
// `aud`, so it is refused here. Without the audience check, any token from
// our Clerk instance (one minted for another OAuth app, too) would get in.

import { type JWTVerifyGetKey, jwtVerify } from "npm:jose@5";

export type AuthResult =
  | { ok: true; userId: string; email: string | null; clientId: string | null; scopes: string[] }
  | { ok: false; reason: string };

export async function verifyAccessToken(
  authHeader: string | null,
  opts: { jwks: JWTVerifyGetKey; issuer: string; audience: string },
): Promise<AuthResult> {
  if (!authHeader) return { ok: false, reason: "no auth header" };
  if (!authHeader.startsWith("Bearer ")) return { ok: false, reason: "no Bearer prefix" };
  try {
    const { payload } = await jwtVerify(authHeader.slice(7), opts.jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "sub claim missing" };
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return {
      ok: true,
      userId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      clientId: typeof payload.client_id === "string" ? payload.client_id : null,
      scopes: scope.split(" ").filter(Boolean),
    };
  } catch (e) {
    return { ok: false, reason: `verify failed: ${(e as Error).message}` };
  }
}

/** RFC 9728 protected resource metadata: tells the assistant which server
 *  signs users in (Clerk) and which scopes to ask for. */
export function resourceMetadata(resource: string, issuer: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["profile", "email"],
    bearer_methods_supported: ["header"],
    resource_name: "Overload",
  };
}

/** The 401 header that starts the sign-in. Clients read resource_metadata to
 *  find the URL above; our function lives under a path on a shared Supabase
 *  host, so the well-known file at the host root is not ours to serve. */
export function wwwAuthenticate(metadataUrl: string, error?: "invalid_token"): string {
  const parts = [`resource_metadata="${metadataUrl}"`, `scope="profile email"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}
