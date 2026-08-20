# yampi-mcp

An MCP server that lets you talk to your [Yampi](https://www.yampi.com.br) store from Claude —
look up orders, create products, adjust stock, build coupons and offers.

Every merchant hosts their own copy on Cloudflare. **This is not a service: nobody holds your
credentials but you.** Unofficial, and not affiliated with Yampi.

## How it works

A Yampi credential belongs to the **user**, not the store: if you run four stores under one
login, all four show up. You connect once and pick the store on each command.

## Setup

You need a Cloudflare account (the free plan is enough) and Node installed.

```bash
git clone https://github.com/Eduardo-Orsi/yampi-mcp && cd yampi-mcp
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # paste the returned id into wrangler.jsonc
npx wrangler deploy
```

In your Claude client (claude.ai, Desktop or Code), add a custom connector pointing at
`https://yampi-mcp.<your-subdomain>.workers.dev/mcp`.

On connect, a screen asks for your **User-Token** and **User-Secret-Key**. You'll find them in
the Yampi dashboard under `Perfil › Credenciais de API` (Profile › API Credentials). That's it — there's no password to create.

## Using it

Once connected, it's plain conversation:

> *"How many paid orders did store X get between June 1st and 15th?"*
> *"Create a product called Black T-Shirt, brand Acme, SKU TS-BLACK-M, R$ 79.90, 20 in stock."*
> *"SKU TS-BLACK-M is priced wrong — change it to R$ 89.90 and drop stock to 5."*
> *"Which carts were abandoned this week and what do they add up to?"*
> *"Create a 15% coupon valid through month end, R$ 100 minimum, 50 uses."*

With more than one store on the account, say which one — the tools require it explicitly so
nothing gets written to the wrong store.

## What it does

| Tool | What it does |
|---|---|
| `describe_store` | Stores, order statuses, categories and brands — the map, so the model stops guessing ids |
| `search_orders` | Orders filtered by status, period and free text |
| `get_order` | One order with items, customer, payments, address and history |
| `search_products` | Catalog with SKUs, prices and images |
| `get_product` | One product with variations, stock, brand and categories |
| `search_customers` | Customers and addresses |
| `customer_history` | A customer and all their orders |
| `abandoned_carts` | Carts that never became orders |
| `create_product` | Creates a product with its SKUs |
| `update_product` | Edits product fields |
| `manage_sku` | Creates a SKU, or updates price and stock |
| `create_coupon` | Discount coupon |
| `advance_order_status` ⚠️ | Moves an order to another status |
| `add_order_comment` ⚠️ | Internal note on an order |
| `manage_offers` | Cashback, order bump, upsell and free gift |

⚠️ **Not validated against the live API.** The other thirteen were run end to end against a
real store — creating a product, changing a price, writing stock, issuing a coupon — and their
field names came out of that process corrected. These two need an existing order, and the test
store had none. The endpoints are right; the request body comes from the documentation, which
turned out to be missing at least one required field in every one of the other five writes.
Expect a 422 on first call — the message will name the missing field.

## What it deliberately does not do

**It does not cancel orders, refund purchases, or switch payment gateways.** Not a feature
behind an environment variable: the code does not exist. These are the irreversible operations
in the API, and neither Claude Desktop nor claude.ai supports `elicitation` — meaning the server
has no way to genuinely ask for confirmation. Absence is the only guarantee that doesn't depend
on someone paying attention.

The ban is enforced in two places, both covered by tests: on the status alias
([`tools/write.ts`](src/tools/write.ts)) and at the seam every request passes through
([`yampi.ts`](src/yampi.ts)). Rationale in [`docs/adr/0002`](docs/adr/0002-forbidden-action-absent-from-code.md).

Order tracking is also out: Yampi caps that route at 3 requests per hour, which makes the tool
useless in practice — two calls and the agent is stuck for 20 minutes.

## Your credentials

- Stored **encrypted** (AES-GCM) in the OAuth grant props, inside **your** KV.
- The key encrypting them is wrapped by a key derived from the access token, and KV only holds
  the token's *hash*. **A KV leak alone does not open the credentials.**
- Claude never receives them: it only ever sees an opaque token.
- Revoking means deleting the grant — other connections keep working.

`/authorize` is public and validates credentials, which technically makes it an oracle for
testing stolen keys. Hence the limit of 5 attempts per IP per minute.

To restrict the instance to specific stores:

```bash
npx wrangler secret put ALLOWED_STORES   # e.g. my-store,other-store
```

## API limits

Yampi limits per route per minute: 30 req/min on products and SKUs, 120 on order reads, 30 on
writes, 60 in general. The server uses `include=` to pull relationships in a single call instead
of N+1, reads `X-RateLimit-Remaining` off every response, and warns the model when the quota is
running out — rather than letting it find out through a 429.

## When something goes wrong

**403 on everything, reads included.** The store is `active: false` in the Yampi dashboard.
Inactive stores reject every route. Reactivate it, then reconnect the connector.

**422 on a write.** The message names the exact field Yampi rejected — the server forwards the
whole `errors` object. Claude usually corrects itself on the next attempt.

**"Grant without credential".** The grant lost its props. Remove the connector and add it again.

**Switching credentials.** Just reconnect: a new grant replaces the old one. To cut access
without reconnecting, delete the KV namespace.

**A store is missing from the list.** Either it's inactive, or the credential doesn't reach it.
Run `describe_store` to see what the server can see.

## Yampi API quirks

Found by testing against the live API. All of them can burn hours, and none are clear from the
documentation:

- **Filters need array syntax.** `?status_id=4` is **silently ignored** and returns the entire
  dataset; `?status_id[]=4` filters. Same for `active[]`. A filter that doesn't filter is worse
  than no filter: the agent summarizes 55,000 orders believing it saw July's.
- **Dates use a bespoke format**: `?date=created_at:2026-06-01|2026-06-30`. Anything else
  returns 500 or is ignored.
- **`filters[...]` does not filter.** It only switches the response to `scroll_id` pagination.
- **`/auth/me` is POST**, not GET, and returns every store on the credential — because the
  credential belongs to the user, not the store.
- **Order `include` has a closed enum**: `items`, `customer`, `marketplace`, `status`,
  `statuses`, `shipping_address`, `promocode`, `transactions`, `comments`, `files`, `discounts`,
  `seller`, `labels`. There is no `payments`.
- **GET responses are cached for 30 minutes** on Yampi's side. In an agent context that lies:
  create a product, ask to read it back, and you get the previous state. This server sends
  `?skipCache=true` on every read.
- **Stock is not a SKU field.** `quantity` on a SKU is always null — including on the real SKUs
  of a live store. Stock lives in `/logistics/stocks` (the stock location) joined to the SKU at
  `/catalog/skus/{id}/stocks`. And `stock_id` is **not** the id from `/logistics/warehouses`,
  which is a different resource entirely.
- **Coupon `discount_type` accepts only `p` or `v`**, not `percentage`/`fixed`.
- **Coupon dates require `Y-m-d H:i:s`.** Date alone returns 422.
- **`PUT /catalog/skus/{id}` requires `product_id` and `price_cost`** even for a partial update.
- **Creating a product requires `simple`, `brand_id` and `skus.*.blocked_sale`**, none of them obvious.
- **A store with `active: false` returns 403 on everything**, reads included. This server filters
  those stores out at connect time, so the model is never offered an option that can only fail.
- **422 responses carry an `errors` object** naming the exact field that failed. Worth forwarding
  to the model instead of showing only the status code — it's what lets it correct itself.

## Development

```bash
npm test              # 32 unit tests, no network
npm run typecheck
npm run dev           # wrangler dev
```

### Testing against your own store

The unit suite uses a fake `fetch` and proves the server's logic. It cannot notice Yampi
changing an endpoint, a field name or a filter syntax — and that happened repeatedly while this
project was built. That other half is covered by an integration suite that hits the live API,
**read-only**, creating and changing nothing:

```bash
cp .env.example .env    # fill in the alias and credentials of YOUR store
npm run test:integration
```

It checks that store discovery works, that status aliases exist, that filtering by status
actually filters, that the date format is accepted, that `include` expands relationships, and
that quota headers arrive. If one fails, the API changed and the server will start lying before
it starts breaking.

The architecture has one rule: **no tool speaks HTTP**. Everything goes through
[`src/yampi.ts`](src/yampi.ts). That's what makes the "does not reach the banned routes" promise
auditable — the entire surface fits in one file.

Project vocabulary in [`CONTEXT.md`](CONTEXT.md). Decisions in [`docs/adr/`](docs/adr/).

## Known limitations

- No order tracking (Yampi's 3 req/h cap makes it unusable).
- No banners, free shipping rules, progressive discounts or combos.
- `advance_order_status` and `add_order_comment` were never run against the live API.
- Stock is written to the store's first registered stock location. Anyone using multiple
  locations needs to adjust `defaultStockId()` in `src/tools/write.ts`.

## License

MIT — see [LICENSE](LICENSE).
