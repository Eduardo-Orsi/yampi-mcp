import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pageFields, resolveStore, result, storeField, toolError, type Context } from "./common";

const TRANSACTION_STATUSES = [
  "waiting_payment",
  "authorized",
  "paid",
  "refused",
  "cancelled",
  "handling_products",
] as const;

/**
 * Yampi ignores `status=`, `status[]=`, `customer_id=` and `filters[...]` on
 * transactions and silently returns the whole dataset. Only the `search=field:value`
 * syntax filters, and several fields need `searchJoin=and` or they are OR-ed.
 */
export function transactionSearch(filters: {
  status?: string;
  payment_id?: number;
  customer_id?: number;
}): { search?: string; searchJoin?: string } {
  const terms = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => `${field}:${value}`);
  if (terms.length === 0) return {};
  return { search: terms.join(";"), searchJoin: terms.length > 1 ? "and" : undefined };
}

/**
 * Yampi silently ignores a `date` without both ends and returns the whole dataset,
 * so a single day has to be sent as a range of one.
 */
export function transactionDateFilter(from?: string, to?: string): string | undefined {
  return from ? `created_at:${from}|${to ?? from}` : undefined;
}

/**
 * What a payment diagnosis needs, as an allowlist. A transaction also carries the
 * cardholder's tax ID, the Pix code and boleto links; none of that explains a
 * failure, and an allowlist keeps fields Yampi adds later out of the conversation.
 */
export function transactionView(t: any) {
  const when = (timestamp: any) => timestamp?.date ?? timestamp ?? null;
  return {
    id: t.id,
    status: t.status,
    error_code: t.error_code,
    error_message: t.error_message,
    amount: t.amount,
    buyer_amount: t.buyer_amount,
    installments: t.installments,
    payment_id: t.payment_id,
    payment: t.payment?.data?.name ?? null,
    customer_id: t.customer_id,
    authorized: t.authorized,
    captured: t.captured,
    cancelled: t.cancelled,
    antifraud_status: t.antifraud_status,
    antifraud_score: t.antifraud_score,
    gateway_transaction_id: t.gateway_transaction_id,
    total_logs: t.total_logs,
    created_at: when(t.created_at),
    authorized_at: when(t.authorized_at),
    captured_at: when(t.captured_at),
    cancelled_at: when(t.cancelled_at),
  };
}

export type CashbackPeriod = "today" | "yesterday" | "month" | "last_month" | "year" | "custom";

/** The period of the cashback report. Returns a string when the combination is invalid. */
export function cashbackPeriodQuery(
  period: CashbackPeriod,
  starts_at?: string,
  ends_at?: string,
): Record<string, string> | string {
  if (period === "custom") {
    if (!starts_at || !ends_at) return "The `custom` period needs both `starts_at` and `ends_at`.";
    // Yampi requires Y-m-d H:i:s.
    return {
      filter: period,
      start_at: `${starts_at} 00:00:00`,
      end_at: `${ends_at} 23:59:59`,
    };
  }
  if (starts_at || ends_at) return "`starts_at` and `ends_at` only apply to the `custom` period.";
  return { filter: period };
}

/** Read tools: they only query the Store. Always available. */
export function registerReadTools(server: McpServer, ctx: Context) {
  const store = storeField(ctx.stores);
  const at = (s?: string) => resolveStore(ctx.stores, s);

  server.registerTool(
    "describe_store",
    {
      title: "Describe store",
      description:
        "Map of the store: stores available on this credential, order statuses (with alias), categories and brands. " +
        "Call this before filtering by status or category instead of guessing identifiers.",
      inputSchema: z.object({ store }),
    },
    async ({ store: s }) => {
      const alias = at(s);
      const [statuses, categories, brands] = await Promise.all([
        ctx.client.request<any>(alias, "/checkout/statuses", { query: { limit: 50 } }),
        ctx.client.request<any>(alias, "/catalog/categories", { query: { limit: 50 } }),
        ctx.client.request<any>(alias, "/catalog/brands", { query: { limit: 50 } }),
      ]);
      return result(ctx, `/${alias}/checkout/statuses`, {
        stores_on_this_credential: ctx.stores,
        store_queried: alias,
        order_statuses: (statuses.data ?? []).map((st: any) => ({
          alias: st.alias,
          name: st.name,
          id: st.id,
        })),
        categories: (categories.data ?? []).map((c: any) => ({ id: c.id, name: c.name })),
        brands: (brands.data ?? []).map((b: any) => ({ id: b.id, name: b.name })),
      });
    },
  );

  server.registerTool(
    "search_orders",
    {
      title: "Search orders",
      description:
        "Lists orders filtered by status, date range and free text. Already brings items, customer, transactions " +
        "and status in the same call. Route limit: 120 requests per minute.",
      inputSchema: z.object({
        store,
        status_alias: z
          .array(z.string())
          .optional()
          .describe('Status aliases, e.g. ["paid", "invoiced"]. See describe_store.'),
        created_from: z.string().optional().describe("Start date, YYYY-MM-DD."),
        created_to: z
          .string()
          .optional()
          .describe("End date, YYYY-MM-DD. Without it, only the created_from day is matched."),
        search: z.string().optional().describe("Free text: name, e-mail or order number."),
        ...pageFields,
      }),
    },
    async ({ store: s, status_alias, created_from, created_to, search, limit, page }) => {
      const alias = at(s);

      // Yampi filters by status_id, but IDs are store data. The alias is the
      // stable key, so we translate here instead of exposing numbers to the model.
      let status_id: number[] | undefined;
      if (status_alias?.length) {
        const statuses = await ctx.client.request<any>(alias, "/checkout/statuses", {
          query: { limit: 50 },
        });
        const byAlias = new Map<string, number>(
          (statuses.data ?? []).map((st: any) => [st.alias, st.id]),
        );
        const unknown = status_alias.filter((a) => !byAlias.has(a));
        if (unknown.length) {
          return toolError(
            `Unknown status: ${unknown.join(", ")}. Valid: ${[...byAlias.keys()].join(", ")}.`,
          );
        }
        status_id = status_alias.map((a) => byAlias.get(a)!);
      }

      const data = await ctx.client.request<any>(alias, "/orders", {
        include: ["items", "customer", "transactions", "status"],
        query: {
          limit,
          page,
          q: search,
          status_id,
          date: created_from
            ? `created_at:${created_from}${created_to ? `|${created_to}` : ""}`
            : undefined,
        },
      });
      return result(ctx, `/${alias}/orders`, data);
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "One full order, with items, customer, payments, address and status history.",
      inputSchema: z.object({ store, order_id: z.union([z.number(), z.string()]) }),
    },
    async ({ store: s, order_id }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, `/orders/${order_id}`, {
        include: ["items", "customer", "transactions", "status", "shipping_address", "comments"],
      });
      return result(ctx, `/${alias}/orders`, data);
    },
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Lists catalog products with SKUs, prices and images. " +
        "Route limit: 30 requests per minute — prefer filtering over paginating.",
      inputSchema: z.object({
        store,
        search: z.string().optional().describe("Text in the name or SKU."),
        active: z.boolean().optional(),
        ...pageFields,
      }),
    },
    async ({ store: s, search, active, limit, page }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/catalog/products", {
        include: ["skus", "images", "brand"],
        // `active=0` is ignored by Yampi; `active[]=0` filters. Hence the array.
        query: { limit, page, q: search, active: active === undefined ? undefined : [active ? 1 : 0] },
      });
      return result(ctx, `/${alias}/catalog/products`, data);
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "One full product: SKUs, prices, stock, variations, images, brand and categories.",
      inputSchema: z.object({ store, product_id: z.union([z.number(), z.string()]) }),
    },
    async ({ store: s, product_id }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, `/catalog/products/${product_id}`, {
        include: ["skus", "skus.variations", "images", "brand", "categories"],
      });
      return result(ctx, `/${alias}/catalog/products`, data);
    },
  );

  server.registerTool(
    "search_customers",
    {
      title: "Search customers",
      description: "Lists customers with addresses. Route limit: 60 requests per minute.",
      inputSchema: z.object({
        store,
        search: z.string().optional().describe("Name, e-mail, tax ID or phone."),
        ...pageFields,
      }),
    },
    async ({ store: s, search, limit, page }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/customers", {
        include: ["addresses"],
        query: { limit, page, q: search },
      });
      return result(ctx, `/${alias}/customers`, data);
    },
  );

  server.registerTool(
    "customer_history",
    {
      title: "Customer history",
      description:
        "One customer and their orders, in a single response. Use it to check repeat purchases or handle support.",
      inputSchema: z.object({ store, customer_id: z.union([z.number(), z.string()]) }),
    },
    async ({ store: s, customer_id }) => {
      const alias = at(s);
      const [customer, orders] = await Promise.all([
        ctx.client.request<any>(alias, `/customers/${customer_id}`, { include: ["addresses"] }),
        ctx.client.request<any>(alias, "/orders", {
          include: ["items", "status"],
          query: { customer_id: String(customer_id), limit: 30 },
        }),
      ]);
      return result(ctx, `/${alias}/customers`, { customer: customer.data, orders: orders.data });
    },
  );

  server.registerTool(
    "abandoned_carts",
    {
      title: "Abandoned carts",
      description: "Carts that never became an order, with items and customer. The basis for recovery.",
      inputSchema: z.object({ store, ...pageFields }),
    },
    async ({ store: s, limit, page }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/checkout/carts", {
        include: ["items", "customer"],
        query: { limit, page },
      });
      return result(ctx, `/${alias}/checkout/carts`, data);
    },
  );

  server.registerTool(
    "search_coupons",
    {
      title: "Search coupons",
      description:
        "Lists discount coupons and their usage, validity and restrictions. Filter by code/text or status.",
      inputSchema: z.object({
        store,
        search: z.string().optional().describe("Coupon code or text to search for."),
        active: z.boolean().optional().describe("Only active or inactive coupons."),
        expired: z.boolean().optional().describe("Only expired or unexpired coupons."),
        ...pageFields,
      }),
    },
    async ({ store: s, search, active, expired, limit, page }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/pricing/promocodes", {
        include: ["customer", "categories", "collections", "brand", "products", "payments"],
        query: {
          limit,
          page,
          q: search,
          active: active === undefined ? undefined : [active ? 1 : 0],
          expired: expired === undefined ? undefined : [expired ? 1 : 0],
        },
      });
      return result(ctx, `/${alias}/pricing/promocodes`, data);
    },
  );

  server.registerTool(
    "get_coupon",
    {
      title: "Get coupon",
      description:
        "Gets one discount coupon by ID, including customer, product, category, collection, brand and payment restrictions.",
      inputSchema: z.object({ store, coupon_id: z.union([z.number(), z.string()]) }),
    },
    async ({ store: s, coupon_id }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, `/pricing/promocodes/${coupon_id}`, {
        include: ["customer", "categories", "collections", "brand", "products", "payments"],
      });
      return result(ctx, `/${alias}/pricing/promocodes`, data);
    },
  );

  server.registerTool(
    "search_kits",
    {
      title: "Search kits",
      description: "Lists product kits (bundles) with their items, pricing rules and shipping settings.",
      inputSchema: z.object({
        store,
        search: z.string().optional().describe("Text in the kit name."),
        ...pageFields,
      }),
    },
    async ({ store: s, search, limit, page }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/catalog/bundles", {
        query: { limit, page, q: search },
      });
      return result(ctx, `/${alias}/catalog/bundles`, data);
    },
  );

  server.registerTool(
    "get_kit",
    {
      title: "Get kit",
      description: "One product kit (bundle) with its items, pricing rules, shipping settings and purchase link.",
      inputSchema: z.object({ store, kit_id: z.union([z.number(), z.string()]) }),
    },
    async ({ store: s, kit_id }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, `/catalog/bundles/${kit_id}`);
      return result(ctx, `/${alias}/catalog/bundles`, data);
    },
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Payment attempts across all orders, newest first, with status, gateway error and antifraud result. " +
        'Use it for questions like "why are card payments failing today?". Read-only: it cannot change a payment.',
      inputSchema: z.object({
        store,
        status: z.enum(TRANSACTION_STATUSES).optional(),
        payment_id: z.number().int().optional().describe("Payment method ID, as returned on a transaction."),
        customer_id: z.number().int().optional(),
        created_from: z.string().optional().describe("Start date, YYYY-MM-DD."),
        created_to: z
          .string()
          .optional()
          .describe("End date, YYYY-MM-DD. Without it, only the created_from day is matched."),
        ...pageFields,
      }),
    },
    async ({ store: s, status, payment_id, customer_id, created_from, created_to, limit, page }) => {
      const alias = at(s);
      if (created_to && !created_from) return toolError("`created_to` also needs `created_from`.");

      const data = await ctx.client.request<any>(alias, "/checkout/transactions", {
        include: ["payment"],
        query: {
          limit,
          page,
          ...transactionSearch({ status, payment_id, customer_id }),
          date: transactionDateFilter(created_from, created_to),
        },
      });
      return result(ctx, `/${alias}/checkout/transactions`, {
        data: (data.data ?? []).map(transactionView),
        meta: data.meta,
      });
    },
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description:
        "One payment attempt with its status, gateway error and antifraud result, plus its logs. " +
        "Yampi only logs capture and cancellation attempts, so the reason for a refusal is in `error_message`.",
      inputSchema: z.object({ store, transaction_id: z.union([z.number(), z.string()]) }),
    },
    async ({ store: s, transaction_id }) => {
      const alias = at(s);
      const [transaction, logs] = await Promise.all([
        ctx.client.request<any>(alias, `/checkout/transactions/${transaction_id}`, {
          include: ["payment"],
        }),
        ctx.client.request<any>(alias, `/checkout/transactions/${transaction_id}/logs`, {
          query: { limit: 50 },
        }),
      ]);
      return result(ctx, `/${alias}/checkout/transactions`, {
        transaction: transactionView(transaction.data),
        logs: logs.data ?? [],
      });
    },
  );

  server.registerTool(
    "customer_cashback",
    {
      title: "Customer cashback",
      description:
        "One customer's cashback balance and statement, oldest entry first. " +
        "Use search_customers first to find the `customer_id`.",
      inputSchema: z.object({ store, customer_id: z.number().int(), ...pageFields }),
    },
    async ({ store: s, customer_id, limit, page }) => {
      const alias = at(s);
      const [balance, statement] = await Promise.all([
        ctx.client.request<any>(alias, "/pricing/wallet/balance", { query: { customer_id } }),
        ctx.client.request<any>(alias, `/pricing/wallet/statement/${customer_id}`, {
          query: { limit, page },
        }),
      ]);
      return result(ctx, `/${alias}/pricing/wallet`, {
        customer_id,
        balance: balance.data?.balance ?? null,
        // Each entry repeats the customer's name, e-mail and phone; the caller already has the ID.
        statement: (statement.data ?? []).map(({ customer: _customer, ...entry }: any) => entry),
        meta: statement.meta,
      });
    },
  );

  server.registerTool(
    "cashback_report",
    {
      title: "Cashback report",
      description:
        "Cashback results for a period: cashback generated and used, orders with cashback and their value, " +
        "share of orders with cashback, and average time until it is used.",
      inputSchema: z.object({
        store,
        period: z.enum(["today", "yesterday", "month", "last_month", "year", "custom"]).default("month"),
        starts_at: z.string().optional().describe("Start date, YYYY-MM-DD. Only for the `custom` period."),
        ends_at: z.string().optional().describe("End date, YYYY-MM-DD. Only for the `custom` period."),
        daily: z.boolean().default(false).describe("Include the day-by-day breakdown."),
      }),
    },
    async ({ store: s, period, starts_at, ends_at, daily }) => {
      const alias = at(s);
      const query = cashbackPeriodQuery(period, starts_at, ends_at);
      if (typeof query === "string") return toolError(query);

      const widget = (name: string) =>
        ctx.client.request<any>(alias, `/metrics/cashback/${name}`, { query });
      const [orders, generated, share, timeToUse] = await Promise.all([
        widget("orders-with-cashback"),
        widget("cashback-generated"),
        widget("order-percentage"),
        widget("average-time-use"),
      ]);
      const totals = ({ data, start_at: _start, end_at: _end, ...sums }: any) =>
        daily ? { ...sums, daily: data } : sums;

      return result(ctx, `/${alias}/metrics/cashback`, {
        period: { starts_at: generated.start_at, ends_at: generated.end_at },
        cashback: generated.data,
        orders_with_cashback: totals(orders),
        share_of_orders: totals(share),
        average_time_to_use: timeToUse.data,
      });
    },
  );
}
