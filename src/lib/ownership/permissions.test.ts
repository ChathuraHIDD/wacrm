import { describe, expect, it } from "vitest";

import type { AccountRole } from "@/lib/auth/roles";
import {
  broadcastMayReach,
  canActWithoutClaim,
  canTakeCustomer,
  decideSend,
  type SendActor,
} from "./permissions";

const ME = "user-me";
const TEAMMATE = "user-teammate";

function actor(role: AccountRole | null, userId: string | null = ME): SendActor {
  return { userId, role, claimVia: "session" };
}

describe("decideSend", () => {
  it("lets an agent reply to their own customer", () => {
    expect(decideSend(actor("agent"), ME)).toEqual({ kind: "allow", asAdmin: false });
  });

  it("makes an agent claim an Unassigned customer before replying", () => {
    expect(decideSend(actor("agent"), null)).toEqual({ kind: "claim_then_send" });
  });

  it("refuses an agent replying to a teammate's customer", () => {
    expect(decideSend(actor("agent"), TEAMMATE)).toEqual({
      kind: "deny",
      reason: "owned_by_other",
      ownerId: TEAMMATE,
    });
  });

  it.each<AccountRole>(["admin", "owner"])(
    "lets an %s reply to anyone as Admin without claiming",
    (role) => {
      for (const ownerId of [null, TEAMMATE, ME]) {
        expect(decideSend(actor(role), ownerId)).toEqual({ kind: "allow", asAdmin: true });
      }
    },
  );

  it("refuses viewers and role-less actors", () => {
    expect(decideSend(actor("viewer"), null).kind).toBe("deny");
    expect(decideSend(actor(null), null)).toMatchObject({ kind: "deny", reason: "insufficient_role" });
    expect(decideSend(actor("agent", null), null)).toMatchObject({ kind: "deny", reason: "insufficient_role" });
  });
});

describe("canActWithoutClaim (reactions)", () => {
  it("requires an agent to own the customer already", () => {
    expect(canActWithoutClaim(actor("agent"), ME)).toBe(true);
    expect(canActWithoutClaim(actor("agent"), null)).toBe(false);
    expect(canActWithoutClaim(actor("agent"), TEAMMATE)).toBe(false);
  });

  it("always allows admins", () => {
    expect(canActWithoutClaim(actor("admin"), TEAMMATE)).toBe(true);
  });
});

describe("broadcastMayReach", () => {
  it("lets an agent reach Unassigned and own customers, skipping a teammate's", () => {
    expect(broadcastMayReach(actor("agent"), null)).toBe(true);
    expect(broadcastMayReach(actor("agent"), ME)).toBe(true);
    expect(broadcastMayReach(actor("agent"), TEAMMATE)).toBe(false);
  });

  it("lets an admin reach everyone", () => {
    expect(broadcastMayReach(actor("admin"), TEAMMATE)).toBe(true);
  });

  it("reaches no one for a viewer", () => {
    expect(broadcastMayReach(actor("viewer"), null)).toBe(false);
  });
});

describe("canTakeCustomer", () => {
  it("offers Take only to agents on Unassigned customers", () => {
    expect(canTakeCustomer("agent", null)).toBe(true);
    expect(canTakeCustomer("agent", TEAMMATE)).toBe(false);
    expect(canTakeCustomer("admin", null)).toBe(false);
    expect(canTakeCustomer("owner", null)).toBe(false);
    expect(canTakeCustomer("viewer", null)).toBe(false);
    expect(canTakeCustomer(null, null)).toBe(false);
  });
});
