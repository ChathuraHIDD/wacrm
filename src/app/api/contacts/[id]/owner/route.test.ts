import { beforeEach, describe, expect, it, vi } from 'vitest'

// Admin-only assign / transfer / release. The role gate must run before
// the database is asked to change anything.

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

function call(body: unknown) {
  return POST(
    new Request('http://localhost/api/contacts/ct-1/owner', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'ct-1' }) },
  )
}

describe('POST /api/contacts/[id]/owner', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it.each(['agent', 'viewer'])('refuses a %s before touching the database', async (role) => {
    callerRole = role
    const res = await call({ owner_id: 'agent-2' })
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(['admin', 'owner'])('lets an %s transfer to an agent', async (role) => {
    callerRole = role
    rpc.mockResolvedValue({
      data: [{ owner_id: 'agent-2', owner_name: 'Hank Agent', action: 'transfer' }],
      error: null,
    })
    const res = await call({ owner_id: 'agent-2', note: 'covering leave' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ owner_id: 'agent-2', owner_name: 'Hank Agent', action: 'transfer' })
    expect(rpc).toHaveBeenCalledWith('set_contact_owner', {
      p_contact_id: 'ct-1',
      p_new_owner_id: 'agent-2',
      p_note: 'covering leave',
    })
  })

  it('releases with owner_id: null', async () => {
    callerRole = 'admin'
    rpc.mockResolvedValue({ data: [{ owner_id: null, owner_name: null, action: 'release' }], error: null })
    const res = await call({ owner_id: null })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('set_contact_owner', expect.objectContaining({ p_new_owner_id: null }))
  })

  it("surfaces the database's refusal to hand a customer to a non-agent", async () => {
    callerRole = 'admin'
    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Customers can only be assigned to agents of this account' },
    })
    const res = await call({ owner_id: 'admin-2' })
    expect(res.status).toBe(400)
  })

  it('requires owner_id in the body', async () => {
    callerRole = 'admin'
    const res = await call({})
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
})
