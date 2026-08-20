import { describe, expect, it } from "vitest";
import { refuseIfForbidden } from "../src/tools/write";
import { resolveStore } from "../src/tools/common";
import { grantId } from "../src/authorize";
import type { Store } from "../src/yampi";

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
