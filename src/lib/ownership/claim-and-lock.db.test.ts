import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Database-level tests for Claim & Lock (migration 043). These run the real
// SQL — the atomic claim, the RLS policies, the triggers — against a
// Postgres that has every migration applied:
//
//   supabase start                      # or the migrations CI job
//   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run src/lib/ownership/claim-and-lock.db.test.ts
//
// Skipped when TEST_DATABASE_URL is unset (plain `npm test`). Every run
// creates its own users/account/contacts under fresh UUIDs, so it never
// collides with other data in the database.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.TEST_DATABASE_URL

interface ClaimRow {
  claimed: boolean
  owner_id: string | null
  owner_name: string | null
}

interface PgError {
  code?: string
  message: string
}

function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'message' in err
}

describe.skipIf(!DATABASE_URL)('Claim & Lock (database)', () => {
  let pool: Pool

  // Members of one shared account.
  const owner = randomUUID()
  const admin = randomUUID()
  const agentA = randomUUID()
  const agentB = randomUUID()
  const viewer = randomUUID()
  // Extra agents for the many-way race.
  const racers = Array.from({ length: 12 }, () => randomUUID())

  let accountId: string
  let pipelineId: string
  let stageId: string

  /** Run `fn` inside a transaction as `userId` through the `authenticated` role. */
  async function asUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await startSession(client, userId)
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async function startSession(client: PoolClient, userId: string): Promise<void> {
    // Supabase's auth.uid() reads either of these, depending on version.
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
      [userId],
    )
    await client.query('SET LOCAL ROLE authenticated')
  }

  /** Expect `fn` to fail with a Postgres error, returning it. */
  async function expectPgError(fn: () => Promise<unknown>): Promise<PgError> {
    try {
      await fn()
    } catch (err) {
      if (isPgError(err)) return err
      throw err
    }
    throw new Error('expected a database error, but the call succeeded')
  }

  /** A fresh unowned customer with one conversation and two deals. */
  async function makeCustomer(): Promise<{ contactId: string; conversationId: string; openDealId: string; wonDealId: string }> {
    const contactId = randomUUID()
    const conversationId = randomUUID()
    const openDealId = randomUUID()
    const wonDealId = randomUUID()
    const phone = `+1555${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`
    await pool.query(
      `INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES ($1, $2, $3, $4, 'Test customer')`,
      [contactId, owner, accountId, phone],
    )
    await pool.query(
      `INSERT INTO conversations (id, user_id, account_id, contact_id, last_message_at) VALUES ($1, $2, $3, $4, now())`,
      [conversationId, owner, accountId, contactId],
    )
    await pool.query(
      `INSERT INTO deals (id, user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status)
       VALUES ($1, $3, $4, $5, $6, $7, 'Open deal', 100, 'open'),
              ($2, $3, $4, $5, $6, $7, 'Won deal', 200, 'won')`,
      [openDealId, wonDealId, owner, accountId, pipelineId, stageId, contactId],
    )
    return { contactId, conversationId, openDealId, wonDealId }
  }

  async function ownerOf(contactId: string): Promise<string | null> {
    const { rows } = await pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM contacts WHERE id = $1',
      [contactId],
    )
    return rows[0]?.owner_id ?? null
  }

  async function profileIdOf(userId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM profiles WHERE user_id = $1', [userId])
    return rows[0].id
  }

  async function events(contactId: string): Promise<{ action: string; source: string; from_user_id: string | null; to_user_id: string | null; actor_user_id: string | null }[]> {
    const { rows } = await pool.query(
      `SELECT action, source, from_user_id, to_user_id, actor_user_id
       FROM contact_ownership_events WHERE contact_id = $1 ORDER BY created_at`,
      [contactId],
    )
    return rows
  }

  function insertAgentMessage(c: PoolClient, conversationId: string, senderId: string, sentAsAdmin = false) {
    return c.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text, status, sent_as_admin)
       VALUES ($1, 'agent', $2, 'text', 'hello', 'sent', $3)`,
      [conversationId, senderId, sentAsAdmin],
    )
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: racers.length + 4 })

    const members: [string, string, string][] = [
      [owner, 'Olivia Owner', 'owner'],
      [admin, 'Adam Admin', 'admin'],
      [agentA, 'Gina Agent', 'agent'],
      [agentB, 'Hank Agent', 'agent'],
      [viewer, 'Vera Viewer', 'viewer'],
      ...racers.map((id, i): [string, string, string] => [id, `Racer ${i}`, 'agent']),
    ]
    // The signup trigger gives each user a personal account + profile…
    for (const [id, name] of members) {
      await pool.query(
        `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, json_build_object('full_name', $3::text))`,
        [id, `${id}@claim-lock.test`, name],
      )
    }
    const { rows } = await pool.query<{ account_id: string }>(
      'SELECT account_id FROM profiles WHERE user_id = $1',
      [owner],
    )
    accountId = rows[0].account_id
    // …then everyone joins the owner's account, as redeem_invitation does.
    for (const [id, , role] of members) {
      if (id === owner) continue
      await pool.query(
        'UPDATE profiles SET account_id = $1, account_role = $2::account_role_enum WHERE user_id = $3',
        [accountId, role, id],
      )
    }

    pipelineId = randomUUID()
    stageId = randomUUID()
    await pool.query(
      `INSERT INTO pipelines (id, user_id, account_id, name) VALUES ($1, $2, $3, 'Claim test')`,
      [pipelineId, owner, accountId],
    )
    await pool.query(
      `INSERT INTO pipeline_stages (id, pipeline_id, name, position) VALUES ($1, $2, 'New', 0)`,
      [stageId, pipelineId],
    )
  })

  afterAll(async () => {
    if (!pool) return
    // Deleting the account cascades to its contacts/conversations/deals/events.
    await pool.query('DELETE FROM accounts WHERE id = $1', [accountId])
    const everyone = [owner, admin, agentA, agentB, viewer, ...racers]
    await pool.query('DELETE FROM accounts WHERE owner_user_id = ANY($1::uuid[])', [everyone])
    await pool.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [everyone])
    await pool.end()
  })

  let customer: Awaited<ReturnType<typeof makeCustomer>>
  beforeEach(async () => {
    customer = await makeCustomer()
  })

  // ------------------------------------------------------------------
  // The race
  // ------------------------------------------------------------------

  it('gives exactly one owner when many agents claim in the same instant', async () => {
    // Open every session first, then fire all claims together so they
    // genuinely contend for the row lock.
    const clients = await Promise.all(racers.map(() => pool.connect()))
    try {
      await Promise.all(
        clients.map(async (c, i) => {
          await c.query('BEGIN')
          await startSession(c, racers[i])
        }),
      )
      const results = await Promise.all(
        clients.map(async (c) => {
          const { rows } = await c.query<ClaimRow>(
            'SELECT * FROM claim_contact($1, $2)',
            [customer.contactId, 'take_button'],
          )
          await c.query('COMMIT')
          return rows[0]
        }),
      )

      const winners = results.filter((r) => r.claimed)
      expect(winners).toHaveLength(1)
      const winner = winners[0].owner_id
      // Every loser was told who won.
      for (const r of results) expect(r.owner_id).toBe(winner)
      expect(await ownerOf(customer.contactId)).toBe(winner)
      expect((await events(customer.contactId)).filter((e) => e.action === 'claim')).toHaveLength(1)
    } finally {
      for (const c of clients) c.release()
    }
  })

  it('makes a blocked claimer lose to the one that committed first', async () => {
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      await first.query('BEGIN')
      await startSession(first, agentA)
      await second.query('BEGIN')
      await startSession(second, agentB)

      const a = await first.query<ClaimRow>('SELECT * FROM claim_contact($1)', [customer.contactId])
      // agentB's claim blocks on agentA's uncommitted row lock…
      const pendingB = second.query<ClaimRow>('SELECT * FROM claim_contact($1)', [customer.contactId])
      await new Promise((resolve) => setTimeout(resolve, 150))
      await first.query('COMMIT')
      // …and, once it proceeds, sees the row already owned.
      const b = await pendingB
      await second.query('COMMIT')

      expect(a.rows[0]).toMatchObject({ claimed: true, owner_id: agentA })
      expect(b.rows[0]).toMatchObject({ claimed: false, owner_id: agentA, owner_name: 'Gina Agent' })
    } finally {
      first.release()
      second.release()
    }
  })

  it('treats a repeat claim by the owner as a no-op success', async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    const again = await asUser(agentA, (c) =>
      c.query<ClaimRow>('SELECT * FROM claim_contact($1)', [customer.contactId]),
    )
    expect(again.rows[0].claimed).toBe(true)
    expect(await events(customer.contactId)).toHaveLength(1)
  })

  it('refuses a claim from an admin, the owner role, or a viewer', async () => {
    for (const who of [admin, owner, viewer]) {
      const err = await expectPgError(() =>
        asUser(who, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId])),
      )
      expect(err.code).toBe('42501')
    }
    expect(await ownerOf(customer.contactId)).toBeNull()
  })

  // ------------------------------------------------------------------
  // Sending (RLS on messages)
  // ------------------------------------------------------------------

  it('rejects an outbound message from a non-owner agent at the database', async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))

    const err = await expectPgError(() =>
      asUser(agentB, (c) => insertAgentMessage(c, customer.conversationId, agentB)),
    )
    expect(err.message).toMatch(/row-level security/)

    await asUser(agentA, (c) => insertAgentMessage(c, customer.conversationId, agentA))
  })

  it('rejects an outbound message from an agent on an unclaimed customer (they must claim first)', async () => {
    const err = await expectPgError(() =>
      asUser(agentA, (c) => insertAgentMessage(c, customer.conversationId, agentA)),
    )
    expect(err.message).toMatch(/row-level security/)
  })

  it("lets an admin reply to someone else's customer without changing the owner", async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))

    await asUser(admin, (c) => insertAgentMessage(c, customer.conversationId, admin, true))

    expect(await ownerOf(customer.contactId)).toBe(agentA)
    const { rows } = await pool.query<{ sent_as_admin: boolean }>(
      'SELECT sent_as_admin FROM messages WHERE conversation_id = $1 AND sender_id = $2',
      [customer.conversationId, admin],
    )
    expect(rows).toEqual([{ sent_as_admin: true }])
  })

  it('does not let an agent forge the Admin label', async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    const err = await expectPgError(() =>
      asUser(agentA, (c) => insertAgentMessage(c, customer.conversationId, agentA, true)),
    )
    expect(err.message).toMatch(/row-level security/)
  })

  // ------------------------------------------------------------------
  // Ownership can't be changed behind the functions' back
  // ------------------------------------------------------------------

  it('blocks direct writes to contacts.owner_id', async () => {
    const err = await expectPgError(() =>
      asUser(agentA, (c) =>
        c.query('UPDATE contacts SET owner_id = $1 WHERE id = $2', [agentA, customer.contactId]),
      ),
    )
    expect(err.code).toBe('42501')
  })

  it('derives conversations.assigned_agent_id from the owner and ignores direct writes', async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    // An admin may update the thread, but the assignee is re-derived.
    await asUser(admin, (c) =>
      c.query('UPDATE conversations SET assigned_agent_id = $1 WHERE id = $2', [agentB, customer.conversationId]),
    )
    const { rows } = await pool.query<{ assigned_agent_id: string }>(
      'SELECT assigned_agent_id FROM conversations WHERE id = $1',
      [customer.conversationId],
    )
    expect(rows[0].assigned_agent_id).toBe(agentA)
  })

  it("stops a non-owner agent from closing or marking read a claimed customer's thread", async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    const res = await asUser(agentB, (c) =>
      c.query(`UPDATE conversations SET status = 'closed', unread_count = 0 WHERE id = $1`, [customer.conversationId]),
    )
    expect(res.rowCount).toBe(0)
  })

  it('still lets any agent manage an unclaimed thread', async () => {
    const res = await asUser(agentB, (c) =>
      c.query(`UPDATE conversations SET unread_count = 0 WHERE id = $1`, [customer.conversationId]),
    )
    expect(res.rowCount).toBe(1)
  })

  // ------------------------------------------------------------------
  // Assign / transfer / release
  // ------------------------------------------------------------------

  it('allows only admins to transfer', async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))

    for (const who of [agentA, agentB, viewer]) {
      const err = await expectPgError(() =>
        asUser(who, (c) => c.query('SELECT * FROM set_contact_owner($1, $2)', [customer.contactId, agentB])),
      )
      expect(err.code).toBe('42501')
    }
    expect(await ownerOf(customer.contactId)).toBe(agentA)

    const { rows } = await asUser(admin, (c) =>
      c.query<{ owner_id: string; action: string }>('SELECT * FROM set_contact_owner($1, $2)', [customer.contactId, agentB]),
    )
    expect(rows[0]).toMatchObject({ owner_id: agentB, action: 'transfer' })
    expect(await ownerOf(customer.contactId)).toBe(agentB)
    expect(await events(customer.contactId)).toEqual([
      expect.objectContaining({ action: 'claim', to_user_id: agentA, actor_user_id: agentA }),
      expect.objectContaining({ action: 'transfer', from_user_id: agentA, to_user_id: agentB, actor_user_id: admin }),
    ])
  })

  it('refuses to make an admin the owner', async () => {
    const err = await expectPgError(() =>
      asUser(owner, (c) => c.query('SELECT * FROM set_contact_owner($1, $2)', [customer.contactId, admin])),
    )
    expect(err.code).toBe('22023')
  })

  it('lets an admin release a customer back to Unassigned', async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    await asUser(admin, (c) => c.query('SELECT * FROM set_contact_owner($1, NULL)', [customer.contactId]))
    expect(await ownerOf(customer.contactId)).toBeNull()
    const last = (await events(customer.contactId)).at(-1)
    expect(last).toMatchObject({ action: 'release', from_user_id: agentA, to_user_id: null })
  })

  // ------------------------------------------------------------------
  // Deals follow the owner
  // ------------------------------------------------------------------

  it('moves open deals (not won ones) on claim and on transfer', async () => {
    const before = await pool.query<{ id: string; assigned_to: string | null }>(
      'SELECT id, assigned_to FROM deals WHERE id = $1',
      [customer.wonDealId],
    )

    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    const dealOwner = async (id: string) =>
      (await pool.query<{ assigned_to: string | null }>('SELECT assigned_to FROM deals WHERE id = $1', [id])).rows[0].assigned_to
    expect(await dealOwner(customer.openDealId)).toBe(await profileIdOf(agentA))
    expect(await dealOwner(customer.wonDealId)).toBe(before.rows[0].assigned_to)

    await asUser(admin, (c) => c.query('SELECT * FROM set_contact_owner($1, $2)', [customer.contactId, agentB]))
    expect(await dealOwner(customer.openDealId)).toBe(await profileIdOf(agentB))
    expect(await dealOwner(customer.wonDealId)).toBe(before.rows[0].assigned_to)
  })

  it("stops a non-owner agent from moving an owned customer's deal to themselves", async () => {
    await asUser(agentA, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    const agentBProfile = await profileIdOf(agentB)
    const err = await expectPgError(() =>
      asUser(agentB, (c) => c.query('UPDATE deals SET assigned_to = $1 WHERE id = $2', [agentBProfile, customer.openDealId])),
    )
    expect(err.code).toBe('42501')
  })

  // ------------------------------------------------------------------
  // Bots and membership changes
  // ------------------------------------------------------------------

  it('lets bot routing fill only an empty owner slot', async () => {
    const first = await pool.query<{ ok: boolean }>(
      'SELECT system_assign_contact($1, $2, $3) AS ok',
      [customer.contactId, agentA, 'round_robin'],
    )
    const second = await pool.query<{ ok: boolean }>(
      'SELECT system_assign_contact($1, $2, $3) AS ok',
      [customer.contactId, agentB, 'round_robin'],
    )
    expect(first.rows[0].ok).toBe(true)
    expect(second.rows[0].ok).toBe(false)
    expect(await ownerOf(customer.contactId)).toBe(agentA)
    expect((await events(customer.contactId))[0]).toMatchObject({ action: 'assign', source: 'round_robin', actor_user_id: null })
  })

  it('never lets bot routing assign an admin', async () => {
    const res = await pool.query<{ ok: boolean }>(
      'SELECT system_assign_contact($1, $2, $3) AS ok',
      [customer.contactId, admin, 'ai_handoff'],
    )
    expect(res.rows[0].ok).toBe(false)
    expect(await ownerOf(customer.contactId)).toBeNull()
  })

  it("releases an agent's customers when they are demoted", async () => {
    const demoted = racers[racers.length - 1]
    await asUser(demoted, (c) => c.query('SELECT * FROM claim_contact($1)', [customer.contactId]))
    await pool.query(`UPDATE profiles SET account_role = 'viewer' WHERE user_id = $1`, [demoted])
    try {
      expect(await ownerOf(customer.contactId)).toBeNull()
      expect((await events(customer.contactId)).at(-1)).toMatchObject({ action: 'release', source: 'member_change' })
    } finally {
      await pool.query(`UPDATE profiles SET account_role = 'agent' WHERE user_id = $1`, [demoted])
    }
  })
})
