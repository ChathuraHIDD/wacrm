"use client"

import { Trophy, Users } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentLeaderboard as AgentLeaderboardData } from '@/lib/dashboard/types'
import { formatCurrency } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface AgentLeaderboardProps {
  data: AgentLeaderboardData | null
  loading: boolean
  currency: string
}

/**
 * Per-agent scoreboard: who is carrying the open load, who is
 * replying, and who is closing deals. One row per assignable team
 * member, ranked by won value. Admins get the whole team here; the
 * data itself is RLS-scoped to the account.
 */
export function AgentLeaderboard({ data, loading, currency }: AgentLeaderboardProps) {
  const t = useTranslations('Dashboard.agentLeaderboard')

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        </div>
        {data && (
          <span className="text-xs text-muted-foreground">
            {t('subtitle', { days: data.rangeDays })}
          </span>
        )}
      </header>

      {loading || !data ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="p-5">
          <EmptyState icon={Users} title={t('empty')} hint={t('emptyHint')} />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-5 py-2 text-left font-medium">{t('colAgent')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colOpen')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colReplies')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colResponse')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colWon')}</th>
                  <th className="px-5 py-2 text-right font-medium">{t('colValue')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.rows.map((row, i) => (
                  <tr key={row.userId} className={cn(i % 2 === 1 && 'bg-muted/40')}>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        {i === 0 && data.rows[0].dealsWonValue > 0 && (
                          <Trophy className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
                        )}
                        <span className="truncate font-medium text-foreground">
                          {row.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                      {row.openConversations}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                      {row.messagesSent}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatMinutes(row.avgResponseMinutes, t)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                      {row.dealsWon}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums font-medium text-foreground">
                      {row.dealsWonValue > 0
                        ? formatCurrency(row.dealsWonValue, currency)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.hasAttributedMessages && (
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              {t('attributionHint')}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function formatMinutes(
  mins: number | null,
  t: ReturnType<typeof useTranslations>,
): string {
  if (mins == null) return '—'
  if (mins < 60) return t('minutesShort', { min: Math.max(1, Math.round(mins)) })
  return t('hoursShort', { hr: Math.round((mins / 60) * 10) / 10 })
}
