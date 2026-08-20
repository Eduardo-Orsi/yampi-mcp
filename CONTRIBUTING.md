# Contributing

Contributions are welcome. Fork the repo, open a pull request against `main`, and CI will
run typecheck and the unit tests on it.

## Before you start on something big

For a bug fix or a small improvement, just send the PR. For anything larger — a new tool, a
new dependency, a change to how authorization works — **open an issue first**. It costs you
nothing and it avoids the case where you write two hundred lines and I say the design does
not fit.

## What will not be merged, no matter how good the patch

**Cancelling orders, refunding purchases, and switching payment gateways.** These are absent
from the code on purpose, not switched off by a flag. They are the irreversible operations in
the Yampi API, and neither Claude Desktop nor claude.ai supports `elicitation`, so the server
cannot genuinely ask a human to confirm. The reasoning is in
[ADR 0002](docs/adr/0002-forbidden-action-absent-from-code.md).

This includes indirect routes: a `status_alias` that resolves to `cancelled`, a generic
"call any endpoint" tool, an escape hatch behind an environment variable. A guarantee that
can be switched off is not a guarantee.

If you need those operations, fork the project — that is what forks are for, and no hard
feelings.

## Rules the codebase holds to

- **No tool speaks HTTP.** Everything goes through [`src/yampi.ts`](src/yampi.ts). That single
  seam is what makes the "cannot reach the forbidden routes" promise auditable.
- **Guards are pure functions.** A check buried inside a tool handler is a check nobody can
  test. See `refuseIfForbidden()` in [`src/tools/write.ts`](src/tools/write.ts).
- **Status is matched by alias, never by ID.** Status IDs are per-store data, not constants.
- **Everything is in English** — identifiers, comments, tool names, docs. The only exceptions
  are literal Yampi dashboard labels (`Perfil › Credenciais de API`), because that is the text
  a merchant has to find on screen.
- **New behaviour comes with a test.** The vocabulary the project uses is in
  [`CONTEXT.md`](CONTEXT.md); decisions are in [`docs/adr/`](docs/adr/).

## Setup

```bash
npm install
npm run typecheck
npm test              # unit tests, no network
```

To run the server locally you also need a Cloudflare account:

```bash
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
npm run dev
```

## Testing against a real store

The unit suite uses a fake `fetch`. It proves the server's logic but cannot notice Yampi
changing an endpoint, a field name or a filter syntax — which happened repeatedly while this
project was built. The integration suite covers that half, **read-only**, against a store of
your own:

```bash
cp .env.example .env    # your own store alias and credentials
npm run test:integration
```

It creates, changes and deletes nothing. It is skipped when `.env` is absent, and **it never
runs in CI** — PRs from forks get no secrets, by design.

Two of its assertions only mean something if the store has data: the status-filter test
passes vacuously against a store with no paid orders. If you are touching filtering, run it
against a store that actually has orders.

## Never commit

`.gitignore` already covers these, but they are worth naming because leaking any of them is
the failure that matters here:

- `.env` — your Yampi Store Credential
- `wrangler.jsonc` — contains your KV namespace id
- `.dev.vars`

A Yampi Store Credential grants unrestricted access to every store on the account. If you
ever paste one into an issue, a PR or a log, rotate it immediately under
`Perfil › Credenciais de API` in the Yampi dashboard.

## Pull request expectations

- `npm run typecheck` and `npm test` pass.
- Commits explain *why*, not *what* — the diff already says what.
- If you found undocumented Yampi API behaviour, add it to the "Yampi API quirks" section of
  the README. That section is the most useful part of this project for other people, and it
  only grows by someone getting burned.

## License

By contributing you agree that your work is licensed under the [MIT License](LICENSE).
