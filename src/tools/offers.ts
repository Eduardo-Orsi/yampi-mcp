import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pageFields, resolveStore, result, storeField, toolError, type Context } from "./common";

/**
 * The four offer types live under /pricing and have quite different fields from
 * one another, but the lifecycle is identical. One tool with a `type` keeps the
 * surface small; if the per-type `body` turns into an unreadable tangle, split it
 * into four.
 */
const ROUTES = {
  cashback: "/pricing/cashbacks",
  order_bump: "/pricing/order-bumps",
  upsell: "/pricing/upsells",
  freebie: "/pricing/freebies",
} as const;

export function registerOfferTools(server: McpServer, ctx: Context) {
  const store = storeField(ctx.stores);

  server.registerTool(
    "manage_offers",
    {
      title: "Manage offers",
      description:
        "Lists, creates or updates the store's offers: cashback, order bump, upsell and freebie. " +
        "Always start with `list` to see the shape of the fields before creating.",
      inputSchema: z.object({
        store,
        type: z.enum(["cashback", "order_bump", "upsell", "freebie"]),
        action: z.enum(["list", "create", "update"]).default("list"),
        offer_id: z.union([z.number(), z.string()]).optional().describe("Required when updating."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Offer body, in the fields the Yampi API expects for the chosen type. " +
              "Use `list` first to discover the shape.",
          ),
        ...pageFields,
      }),
    },
    async ({ store: s, type, action, offer_id, data, limit, page }) => {
      const alias = resolveStore(ctx.stores, s);
      const route = ROUTES[type];

      if (action === "list") {
        const list = await ctx.client.request<any>(alias, route, { query: { limit, page } });
        return result(ctx, `/${alias}${route}`, list);
      }

      if (!data || Object.keys(data).length === 0) {
        return toolError("Provide `data` with the offer body. Run `list` first to see the expected fields.");
      }

      if (action === "create") {
        const created = await ctx.client.request<any>(alias, route, { method: "POST", body: data });
        return result(ctx, `/${alias}${route}`, created);
      }

      if (offer_id === undefined) return toolError("Provide `offer_id` to update.");
      const updated = await ctx.client.request<any>(alias, `${route}/${offer_id}`, {
        method: "PUT",
        body: data,
      });
      return result(ctx, `/${alias}${route}`, updated);
    },
  );
}
