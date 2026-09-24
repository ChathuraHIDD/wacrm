import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { claimContact, OwnershipError } from '@/lib/ownership/claim';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * POST /api/contacts/[id]/claim — "Take this customer" (agents only).
 *
 * Atomic: of any number of agents pressing Take at once, exactly one gets
 * 200 `{ claimed: true }`. Everyone else gets 409 with the winner's name.
 * Owners/admins get 403 — they supervise and never own customers.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, userId, role } = await requireRole('agent');

    // Share the send budget: taking a customer is the first step of replying.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const { id: contactId } = await params;
    const result = await claimContact(supabase, {
      contactId,
      actor: { userId, role, claimVia: 'session' },
      source: 'take_button',
    });

    const body = {
      claimed: result.claimed,
      owner_id: result.ownerId,
      owner_name: result.ownerName,
    };
    if (!result.claimed) {
      return NextResponse.json(
        {
          ...body,
          code: 'claimed_by_other',
          error: `${result.ownerName ?? 'Another agent'} is already handling this customer`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return toErrorResponse(error);
  }
}
