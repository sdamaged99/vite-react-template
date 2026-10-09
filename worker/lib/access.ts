import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../types";

/**
 * Cloudflare Access JWT validation.
 *
 * The admin area sits behind a Cloudflare Access application (one-time PIN to
 * Amanda's email). Access injects a signed JWT in the Cf-Access-Jwt-Assertion
 * header on every request that passed the edge policy. Defence in depth: the
 * Worker verifies that JWT itself, so admin routes stay closed even if the
 * route is ever exposed without Access in front of it.
 *
 * Configuration: ACCESS_TEAM_DOMAIN (e.g. "example.cloudflareaccess.com") and
 * ACCESS_AUD (the Access application's audience tag). With either unset, all
 * admin requests are rejected; there is no bypass mode.
 */

interface AccessPayload {
  aud: string[] | string;
  email?: string;
  exp: number;
  iat: number;
  iss: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

// Cache the signing keys per isolate; Access rotates them infrequently.
let keyCache: { fetchedAt: number; keys: Jwk[] } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

async function getKeys(teamDomain: string): Promise<Jwk[]> {
  if (keyCache && Date.now() - keyCache.fetchedAt < KEY_TTL_MS) return keyCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  keyCache = { fetchedAt: Date.now(), keys: body.keys };
  return body.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<AccessPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const [h, p, s] = parts as [string, string, string];

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid: string; alg: string };
  if (header.alg !== "RS256") throw new Error("Unexpected JWT alg");

  const keys = await getKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new Error("Invalid JWT signature");

  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as AccessPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("JWT expired");
  if (payload.iss !== `https://${teamDomain}`) throw new Error("Unexpected issuer");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) throw new Error("Audience mismatch");
  return payload;
}

export const requireAccess: MiddlewareHandler<AppBindings> = async (c, next) => {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD } = c.env;
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    return c.json({ error: "Admin access is not configured" }, 503);
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "Unauthorised" }, 401);
  try {
    const payload = await verifyAccessJwt(token, ACCESS_TEAM_DOMAIN, ACCESS_AUD);
    c.set("adminEmail", payload.email);
  } catch {
    return c.json({ error: "Unauthorised" }, 401);
  }
  await next();
};
