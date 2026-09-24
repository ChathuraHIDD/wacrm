import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Take this customer". The atomic race itself is proven against real
// Postgres in src/lib/ownership/claim-and-lock.db.test.ts; this covers
// the HTTP mapping around it.

let callerRole = 'agent'
const rpc = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () =>
          table === 'profiles'
            ? { data: { account_id: 'acct-1', account_role: callerRole }, error: null }
            : { data: { id: 'acct-1', name: 'Acme' }, error: null },
      }
      return chain
    },
    rpc,
  }),
}))

import { POST } from './route'

const call = () =>
  POST(new Request('http://localhost/api/contacts/ct-1/claim', { method: 'POST' }), {
    params: Promise.resolve({ id: 'ct-1' }),
  })

describe('POST /api/contacts/[id]/claim', () => {
  beforeEach(() => {
    rpc.mockReset()
    callerRole = 'agent'
  })

  it('returns 200 to the winner', async () => {
    rpc.mockResolvedValue({ data: [{ claimed: true, owner_id: 'user-1', owner_name: 'Gina' }], error: null })
    const res = await call()
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('claim_contact', { p_contact_id: 'ct-1', p_source: 'take_button' })
  })

  it('returns 409 with the winner to the loser', async () => {
    rpc.mockResolvedValue({ data: [{ claimed: false, owner_id: 'user-2', owner_name: 'Hank' }], error: null })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      claimed: false,
      owner_id: 'user-2',
      owner_name: 'Hank',
      code: 'claimed_by_other',
    })
  })

  it("maps the database's refusal of an admin to 403", async () => {
    callerRole = 'admin'
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Only agents can take customers' } })
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('refuses a viewer before the database', async () => {
    callerRole = 'viewer'
    const res = await call()
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })
})
