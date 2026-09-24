// ============================================================
// Claim & Lock — who may send to a customer. Pure, no I/O.
//
// This is the server-side mirror of the database rules in migration
// 043 (the `claim_contact` function and the `messages_insert` RLS
// policy). Every outbound path — the inbox, the public API / MCP,
// reactions, broadcasts — asks these functions first so a refused send
// never reaches Meta; RLS is the backstop if one forgets.
//
//   owner / admin  → may send to anyone; never become the owner
//   agent          → may send to customers they own; sending to an
//                    Unassigned customer claims it first
//   viewer         → never sends
// ============================================================

import {
  canOwnCustomers,
  canSendMessages,
  canSuperviseCustomers,
  type AccountRole,
} from "@/lib/auth/roles";

/**
 * The human a send is attributed to. Dashboard sends are the signed-in
 * member; public-API sends act for the member who created the key.
 */
export interface SendActor {
  /** auth.users id — null for an API key whose creator has left. */
  userId: string | null;
  /** Current role in the account — null when not (or no longer) a member. */
  role: AccountRole | null;
  /**
   * How to claim for this actor: their own session (`claim_contact`
   * reads auth.uid()) or the service role on their behalf
   * (`claim_contact_as`, public API).
   */
  claimVia: "session" | "service";
}

export type SendDecision =
  /** Send now. `asAdmin` stamps the "Admin" label on the message. */
  | { kind: "allow"; asAdmin: boolean }
  /** Unassigned customer, agent sender: claim atomically, then send. */
  | { kind: "claim_then_send" }
  | { kind: "deny"; reason: "insufficient_role" | "owned_by_other"; ownerId: string | null };

export function decideSend(actor: SendActor, ownerId: string | null): SendDecision {
  if (!actor.userId || !actor.role || !canSendMessages(actor.role)) {
    return { kind: "deny", reason: "insufficient_role", ownerId };
  }
  if (canSuperviseCustomers(actor.role)) {
    return { kind: "allow", asAdmin: true };
  }
  if (ownerId === actor.userId) {
    return { kind: "allow", asAdmin: false };
  }
  if (ownerId === null && canOwnCustomers(actor.role)) {
    return { kind: "claim_then_send" };
  }
  return { kind: "deny", reason: "owned_by_other", ownerId };
}

/**
 * Non-reply outbound actions (reactions) don't claim: an agent must own
 * the customer first. Admins may always.
 */
export function canActWithoutClaim(actor: SendActor, ownerId: string | null): boolean {
  const decision = decideSend(actor, ownerId);
  return decision.kind === "allow";
}

/**
 * Broadcasts never claim. An admin's broadcast reaches everyone; an
 * agent's reaches Unassigned customers and their own, and skips
 * customers owned by a teammate.
 */
export function broadcastMayReach(actor: SendActor, ownerId: string | null): boolean {
  if (!actor.userId || !actor.role || !canSendMessages(actor.role)) return false;
  if (canSuperviseCustomers(actor.role)) return true;
  return ownerId === null || ownerId === actor.userId;
}

/** "Take this customer" is offered to agents on Unassigned customers only. */
export function canTakeCustomer(role: AccountRole | null, ownerId: string | null): boolean {
  return role !== null && canOwnCustomers(role) && ownerId === null;
}
