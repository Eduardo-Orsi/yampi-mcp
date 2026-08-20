/**
 * Authorization screen. This is where the Merchant presents the Store Credential
 * — the User-Token / User-Secret-Key pair from the Yampi dashboard. Presenting it
 * IS the authentication: whoever holds it owns the store, and there is no separate
 * password to invent, store or leak.
 *
 * The validated credential travels encrypted in the Grant props. Claude never sees
 * it; it only receives an opaque token.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { YampiClient, YampiError, type Store } from "./yampi";

export interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  /** Optional: restricts this Instance to these aliases, comma-separated. */
  ALLOWED_STORES?: string;
}

/**
 * Grant identifier. It must not contain `:` — the library builds the
 * authorization code as `userId:grantId:secret` and splits it into exactly three
 * parts. A colon here breaks the whole token exchange, and the error only shows
 * up much later as "Invalid authorization code format".
 */
export function grantId(stores: Store[]): string {
  return `yampi-${stores.map((s) => s.id).join("-")}`;
}

export interface GrantProps {
  userToken: string;
  secretKey: string;
  stores: Store[];
}

/** A public `/authorize` validates credentials, so it is an oracle for testing stolen keys. */
const ATTEMPTS_PER_MINUTE = 5;

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize") return homePage(url);

  if (request.method === "GET") {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const oauthClient = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    return formHtml(url.search, oauthClient?.clientName ?? authRequest.clientId, null);
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  const params = String(form.get("oauth_req") ?? "");
  const userToken = String(form.get("user_token") ?? "").trim();
  const secretKey = String(form.get("secret_key") ?? "").trim();

  // Re-validate the OAuth request from the original parameters instead of
  // trusting a JSON blob coming from the form: client, redirect_uri and PKCE go
  // through the library again.
  const authRequest: AuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(
    new Request(url.origin + "/authorize" + params),
  );
  const oauthClient = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  const clientName = oauthClient?.clientName ?? authRequest.clientId;

  if (await tooManyAttempts(request, env)) {
    return formHtml(params, clientName, "Too many attempts. Wait a minute.", 429);
  }

  if (!userToken || !secretKey) {
    return formHtml(params, clientName, "Fill in both credentials.", 400);
  }

  let stores: Store[];
  try {
    stores = await new YampiClient({ userToken, secretKey }).stores();
  } catch (e) {
    // Never swallow the cause: "invalid credential" and "the call failed" are
    // different problems, and calling both a rejection sends the Merchant off to
    // double-check a credential that may well be correct.
    const cause = e instanceof Error ? e.message : String(e);
    console.error("failed to validate credential:", cause);
    const rejected = e instanceof YampiError && (e.status === 401 || e.status === 403);
    return formHtml(
      params,
      clientName,
      rejected
        ? "Yampi rejected these credentials. Check them under Perfil › Credenciais de API in the dashboard."
        : `Could not validate with Yampi: ${cause}`,
      rejected ? 401 : 502,
    );
  }

  const allowed = env.ALLOWED_STORES?.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (allowed?.length) stores = stores.filter((s) => allowed.includes(s.alias));

  if (stores.length === 0) {
    return formHtml(params, clientName, "Valid credential, but no store reachable on this Instance.", 403);
  }

  const props: GrantProps = { userToken, secretKey, stores };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: grantId(stores),
    metadata: { clientName, stores: stores.map((s) => s.alias) },
    scope: authRequest.scope,
    props,
  });
  return Response.redirect(redirectTo, 302);
}

async function tooManyAttempts(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const window = Math.floor(Date.now() / 60_000);
  const key = `attempt:${ip}:${window}`;
  const current = Number((await env.OAUTH_KV.get(key)) ?? 0);
  if (current >= ATTEMPTS_PER_MINUTE) return true;
  await env.OAUTH_KV.put(key, String(current + 1), { expirationTtl: 120 });
  return false;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function homePage(url: URL): Response {
  return new Response(
    `yampi-mcp\n\nMCP server for Yampi stores.\nAdd ${url.origin}/mcp as a connector in your Claude client.\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

function formHtml(
  params: string,
  clientName: string,
  error: string | null,
  status = 200,
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Yampi store</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:6vh auto;padding:0 1.25rem}
 h1{font-size:1.3rem;margin:0 0 .25rem}
 p{color:#666;margin:.25rem 0 1.5rem}
 label{display:block;margin:1rem 0 .3rem;font-weight:600;font-size:.9rem}
 input{width:100%;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem;background:transparent;color:inherit}
 button{margin-top:1.5rem;width:100%;padding:.7rem;font:inherit;font-weight:600;border:0;border-radius:.4rem;background:#2d6cdf;color:#fff;cursor:pointer}
 .error{background:#d3202033;border-left:3px solid #d32020;padding:.7rem;border-radius:.3rem;margin-bottom:1rem}
 .help{margin-top:2rem;font-size:.85rem;color:#888}
 code{background:#8881;padding:.1rem .3rem;border-radius:.2rem}
</style></head><body>
<h1>Connect Yampi store</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to access your Yampi stores.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="POST" action="/authorize">
 <input type="hidden" name="oauth_req" value="${escapeHtml(params)}">
 <label for="ut">User-Token</label>
 <input id="ut" name="user_token" required autocomplete="off" spellcheck="false">
 <label for="sk">User-Secret-Key</label>
 <input id="sk" name="secret_key" type="password" required autocomplete="off">
 <button type="submit">Authorize</button>
</form>
<p class="help">In the Yampi dashboard: <code>Perfil › Credenciais de API</code>.
Your credentials are encrypted on this Instance and are never sent to Claude.
Every store attached to that credential becomes available.</p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
