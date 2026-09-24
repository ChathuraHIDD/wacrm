// ============================================================
// Claim & Lock — thin wrappers over the migration-043 functions.
//
// The atomicity lives in Postgres (`UPDATE … WHERE owner_id IS NULL`);
// these only pick the right RPC for the caller and map database errors
// onto HTTP-shaped ones. Every ownership change goes through here.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAccountRole } from "@/lib/auth/roles";
import type { SendActor } from "./permissions";

/** Where a claim/assignment came from — recorded in the audit log. */
export type ClaimSource = "take_button" | "first_reply" | "ai_takeover" | "api";
export type SystemAssignSource = "round_robin" | "ai_handoff" | "flow_handoff";

export interface ClaimResult {
  /** True iff the caller owns the customer now (won, or already owned). */
  claimed: boolean;
  ownerId: string | null;
  ownerName: string | null;
}

export type OwnerChangeAction = "assign" | "transfer" | "release" | "none";

export interface OwnerChangeResult {
  ownerId: string | null;
  ownerName: string | null;
  action: OwnerChangeAction;
}

export class OwnershipError extends Error {
  readonly status: 400 | 403 | 404 | 500;
  constructor(message: string, status: 400 | 403 | 404 | 500) {
    super(message);
    this.name = "OwnershipError";
    this.status = status;
  }
}

interface PostgrestLikeError {
  code?: string;
  message: string;
}

function toOwnershipError(error: PostgrestLikeError): OwnershipError {
  switch (error.code) {
    case "42501":
      return new OwnershipError(error.message, 403);
    case "P0002":
      return new OwnershipError("Customer not found", 404);
    case "22023":
      return new OwnershipError(error.message, 400);
    default:
      console.error("[ownership] database error:", error);
      return new OwnershipError("Could not update customer ownership", 500);
  }
}

interface ClaimRow {
  claimed: boolean;
  owner_id: string | null;
  owner_name: string | null;
}

/**
 * Atomically claim an Unassigned customer for `actor`. Exactly one of
 * any number of concurrent callers gets `claimed: true`; the rest learn
 * who won. Throws OwnershipError when the actor may not own customers.
 */
export async function claimContact(
  db: SupabaseClient,
  args: { contactId: string; actor: SendActor; source: ClaimSource },
): Promise<ClaimResult> {
  const { contactId, actor, source } = args;
  const { data, error } =
    actor.claimVia === "session"
      ? await db.rpc("claim_contact", { p_contact_id: contactId, p_source: source })
      : await db.rpc("claim_contact_as", {
          p_contact_id: contactId,
          p_actor_id: actor.userId,
          p_source: source,
        });

  if (error) throw toOwnershipError(error);
  const row = (data as ClaimRow[] | null)?.[0];
  if (!row) throw new OwnershipError("Could not claim this customer", 500);
  return { claimed: row.claimed, ownerId: row.owner_id, ownerName: row.owner_name };
}

interface OwnerChangeRow {
  owner_id: string | null;
  owner_name: string | null;
  action: string;
}

function isOwnerChangeAction(value: string): value is OwnerChangeAction {
  return value === "assign" || value === "transfer" || value === "release" || value === "none";
}

/**
 * Admin-only assign / transfer / release (`newOwnerId: null`). Runs under
 * the caller's session; the database refuses non-admins and non-agent
 * targets.
 */
export async function setContactOwner(
  db: SupabaseClient,
  args: { contactId: string; newOwnerId: string | null; note?: string | null },
): Promise<OwnerChangeResult> {
  const { data, error } = await db.rpc("set_contact_owner", {
    p_contact_id: args.contactId,
    p_new_owner_id: args.newOwnerId,
    p_note: args.note ?? null,
  });
  if (error) throw toOwnershipError(error);
  const row = (data as OwnerChangeRow[] | null)?.[0];
  if (!row || !isOwnerChangeAction(row.action)) {
    throw new OwnershipError("Could not update customer ownership", 500);
  }
  return { ownerId: row.owner_id, ownerName: row.owner_name, action: row.action };
}

/**
 * Bot routing: give an Unassigned customer to `agentId`. Never overrides
 * an owner and never assigns a non-agent. Service-role client only.
 * Returns whether the assignment happened.
 */
export async function systemAssignContact(
  db: SupabaseClient,
  args: { contactId: string; agentId: string; source: SystemAssignSource },
): Promise<boolean> {
  const { data, error } = await db.rpc("system_assign_contact", {
    p_contact_id: args.contactId,
    p_agent_id: args.agentId,
    p_source: args.source,
  });
  if (error) {
    console.error("[ownership] system_assign_contact failed:", error);
    return false;
  }
  return data === true;
}

/**
 * The public API acts for the member who created the key, with that
 * member's CURRENT role: an admin's key replies anywhere without
 * claiming, an agent's key follows agent rules. A creator who left the
 * account (or a key with no recorded creator) resolves to no role, and
 * `decideSend` refuses every send until an admin issues a new key.
 */
export async function actorForApiKey(
  db: SupabaseClient,
  args: { accountId: string; createdBy: string | null },
): Promise<SendActor> {
  if (!args.createdBy) return { userId: null, role: null, claimVia: "service" };
  const { data } = await db
    .from("profiles")
    .select("account_role")
    .eq("user_id", args.createdBy)
    .eq("account_id", args.accountId)
    .maybeSingle();
  const role: unknown = data?.account_role;
  return {
    userId: args.createdBy,
    role: isAccountRole(role) ? role : null,
    claimVia: "service",
  };
}
