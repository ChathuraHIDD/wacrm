import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { canOwnCustomers, canSuperviseCustomers } from '@/lib/auth/roles'
import { claimContact, OwnershipError, setContactOwner } from '@/lib/ownership/claim'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set and the caller is an agent,
 *                     also CLAIM the customer (Claim & Lock, migration
 *                     043) — atomically, so a lost race answers 409.
 *                     Admins pause without owning.
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. A claimed
 *                     customer must be released first, and only an admin
 *                     may release — so an admin's Resume releases, and an
 *                     agent's Resume on a claimed customer is refused.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id, contact:contacts(owner_id)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact
    const ownerId: string | null = contact?.owner_id ?? null
    const update: Record<string, unknown> = { ai_autoreply_disabled: paused }

    // A teammate's customer is read-only for other agents (RLS would
    // silently skip the update below — say so instead).
    if (ownerId && ownerId !== userId && !canSuperviseCustomers(role)) {
      return NextResponse.json(
        { error: 'Another agent is handling this customer', code: 'not_owner' },
        { status: 403 },
      )
    }

    // Ownership changes go through the migration-043 functions; the
    // conversation's assigned_agent_id is derived from them.
    try {
      if (paused && assignToMe && canOwnCustomers(role) && ownerId !== userId) {
        const claim = await claimContact(supabase, {
          contactId: conv.contact_id,
          actor: { userId, role, claimVia: 'session' },
          source: 'ai_takeover',
        })
        if (!claim.claimed) {
          return NextResponse.json(
            {
              error: `${claim.ownerName ?? 'Another agent'} is already handling this customer`,
              code: 'claimed_by_other',
              owner_id: claim.ownerId,
              owner_name: claim.ownerName,
            },
            { status: 409 },
          )
        }
      }
      if (!paused && ownerId) {
        // The bot stands down while a human owns the customer, so
        // resuming means releasing — which only an admin may do.
        if (!canSuperviseCustomers(role)) {
          return NextResponse.json(
            { error: 'Only an admin can release this customer back to the AI assistant' },
            { status: 403 },
          )
        }
        await setContactOwner(supabase, {
          contactId: conv.contact_id,
          newOwnerId: null,
          note: 'Resumed AI auto-reply',
        })
      }
    } catch (err) {
      if (err instanceof OwnershipError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    if (!paused) {
      // Resuming hands the thread *back to the bot*: clear the pause and
      // the handoff note (the release above removed any owner).
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale — it's
      // a human choosing to re-engage the assistant.
      update.ai_reply_count = 0
      update.ai_handoff_summary = null
    }

    const { error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr)
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, paused })
  } catch (err) {
    return toErrorResponse(err)
  }
}
