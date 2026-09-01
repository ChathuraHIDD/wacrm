import type { SupabaseClient } from '@supabase/supabase-js'

// ------------------------------------------------------------
// Round-robin conversation assignment.
//
// The `assign_conversation` automation step (mode: 'round_robin')
// used to just grab the first account member — so every lead landed
// on the same person. This spreads inbound conversations across the
// team instead.
//
// "Round-robin" here is *load-balanced*, not a strict rotation:
// among the account's assignable members (owner / admin / agent —
// viewers are read-only), pick whoever is currently carrying the
// fewest OPEN conversations. Ties break toward the agent whose most
// recent conversation is oldest, so a cold start (everyone at zero)
// still alternates instead of always picking the same name.
//
// The IO wrapper (`pickRoundRobinAgent`) is a thin shell over the
// pure `chooseNextAgent` so the ranking logic is unit-testable
// without a database.
// ------------------------------------------------------------

/** Account roles whose members may own a conversation. */
export const ASSIGNABLE_ROLES = ['owner', 'admin', 'agent'] as const

/** Minimal shape of an open conversation used for load balancing. */
export interface OpenConversationRow {
  assigned_agent_id: string | null
  last_message_at: string | null
}

/**
 * Pure ranking: given the candidate agent ids and every open
 * conversation in the account, return the id that should take the
 * next lead. Returns null only when `candidates` is empty.
 */
export function chooseNextAgent(
  candidates: string[],
  openConversations: OpenConversationRow[],
): string | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const load = new Map<string, number>()
  const lastAssignedAt = new Map<string, number>()
  for (const id of candidates) {
    load.set(id, 0)
    lastAssignedAt.set(id, 0)
  }

  for (const row of openConversations) {
    const agent = row.assigned_agent_id
    if (!agent || !load.has(agent)) continue
    load.set(agent, (load.get(agent) ?? 0) + 1)
    const ts = row.last_message_at ? Date.parse(row.last_message_at) : 0
    if (Number.isFinite(ts) && ts > (lastAssignedAt.get(agent) ?? 0)) {
      lastAssignedAt.set(agent, ts)
    }
  }

  // Deterministic: fewest open conversations first, then whoever has
  // gone longest without a new one, then id as a stable final tiebreak.
  return [...candidates].sort((a, b) => {
    const byLoad = (load.get(a) ?? 0) - (load.get(b) ?? 0)
    if (byLoad !== 0) return byLoad
    const byRecency = (lastAssignedAt.get(a) ?? 0) - (lastAssignedAt.get(b) ?? 0)
    if (byRecency !== 0) return byRecency
    return a < b ? -1 : a > b ? 1 : 0
  })[0]
}

/**
 * Resolve the next round-robin assignee for an account, or null when
 * the account has no assignable member. `db` must be able to read the
 * account's `profiles` and `conversations` (the automation engine
 * passes the service-role client).
 */
export async function pickRoundRobinAgent(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data: members } = await db
    .from('profiles')
    .select('user_id, account_role')
    .eq('account_id', accountId)
    .in('account_role', ASSIGNABLE_ROLES as unknown as string[])

  const candidates = (members ?? [])
    .map((m) => m.user_id as string | null)
    .filter((id): id is string => Boolean(id))

  if (candidates.length <= 1) return candidates[0] ?? null

  const { data: open } = await db
    .from('conversations')
    .select('assigned_agent_id, last_message_at')
    .eq('account_id', accountId)
    .eq('status', 'open')
    .not('assigned_agent_id', 'is', null)

  return chooseNextAgent(candidates, (open ?? []) as OpenConversationRow[])
}
