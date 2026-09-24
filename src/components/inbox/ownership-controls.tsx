"use client";

// ============================================================
// Claim & Lock UI for the thread header and above the composer.
//
//   Agent, Unassigned customer  → "Take this customer" button
//   Agent / viewer, owned       → owner badge ("You" when it's mine)
//   Owner / admin               → Assign / Transfer / Release menu
//                                 (agents only — admins never own)
//
// The server and the database enforce all of this; the UI just offers
// the actions the caller is actually allowed to take.
// ============================================================

import { Check, ChevronDown, Lock, ShieldCheck, UserCheck, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PresenceDot } from "@/components/presence/presence-dot";
import { usePresence } from "@/hooks/use-presence";
import { useCan } from "@/hooks/use-can";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types";

type Member = Pick<Profile, "id" | "user_id" | "full_name" | "email" | "account_role">;

export function memberName(members: readonly Member[], userId: string | null): string | null {
  if (!userId) return null;
  const m = members.find((p) => p.user_id === userId);
  return m ? m.full_name?.trim() || m.email : null;
}

interface OwnershipControlProps {
  ownerId: string | null;
  members: readonly Member[];
  currentUserId: string | null;
  busy: boolean;
  onTake: () => void;
  /** Admin assign / transfer (an agent's user id) or release (null). */
  onSetOwner: (ownerId: string | null) => void;
}

export function OwnershipControl({
  ownerId,
  members,
  currentUserId,
  busy,
  onTake,
  onSetOwner,
}: OwnershipControlProps) {
  const t = useTranslations("Inbox.ownership");
  const canOwn = useCan("own-customers");
  const canSupervise = useCan("supervise-customers");
  const { getPresence, getRow, now } = usePresence();

  const ownerName = memberName(members, ownerId) ?? t("anotherAgent");

  if (canSupervise) {
    const agents = members.filter((m) => m.account_role === "agent");
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:opacity-60",
            ownerId ? "text-primary" : "text-muted-foreground",
          )}
        >
          <UserPlus className="h-3 w-3" />
          <span className="hidden max-w-[10rem] truncate sm:inline">
            {ownerId ? ownerName : t("unassigned")}
          </span>
          <ChevronDown className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {ownerId ? t("transferTo") : t("assignTo")}
          </div>
          {agents.length === 0 ? (
            <DropdownMenuItem disabled className="text-sm text-muted-foreground">
              {t("noAgents")}
            </DropdownMenuItem>
          ) : (
            agents.map((agent) => {
              const isOwner = agent.user_id === ownerId;
              const presence = getPresence(agent.user_id);
              return (
                <DropdownMenuItem
                  key={agent.id}
                  disabled={isOwner}
                  onClick={() => onSetOwner(agent.user_id)}
                  className={cn("text-sm", isOwner ? "text-primary" : "text-popover-foreground")}
                >
                  <PresenceDot
                    status={presence}
                    label={presenceLabel(presence, getRow(agent.user_id)?.last_seen_at ?? null, now)}
                    className="mr-2"
                  />
                  <span className="flex-1">{agent.full_name?.trim() || agent.email}</span>
                  {isOwner && <Check className="ml-2 h-3 w-3" />}
                </DropdownMenuItem>
              );
            })
          )}
          {ownerId && (
            <>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={() => onSetOwner(null)}
                className="text-sm text-muted-foreground"
              >
                {t("release")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (!ownerId && canOwn) {
    return (
      <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={onTake}>
        <UserCheck className="h-3 w-3" />
        {busy ? t("taking") : t("take")}
      </Button>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "max-w-[12rem] gap-1 truncate border-border text-[10px]",
        ownerId === currentUserId ? "text-primary" : "text-muted-foreground",
      )}
    >
      {ownerId ? <Lock className="h-3 w-3" /> : null}
      {ownerId ? t("ownerLabel", { owner: ownerId === currentUserId ? t("you") : ownerName }) : t("unassigned")}
    </Badge>
  );
}

interface OwnershipBannerProps {
  ownerId: string | null;
  members: readonly Member[];
  currentUserId: string | null;
}

/**
 * The strip above the composer: a lock for agents reading a teammate's
 * customer, and a reminder for admins that their reply won't move the
 * customer. Renders nothing for the owner or on an Unassigned customer
 * seen by an agent (their reply claims it — the Take button says so).
 */
export function OwnershipBanner({ ownerId, members, currentUserId }: OwnershipBannerProps) {
  const t = useTranslations("Inbox.ownership");
  const canSupervise = useCan("supervise-customers");
  const owner = memberName(members, ownerId) ?? t("anotherAgent");

  if (canSupervise) {
    return (
      <div className="flex items-center gap-2 border-t border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
        {ownerId ? t("adminReplyHint", { owner }) : t("adminUnassignedHint")}
      </div>
    );
  }

  if (!ownerId || ownerId === currentUserId) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-0.5 border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-amber-700 dark:text-amber-300"
    >
      <span className="text-sm font-medium">{t("lockedBanner", { owner })}</span>
      <span className="text-xs opacity-80">{t("lockedHint", { owner })}</span>
    </div>
  );
}
