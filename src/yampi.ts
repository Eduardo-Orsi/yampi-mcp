/**
 * Yampi API client. The single seam of this server: no tool speaks HTTP
 * directly, everything goes through here. That is what makes the Forbidden
 * Action auditable — the entire surface this server can touch fits in one file.
 */

const BASE = "https://api.dooki.com.br/v2";

/**
 * Forbidden Action, enforced at the seam. The matching tools do not exist, but
 * a future bug must not be able to reach these routes by another path.
 * Only applies to state-changing methods: reading the gateway configuration is
 * legitimate, switching it is not.
 */
const FORBIDDEN_ROUTES: RegExp[] = [
  /\/orders\/[^/]+\/cancel/i,
  /\/refunds?\b/i,
  /\/transactions\/[^/]+\/(refund|estorno)/i,
  /\/payments?\/gateways/i,
  /\/payment[-_]?configurations/i,
];

export class YampiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "YampiError";
  }
}

export class RateLimitError extends YampiError {
  constructor(readonly route: string) {
    super(
      `Yampi refused the call: too many requests on ${route}. The limit is per route, per minute; ` +
        `wait for the next minute or narrow the query (fewer items per page, tighter filter).`,
      429,
    );
  }
}

export class ForbiddenActionError extends YampiError {
  constructor(route: string) {
    super(
      `Route forbidden by design: ${route}. This server does not cancel orders, does not refund ` +
        `purchases and does not switch payment gateways. Use the Yampi dashboard.`,
      403,
    );
  }
}

export interface Store {
  id: number;
  alias: string;
  name: string;
}

export interface Credentials {
  userToken: string;
  secretKey: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Relationships to expand. Collapses N+1 into a single call. */
  include?: string[];
  /**
   * Query parameters. Arrays become `key[]=a&key[]=b` — without the brackets
   * Yampi silently ignores the filter and returns the whole dataset.
   */
  query?: Record<string, string | number | boolean | undefined | Array<string | number>>;
  body?: unknown;
}

/** Quota left as seen on the last response of each route. Best-effort: the isolate dies and the Map goes with it. */
type Quota = { remaining: number; limit: number };

export class YampiClient {
  #quotas = new Map<string, Quota>();

  constructor(
    private readonly credentials: Credentials,
    // Explicit bind: native `fetch` loses `this` when it becomes a class field.
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  /**
   * Stores this credential reaches. A Yampi credential belongs to the user, not
   * to the store.
   *
   * Inactive stores are left out: Yampi answers 403 on every route of theirs,
   * reads included. Offering them to the model would be offering an option that
   * can only fail, and the 403 never says the cause is a disabled store.
   */
  async stores(): Promise<Store[]> {
    const data = await this.#raw("/auth/me", { method: "POST" });
    const merchants = (data as any)?.data?.merchants ?? (data as any)?.merchants;
    const items = merchants?.data ?? merchants ?? [];
    return items
      .filter((m: any) => m.active !== false)
      .map((m: any) => ({ id: m.id, alias: m.alias, name: m.name }));
  }

  async request<T = unknown>(
    alias: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return this.#raw(`/${alias}${path}`, options) as Promise<T>;
  }

  /**
   * Quota warning to append to the tool response. Without it the model only
   * finds out about the limit when it takes a 429, and by then the route is
   * blocked for the rest of the minute.
   */
  quotaWarning(path: string): string | null {
    const quota = this.#quotas.get(this.#routeKey(path));
    if (!quota || quota.remaining > 5) return null;
    return `Heads up: ${quota.remaining} of ${quota.limit} requests left on this route this minute.`;
  }

  async #raw(path: string, options: RequestOptions): Promise<unknown> {
    const method = options.method ?? "GET";

    if (method !== "GET" && FORBIDDEN_ROUTES.some((r) => r.test(path))) {
      throw new ForbiddenActionError(path);
    }

    const url = new URL(BASE + path);

    // Yampi caches GET for 30 minutes. In an agent context that lies: create a
    // product and read it back and you get the previous state. Always skip it.
    if (method === "GET") url.searchParams.set("skipCache", "true");

    if (options.include?.length) url.searchParams.set("include", options.include.join(","));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      // The Yampi API sits behind Cloudflare and caches GET for 30 minutes. A
      // Worker subrequest can be served from the edge cache, whose key is the
      // URL — without the auth headers. Result: another credential's response.
      // Never cache an authenticated call.
      cache: "no-store",
      headers: {
        "User-Token": this.credentials.userToken,
        "User-Secret-Key": this.credentials.secretKey,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    this.#recordQuota(path, response.headers);

    if (response.status === 429) throw new RateLimitError(path);

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new YampiError(
        `Unreadable response from Yampi at ${path}: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok) {
      const message = (body as any)?.message ?? response.statusText;
      // On 422 Yampi says exactly which field failed, inside `errors`. Dropping
      // that leaves the model retrying blind; forwarding it lets the model fix
      // itself on the next call.
      const errors = (body as any)?.errors;
      const detail =
        errors && typeof errors === "object"
          ? " Fields: " +
            Object.entries(errors)
              .map(([field, msgs]) => `${field} (${[msgs].flat().join("; ")})`)
              .join(", ")
          : "";
      throw new YampiError(
        `Yampi answered ${response.status} at ${path}: ${message}.${detail}`,
        response.status,
      );
    }
    return body;
  }

  #recordQuota(path: string, headers: Headers) {
    const remaining = Number(headers.get("X-RateLimit-Remaining"));
    const limit = Number(headers.get("X-RateLimit-Limit"));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      this.#quotas.set(this.#routeKey(path), { remaining, limit });
    }
  }

  /** Yampi's limit is per route, not per exact path: /orders/123 and /orders share the same quota. */
  #routeKey(path: string): string {
    return path.split("/").filter(Boolean).slice(1, 3).join("/");
  }
}
