import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// POST / DELETE /api/whatsapp/config must be owner/admin-only. RLS blocks a
// non-admin's `whatsapp_config` write, but POST calls Meta (verify, subscribe,
// register with PIN) BEFORE persisting — so without an up-front role gate an
// agent could still re-register the company number. These tests pin that the
// gate runs before any Meta call or DB write.
// ---------------------------------------------------------------------------

let callerRole = 'agent'
const deletes: string[] = []

function makeSupabaseMock() {
  function builder(table: string) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      delete: () => {
        deletes.push(table)
        return chain
      },
      maybeSingle: () =>
        Promise.resolve(
          table === 'profiles'
            ? { data: { account_id: 'acct-1', account_role: callerRole }, error: null }
            : { data: null, error: null },
        ),
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    }
    return chain
  }
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => builder(table),
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(makeSupabaseMock()),
}))

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  getSubscribedApps: vi.fn(),
  listWabaPhoneNumbers: vi.fn(),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { DELETE, POST } from './route'

function postRequest() {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    body: JSON.stringify({
      phone_number_id: '123456789',
      waba_id: '987654321',
      access_token: 'EAAtoken',
      pin: '123456',
    }),
  })
}

describe('/api/whatsapp/config role gate', () => {
  beforeEach(() => {
    deletes.length = 0
    for (const fn of Object.values(meta)) fn.mockReset()
  })

  it.each(['agent', 'viewer'])('POST refuses a %s before calling Meta', async (role) => {
    callerRole = role
    const res = await POST(postRequest())
    expect(res.status).toBe(403)
    for (const fn of Object.values(meta)) expect(fn).not.toHaveBeenCalled()
  })

  it.each(['agent', 'viewer'])('DELETE refuses a %s without touching the row', async (role) => {
    callerRole = role
    const res = await DELETE()
    expect(res.status).toBe(403)
    expect(deletes).toEqual([])
  })

  it('DELETE lets an admin reset the configuration', async () => {
    callerRole = 'admin'
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(deletes).toEqual(['whatsapp_config'])
  })
})
