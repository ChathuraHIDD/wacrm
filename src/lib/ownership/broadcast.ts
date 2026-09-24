// ============================================================
// Claim & Lock for broadcasts.
//
// Broadcasts never claim. An admin's broadcast reaches everyone; an
// agent's reaches Unassigned customers and their own and SKIPS customers
// a teammate owns. Skipped recipients are reported (not silently
// dropped) so the sender sees why a contact didn't get the campaign.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { broadcastMayReach, type SendActor } from "./permissions";

export interface ReachPartition<T> {
  reachable: T[];
  /** Recipients whose customer is owned by someone the actor can't message. */
  skipped: T[];
}

export function partitionByReach<T>(
  items: readonly T[],
  ownerOf: (item: T) => string | null,
  actor: SendActor,
): ReachPartition<T> {
  const reachable: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    (broadcastMayReach(actor, ownerOf(item)) ? reachable : skipped).push(item);
  }
  return { reachable, skipped };
}

export function skippedOwnedMessage(ownerName: string | null | undefined): string {
  return `Skipped: ${ownerName?.trim() || "another agent"} is handling this customer`;
}

/** user id → display name, for the owners in `ownerIds`. */
export async function loadOwnerNames(
  db: SupabaseClient,
  ownerIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(ownerIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data } = await db
    .from("profiles")
    .select("user_id, full_name, email")
    .in("user_id", ids);
  for (const row of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
    names.set(row.user_id, row.full_name?.trim() || row.email || "another agent");
  }
  return names;
}

/**
 * Owners of the account's contacts, keyed by digits-only phone
 * (`contacts.phone_normalized`, migration 022). For the dashboard
 * broadcast route, which receives phones rather than contact ids.
 */
export async function loadOwnersByPhone(
  db: SupabaseClient,
  accountId: string,
  normalizedPhones: readonly string[],
): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  const phones = [...new Set(normalizedPhones.filter(Boolean))];
  // Chunk to keep the PostgREST query string bounded.
  for (let i = 0; i < phones.length; i += 200) {
    const { data, error } = await db
      .from("contacts")
      .select("phone_normalized, owner_id")
      .eq("account_id", accountId)
      .in("phone_normalized", phones.slice(i, i + 200));
    if (error) throw new Error(`Could not load customer owners: ${error.message}`);
    for (const row of (data ?? []) as { phone_normalized: string; owner_id: string | null }[]) {
      owners.set(row.phone_normalized, row.owner_id);
    }
  }
  return owners;
}
