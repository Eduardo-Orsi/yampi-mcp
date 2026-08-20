# The Store Credential is the login, with no separate password

The `/authorize` screen asks for the `User-Token` and the `User-Secret-Key` from the Yampi
dashboard and validates both by calling `POST /v2/auth/me`. There is no password, no IdP and
no Cloudflare Access in front: whoever can present a valid Store Credential **is** the
Merchant, so demanding a second secret would only create one more thing to store, rotate and
leak.

## Considered Options

- **Authless URL with a secret in the path.** Supported by Claude and the simplest of all,
  but it turns the link into a bearer of full access: leak the URL, leak the store. Rejected
  because the project is public and the link travels through screenshots and config files.
- **Cloudflare Access in front of `/mcp`.** Does not work: the thing fetching the connector
  URL is Anthropic's server, with no browser, so there is no session for Access to
  authenticate. It would answer 403. (It would work on `/authorize`, which is opened in a
  browser — but then it would be a third secret solving a problem the Store Credential
  already solves.)
- **Yampi's own OAuth 2.0.** That is the ideal, one-click experience, but Yampi restricts
  OAuth to apps published in their App Store, which requires prior approval and turns into a
  partnership. Out of scope for this project.

## Consequences

`/authorize` is public and validates credentials, which makes it an oracle for testing stolen
keys. Hence the limit of 5 attempts per IP per minute in `authorize.ts`.

In exchange, the deploy needs no secret configuration at all: ship the Worker and connect.
And the Credential never reaches Claude — it travels encrypted in the Grant props, with the
encryption key wrapped by a key derived from the token. Since the KV only stores the token's
hash, a KV leak alone does not open the credentials.
