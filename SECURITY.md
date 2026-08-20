# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/Eduardo-Orsi/yampi-mcp/security/advisories/new).

It creates a private thread visible only to you and the maintainer. Include what you found,
how to reproduce it, and what an attacker gets out of it. I will confirm receipt and tell you
whether it is in scope; if it is, you get credit in the advisory unless you would rather not.

Please do not test against anyone else's store.

## What this project is, for threat-modelling purposes

Every merchant deploys their own copy. There is no hosted service and no shared database, so
there is no central place holding anyone's credentials. A vulnerability here affects each
self-hosted instance separately.

Each instance stores one thing worth attacking: the merchant's Yampi Store Credential, which
grants unrestricted access to every store on their Yampi account.

How it is handled:

- Encrypted (AES-GCM) inside the OAuth grant props, in the merchant's own Cloudflare KV.
- The key encrypting it is wrapped by a key derived from the access token, and KV stores only
  the token's *hash*. **A KV leak alone does not decrypt the credential.**
- It is never sent to Claude. Claude only ever receives an opaque token.
- `/authorize` is public and validates credentials, which makes it an oracle for testing
  stolen keys. That is why it is rate-limited to 5 attempts per IP per minute. Findings that
  weaken or bypass that limit are in scope.

## In scope

- Anything that exposes a Store Credential, in transit, at rest or in logs.
- Anything that lets a request reach a store the presented credential does not own.
- Anything that reaches the forbidden routes — cancelling an order, refunding, switching
  payment gateway — through a path the seam in `src/yampi.ts` does not cover.
- Flaws in the OAuth flow: PKCE, DCR, the authorization code exchange, grant isolation.
- Bypasses of the `/authorize` rate limit.

## Out of scope

- Vulnerabilities in the Yampi API itself — report those to Yampi.
- Vulnerabilities in Cloudflare Workers or KV — report those to Cloudflare.
- The fact that a valid Store Credential grants full access. That is how Yampi's API works;
  this server does not add permissions and cannot subtract them.
- Anything requiring the attacker to already have the merchant's Cloudflare account.

## If you leaked your own credential

Rotate it immediately in the Yampi dashboard under `Perfil › Credenciais de API`, then
reconnect the connector. Deleting the KV namespace cuts every existing grant at once.

## Supported versions

`main` only. This is a small project; fixes go to `main` and merchants redeploy.
