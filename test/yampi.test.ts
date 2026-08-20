import { describe, expect, it } from "vitest";
import { ForbiddenActionError, RateLimitError, YampiClient } from "../src/yampi";

const credentials = { userToken: "t", secretKey: "s" };

/** Fake fetch: records the calls and returns whatever the test asks for. */
function fakeFetch(
  response: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
) {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: response.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("Forbidden Action at the seam", () => {
  // The core guarantee of the project: cancelling, refunding and switching
  // gateway have no tool — and even if a future bug tries, the seam refuses
  // before the network.
  const forbidden = [
    "/orders/123/cancel",
    "/refunds",
    "/transactions/abc/refund",
    "/payments/gateways",
    "/payment-configurations/9",
  ];

  it.each(forbidden)("refuses %s on a state-changing method", async (path) => {
    const { impl, calls } = fakeFetch();
    const client = new YampiClient(credentials, impl);
    await expect(client.request("store-a", path, { method: "POST" })).rejects.toThrow(
      ForbiddenActionError,
    );
    expect(calls).toHaveLength(0); // it never even left the machine
  });

  it("allows GET on the same routes: reading the gateway configuration is legitimate", async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/payments/gateways");
    expect(calls).toHaveLength(1);
  });
});

describe("rate limit", () => {
  it("turns a 429 into an error that tells the model what to do", async () => {
    const { impl } = fakeFetch({ status: 429, body: { message: "Too Many Requests" } });
    const client = new YampiClient(credentials, impl);
    const error: any = await client.request("store-a", "/orders").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.message).toMatch(/wait for the next minute|narrow the query/);
  });

  it("warns when the route quota is running out", async () => {
    const { impl } = fakeFetch({
      body: { data: [] },
      headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "3" },
    });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/catalog/products");
    expect(client.quotaWarning("/store-a/catalog/products")).toMatch(/3 of 30/);
  });

  it("stays quiet while there is quota to spare", async () => {
    const { impl } = fakeFetch({
      body: { data: [] },
      headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "25" },
    });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/catalog/products");
    expect(client.quotaWarning("/store-a/catalog/products")).toBeNull();
  });

  it("shares the quota across paths of the same route", async () => {
    // Yampi limits per route: /catalog/products and /catalog/products/1 share the same quota.
    const { impl } = fakeFetch({
      body: { data: {} },
      headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "1" },
    });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/catalog/products/1");
    expect(client.quotaWarning("/store-a/catalog/products")).toMatch(/1 of 30/);
  });
});

describe("store discovery", () => {
  it("reads merchants.data from /auth/me", async () => {
    const { impl, calls } = fakeFetch({
      body: {
        data: {
          merchants: {
            data: [
              { id: 101, alias: "store-a", name: "Store A" },
              { id: 102, alias: "store-b", name: "Store B" },
            ],
          },
        },
      },
    });
    const client = new YampiClient(credentials, impl);
    const stores = await client.stores();
    expect(stores.map((s) => s.alias)).toEqual(["store-a", "store-b"]);
    expect(calls[0].method).toBe("POST"); // /auth/me refuses GET with 405
  });
});

describe("URL building", () => {
  it("collapses relationships with include instead of N+1", async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/orders", {
      include: ["items", "customer"],
      query: { limit: 5, empty: undefined },
    });
    expect(calls[0].url).toContain("include=items%2Ccustomer");
    expect(calls[0].url).toContain("limit=5");
    expect(calls[0].url).not.toContain("empty");
  });
});

describe("filter serialization", () => {
  // Yampi silently ignores `status_id=4` and returns the whole dataset; only
  // `status_id[]=4` filters. A filter that does not filter is worse than no
  // filter: the model summarizes 55 thousand orders believing it saw July's.
  it("serializes an array as a repeated key[]=v", async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/orders", { query: { status_id: [4, 10] } });
    const url = decodeURIComponent(calls[0].url);
    expect(url).toContain("status_id[]=4");
    expect(url).toContain("status_id[]=10");
    expect(url).not.toMatch(/status_id=4/);
  });

  it("keeps scalars without brackets", async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    const client = new YampiClient(credentials, impl);
    await client.request("store-a", "/orders", {
      query: { date: "created_at:2026-06-01|2026-06-05" },
    });
    const url = decodeURIComponent(calls[0].url);
    expect(url).toContain("date=created_at:2026-06-01|2026-06-05");
  });
});

describe("Yampi cache", () => {
  it("skips the cache on every read", async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    await new YampiClient(credentials, impl).request("store-a", "/orders");
    expect(calls[0].url).toContain("skipCache=true");
  });

  it("does not pollute writes with skipCache", async () => {
    const { impl, calls } = fakeFetch({ body: { data: {} } });
    await new YampiClient(credentials, impl).request("store-a", "/catalog/products", {
      method: "POST",
      body: { name: "x" },
    });
    expect(calls[0].url).not.toContain("skipCache");
  });
});

describe("inactive stores", () => {
  it("does not offer a disabled store: Yampi answers 403 on everything in them", async () => {
    const { impl } = fakeFetch({
      body: {
        data: {
          merchants: {
            data: [
              { id: 1, alias: "active", name: "Active", active: true },
              { id: 2, alias: "disabled", name: "Disabled", active: false },
              { id: 3, alias: "no-field", name: "No field" },
            ],
          },
        },
      },
    });
    const stores = await new YampiClient(credentials, impl).stores();
    expect(stores.map((s) => s.alias)).toEqual(["active", "no-field"]);
  });
});

describe("validation error", () => {
  it("forwards which fields Yampi refused, not just the status code", async () => {
    const { impl } = fakeFetch({
      status: 422,
      body: {
        message: "422 Unprocessable Entity",
        errors: { brand_id: ["Required field."], simple: ["Required field."] },
      },
    });
    const client = new YampiClient(credentials, impl);
    const e: any = await client
      .request("store-a", "/catalog/products", { method: "POST", body: {} })
      .catch((x) => x);
    expect(e.message).toContain("brand_id");
    expect(e.message).toContain("simple");
    expect(e.message).toContain("Required field");
  });
});
