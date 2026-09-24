-- ============================================================
-- 043_claim_and_lock.sql — contact-level ownership for the shared
--                            inbox ("Claim & Lock")
--
-- One company number, many agents, one shared inbox. A customer
-- (contact) starts Unassigned. The first AGENT to press "Take this
-- customer" or to send the first reply becomes its owner, atomically.
-- From then on:
--   - the owner reads + replies;
--   - other agents read only;
--   - owners/admins read + reply to everything, but never OWN a
--     customer — their replies never change ownership;
--   - only owners/admins assign, transfer or release.
-- Bots (automations, flows, AI auto-reply) never claim; their routing
-- steps may only assign a customer nobody owns yet.
--
-- What this migration adds
--   1. contacts.owner_id / claimed_at — the single source of truth.
--   2. messages.sent_as_admin — drives the "Admin" label in threads.
--   3. contact_ownership_events — append-only audit log (admin-read).
--   4. Backfill: an existing conversation assignment to an AGENT
--      becomes that contact's owner; assignments to admins/owners are
--      cleared (admins can't own). Every change is logged so the
--      rollback script can restore it.
--   5. Atomic functions: claim_contact, claim_contact_as,
--      set_contact_owner, system_assign_contact.
--   6. Triggers:
--        - contacts.owner_id is writable only through (5);
--        - conversations.assigned_agent_id is DERIVED from the
--          contact's owner (legacy readers — notifications 027, the AI
--          bot's "a human owns this" gate, /api/v1, the dashboard —
--          keep working unchanged, and realtime on `conversations`
--          broadcasts every ownership change to open inboxes);
--        - a claim/transfer moves the contact's OPEN deals to the new
--          owner (won/lost keep their credit);
--        - an agent who is demoted/removed releases their customers.
--   7. RLS: only the owner or an admin may insert/update/delete a
--      thread's messages or reactions; only the owner or an admin may
--      update/delete a claimed conversation (unclaimed ones stay
--      editable by every agent).
--
-- Why a plain UPDATE is race-safe
--   `UPDATE contacts SET owner_id = $me WHERE id = $c AND owner_id IS
--   NULL` takes the row lock. A concurrent claimer blocks on it, then
--   re-evaluates the WHERE against the committed row (READ COMMITTED
--   EvalPlanQual), finds owner_id set, and updates nothing. Exactly one
--   caller wins; everyone gets told who did.
--
-- Safe on a live database: additive columns (metadata-only defaults),
-- guarded DDL, idempotent backfill. Rollback:
-- supabase/rollbacks/043_claim_and_lock.down.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1–2. Columns
-- ------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN contacts.owner_id IS
  'Agent who owns this customer (Claim & Lock, migration 043). NULL = Unassigned. Written only by claim_contact / claim_contact_as / set_contact_owner / system_assign_contact.';

CREATE INDEX IF NOT EXISTS idx_contacts_account_owner
  ON contacts(account_id, owner_id);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sent_as_admin BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN messages.sent_as_admin IS
  'True when an owner/admin sent this reply (they never own the customer). Drives the "Admin" label in the thread.';

-- ------------------------------------------------------------
-- 3. Audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_ownership_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  action TEXT NOT NULL
    CHECK (action IN ('claim', 'assign', 'transfer', 'release', 'backfill')),
  -- Where it came from: take_button | first_reply | ai_takeover | api |
  -- admin | round_robin | ai_handoff | flow_handoff | member_change |
  -- migration. Free text so a new source needs no migration.
  source TEXT NOT NULL,
  from_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  to_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- NULL = the system (a bot, a trigger, this migration).
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_ownership_events_account_created
  ON contact_ownership_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_ownership_events_contact_created
  ON contact_ownership_events(contact_id, created_at DESC);

ALTER TABLE contact_ownership_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_ownership_events_select ON contact_ownership_events;
CREATE POLICY contact_ownership_events_select ON contact_ownership_events
  FOR SELECT USING (is_account_member(account_id, 'admin'));
-- No client write policy: rows are written only by the SECURITY
-- DEFINER functions below. Belt and braces on top of RLS:
REVOKE INSERT, UPDATE, DELETE ON contact_ownership_events FROM anon, authenticated;

-- ------------------------------------------------------------
-- 4. Backfill (before the triggers exist, so it neither moves deals
--    nor fires the guards). Idempotent: only unowned contacts are
--    touched and only real changes are logged.
-- ------------------------------------------------------------
WITH src AS (
  SELECT DISTINCT ON (cv.contact_id)
         cv.contact_id, cv.assigned_agent_id
  FROM conversations cv
  JOIN profiles p
    ON p.user_id = cv.assigned_agent_id
   AND p.account_id = cv.account_id
   AND p.account_role = 'agent'
  WHERE cv.assigned_agent_id IS NOT NULL
  ORDER BY cv.contact_id, cv.last_message_at DESC NULLS LAST
), upd AS (
  UPDATE contacts c
  SET owner_id = src.assigned_agent_id,
      claimed_at = NOW()
  FROM src
  WHERE c.id = src.contact_id
    AND c.owner_id IS NULL
  RETURNING c.id, c.account_id, c.owner_id
)
INSERT INTO contact_ownership_events
  (account_id, contact_id, action, source, from_user_id, to_user_id, actor_user_id, note)
SELECT account_id, id, 'backfill', 'migration', NULL, owner_id, NULL,
       'Existing conversation assignment kept as owner'
FROM upd;

-- Assignments that did NOT become an owner (assignee is an owner/admin
-- or no longer an agent of the account). Log them — the rollback
-- script restores `conversations.assigned_agent_id` from these rows —
-- then align every conversation with its contact's owner.
INSERT INTO contact_ownership_events
  (account_id, contact_id, action, source, from_user_id, to_user_id, actor_user_id, note)
SELECT cv.account_id, cv.contact_id, 'release', 'migration', cv.assigned_agent_id, NULL, NULL,
       'Assignee is not an agent; customer starts Unassigned'
FROM conversations cv
JOIN contacts ct ON ct.id = cv.contact_id
WHERE cv.assigned_agent_id IS NOT NULL
  AND ct.owner_id IS NULL;

UPDATE conversations cv
SET assigned_agent_id = ct.owner_id
FROM contacts ct
WHERE ct.id = cv.contact_id
  AND cv.assigned_agent_id IS DISTINCT FROM ct.owner_id;

-- ------------------------------------------------------------
-- 5. Functions
-- ------------------------------------------------------------

-- Caller-independent role lookup. Internal only.
CREATE OR REPLACE FUNCTION public.account_role_of(p_user_id UUID, p_account_id UUID)
RETURNS account_role_enum
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.account_role
  FROM profiles p
  WHERE p.user_id = p_user_id
    AND p.account_id = p_account_id;
$$;

-- Display name for an owner badge / "X is handling this customer".
CREATE OR REPLACE FUNCTION public.member_display_name(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email)
  FROM profiles p
  WHERE p.user_id = p_user_id;
$$;

-- The atomic claim. Internal: callers go through claim_contact (session)
-- or claim_contact_as (server, public API).
CREATE OR REPLACE FUNCTION public._claim_contact(
  p_contact_id UUID,
  p_actor_id UUID,
  p_source TEXT
)
RETURNS TABLE (claimed BOOLEAN, owner_id UUID, owner_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account_id UUID;
  v_role account_role_enum;
  v_won UUID;
  v_owner UUID;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT c.account_id INTO v_account_id FROM contacts c WHERE c.id = p_contact_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = 'P0002';
  END IF;

  v_role := public.account_role_of(p_actor_id, v_account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF v_role <> 'agent' THEN
    RAISE EXCEPTION 'Only agents can take customers (your role: %)', v_role
      USING ERRCODE = '42501';
  END IF;

  UPDATE contacts c
  SET owner_id = p_actor_id,
      claimed_at = NOW()
  WHERE c.id = p_contact_id
    AND c.owner_id IS NULL
  RETURNING c.id INTO v_won;

  IF v_won IS NOT NULL THEN
    INSERT INTO contact_ownership_events
      (account_id, contact_id, action, source, from_user_id, to_user_id, actor_user_id)
    VALUES
      (v_account_id, p_contact_id, 'claim', p_source, NULL, p_actor_id, p_actor_id);
  END IF;

  -- New statement → new snapshot: sees the winner even when we lost.
  SELECT c.owner_id INTO v_owner FROM contacts c WHERE c.id = p_contact_id;

  RETURN QUERY
    SELECT (v_owner IS NOT DISTINCT FROM p_actor_id),
           v_owner,
           public.member_display_name(v_owner);
END;
$$;

-- Session claim: "Take this customer", auto-claim on first reply, and
-- the AI banner's "Take over". Returns whether the CALLER owns it now.
CREATE OR REPLACE FUNCTION public.claim_contact(
  p_contact_id UUID,
  p_source TEXT DEFAULT 'take_button'
)
RETURNS TABLE (claimed BOOLEAN, owner_id UUID, owner_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_source NOT IN ('take_button', 'first_reply', 'ai_takeover') THEN
    RAISE EXCEPTION 'Invalid claim source: %', p_source USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM public._claim_contact(p_contact_id, auth.uid(), p_source);
END;
$$;

-- Server-side claim for callers without a session (public API keys act
-- for the member who created them). service_role only.
CREATE OR REPLACE FUNCTION public.claim_contact_as(
  p_contact_id UUID,
  p_actor_id UUID,
  p_source TEXT DEFAULT 'api'
)
RETURNS TABLE (claimed BOOLEAN, owner_id UUID, owner_name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public._claim_contact(p_contact_id, p_actor_id, p_source);
$$;

-- Admin assign / transfer / release. p_new_owner NULL = release.
CREATE OR REPLACE FUNCTION public.set_contact_owner(
  p_contact_id UUID,
  p_new_owner_id UUID,
  p_note TEXT DEFAULT NULL
)
RETURNS TABLE (owner_id UUID, owner_name TEXT, action TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account_id UUID;
  v_old UUID;
  v_action TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT c.account_id, c.owner_id INTO v_account_id, v_old
  FROM contacts c
  WHERE c.id = p_contact_id
  FOR UPDATE;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'Only an owner or admin can assign, transfer or release customers'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_id IS NOT NULL
     AND public.account_role_of(p_new_owner_id, v_account_id) IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'Customers can only be assigned to agents of this account'
      USING ERRCODE = '22023';
  END IF;

  IF p_new_owner_id IS NOT DISTINCT FROM v_old THEN
    RETURN QUERY SELECT v_old, public.member_display_name(v_old), 'none'::TEXT;
    RETURN;
  END IF;

  UPDATE contacts c
  SET owner_id = p_new_owner_id,
      claimed_at = CASE WHEN p_new_owner_id IS NULL THEN NULL ELSE NOW() END
  WHERE c.id = p_contact_id;

  v_action := CASE
    WHEN v_old IS NULL THEN 'assign'
    WHEN p_new_owner_id IS NULL THEN 'release'
    ELSE 'transfer'
  END;

  INSERT INTO contact_ownership_events
    (account_id, contact_id, action, source, from_user_id, to_user_id, actor_user_id, note)
  VALUES
    (v_account_id, p_contact_id, v_action, 'admin', v_old, p_new_owner_id, auth.uid(), p_note);

  RETURN QUERY SELECT p_new_owner_id, public.member_display_name(p_new_owner_id), v_action;
END;
$$;

-- Bot routing (round-robin automation step, AI handoff, flow handoff).
-- Only ever fills an EMPTY owner slot, only with an agent. service_role.
CREATE OR REPLACE FUNCTION public.system_assign_contact(
  p_contact_id UUID,
  p_agent_id UUID,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account_id UUID;
  v_won UUID;
BEGIN
  SELECT c.account_id INTO v_account_id FROM contacts c WHERE c.id = p_contact_id;
  IF v_account_id IS NULL OR p_agent_id IS NULL THEN
    RETURN false;
  END IF;
  IF public.account_role_of(p_agent_id, v_account_id) IS DISTINCT FROM 'agent' THEN
    RETURN false;
  END IF;

  UPDATE contacts c
  SET owner_id = p_agent_id,
      claimed_at = NOW()
  WHERE c.id = p_contact_id
    AND c.owner_id IS NULL
  RETURNING c.id INTO v_won;

  IF v_won IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO contact_ownership_events
    (account_id, contact_id, action, source, from_user_id, to_user_id, actor_user_id)
  VALUES
    (v_account_id, p_contact_id, 'assign', p_source, NULL, p_agent_id, NULL);
  RETURN true;
END;
$$;

-- RLS helpers. Evaluated as the querying user, so granted to
-- `authenticated`; each reveals only a boolean about the caller.
--
-- May the caller post into this thread? Owner or admin.
CREATE OR REPLACE FUNCTION public.can_reply_in_conversation(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM conversations cv
    JOIN contacts ct ON ct.id = cv.contact_id
    WHERE cv.id = p_conversation_id
      AND (
        public.is_account_member(cv.account_id, 'admin')
        OR (public.is_account_member(cv.account_id, 'agent') AND ct.owner_id = auth.uid())
      )
  );
$$;

-- May the caller change this conversation (status, unread, delete)?
-- Admin, the owner, or any agent while the customer is Unassigned.
CREATE OR REPLACE FUNCTION public.can_manage_contact_thread(p_account_id UUID, p_contact_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_account_member(p_account_id, 'admin')
      OR (
        public.is_account_member(p_account_id, 'agent')
        AND EXISTS (
          SELECT 1 FROM contacts ct
          WHERE ct.id = p_contact_id
            AND (ct.owner_id IS NULL OR ct.owner_id = auth.uid())
        )
      );
$$;

-- Grants. SECURITY DEFINER functions default to EXECUTE for PUBLIC on
-- Supabase, so revoke explicitly and grant only what each caller needs.
REVOKE ALL ON FUNCTION public.account_role_of(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.member_display_name(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._claim_contact(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_contact(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_contact_as(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_contact_owner(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.system_assign_contact(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_reply_in_conversation(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_contact_thread(UUID, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.account_role_of(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.member_display_name(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_contact(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_as(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_contact_owner(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.system_assign_contact(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.can_reply_in_conversation(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_contact_thread(UUID, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Triggers
-- ------------------------------------------------------------

-- 6a. contacts.owner_id / claimed_at only change through the functions
-- above (which run as postgres). Same `current_user` discriminator as
-- migration 034.
CREATE OR REPLACE FUNCTION public.guard_contact_owner_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' AND (NEW.owner_id IS NOT NULL OR NEW.claimed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'A new contact cannot be created with an owner; use claim_contact'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.owner_id IS DISTINCT FROM OLD.owner_id
                             OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at) THEN
      RAISE EXCEPTION 'Contact ownership cannot be changed directly; use claim_contact or set_contact_owner'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_contact_owner_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS guard_contact_owner_columns ON contacts;
CREATE TRIGGER guard_contact_owner_columns
  BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_contact_owner_columns();

-- 6b. Ownership change → mirror to the conversation, move OPEN deals.
CREATE OR REPLACE FUNCTION public.sync_contact_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN
    RETURN NEW;
  END IF;

  UPDATE conversations cv
  SET assigned_agent_id = NEW.owner_id
  WHERE cv.contact_id = NEW.id
    AND cv.account_id = NEW.account_id
    AND cv.assigned_agent_id IS DISTINCT FROM NEW.owner_id;

  -- Claim / assign / transfer: open deals follow the owner so "won"
  -- credit lands on the right agent. Release leaves deals as they are.
  IF NEW.owner_id IS NOT NULL THEN
    UPDATE deals d
    SET assigned_to = p.id
    FROM profiles p
    WHERE d.contact_id = NEW.id
      AND d.account_id = NEW.account_id
      AND d.status = 'open'
      AND p.user_id = NEW.owner_id
      AND d.assigned_to IS DISTINCT FROM p.id;
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_contact_owner() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_contact_owner ON contacts;
CREATE TRIGGER sync_contact_owner
  AFTER UPDATE OF owner_id ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.sync_contact_owner();

-- 6c. conversations.assigned_agent_id is derived, never set directly. A
-- returning customer's new conversation lands on the same owner, and
-- any legacy writer (or a browser) setting it is silently corrected.
CREATE OR REPLACE FUNCTION public.derive_conversation_assignee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.assigned_agent_id := (
    SELECT ct.owner_id FROM contacts ct WHERE ct.id = NEW.contact_id
  );
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.derive_conversation_assignee() OWNER TO postgres;

DROP TRIGGER IF EXISTS derive_conversation_assignee ON conversations;
CREATE TRIGGER derive_conversation_assignee
  BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.derive_conversation_assignee();

-- 6d. Deals: a deal created for an owned customer defaults to the
-- owner. A non-admin may not move a deal of an owned customer to
-- anyone but that owner (protects "won" credit).
CREATE OR REPLACE FUNCTION public.guard_deal_assignee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_profile UUID;
BEGIN
  IF NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.id INTO v_owner_profile
  FROM contacts ct
  JOIN profiles p ON p.user_id = ct.owner_id
  WHERE ct.id = NEW.contact_id;

  IF v_owner_profile IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NULL
       OR (auth.uid() IS NOT NULL AND NOT public.is_account_member(NEW.account_id, 'admin')) THEN
      NEW.assigned_to := v_owner_profile;
    END IF;
  ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
        AND NEW.assigned_to IS DISTINCT FROM v_owner_profile
        AND auth.uid() IS NOT NULL
        AND NOT public.is_account_member(NEW.account_id, 'admin') THEN
    RAISE EXCEPTION 'This customer is owned by another agent; only an admin can reassign its deals'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_deal_assignee() OWNER TO postgres;

DROP TRIGGER IF EXISTS guard_deal_assignee ON deals;
CREATE TRIGGER guard_deal_assignee
  BEFORE INSERT OR UPDATE OF assigned_to ON deals
  FOR EACH ROW EXECUTE FUNCTION public.guard_deal_assignee();

-- 6e. An agent who is demoted or leaves the account releases their
-- customers back to Unassigned (logged), so nobody is stuck owned by a
-- non-agent.
CREATE OR REPLACE FUNCTION public.release_contacts_on_member_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.account_role = 'agent'
     AND (NEW.account_role IS DISTINCT FROM 'agent'
          OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
    WITH released AS (
      UPDATE contacts c
      SET owner_id = NULL,
          claimed_at = NULL
      WHERE c.account_id = OLD.account_id
        AND c.owner_id = OLD.user_id
      RETURNING c.id
    )
    INSERT INTO contact_ownership_events
      (account_id, contact_id, action, source, from_user_id, to_user_id, actor_user_id, note)
    SELECT OLD.account_id, released.id, 'release', 'member_change', OLD.user_id, NULL, auth.uid(),
           'Agent was removed or changed role'
    FROM released;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.release_contacts_on_member_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS release_contacts_on_member_change ON profiles;
CREATE TRIGGER release_contacts_on_member_change
  AFTER UPDATE OF account_id, account_role ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.release_contacts_on_member_change();

-- ------------------------------------------------------------
-- 7. RLS
-- ------------------------------------------------------------

-- messages: was one agent-level FOR ALL policy (017).
DROP POLICY IF EXISTS messages_modify ON messages;
DROP POLICY IF EXISTS messages_insert ON messages;
DROP POLICY IF EXISTS messages_update ON messages;
DROP POLICY IF EXISTS messages_delete ON messages;
CREATE POLICY messages_insert ON messages FOR INSERT WITH CHECK (
  public.can_reply_in_conversation(conversation_id)
  -- Only an admin may stamp the "Admin" label.
  AND (
    sent_as_admin = false
    OR EXISTS (
      SELECT 1 FROM conversations cv
      WHERE cv.id = messages.conversation_id
        AND public.is_account_member(cv.account_id, 'admin')
    )
  )
);
CREATE POLICY messages_update ON messages FOR UPDATE
  USING (public.can_reply_in_conversation(conversation_id))
  WITH CHECK (public.can_reply_in_conversation(conversation_id));
CREATE POLICY messages_delete ON messages FOR DELETE
  USING (public.can_reply_in_conversation(conversation_id));

-- message_reactions: an outbound reaction is a message to the customer.
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_reactions.message_id
      AND public.can_reply_in_conversation(m.conversation_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_reactions.message_id
      AND public.can_reply_in_conversation(m.conversation_id)
  )
);

-- conversations: non-owners can't close, reopen, mark read or delete a
-- claimed customer's thread.
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (public.can_manage_contact_thread(account_id, contact_id))
  WITH CHECK (public.can_manage_contact_thread(account_id, contact_id));
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (public.can_manage_contact_thread(account_id, contact_id));
