import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SendActor } from '@/lib/ownership/permissions';
import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = {
    conversationId: 'cv-1',
    actor: { userId: 'user-1', role: 'agent', claimVia: 'session' },
  } satisfies Partial<SendMessageParams>;

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ ...base, conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ ...base, messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));

// Owners/admins never claim, so the persistence tests below send as one.
const ADMIN_ACTOR: SendActor = { userId: 'admin-1', role: 'admin', claimVia: 'session' };

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  // Only used for the best-effort "pause active flow run" write.
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
type RpcFake = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;

function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites,
  contact: Record<string, unknown> = { id: 'ct-1', phone: '+15551234567' },
  rpc?: RpcFake
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact,
  };
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () =>
          table === 'profiles'
            ? { data: { full_name: 'Gina Agent', email: 'gina@x.test' }, error: null }
            : { data: null, error: null },
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : [],
            error: null,
          }),
      };
      return builder;
    },
    rpc,
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        actor: ADMIN_ACTOR,
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      actor: ADMIN_ACTOR,
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      actor: ADMIN_ACTOR,
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
      contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      actor: ADMIN_ACTOR,
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    });
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0]
        .language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      actor: ADMIN_ACTOR,
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta withholds the phone number for a customer who has adopted a
// WhatsApp username, so their contact row carries only `wa_user_id`.
// The send path used to reject those outright with "Contact phone
// number not found" — the business could receive their messages but
// never answer them.
// ============================================================

const BSUID = 'US.13491208655302741918';

describe('sendMessageToConversation — BSUID recipients (#519)', () => {
  it('sends to the BSUID when the contact has no phone number', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', wa_user_id: BSUID }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', actor: ADMIN_ACTOR }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('still prefers the phone number when the contact has both', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: '+15551234567',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', actor: ADMIN_ACTOR }
    );

    // Only the phone path supports the trunk-prefix variant retry, so
    // it wins whenever we have a usable number.
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
  });

  it('falls back to the BSUID when the stored phone is unusable', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: 'not-a-number',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', actor: ADMIN_ACTOR }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('400s when the contact has neither a usable phone nor a BSUID', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', actor: ADMIN_ACTOR }
      )
    ).rejects.toThrow(/no phone number or WhatsApp user ID/);
  });

  it('ignores a wa_user_id that is not BSUID-shaped', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, {
          id: 'ct-1',
          phone: '',
          wa_user_id: 'garbage',
        }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', actor: ADMIN_ACTOR }
      )
    ).rejects.toThrow(/no phone number or WhatsApp user ID/);
  });
});

// ============================================================
// Claim & Lock (migration 043) — the gate in front of Meta.
// ============================================================

describe('sendMessageToConversation — Claim & Lock', () => {
  const AGENT: SendActor = { userId: 'agent-me', role: 'agent', claimVia: 'session' };
  const OWNED_BY_TEAMMATE = { id: 'ct-1', phone: '+15551234567', owner_id: 'agent-gina' };
  const UNASSIGNED = { id: 'ct-1', phone: '+15551234567', owner_id: null };

  async function metaText() {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();
    return vi.mocked(sendTextMessage);
  }

  function text(actor: SendActor) {
    return { conversationId: 'cv-1', messageType: 'text', contentText: 'hi', actor };
  }

  it("rejects a non-owner agent with 403 before anything reaches Meta", async () => {
    const meta = await metaText();
    const captured: CapturedWrites = {};
    const rpc = vi.fn<RpcFake>();

    const err = await sendMessageToConversation(
      sendPathDb([], captured, OWNED_BY_TEAMMATE, rpc),
      'acct-1',
      text(AGENT)
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    expect(err).toMatchObject({
      status: 403,
      code: 'not_owner',
      message: 'Gina Agent is handling this customer',
      ownership: { ownerId: 'agent-gina', ownerName: 'Gina Agent' },
    });
    expect(meta).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it('claims an Unassigned customer on the first reply, then sends', async () => {
    const meta = await metaText();
    const captured: CapturedWrites = {};
    const rpc = vi.fn<RpcFake>(async () => ({
      data: [{ claimed: true, owner_id: 'agent-me', owner_name: 'Me' }],
      error: null,
    }));

    await sendMessageToConversation(sendPathDb([], captured, UNASSIGNED, rpc), 'acct-1', text(AGENT));

    expect(rpc).toHaveBeenCalledWith('claim_contact', {
      p_contact_id: 'ct-1',
      p_source: 'first_reply',
    });
    expect(meta).toHaveBeenCalledTimes(1);
    expect(captured.message?.sent_as_admin).toBe(false);
  });

  it('refuses the loser of a claim race with 409 and sends nothing', async () => {
    const meta = await metaText();
    const captured: CapturedWrites = {};
    const rpc = vi.fn<RpcFake>(async () => ({
      data: [{ claimed: false, owner_id: 'agent-hank', owner_name: 'Hank Agent' }],
      error: null,
    }));

    const err = await sendMessageToConversation(
      sendPathDb([], captured, UNASSIGNED, rpc),
      'acct-1',
      text(AGENT)
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({
      status: 409,
      code: 'claimed_by_other',
      ownership: { ownerId: 'agent-hank', ownerName: 'Hank Agent' },
    });
    expect(meta).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it.each(['admin', 'owner'] as const)(
    "lets an %s reply to a teammate's customer without claiming, labelled Admin",
    async (role) => {
      const meta = await metaText();
      const captured: CapturedWrites = {};
      const rpc = vi.fn<RpcFake>();

      await sendMessageToConversation(
        sendPathDb([], captured, OWNED_BY_TEAMMATE, rpc),
        'acct-1',
        text({ userId: 'boss', role, claimVia: 'session' })
      );

      expect(meta).toHaveBeenCalledTimes(1);
      // No claim RPC ⇒ the owner is untouched.
      expect(rpc).not.toHaveBeenCalled();
      expect(captured.message?.sent_as_admin).toBe(true);
    }
  );

  it('also never claims when an admin replies to an Unassigned customer', async () => {
    const captured: CapturedWrites = {};
    const rpc = vi.fn<RpcFake>();
    await sendMessageToConversation(
      sendPathDb([], captured, UNASSIGNED, rpc),
      'acct-1',
      text({ userId: 'boss', role: 'admin', claimVia: 'session' })
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claims through claim_contact_as for a public-API key's creator", async () => {
    const captured: CapturedWrites = {};
    const rpc = vi.fn<RpcFake>(async () => ({
      data: [{ claimed: true, owner_id: 'agent-me', owner_name: 'Me' }],
      error: null,
    }));
    await sendMessageToConversation(
      sendPathDb([], captured, UNASSIGNED, rpc),
      'acct-1',
      text({ userId: 'agent-me', role: 'agent', claimVia: 'service' })
    );
    expect(rpc).toHaveBeenCalledWith('claim_contact_as', {
      p_contact_id: 'ct-1',
      p_actor_id: 'agent-me',
      p_source: 'api',
    });
  });

  it('refuses viewers and keys whose creator left', async () => {
    const meta = await metaText();
    for (const actor of [
      { userId: 'v', role: 'viewer', claimVia: 'session' },
      { userId: null, role: null, claimVia: 'service' },
    ] satisfies SendActor[]) {
      const err = await sendMessageToConversation(
        sendPathDb([], {}, UNASSIGNED, vi.fn<RpcFake>()),
        'acct-1',
        text(actor)
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 403, code: 'forbidden' });
    }
    expect(meta).not.toHaveBeenCalled();
  });
});
