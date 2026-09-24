-- ============================================================
-- ROLLBACK for 043_claim_and_lock.sql
--
-- Lives outside supabase/migrations/ on purpose: the Supabase CLI
-- applies every file in that folder, and this must only ever run by
-- hand. Run it in the SQL editor (it is one transaction), THEN deploy
-- the app version from before Claim & Lock — the new app code calls
-- functions this script removes.
--
-- What it restores
--   - The pre-043 RLS policies (verbatim from migration 017).
--   - conversations.assigned_agent_id: every conversation is assigned
--     to its contact's current owner, and conversations the migration
--     cleared (assignee was an admin/owner) get that assignee back
--     from the audit log.
--
-- What it cannot restore
--   - contact_ownership_events is dropped. Export it first if you
--     want the history:  COPY (SELECT * FROM contact_ownership_events)
--   - messages.sent_as_admin is dropped (the "Admin" labels go).
--   - Deals already moved to a new owner stay with that owner.
-- ============================================================
BEGIN;

-- Triggers first, so the data fix-up below isn't re-derived.
DROP TRIGGER IF EXISTS derive_conversation_assignee ON conversations;
DROP TRIGGER IF EXISTS sync_contact_owner ON contacts;
DROP TRIGGER IF EXISTS guard_contact_owner_columns ON contacts;
DROP TRIGGER IF EXISTS guard_deal_assignee ON deals;
DROP TRIGGER IF EXISTS release_contacts_on_member_change ON profiles;

-- Conversations keep today's ownership as a plain assignment…
UPDATE conversations cv
SET assigned_agent_id = ct.owner_id
FROM contacts ct
WHERE ct.id = cv.contact_id
  AND ct.owner_id IS NOT NULL
  AND cv.assigned_agent_id IS DISTINCT FROM ct.owner_id;

-- …and the ones 043 cleared get their original assignee back.
UPDATE conversations cv
SET assigned_agent_id = ev.from_user_id
FROM contact_ownership_events ev
JOIN contacts ct ON ct.id = ev.contact_id
WHERE ev.source = 'migration'
  AND ev.action = 'release'
  AND ev.contact_id = cv.contact_id
  AND ct.owner_id IS NULL
  AND cv.assigned_agent_id IS NULL;

-- RLS back to migration 017.
DROP POLICY IF EXISTS messages_insert ON messages;
DROP POLICY IF EXISTS messages_update ON messages;
DROP POLICY IF EXISTS messages_delete ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent'))
);

DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
  )
);

DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_delete ON conversations FOR DELETE USING (is_account_member(account_id, 'agent'));

-- Functions.
DROP FUNCTION IF EXISTS public.claim_contact(UUID, TEXT);
DROP FUNCTION IF EXISTS public.claim_contact_as(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public._claim_contact(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.set_contact_owner(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.system_assign_contact(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.can_reply_in_conversation(UUID);
DROP FUNCTION IF EXISTS public.can_manage_contact_thread(UUID, UUID);
DROP FUNCTION IF EXISTS public.account_role_of(UUID, UUID);
DROP FUNCTION IF EXISTS public.member_display_name(UUID);
DROP FUNCTION IF EXISTS public.guard_contact_owner_columns();
DROP FUNCTION IF EXISTS public.sync_contact_owner();
DROP FUNCTION IF EXISTS public.derive_conversation_assignee();
DROP FUNCTION IF EXISTS public.guard_deal_assignee();
DROP FUNCTION IF EXISTS public.release_contacts_on_member_change();

-- Schema.
DROP TABLE IF EXISTS contact_ownership_events;
DROP INDEX IF EXISTS idx_contacts_account_owner;
ALTER TABLE messages DROP COLUMN IF EXISTS sent_as_admin;
ALTER TABLE contacts DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE contacts DROP COLUMN IF EXISTS owner_id;

-- Let the Supabase CLI forget 043 so a later `db push` re-applies it
-- (skipped when migrations were pasted into the SQL editor instead).
DO $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations WHERE version = '043';
  END IF;
END $$;

COMMIT;
