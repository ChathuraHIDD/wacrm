import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { OwnershipError, setContactOwner } from '@/lib/ownership/claim';

/**
 * POST /api/contacts/[id]/owner — admin assign / transfer / release.
 *
 * Body: { owner_id: string | null, note?: string }
 *   owner_id = an agent's user id → assign (if Unassigned) or transfer
 *   owner_id = null               → release back to Unassigned
 *
 * Owner/admin only (checked here and again in the database). The target
 * must be an agent of the account — admins never own customers. Open
 * deals move with the customer; every change is written to the audit log.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase } = await requireRole('admin');
    const { id: contactId } = await params;

    const body = (await request.json().catch(() => null)) as {
      owner_id?: unknown;
      note?: unknown;
    } | null;
    if (!body || !('owner_id' in body)) {
      return NextResponse.json(
        { error: 'owner_id is required (a user id, or null to release)' },
        { status: 400 },
      );
    }
    const ownerId = body.owner_id;
    if (ownerId !== null && (typeof ownerId !== 'string' || !ownerId.trim())) {
      return NextResponse.json(
        { error: 'owner_id must be a user id or null' },
        { status: 400 },
      );
    }

    const result = await setContactOwner(supabase, {
      contactId,
      newOwnerId: ownerId,
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
    });

    return NextResponse.json({
      owner_id: result.ownerId,
      owner_name: result.ownerName,
      action: result.action,
    });
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return toErrorResponse(error);
  }
}
