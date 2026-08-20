# Cancelling, refunding and switching gateway do not exist in the code

This server exposes no tool to cancel an order, refund a purchase or switch the payment
gateway — and not as a feature turned off by a flag, but as code that was never written.
Those are the three irreversible operations in the Yampi API, and the only defence that does
not depend on correct configuration or on human attention is absence.

## Considered Options

- **Behind `YAMPI_ALLOW_DESTRUCTIVE=true`.** More flexible, and someone turns it on "just to
  test" on a production store. What weighed against it was a fact established during design:
  Claude Desktop and claude.ai **do not support `elicitation`**, so the server has no way to
  ask for confirmation. The only obstacle would be the client's tool-approval dialog, which
  the user clicks through on autopilot after the third time.

## Consequences

Cancelling an order on Yampi is a status change, so the absence of the tool would not be
enough: cancellation would come in through the back door of `advance_order_status`. That is
why the decision is enforced in two places, both covered by tests:

1. `refuseIfForbidden()` in `tools/write.ts`, by alias (`cancelled`, `refused`) and never by
   ID — status IDs are store data, not universal constants.
2. `FORBIDDEN_ROUTES` in `yampi.ts`, at the seam every request passes through, so that a
   future bug cannot reach those routes by another path. It applies only to state-changing
   methods: reading the gateway configuration is legitimate, switching it is not.

Anyone who disagrees is one command away from a fork. A guarantee that can be switched off by
an environment variable is not a guarantee.
