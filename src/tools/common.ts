import { z } from "zod";
import type { Store, YampiClient } from "../yampi";

export interface Context {
  client: YampiClient;
  stores: Store[];
}

/**
 * The `store` parameter is required whenever the credential reaches more than one
 * store: silently writing to the wrong store is the failure this project refuses
 * to allow. Whoever has a single store does not pay for the problem of whoever
 * has four.
 */
export function storeField(stores: Store[]) {
  const aliases = stores.map((s) => s.alias) as [string, ...string[]];
  const description = `Store alias. Available: ${stores.map((s) => `${s.alias} (${s.name})`).join(", ")}`;
  const base = z.enum(aliases).describe(description);
  return stores.length === 1 ? base.optional() : base;
}

export function resolveStore(stores: Store[], store?: string): string {
  const available = stores.map((s) => s.alias).join(", ");
  if (store) {
    if (!stores.some((s) => s.alias === store)) {
      throw new Error(`Store "${store}" does not belong to this credential. Available: ${available}.`);
    }
    return store;
  }
  if (stores.length === 1) return stores[0].alias;
  throw new Error(`Say which store to act on. Available: ${available}.`);
}

export const pageFields = {
  limit: z.number().int().min(1).max(50).default(10).describe("Items per page. Maximum 50."),
  page: z.number().int().min(1).default(1).describe("Page, starting at 1."),
};

/** Standard response: the data plus the quota warning, when the route is close to its limit. */
export function result(ctx: Context, path: string, data: unknown) {
  const warning = ctx.client.quotaWarning(path);
  const text = JSON.stringify(data, null, 1);
  return {
    content: [{ type: "text" as const, text: warning ? `${text}\n\n${warning}` : text }],
  };
}

export function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
