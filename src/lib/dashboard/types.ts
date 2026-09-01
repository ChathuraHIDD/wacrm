// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export interface AgentLeaderboardRow {
  /** auth.users id of the agent. */
  userId: string
  /** Display name (falls back to email, then a short id). */
  name: string
  /** Open conversations currently assigned to this agent. */
  openConversations: number
  /** Conversations ever assigned to this agent (any status). */
  totalAssigned: number
  /** Messages this agent sent in the selected window. */
  messagesSent: number
  /** Deals marked "won" attributed to this agent (lifetime). */
  dealsWon: number
  /** Summed value of those won deals. */
  dealsWonValue: number
  /** Mean first-response time (minutes) for replies this agent sent. */
  avgResponseMinutes: number | null
}

export interface AgentLeaderboard {
  rows: AgentLeaderboardRow[]
  /** Window the message / deal counts cover. */
  rangeDays: number
  /**
   * True once at least one message in the window carries a `sender_id`.
   * Older messages predate per-agent attribution, so a fresh install
   * shows a hint instead of a misleading all-zero "messages sent".
   */
  hasAttributedMessages: boolean
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
