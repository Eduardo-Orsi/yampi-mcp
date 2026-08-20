/**
 * Integration test against the real Yampi API.
 *
 * The other tests use a fake `fetch` and prove the server's logic. This one proves
 * the other half: that the endpoints, the field names and the filter syntax are
 * still the ones this code assumes. The Yampi API changes without notice, and a
 * suite that only tests mocks never notices.
 *
 * Skipped by default. To run it against your own store:
 *
 *   cp .env.example .env    # fill in alias, token and secret
 *   npm run test:integration
 *
 * Read-only. Nothing is created, changed or deleted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { YampiClient } from "../src/yampi";

const alias = process.env.YAMPI_ALIAS;
const userToken = process.env.YAMPI_USER_TOKEN;
const secretKey = process.env.YAMPI_USER_SECRET_KEY;
const configured = Boolean(alias && userToken && secretKey);

describe.skipIf(!configured)("Yampi API (real network, read-only)", () => {
  let client: YampiClient;
  beforeAll(() => {
    client = new YampiClient({ userToken: userToken!, secretKey: secretKey! });
  });

  it("discovers the credential's stores and includes the configured one", async () => {
    const stores = await client.stores();
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.map((s) => s.alias)).toContain(alias);
  });

  it("lists order statuses with a usable alias", async () => {
    const r = await client.request<any>(alias!, "/checkout/statuses", { query: { limit: 50 } });
    const aliases = (r.data ?? []).map((s: any) => s.alias);
    expect(aliases).toContain("paid");
    expect(aliases).toContain("cancelled"); // it exists in the API, but it is a Forbidden Action here
  });

  it("actually filters orders by status", async () => {
    // The point of this test: `status_id=4` is silently ignored by Yampi and
    // returns the whole dataset. Only `status_id[]=4` filters. If the API starts
    // accepting the scalar form again, or stops accepting the array, this is
    // where you find out.
    const statuses = await client.request<any>(alias!, "/checkout/statuses", { query: { limit: 50 } });
    const paid = (statuses.data ?? []).find((s: any) => s.alias === "paid");
    const r = await client.request<any>(alias!, "/orders", {
      include: ["status"],
      query: { limit: 5, status_id: [paid.id] },
    });
    const found = (r.data ?? []).map((o: any) => o.status?.data?.alias);
    for (const s of found) expect(s).toBe("paid");
  });

  it("accepts the date format Yampi requires", async () => {
    const r = await client.request<any>(alias!, "/orders", {
      query: { limit: 1, date: "created_at:2020-01-01|2020-01-02" },
    });
    expect(Array.isArray(r.data)).toBe(true); // a wrong format would return 400/500
  });

  it("expands product relationships via include", async () => {
    const r = await client.request<any>(alias!, "/catalog/products", {
      include: ["skus", "images"],
      query: { limit: 1 },
    });
    if ((r.data ?? []).length > 0) expect(r.data[0]).toHaveProperty("skus");
  });

  it("exposes the route quota in the headers", async () => {
    await client.request(alias!, "/catalog/brands", { query: { limit: 1 } });
    // Without the header the quota warning never fires and the model only learns about the limit on a 429.
    expect(client.quotaWarning(`/${alias}/catalog/brands`)).not.toBeUndefined();
  });
});

describe.skipIf(configured)("integration", () => {
  it("skipped: set YAMPI_ALIAS, YAMPI_USER_TOKEN and YAMPI_USER_SECRET_KEY to run", () => {
    expect(configured).toBe(false);
  });
});
