import { describe, expect, it } from 'vitest'
import { chooseNextAgent, type OpenConversationRow } from './assign'

const conv = (
  agent: string | null,
  last_message_at: string | null = null,
): OpenConversationRow => ({ assigned_agent_id: agent, last_message_at })

describe('chooseNextAgent', () => {
  it('returns null with no candidates', () => {
    expect(chooseNextAgent([], [])).toBeNull()
  })

  it('returns the only candidate without inspecting load', () => {
    expect(chooseNextAgent(['niluka'], [conv('prasanga')])).toBe('niluka')
  })

  it('picks the agent with the fewest open conversations', () => {
    const open = [conv('niluka'), conv('niluka'), conv('prasanga')]
    expect(chooseNextAgent(['niluka', 'prasanga'], open)).toBe('prasanga')
  })

  it('ignores conversations assigned to non-candidates', () => {
    const open = [conv('former-agent'), conv('former-agent'), conv('niluka')]
    expect(chooseNextAgent(['niluka', 'prasanga'], open)).toBe('prasanga')
  })

  it('on an even load, prefers whoever went longest without a new one', () => {
    const open = [
      conv('niluka', '2026-09-01T10:00:00Z'),
      conv('prasanga', '2026-09-01T09:00:00Z'),
    ]
    expect(chooseNextAgent(['niluka', 'prasanga'], open)).toBe('prasanga')
  })

  it('alternates from a cold start deterministically', () => {
    // Everyone at zero load, no history -> stable id order, so the
    // caller can assign, then the next call (now niluka has 1) flips.
    expect(chooseNextAgent(['niluka', 'prasanga'], [])).toBe('niluka')
    expect(
      chooseNextAgent(['niluka', 'prasanga'], [conv('niluka', '2026-09-01T10:00:00Z')]),
    ).toBe('prasanga')
  })
})
