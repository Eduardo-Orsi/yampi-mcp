## What and why

<!-- What changes, and what problem it solves. The diff already says what; explain why. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behaviour has a test
- [ ] This does not add a way to cancel an order, refund a purchase, or switch payment
      gateway — including indirectly. See [ADR 0002](../docs/adr/0002-forbidden-action-absent-from-code.md).
- [ ] No credentials, KV namespace ids, or store aliases in the diff

## Tested against the live API?

<!-- Optional but valuable. If you ran `npm run test:integration` against your own store, say
     so. If you found undocumented Yampi behaviour, add it to the README's "Yampi API quirks". -->
