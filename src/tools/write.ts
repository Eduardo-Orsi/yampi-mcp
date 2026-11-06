import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveStore, result, storeField, toolError, type Context } from "./common";

/**
 * The Forbidden Action in status form: cancelling an order on Yampi is a status
 * change, so the absence of a tool would not be enough — cancellation would come
 * in through the back door of `advance_order_status`.
 *
 * The guard is by alias, never by ID: status IDs are store data and vary between
 * accounts.
 */
const FORBIDDEN_STATUSES = new Set(["cancelled", "refused"]);

/**
 * The single gate for cancellation. A pure function on purpose: that is what a
 * test can exercise. A guard locked inside a tool handler is a guard nobody
 * checks.
 */
export function refuseIfForbidden(statusAlias: string): string | null {
  if (!FORBIDDEN_STATUSES.has(statusAlias.trim().toLowerCase())) return null;
  return (
    `This server does not move orders to "${statusAlias}". Cancelling and refusing are irreversible ` +
    `and stay out of reach of any agent by design — use the Yampi dashboard.`
  );
}

const extraFields = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Extra fields accepted by the Yampi API, merged into the request body.");

/**
 * Stock on Yampi is not a SKU field — `quantity` is always null, even on real
 * SKUs. It lives in `/logistics/stocks` (the stock location) crossed with the SKU
 * at `/catalog/skus/{id}/stocks`. These two functions hide that from the tools.
 */
async function defaultStockId(ctx: Context, alias: string): Promise<number> {
  const r = await ctx.client.request<any>(alias, "/logistics/stocks", { query: { limit: 10 } });
  const locations = r.data ?? [];
  if (locations.length === 0) throw new Error("This store has no stock location registered on Yampi.");
  return locations[0].id;
}

async function setStock(ctx: Context, alias: string, skuId: number | string, quantity: number) {
  const stockId = await defaultStockId(ctx, alias);
  const current = await ctx.client.request<any>(alias, `/catalog/skus/${skuId}/stocks`);
  const existing = (current.data ?? []).find((e: any) => e.stock_id === stockId);
  return existing
    ? ctx.client.request(alias, `/catalog/skus/${skuId}/stocks/${existing.id}`, {
        method: "PUT",
        body: { stock_id: stockId, quantity },
      })
    : ctx.client.request(alias, `/catalog/skus/${skuId}/stocks`, {
        method: "POST",
        body: { stock_id: stockId, quantity },
      });
}

const KIT_ITEM = z.object({
  sku_id: z.number().int(),
  price_type: z
    .enum(["sku", "discount", "custom"])
    .describe("sku = the SKU's own price; discount = % off the SKU's price; custom = fixed `price`."),
  price: z.number().optional().describe("Fixed price. Required when price_type is `custom`."),
  discount: z.number().optional().describe("Percentage off. Required when price_type is `discount`."),
  quantity: z.number().int().min(1),
});

const KIT_FIELDS = {
  active: z.boolean().optional(),
  modifiable: z.boolean().optional().describe("Whether the customer may change the items before buying."),
  custom_shipping: z.boolean().optional().describe("Use the kit's own shipping instead of the store's."),
  shipping_type: z.enum(["fixed", "free"]).optional().describe("Only applies with custom_shipping."),
  shipping_price: z.number().optional().describe("Required when shipping_type is `fixed`."),
  shipping_days: z.number().int().optional().describe("Required when custom_shipping is true."),
};

export interface KitFields {
  name?: string;
  image_url?: string;
  active?: boolean;
  modifiable?: boolean;
  custom_shipping?: boolean;
  shipping_type?: string | null;
  shipping_price?: number;
  shipping_days?: number;
  items?: z.infer<typeof KIT_ITEM>[];
}

/** Keeps the fields the caller actually sent, so a merge cannot overwrite data with `undefined`. */
function sent<T extends object>(changes: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** The request body of a kit. Yampi rejects shipping settings on a kit that uses the store's shipping. */
export function kitBody(fields: KitFields) {
  const { shipping_type, shipping_price, shipping_days, ...rest } = fields;
  return rest.custom_shipping ? { ...rest, shipping_type, shipping_price, shipping_days } : rest;
}

/**
 * `PUT /catalog/bundles/{id}` demands the whole kit, and `items` replaces the list:
 * sending only what changed would either fail or empty the kit. So an edit is the
 * current kit with the changes on top. Returns null if the current kit came back
 * without its items, because writing from that would delete them.
 */
export function mergeKit(current: any, changes: KitFields): KitFields | null {
  const items = current?.items?.data;
  if (!Array.isArray(items) && !changes.items) return null;
  return {
    name: current.name,
    image_url: current.image_url,
    active: current.active,
    modifiable: current.modifiable,
    custom_shipping: current.custom_shipping,
    shipping_type: current.shipping_type,
    shipping_price: current.shipping_price,
    shipping_days: current.shipping_days,
    items: (items ?? []).map((item: any) => ({
      sku_id: item.sku_id,
      price_type: item.price_type,
      quantity: item.quantity,
      ...(item.price_type === "custom" ? { price: item.price } : {}),
      ...(item.price_type === "discount" ? { discount: item.discount } : {}),
    })),
    ...sent(changes),
  };
}

/**
 * `PUT /pricing/promocodes/{id}` requires the same fields as creating a coupon, so
 * an edit is the current coupon with the changes on top. Yampi returns money as
 * strings and dates as objects with microseconds; neither is accepted back.
 */
export function mergeCoupon(current: any, changes: Record<string, unknown>) {
  const dateTime = (value: any) => String(value?.date ?? value).slice(0, 19);
  return {
    code: current.code,
    active: current.active,
    discount_type: current.discount_type,
    value: Number(current.value),
    min_value: Number(current.min_value),
    quantity: current.quantity,
    start_at: dateTime(current.start_at),
    end_at: dateTime(current.end_at),
    for_the_price_of: current.for_the_price_of,
    accumulate: current.accumulate,
    once_per_customer: current.once_per_customer,
    abandoned_cart: current.abandoned_cart,
    newsletter: current.newsletter,
    free_shipment: current.free_shipment,
    ignore_promotion_products: current.ignore_promotion_products,
    freebie_id: current.freebie_id,
    advertise: current.advertise,
    ...sent(changes),
  };
}

/** Yampi's write responses leave out or misreport a kit's items, so the answer comes from a fresh read. */
async function readKit(ctx: Context, alias: string, kitId: number | string) {
  return result(
    ctx,
    `/${alias}/catalog/bundles`,
    await ctx.client.request<any>(alias, `/catalog/bundles/${kitId}`),
  );
}

/** Reversible Write tools: they change the Store, and the Merchant can undo them from the dashboard. */
export function registerWriteTools(server: McpServer, ctx: Context) {
  const store = storeField(ctx.stores);
  const at = (s?: string) => resolveStore(ctx.stores, s);

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: "Registers a product with its SKUs. Reversible: it can be deactivated or deleted from the dashboard.",
      inputSchema: z.object({
        store,
        name: z.string().min(1),
        description: z.string().optional(),
        brand_id: z.number().int().describe("Required by Yampi. Use describe_store to list the brands."),
        active: z.boolean().default(true),
        simple: z.boolean().default(true).describe("Product without variations. Yampi requires this field."),
        skus: z
          .array(
            z.object({
              sku: z.string().describe("SKU code."),
              sale_price: z.number().describe("Sale price."),
              cost_price: z.number().optional(),
              stock: z.number().int().optional(),
            }),
          )
          .min(1),
        extra_fields: extraFields,
      }),
    },
    async ({ store: s, name, description, brand_id, active, simple, skus, extra_fields }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/catalog/products", {
        method: "POST",
        body: {
          name,
          description,
          brand_id,
          active,
          simple,
          skus: skus.map((sku) => ({
            sku: sku.sku,
            price_sale: sku.sale_price,
            price_cost: sku.cost_price,
            quantity_managed: sku.stock !== undefined,
            quantity: sku.stock,
            blocked_sale: false, // required by Yampi; blocking the sale is not this tool's use case
          })),
          ...(extra_fields ?? {}),
        },
      });

      // Stock is a separate resource; it only exists once the SKU has an id.
      const created = (data?.data?.skus?.data ?? []) as any[];
      for (let i = 0; i < created.length; i++) {
        const quantity = skus[i]?.stock;
        if (quantity !== undefined) await setStock(ctx, alias, created[i].id, quantity);
      }
      return result(ctx, `/${alias}/catalog/products`, data);
    },
  );

  server.registerTool(
    "update_product",
    {
      title: "Update product",
      description: "Changes fields of an existing product. Send only what changes.",
      inputSchema: z.object({
        store,
        product_id: z.union([z.number(), z.string()]),
        name: z.string().optional(),
        description: z.string().optional(),
        active: z.boolean().optional(),
        brand_id: z.number().int().optional(),
        extra_fields: extraFields,
      }),
    },
    async ({ store: s, product_id, name, description, active, brand_id, extra_fields }) => {
      const alias = at(s);
      const body: Record<string, unknown> = { ...(extra_fields ?? {}) };
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (active !== undefined) body.active = active;
      if (brand_id !== undefined) body.brand_id = brand_id;
      if (Object.keys(body).length === 0) return toolError("Nothing to update: provide at least one field.");

      const data = await ctx.client.request<any>(alias, `/catalog/products/${product_id}`, {
        method: "PUT",
        body,
      });
      return result(ctx, `/${alias}/catalog/products`, data);
    },
  );

  server.registerTool(
    "manage_sku",
    {
      title: "Manage SKU",
      description:
        "Creates a new SKU or updates price and stock of existing SKUs. " +
        "Use get_product first to find the `sku_id`.",
      inputSchema: z.object({
        store,
        product_id: z.union([z.number(), z.string()]),
        action: z.enum(["create", "update"]),
        skus: z
          .array(
            z.object({
              sku_id: z.union([z.number(), z.string()]).optional().describe("Required when updating."),
              sku: z.string().optional().describe("Code, required when creating."),
              sale_price: z.number().optional(),
              cost_price: z.number().optional().describe("Yampi requires this field when updating."),
              stock: z.number().int().optional(),
            }),
          )
          .min(1),
      }),
    },
    async ({ store: s, product_id, action, skus }) => {
      const alias = at(s);
      const done: unknown[] = [];

      for (const sku of skus) {
        if (action === "create") {
          if (!sku.sku) return toolError("When creating a SKU, the `sku` field is required.");
          const created = await ctx.client.request<any>(alias, "/catalog/skus", {
            method: "POST",
            body: {
              product_id,
              sku: sku.sku,
              price_sale: sku.sale_price,
              price_cost: sku.cost_price,
              blocked_sale: false,
            },
          });
          if (sku.stock !== undefined) await setStock(ctx, alias, created.data.id, sku.stock);
          done.push(created.data);
          continue;
        }

        if (sku.sku_id === undefined) {
          return toolError("When updating a SKU, provide `sku_id` on each item. Use get_product to find them.");
        }
        // Yampi requires product_id and price_cost even on a partial update.
        if (sku.sale_price !== undefined || sku.cost_price !== undefined) {
          if (sku.cost_price === undefined) {
            return toolError(`Yampi requires \`cost_price\` alongside \`sale_price\` on SKU ${sku.sku_id}.`);
          }
          const updated = await ctx.client.request<any>(alias, `/catalog/skus/${sku.sku_id}`, {
            method: "PUT",
            body: { product_id, price_sale: sku.sale_price, price_cost: sku.cost_price },
          });
          done.push(updated.data);
        }
        if (sku.stock !== undefined) {
          await setStock(ctx, alias, sku.sku_id, sku.stock);
          done.push({ sku_id: sku.sku_id, stock: sku.stock });
        }
      }
      return result(ctx, `/${alias}/catalog/skus`, done);
    },
  );

  server.registerTool(
    "create_coupon",
    {
      title: "Create coupon",
      description: "Creates a discount coupon. Reversible: it can be deactivated from the dashboard.",
      inputSchema: z.object({
        store,
        code: z.string().min(1).describe("Code the customer types at checkout."),
        type: z.enum(["percentage", "fixed"]).describe("percentage = % of the order; fixed = amount off."),
        value: z.number().positive(),
        min_value: z.number().describe("Minimum order value. Required by Yampi; use 0 for no minimum."),
        quantity: z.number().int().describe("Usage limit. Required by Yampi."),
        starts_at: z.string().describe("Start of validity, YYYY-MM-DD. Required by Yampi."),
        ends_at: z.string().describe("End of validity, YYYY-MM-DD. Required by Yampi."),
        extra_fields: extraFields,
      }),
    },
    async ({ store: s, code, type, value, min_value, quantity, starts_at, ends_at, extra_fields }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, "/pricing/promocodes", {
        method: "POST",
        body: {
          code,
          discount_type: type === "percentage" ? "p" : "v", // Yampi only accepts "p" or "v"
          value,
          min_value,
          quantity,
          start_at: `${starts_at} 00:00:00`, // Yampi requires Y-m-d H:i:s
          end_at: `${ends_at} 23:59:59`,
          active: true,
          ...(extra_fields ?? {}),
        },
      });
      return result(ctx, `/${alias}/pricing/promocodes`, data);
    },
  );

  server.registerTool(
    "update_coupon",
    {
      title: "Update coupon",
      description:
        "Changes an existing coupon, including deactivating it or extending its validity. Send only what changes.",
      inputSchema: z.object({
        store,
        coupon_id: z.union([z.number(), z.string()]),
        active: z.boolean().optional().describe("false deactivates the coupon."),
        code: z.string().min(1).optional(),
        type: z.enum(["percentage", "fixed"]).optional(),
        value: z.number().positive().optional(),
        min_value: z.number().optional(),
        quantity: z.number().int().optional().describe("Usage limit."),
        starts_at: z.string().optional().describe("Start of validity, YYYY-MM-DD."),
        ends_at: z.string().optional().describe("End of validity, YYYY-MM-DD."),
        extra_fields: extraFields,
      }),
    },
    async ({ store: s, coupon_id, type, starts_at, ends_at, extra_fields, active, code, value, min_value, quantity }) => {
      const alias = at(s);
      const changes = sent({
        active,
        code,
        value,
        min_value,
        quantity,
        discount_type: type && (type === "percentage" ? "p" : "v"),
        start_at: starts_at && `${starts_at} 00:00:00`,
        end_at: ends_at && `${ends_at} 23:59:59`,
        ...(extra_fields ?? {}),
      });
      if (Object.keys(changes).length === 0) return toolError("Nothing to update: provide at least one field.");

      const current = await ctx.client.request<any>(alias, `/pricing/promocodes/${coupon_id}`);
      const data = await ctx.client.request<any>(alias, `/pricing/promocodes/${coupon_id}`, {
        method: "PUT",
        body: mergeCoupon(current.data, changes),
      });
      return result(ctx, `/${alias}/pricing/promocodes`, data);
    },
  );

  server.registerTool(
    "create_kit",
    {
      title: "Create kit",
      description:
        "Creates a product kit (bundle) from existing SKUs. Reversible: it can be deactivated with update_kit. " +
        "Use get_product to find the `sku_id` of each item.",
      inputSchema: z.object({
        store,
        name: z.string().min(1).describe("Must be unique in the store."),
        image_url: z.string().url().describe("Required by Yampi."),
        items: z.array(KIT_ITEM).min(1),
        ...KIT_FIELDS,
      }),
    },
    async ({ store: s, ...fields }) => {
      const alias = at(s);
      const created = await ctx.client.request<any>(alias, "/catalog/bundles", {
        method: "POST",
        body: kitBody(fields),
      });
      return readKit(ctx, alias, created.data.id);
    },
  );

  server.registerTool(
    "update_kit",
    {
      title: "Update kit",
      description:
        "Changes an existing product kit, including deactivating it. Send only what changes. " +
        "`items`, when sent, REPLACES the kit's whole item list: to change one item, send all of them.",
      inputSchema: z.object({
        store,
        kit_id: z.union([z.number(), z.string()]),
        name: z.string().min(1).optional(),
        image_url: z.string().url().optional(),
        items: z.array(KIT_ITEM).min(1).optional(),
        ...KIT_FIELDS,
      }),
    },
    async ({ store: s, kit_id, ...fields }) => {
      const alias = at(s);
      const changes = sent(fields);
      if (Object.keys(changes).length === 0) return toolError("Nothing to update: provide at least one field.");

      const current = await ctx.client.request<any>(alias, `/catalog/bundles/${kit_id}`);
      const merged = mergeKit(current.data, changes);
      if (!merged) {
        return toolError(
          `Yampi returned kit ${kit_id} without its items, so it was left unchanged. ` +
            "Saving now could erase them. Send the full `items` list to update it.",
        );
      }
      await ctx.client.request(alias, `/catalog/bundles/${kit_id}`, {
        method: "PUT",
        body: kitBody(merged),
      });
      return readKit(ctx, alias, kit_id);
    },
  );

  server.registerTool(
    "advance_order_status",
    {
      title: "Advance order status",
      description:
        "Moves an order to another status, by alias (see describe_store). " +
        "It does not cancel or refuse orders — for that, use the Yampi dashboard.",
      inputSchema: z.object({
        store,
        order_id: z.union([z.number(), z.string()]),
        status_alias: z.string().describe("Alias of the target status, e.g. paid, invoiced, delivered."),
      }),
    },
    async ({ store: s, order_id, status_alias }) => {
      const refusal = refuseIfForbidden(status_alias);
      if (refusal) return toolError(refusal);
      const alias = at(s);
      const statuses = await ctx.client.request<any>(alias, "/checkout/statuses", { query: { limit: 50 } });
      const target = (statuses.data ?? []).find((st: any) => st.alias === status_alias);
      if (!target) {
        const valid = (statuses.data ?? [])
          .map((st: any) => st.alias)
          .filter((a: string) => !FORBIDDEN_STATUSES.has(a))
          .join(", ");
        return toolError(`Status "${status_alias}" does not exist in this store. Valid: ${valid}.`);
      }
      const data = await ctx.client.request<any>(alias, `/orders/${order_id}`, {
        method: "PUT",
        body: { status_id: target.id },
      });
      return result(ctx, `/${alias}/orders`, data);
    },
  );

  server.registerTool(
    "add_order_comment",
    {
      title: "Add order comment",
      description: "Adds an internal comment to the order. Useful to record what was agreed with the customer.",
      inputSchema: z.object({
        store,
        order_id: z.union([z.number(), z.string()]),
        comment: z.string().min(1),
        notify_customer: z.boolean().default(false),
      }),
    },
    async ({ store: s, order_id, comment, notify_customer }) => {
      const alias = at(s);
      const data = await ctx.client.request<any>(alias, `/orders/${order_id}/comments`, {
        method: "POST",
        body: { comment, notify_customer },
      });
      return result(ctx, `/${alias}/orders`, data);
    },
  );
}
