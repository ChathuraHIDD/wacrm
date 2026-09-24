# Claim & Lock: one owner per customer in the shared inbox

The company has one WhatsApp number, and the whole sales team works from one shared inbox. Claim & Lock makes sure every customer is handled by exactly one sales agent, so two agents never answer the same customer and "won" credit goes to the right person.

Migration: `supabase/migrations/043_claim_and_lock.sql` (rollback: `supabase/rollbacks/043_claim_and_lock.down.sql`).

## The rules

| | Read the chat | Reply | Take a customer | Assign / transfer / release |
|---|---|---|---|---|
| **Agent**, own customer | ✅ | ✅ | — | ❌ |
| **Agent**, Unassigned customer | ✅ | ✅ (the first reply claims it) | ✅ | ❌ |
| **Agent**, a teammate's customer | ✅ (read-only) | ❌ | ❌ | ❌ |
| **Owner / Admin** | ✅ | ✅ everywhere, labelled **Admin** | ❌ never owns | ✅ (to agents only) |
| **Viewer** | ✅ | ❌ | ❌ | ❌ |
| **Bots** (automations, flows, AI) | — | ✅ | ❌ never claim | only fill an *empty* slot, only with an agent |

1. **A new customer is Unassigned** and visible to every agent.
2. **The first agent wins.** An agent becomes the owner by pressing **Take this customer** or by sending the first reply. Just opening a chat never claims it.
3. **Ownership belongs to the customer (the contact), not the conversation.** If the customer writes again later, the chat goes to the same owner.
4. **Other agents can read but not send.** They see "🔒 *Name* is handling this customer", and their reply box is disabled.
5. **Admins reply without owning.** Owners and admins can reply to anyone. Their messages carry an **Admin** badge, and the customer's owner never changes. Admins never own customers.
6. **Only admins move customers.** They can assign, transfer to another agent, or release back to Unassigned. Every claim, assignment, transfer and release is written to the audit log.
7. **Bots never claim.**

## How it works

### The data
- **`contacts.owner_id`** is the only source of truth. `NULL` means Unassigned.
- **`conversations.assigned_agent_id`** is *derived* from it by a trigger (`derive_conversation_assignee`). Anything that already read the assignee keeps working unchanged, including notifications, the AI bot's "a human owns this" check, `/api/v1` and the dashboard. Because realtime is already enabled on `conversations`, every open inbox sees ownership changes instantly. Writes to this column are silently re-derived, so the browser can't fake an assignment.
- **`contact_ownership_events`** is the append-only audit log. Admins can read it. Nobody can write to it directly.
- **`messages.sent_as_admin`** drives the Admin badge. The database refuses it from non-admins.

### The atomic claim
```sql
UPDATE contacts SET owner_id = <agent> WHERE id = <contact> AND owner_id IS NULL
```
The first transaction takes the row lock. Any concurrent claimer waits on that lock. When it gets the lock, Postgres re-checks the `WHERE` against the committed row, finds an owner already set, and updates nothing. `claim_contact` then tells every caller who won. Of any number of simultaneous clicks or replies, **exactly one** succeeds. `src/lib/ownership/claim-and-lock.db.test.ts` proves this against a real database with 12 agents claiming at once.

### Database functions (migration 043)
| Function | Who may call | What it does |
|---|---|---|
| `claim_contact(contact, source)` | signed-in agents | Atomic claim. Returns `{claimed, owner_id, owner_name}`. |
| `claim_contact_as(contact, actor, source)` | server (service role) | The same claim for public-API keys, which have no user session. |
| `set_contact_owner(contact, new_owner, note)` | owners/admins | Assign, transfer or release (`new_owner = NULL`). The target must be an agent. |
| `system_assign_contact(contact, agent, source)` | server (service role) | Bot routing: fills an *empty* slot with an *agent*, never overrides an owner. |

On claim, assign or transfer, the contact's **open** deals move to the new owner. Won and lost deals keep their credit. If an agent is demoted or removed from the account, their customers are released to Unassigned, and that is logged too.

### Three layers of enforcement
1. **Database (RLS and triggers).** Only the owner or an admin may insert, update or delete a thread's messages or reactions. Non-owners can't close a claimed customer's conversation or mark it read. `owner_id` can't be written directly. Deals of an owned customer can't be moved to someone else by a non-admin.
2. **Server.** Every sending path checks ownership **before anything reaches WhatsApp** (`src/lib/ownership/permissions.ts`):

   | Path | Behaviour |
   |---|---|
   | Inbox send (`/api/whatsapp/send`) and the contact page "Send template" | Non-owner: `403 not_owner`. An agent's first reply to an Unassigned customer claims it; a lost race returns `409 claimed_by_other` and **nothing is sent**. |
   | Public API `POST /api/v1/messages`, and therefore MCP | Same rules. The key acts for its creator with their current role. |
   | Reactions (`/api/whatsapp/react`) | An agent must already own the customer. Never claims. |
   | Broadcasts: dashboard, resume, `POST /api/v1/broadcasts` | Never claim. An agent's broadcast **skips** customers owned by teammates and records the reason as `Skipped: <name> is handling this customer`. An admin's broadcast reaches everyone. |
   | AI banner "Take over" / "Resume AI" | Take over claims (agents). Resume on a claimed customer releases it, which only an admin may do. |
   | Automations (`assign_conversation`, round-robin), AI handoff, Flows handoff | `system_assign_contact`: only Unassigned customers, only agents. |
   | Automation / Flow / AI **replies** | Bot sends never claim. |
3. **UI.**
   - The inbox has **Unassigned / Mine / Team** tabs. Admins get **All / Unassigned / Team** plus a filter by agent.
   - Agents on an Unassigned customer see a **Take this customer** button.
   - Admins get an **Assign / Transfer / Release** menu that lists agents only.
   - Non-owners see a lock banner, and their composer and status menu are disabled.
   - When a send loses the race, the agent sees who took the customer and **their typed draft goes back into the reply box**.

## Deploying

1. Apply `043_claim_and_lock.sql` after migrations `001`–`042`. It is additive and safe to run twice. It **backfills** ownership:
   - an existing conversation assignment to an **agent** becomes that customer's owner;
   - assignments to owners or admins are cleared, because admins can't own customers. They are logged with `source = 'migration'`, so the rollback can restore them.
2. Deploy the app. There are no new environment variables.
3. Check it worked: run `select action, count(*) from contact_ownership_events group by 1;` to see the backfill rows. `supabase/ci/verify-schema.sql` also asserts that the new objects exist.

**Rollback:** run `supabase/rollbacks/043_claim_and_lock.down.sql` in the SQL editor, then deploy the previous app version. The header of that file lists exactly what it restores, and what it can't (the audit log and the Admin labels).

## Testing

- `npm test` runs the unit and route tests: permission rules, send-core enforcement (non-owner rejected before Meta, lost race gets 409 and nothing is sent, admin reply keeps the owner), the claim and owner routes (only admins can transfer), broadcasts, and bot routing.
- The database suite runs against a real Postgres with all migrations applied. It covers the claim race, RLS, transfer permissions, deals and demotion:
  ```bash
  supabase start
  TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
    npx vitest run src/lib/ownership/claim-and-lock.db.test.ts
  ```
  CI runs it in the Migrations workflow.

## Edge cases

- **Closing a conversation does not release the customer.** A returning customer goes back to the same owner. Use **Release** to put them back in the queue.
- **Owner leaves the team or is demoted:** their customers are released automatically.
- **API key whose creator has left:** it can't send at all (`403 forbidden`). Issue a new key.
- **Admin replies to an Unassigned customer:** the customer stays Unassigned, and the message is labelled Admin.
- **AI auto-reply** still stops as soon as a customer has an owner.
