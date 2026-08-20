import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pageFields, resolveStore, result, storeField, toolError, type Context } from "./common";

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
}
