import { describe, expect, it } from "vitest";
import { kitBody, mergeCoupon, mergeKit, refuseIfForbidden } from "../src/tools/write";
import { cashbackPeriodQuery, transactionDateFilter, transactionSearch, transactionView } from "../src/tools/read";
import { resolveStore } from "../src/tools/common";
import { grantId } from "../src/authorize";
import type { Store } from "../src/yampi";

describe("kit edits", () => {
  const current = {
    id: 1,
    name: "Kit",
    image_url: "https://example.com/kit.png",
    active: true,
    modifiable: false,
    custom_shipping: false,
    shipping_type: null,
    shipping_price: 0,
    shipping_days: 0,
    purchase_url: "https://example.com/buy",
    items: {
      data: [
        { id: 9, bundle_id: 1, sku_id: 10, price_type: "sku", price: 0, discount: 0, quantity: 1 },
        { id: 8, bundle_id: 1, sku_id: 11, price_type: "custom", price: 25, discount: 0, quantity: 2 },
        { id: 7, bundle_id: 1, sku_id: 12, price_type: "discount", price: 0, discount: 10, quantity: 1 },
      ],
    },
  };

  it("keeps every item when only another field changes", () => {
    expect(mergeKit(current, { active: false })).toMatchObject({
      name: "Kit",
      active: false,
      items: [
        { sku_id: 10, price_type: "sku", quantity: 1 },
        { sku_id: 11, price_type: "custom", price: 25, quantity: 2 },
        { sku_id: 12, price_type: "discount", discount: 10, quantity: 1 },
      ],
    });
  });

  it("sends each item only the price field its rule uses", () => {
    const items = mergeKit(current, { active: false })!.items!;
    expect(items[0]).not.toHaveProperty("price");
    expect(items[0]).not.toHaveProperty("discount");
    expect(items[1]).not.toHaveProperty("discount");
    expect(items[2]).not.toHaveProperty("price");
  });

  it("replaces the list when items are sent", () => {
    const items = [{ sku_id: 99, price_type: "sku" as const, quantity: 3 }];
    expect(mergeKit(current, { items })!.items).toEqual(items);
  });

  it("does not let an unset field erase a current value", () => {
    expect(mergeKit(current, { name: undefined, active: false })!.name).toBe("Kit");
  });

  // Writing from a response without items would silently empty a live kit.
  it("refuses to merge when the current kit came back without items", () => {
    const { items: _items, ...withoutItems } = current;
    expect(mergeKit(withoutItems, { active: false })).toBeNull();
  });

  it("drops shipping settings unless the kit uses its own shipping", () => {
    const fields = { name: "Kit", shipping_type: null, shipping_price: 0, shipping_days: 0 };
    expect(kitBody({ ...fields, custom_shipping: false })).toEqual({ name: "Kit", custom_shipping: false });
    expect(
      kitBody({ name: "Kit", custom_shipping: true, shipping_type: "free", shipping_days: 3 }),
    ).toMatchObject({ shipping_type: "free", shipping_days: 3 });
  });
});

describe("coupon edits", () => {
  const current = {
    code: "TEN",
    active: true,
    discount_type: "p",
    value: "10.00",
    min_value: "99.90",
    quantity: 5,
    once_per_customer: true,
    start_at: { date: "2026-01-01 00:00:00.000000", timezone_type: 3, timezone: "America/Sao_Paulo" },
    end_at: { date: "2026-12-31 23:59:59.000000", timezone_type: 3, timezone: "America/Sao_Paulo" },
  };

  it("deactivates without touching anything else, in the formats Yampi accepts back", () => {
    expect(mergeCoupon(current, { active: false })).toMatchObject({
      code: "TEN",
      active: false,
      discount_type: "p",
      value: 10,
      min_value: 99.9,
      quantity: 5,
      once_per_customer: true,
      start_at: "2026-01-01 00:00:00",
      end_at: "2026-12-31 23:59:59",
    });
  });

  it("applies a change over the current value", () => {
    expect(mergeCoupon(current, { end_at: "2027-01-31 23:59:59" }).end_at).toBe("2027-01-31 23:59:59");
  });
});

describe("transaction search", () => {
  it("sends nothing without filters", () => {
    expect(transactionSearch({})).toEqual({});
  });

  it("uses field:value, because Yampi ignores status= and returns everything", () => {
    expect(transactionSearch({ status: "refused" })).toEqual({ search: "status:refused" });
  });

  it("combines filters with AND, because Yampi OR-s them by default", () => {
    expect(transactionSearch({ status: "refused", payment_id: 3 })).toEqual({
      search: "status:refused;payment_id:3",
      searchJoin: "and",
    });
  });
});

describe("transaction date filter", () => {
  // Without both ends Yampi ignores the filter and returns every transaction.
  it("sends a single day as a range of one", () => {
    expect(transactionDateFilter("2026-10-15")).toBe("created_at:2026-10-15|2026-10-15");
  });

  it("sends a range", () => {
    expect(transactionDateFilter("2026-10-01", "2026-10-31")).toBe("created_at:2026-10-01|2026-10-31");
  });

  it("sends nothing without a start", () => {
    expect(transactionDateFilter()).toBeUndefined();
  });
});

describe("transaction view", () => {
  const view = transactionView({
    id: 1,
    status: "refused",
    error_code: "51",
    error_message: "Insufficient funds",
    holder_document: "000.000.000-00",
    holder_name: "Someone",
    billet_whatsapp_link: "https://example.com/pay",
    metadata: { data: { pix_qr_code: "secret" } },
    payment: { data: { name: "Pix" } },
    created_at: { date: "2026-11-06 10:00:00.000000" },
  });

  it("keeps what explains the failure", () => {
    expect(view).toMatchObject({ id: 1, error_message: "Insufficient funds", payment: "Pix" });
  });

  it("leaves personal and payment data out", () => {
    const text = JSON.stringify(view);
    for (const leaked of ["000.000.000-00", "Someone", "example.com", "secret"]) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe("cashback report period", () => {
  it("passes a preset through", () => {
    expect(cashbackPeriodQuery("month")).toEqual({ filter: "month" });
  });

  it("expands custom dates to the format Yampi requires", () => {
    expect(cashbackPeriodQuery("custom", "2026-10-01", "2026-10-31")).toEqual({
      filter: "custom",
      start_at: "2026-10-01 00:00:00",
      end_at: "2026-10-31 23:59:59",
    });
  });

  it("refuses a custom period with a missing date", () => {
    expect(cashbackPeriodQuery("custom", "2026-10-01")).toMatch(/both/);
  });

  // A preset would win over the dates, and the model would report the wrong period.
  it("refuses dates on a preset", () => {
    expect(cashbackPeriodQuery("month", "2026-10-01", "2026-10-31")).toMatch(/only apply/);
  });
});

describe("Forbidden Action by status", () => {
  // Cancelling on Yampi is a status change. Without this guard, the absence of a
  // cancellation tool would be worth nothing: cancellation would come in here.
  it.each(["cancelled", "refused", "CANCELLED", " refused "])("refuses %j", (alias) => {
    expect(refuseIfForbidden(alias)).toMatch(/does not move orders|irreversible/);
  });

  it.each(["paid", "invoiced", "delivered", "on_carriage", "ready_for_shipping"])(
    "lets %j through",
    (alias) => {
      expect(refuseIfForbidden(alias)).toBeNull();
    },
  );
});

describe("store resolution", () => {
  const four: Store[] = [
    { id: 1, alias: "store-a", name: "Store A" },
    { id: 2, alias: "store-b", name: "Store B" },
    { id: 3, alias: "store-c", name: "Store C" },
    { id: 4, alias: "store-a", name: "Store A" },
  ];
  const one: Store[] = [four[0]];

  it("demands an explicit choice when there is more than one store", () => {
    expect(() => resolveStore(four)).toThrow(/Say which store/);
  });

  it("assumes the only store when there is just one", () => {
    expect(resolveStore(one)).toBe("store-a");
  });

  it("refuses an alias outside the credential instead of trying anyway", () => {
    expect(() => resolveStore(four, "someone-elses-store")).toThrow(
      /does not belong to this credential/,
    );
  });

  it("accepts a valid alias", () => {
    expect(resolveStore(four, "store-b")).toBe("store-b");
  });
});

describe("Grant id", () => {
  // The library splits the authorization code into `userId:grantId:secret`. A `:`
  // in the userId breaks the whole token exchange — and the error only shows up
  // at the end of the flow, as "Invalid authorization code format".
  it("never contains a colon", () => {
    const id = grantId([
      { id: 100, alias: "store-a", name: "Store A" },
      { id: 101, alias: "store-a", name: "Store A" },
    ]);
    expect(id).not.toContain(":");
    expect(`${id}:grant123:secret`.split(":")).toHaveLength(3);
  });
});
