// ============================================================
// Inbox ownership tabs (Claim & Lock). Pure, no I/O.
//
//   Unassigned — nobody owns the customer yet (agents see "Take")
//   Mine       — customers I own (agents only; admins never own)
//   Team       — customers owned by someone else (read-only for agents)
//   All        — everything (admins)
//
// Ownership is read from `conversations.assigned_agent_id`, which the
// database derives from the contact's owner (migration 043) and which
// realtime pushes to every open inbox when it changes.
// ============================================================

import { canSuperviseCustomers, type AccountRole } from "@/lib/auth/roles";

export type OwnershipTab = "unassigned" | "mine" | "team" | "all";

export interface OwnedThread {
  assigned_agent_id?: string | null;
}

/** Tabs to show, in display order. */
export function ownershipTabsFor(role: AccountRole | null): OwnershipTab[] {
  if (role && canSuperviseCustomers(role)) return ["all", "unassigned", "team"];
  return ["unassigned", "mine", "team"];
}

/** Where the inbox opens: admins on everything, agents on their own work. */
export function defaultOwnershipTab(role: AccountRole | null): OwnershipTab {
  if (role && canSuperviseCustomers(role)) return "all";
  if (role === "agent") return "mine";
  return "unassigned";
}

/**
 * Does `thread` belong in `tab` for `userId`? `agentFilter` (admins'
 * "filter by agent") narrows the owned tabs to one agent's customers.
 */
export function matchesOwnershipTab(
  thread: OwnedThread,
  tab: OwnershipTab,
  userId: string | null,
  agentFilter: string | null = null,
): boolean {
  const owner = thread.assigned_agent_id ?? null;
  if (agentFilter && owner !== agentFilter) return false;
  switch (tab) {
    case "unassigned":
      return owner === null;
    case "mine":
      return owner !== null && owner === userId;
    case "team":
      return owner !== null && owner !== userId;
    case "all":
      return true;
  }
}

export function countByOwnershipTab(
  threads: readonly OwnedThread[],
  userId: string | null,
  agentFilter: string | null = null,
): Record<OwnershipTab, number> {
  const counts: Record<OwnershipTab, number> = { unassigned: 0, mine: 0, team: 0, all: 0 };
  for (const thread of threads) {
    for (const tab of Object.keys(counts) as OwnershipTab[]) {
      if (matchesOwnershipTab(thread, tab, userId, agentFilter)) counts[tab] += 1;
    }
  }
  return counts;
}
