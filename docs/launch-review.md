# Launch-readiness review — BatteryLab WhatsApp CRM

_Reviewed 2026-09-24 against `main` @ `bbab8be`. Phase 1 of the Claim & Lock project: review only, no code changes._

**Verdict:** Not ready to launch as-is. The codebase is in good shape: 839/839 tests pass, typecheck and lint are clean, and every table has RLS. There are **4 blockers**, all fixable in about a day. Two of them are solved by merging upstream.

---

## 1. What this fork changed vs upstream `ArnasDon/wacrm`

Remotes: `origin` = `ChathuraHIDD/wacrm`, `upstream` = `ArnasDon/wacrm`.

Commits unique to this fork (everything else is upstream history):

| Commit | What it does | Files |
|---|---|---|
| `fbc6db9` "C.0.0.0.0" | **Round-robin assignment.** The `assign_conversation` automation step now load-balances across owner/admin/agent members (it used to always pick the first member). Adds a new `round_robin_leads` automation template. | `src/lib/automations/assign.ts` (+test), `engine.ts`, `templates.ts`, `automations/page.tsx` |
| | **Agent leaderboard** on `/dashboard`: messages sent, avg response time, open/assigned conversations, deals won and won value per agent. | `src/lib/dashboard/queries.ts`, `types.ts`, `components/dashboard/agent-leaderboard.tsx`, `dashboard/page.tsx`, `messages/{en,ko}.json` |
| | **Sender attribution.** The dashboard send route now stores `messages.sender_id = auth.uid()`. The public API, automations and the AI bot still write `NULL`. | `api/whatsapp/send/route.ts`, `lib/whatsapp/send-message.ts` |
| `59f90fd` | Merged upstream up to PR #532. | — |
| `bbab8be` | Rebrand to "BatteryLab WhatsApp CRM" (app title, signup copy, i18n). | `layout.tsx`, `signup/page.tsx`, `messages/*.json` |

There are **no fork-specific migrations**. The schema is upstream's `001`–`039`.

**The fork is 43 commits behind `upstream/main`.** Those commits include three new migrations and security fixes this fork doesn't have yet (see B1 and B2).

---

## 2. Prioritized findings

### 🔴 Blockers (fix before launch)

**B1. Next.js 16.2.12 has a critical advisory (unauthenticated RCE).**
`npm audit` flags `next` (GHSA-2xp9-vwfh-vxw4, image-optimisation RCE with AVIF; GHSA-p293-qw3h-jr36, Windows hosts) and `sharp <0.35.4` (libheif, high). Upstream has already fixed this in `ffa583a` (Next 16.3.5, `sharp ^0.35.4`, raised Dependabot floors). **Fix:** merge upstream (see B2), then run `npm audit` again. Audit now proposes `next@16.3.6`, so bump to that if 16.3.5 still gets flagged.

**B2. Merge `upstream/main` (43 commits) before any new work.**
Beyond B1, upstream contains fixes that matter for a live sales inbox:
- `041`: **the public-API broadcast RPC is broken.** `create_broadcast_with_recipients` fails with SQLSTATE 42702 on every call, so `POST /api/v1/broadcasts` (and the MCP `send_broadcast` tool) cannot work on this fork. Dashboard broadcasts use a different path and are unaffected.
- `040`: identify senders by WhatsApp **business-scoped user ID**. Once a customer adopts a WhatsApp username, Meta stops sending their phone number. Without this fix, every message from such a customer creates a new contact and a new conversation. That would also break contact-level ownership in Phase 2.
- `042`: stores Meta's failure reason on failed messages.
- Several other fixes: webhook secrets, template headers, flows vars, the `+` country-code requirement on phone numbers.

Merging now also means our Phase 2 migrations can start at **`043_`**. If we don't merge first, our migrations will clash with upstream's numbering.

**B3. `POST /api/whatsapp/config` has no role check.**
Any **agent** (and even a **viewer**) can call it. RLS does block the final `whatsapp_config` write, which requires admin. But before that write, the route calls Meta: it verifies the token and **registers the phone number with a PIN**. This is the same bug class upstream already fixed for `/api/whatsapp/send` (the comment at `send/route.ts:22`). A non-admin could re-register the company number with Meta. **Fix:** `requireRole('admin')` at the top of `POST` and `DELETE` in `src/app/api/whatsapp/config/route.ts`, and in `verify-registration/route.ts`.

**B4. Anyone on the internet can sign up.**
`/signup` calls `supabase.auth.signUp` unconditionally, and each signup gets its own empty account. RLS keeps strangers out of your data. But on a commercial single-company deploy, this still means strangers can create accounts on your Supabase, use your AI and storage quota, and connect their own WhatsApp numbers to your instance. **Fix, pick one:**
- (a) Supabase → Auth → disable "Allow new users to sign up". Onboard staff with Supabase "Invite user" and then an in-app `/join/<token>` link.
- (b) An app-side gate: `/signup` only works with a valid `?invite=` token, plus a server check.

Option (a) needs no code.

### 🟠 Should-fix (before or shortly after launch)

| # | Issue | Where | Fix |
|---|---|---|---|
| S1 | **SECURITY DEFINER functions still executable by `anon`/`authenticated`.** Supabase grants EXECUTE on public-schema functions to `anon` by default, and these never `REVOKE ... FROM PUBLIC`: `_bcast_bump(uuid,text,int)` (adds to **any integer column** of **any** account's broadcast), `recompute_broadcast_counts`, `record_webhook_failure` (can disable any account's outbound webhook), `claim_ai_reply_slot` (can burn any conversation's AI reply budget). All of them need a UUID the attacker would have to guess, so exploitability is low. The fix is still trivial. | migrations 003/005/028/029 | New migration: `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT ... TO service_role`. |
| S2 | **Inbound customer media is publicly readable.** The `chat-media` bucket is public (023), and 039 mirrors inbound attachments into it: IDs, invoices, photos. Anyone with the URL can read them, and URLs end up in logs and browser history. | 023 / 039 | Make the bucket private and serve media through signed URLs. Or set `mirror_inbound_media=false` (media then expires after about 30 days at Meta). |
| S3 | **The media proxy sends `Cache-Control: public, max-age=86400`** on authenticated customer media. Hostinger's CDN/LiteSpeed can cache it and serve it to unauthenticated requests. | `api/whatsapp/media/[mediaId]/route.ts` | Change to `private, max-age=86400`. |
| S4 | **CSP is report-only.** | `next.config.ts:39` | Watch the console for a week, then switch it to enforcing, as the file comment suggests. |
| S5 | **Agents can UPDATE/DELETE any message in the account** (`messages_modify` is `FOR ALL` at agent level). Agents can also rewrite `conversations.assigned_agent_id` directly from the browser. That undermines any audit trail and conflicts with Phase 2. | 017 | Addressed in the Phase 2 RLS rewrite. |
| S6 | **The fork's leaderboard silently truncates.** `loadAgentLeaderboard` selects `messages`/`conversations`/`deals` with no `.range()`, and PostgREST caps each response at 1,000 rows. Past about 1k messages in 30 days, per-agent counts and response times will be wrong. It also credits response time to any sender, including admins covering a chat. | `src/lib/dashboard/queries.ts:277` | Move the aggregation into a SQL function (this is planned for Phase 3). |
| S7 | **`deals.assigned_to` points at `profiles.id`, but conversations use `auth.users.id`.** The fork's leaderboard maps between them correctly. The Flows handoff node, however, writes a user id into `flow_run_events.assigned_to`, and the deal form writes a profile id. It's easy to get this wrong in Phase 2. | 002, `deal-form.tsx` | Phase 2 will map explicitly. |
| S8 | **The rate limiter is in-memory, one per process.** That's fine on one Hostinger Node instance, but ineffective with multiple instances or serverless. | `src/lib/rate-limit.ts` | Keep a single instance, or move the limiter to Upstash/Redis. |
| S9 | **The `middleware.ts` file convention is deprecated in Next 16** (the build warns about it). | `src/middleware.ts` | Rename to `proxy.ts` when bumping Next. Upstream may already have done this. |
| S10 | **Build picks the wrong workspace root.** A stray `~/package.json` and `~/package-lock.json` in your home directory make Next infer the wrong root. | local machine | Delete those two files, or set `turbopack.root`. |

### 🟢 Nice-to-have

- 37 lint warnings, 0 errors: 17 unused vars, 17 `exhaustive-deps` (mostly a missing `t`), 2 `<img>`, 1 set-state-in-effect.
- The webhook route uses untyped `any` for its admin client (`webhook/route.ts:27`).
- `profiles.role` is a legacy column that 017 flagged for removal.
- Local Node is **v25.8.2**, while CI and the Dockerfile use Node 20. Develop on Node 20 or 22 LTS to match production.
- Add `supabase/ci/verify-schema.sql` assertions for any new Phase 2 objects.

---

## 3. Security review

### Secrets and `.env`
- ✅ **No secrets in git history.** Every commit on all branches was scanned for OpenAI/Anthropic/Meta `EAA…`/AWS/JWT/private-key patterns. The only two hits are minified `opus-recorder` WASM glue, which are false positives.
- ✅ `.gitignore` ignores `.env*` except the examples. The only env files ever committed are `.env.local.example` and `mcp-server/.env.example`, and both contain placeholders only.
- ✅ WhatsApp access/verify tokens and AI provider keys are AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- ⚠️ There is no `.env.local` in the working tree, so `npm run build` fails locally (see §4). That's expected, not a bug.

### RLS coverage: all 36 tables have RLS enabled

| Tier | Tables |
|---|---|
| Member read, **agent** write | contacts, contact_notes, contact_tags, contact_custom_values, conversations, **messages**, deals, broadcasts, broadcast_recipients, automations, automation_steps, flows, flow_nodes, message_reactions |
| Member read, **admin** write | tags, custom_fields, whatsapp_config, message_templates, pipelines, pipeline_stages, api_keys, webhook_endpoints, ai_configs, ai_knowledge_*, quick_replies, accounts, account_invitations (admin read too) |
| Read-only for clients (service role writes) | automation_logs, flow_runs, flow_run_events, ai_usage_log, member_presence (writes through the `touch_presence` RPC) |
| Self only | profiles (update/insert: own row only, privilege columns locked by the 034 trigger), notifications (only `read_at` is updatable) |
| No client policy (service role only) | automation_pending_executions |

Notes:
- The `001` policy `"Service role can insert messages" WITH CHECK (true)` was **dropped by 017**. It is not live.
- Tenancy isolation relies entirely on `is_account_member()`, which is SECURITY DEFINER, `search_path` pinned, owned by postgres. It is sound.
- Gaps are listed in S1 (function grants) and S5 (agents can edit and delete messages and assignment).

### Webhook HMAC
✅ `verifyMetaWebhookSignature` checks HMAC-SHA256 of the raw body against `x-hub-signature-256` with `timingSafeEqual`. It **fails closed** when `META_APP_SECRET` is unset. The GET verify-token handshake decrypts and compares the stored token. Outbound webhooks are signed (`lib/webhooks/sign.ts`) and SSRF-guarded (`ssrf.ts`).

### Rate limiting
| Surface | Limited? |
|---|---|
| `/api/v1/*` (public API, MCP) | ✅ per API key, inside `requireApiKey` |
| `/api/whatsapp/send`, `/react`, `/broadcast`, `/broadcast/[id]/resume`, `/templates/submit` | ✅ per user |
| `/api/account/*`, `/api/ai/*` (except usage), invitations peek/redeem | ✅ |
| automations, flows, contacts/tags, quick-replies, whatsapp config/templates/media | ❌ auth only. These are low-risk CRUD. Worth adding to `/api/whatsapp/config` (Meta calls) and `/api/whatsapp/media` (Meta downloads). |
| `/api/whatsapp/webhook` | ❌ by design. It's HMAC-gated, and throttling Meta would drop messages. |

### Auth check on every API route (55 routes)
- **Cookie routes**, 44: every one calls `requireRole(...)` / `getCurrentAccount()` / `auth.getUser()` and scopes by `account_id`. Routes that only call `getUser()` (flows, templates/[id], media, config) fall back on RLS for authorisation. That works for DB writes, but **not for side effects before the write** (B3).
- **Public API `/api/v1`**, 11 routes: every handler calls `requireApiKey(request, scope)`. Keys are SHA-256 hashed, revocable and expirable, rate-limited per key, and scope-checked. The client is service-role, so each query is explicitly filtered by `ctx.accountId` (spot-checked `messages`, `conversations`, `contacts`, `broadcasts`).
  ⚠️ **Keys are account-scoped, not user-scoped.** A key has no identity of "which agent is sending". This matters for Phase 2 (see §6, Q3).
- **Cron**, `/api/automations/cron` and `/api/flows/cron`: `x-cron-secret` is compared in constant time, and the route returns 503 if `AUTOMATION_CRON_SECRET` is unset. ✅
- **`/api/invitations/[token]/peek`** is anonymous by design, rate-limited, and returns uniform responses.
- **`mcp-server/`** is a thin stdio client of `/api/v1`. It holds no DB credentials and has no auth surface of its own. Writes and broadcasts are opt-in via `WACRM_ENABLE_WRITES` / `WACRM_ENABLE_BROADCASTS`, and the key's scopes are still enforced server-side. So any Phase 2 enforcement added to `/api/v1` automatically covers MCP.
- **Middleware** returns 401 on `/api/whatsapp/*` (except the webhook) and redirects signed-out users away from dashboard pages. That is defense in depth only; each route still checks for itself.

---

## 4. Build and test results

Environment: macOS, Node v25.8.2, npm 11.11.1.

| Step | Result |
|---|---|
| `npm install` | ✅ 688 packages. ⚠️ 12 vulnerabilities (1 critical, 4 high, 6 moderate, 1 low) |
| `npm run lint` | ✅ **0 errors**, 37 warnings |
| `npm run typecheck` | ✅ clean |
| `npm test` (vitest) | ✅ **81 files, 839 tests, all passing** (3.5 s) |
| `npm run build` (no env) | ❌ Fails prerendering `/forgot-password` with `@supabase/ssr: Your project's URL and API key are required`. **Only cause: no `.env.local`.** |
| `npm run build` (CI dummy env) | ✅ 51 routes. Warnings: `middleware` → `proxy` deprecation, and wrong workspace root (S10) |

`npm audit --omit=dev` (production dependencies): **9 vulnerabilities**
- `next`: critical (B1)
- `sharp`, `fast-uri`, `js-yaml`, `browserslist`: high
- `qs`, `hono`, `baseline-browser-mapping`: moderate
- `postcss-selector-parser`: low

Most are fixed by the upstream merge plus `npm audit fix`. `hono` and `fast-uri` come in through `shadcn` and the MCP SDK.

---

## 5. Production configuration

### Environment variables
| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Needed at **build time** too; it's inlined into the client bundle. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Build time too. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Server only. Used by the webhook, engines, the public API and the media mirror. |
| `ENCRYPTION_KEY` | ✅ | 64 hex characters. **Never rotate it after launch**: that orphans every stored token. Back it up. |
| `META_APP_SECRET` | ✅ | Without it, every webhook is rejected. |
| `NEXT_PUBLIC_SITE_URL` | recommended | Your canonical https URL. Pins invite links. |
| `NEXT_PUBLIC_APP_LOCALE` | recommended | `en` |
| `AUTOMATION_CRON_SECRET` | **yes for us** | Automation wait steps and flow timeouts need an external pinger. Without it, both cron routes return 503. |
| `META_APP_ID` | optional | Only for image-header templates. |
| `ALLOWED_INVITE_HOSTS` | optional | Belt-and-braces for invite hosts. |
| `WHATSAPP_TEMPLATES_DRY_RUN` | **must be unset in prod** | |
| `AI_REQUEST_TIMEOUT_MS`, `AI_CONTEXT_MESSAGE_LIMIT` | optional | |

### Supabase migrations status
I have no production DB credentials, so I **cannot see which migrations are applied**. The repo contains `001`–`039`, and upstream adds `040`–`042`. To check, run this in the Supabase SQL editor:

```sql
-- If you used `supabase db push`:
select version from supabase_migrations.schema_migrations order by version;
-- If you pasted files into the SQL editor, probe for the newest objects instead:
select
  to_regclass('public.member_presence')                         is not null as m024,
  to_regclass('public.api_keys')                                is not null as m026,
  to_regclass('public.ai_configs')                              is not null as m029,
  exists(select 1 from pg_indexes where indexname like '%conversations%account%contact%') as m036,
  exists(select 1 from information_schema.columns
         where table_name='messages' and column_name='media_type') as m039;
```

All migrations are idempotent, so re-running one that's already applied is safe.

### Deployment steps (Hostinger Managed Node.js, per upstream docs)
1. **Merge upstream** and fix B1 and B3. Get CI green: lint, typecheck, test, build, and the migrations replay job.
2. **Supabase:** apply migrations `001`→`042` in order.
   - Auth → **disable public sign-ups** (B4).
   - Set Site URL and redirect URLs to your domain.
   - Confirm Realtime is enabled for `messages`, `conversations`, `notifications`, `member_presence`, `message_reactions`, `flow_runs`.
   - Turn on PITR / daily backups.
3. **Hostinger:** create a Node.js app from the fork, Node 20.
   - Set all env vars above. `NEXT_PUBLIC_*` must be present at build time.
   - Build with `npm ci && npm run build`, start with `npm start`. Or use the `Dockerfile`, which produces standalone output.
4. **Create the owner account** before closing sign-ups, or through Supabase "Invite user".
   - Owner → Settings → WhatsApp: phone number ID, WABA ID, **permanent System User token**, verify token, and the 6-digit PIN. The PIN is needed for API-only (non-coexistence) registration.
5. **Meta app:**
   - Webhook URL `https://<domain>/api/whatsapp/webhook` with the same verify token.
   - Subscribe to the `messages` field. Add `message_template_status_update` / `message_template_quality_update` if you use templates.
   - App in **Live** mode.
6. **Cron:** ping `GET /api/automations/cron` and `GET /api/flows/cron` every 5 minutes with header `x-cron-secret: $AUTOMATION_CRON_SECRET`. Use a Hostinger cron job or an external pinger.
7. **Invite agents** with role `agent`, and admins with role `admin`.
8. **Smoke test:** inbound text and inbound media, outbound reply, template send, broadcast to a test list, automation, and the AI draft if you use it.
9. After a week of clean CSP reports, switch CSP to enforcing (S4).

---

## 6. Conflicts with the Claim & Lock spec: decisions needed before Phase 2

These are places where the existing code contradicts the Phase 2 rules. Each includes my recommendation.

| # | Conflict | Recommendation |
|---|---|---|
| **Q1** | Ownership exists today only as `conversations.assigned_agent_id`. Since 036 there is exactly **one conversation per contact** (`UNIQUE(account_id, contact_id)`). | Add `contacts.owner_id` as the source of truth and **mirror** it into `conversations.assigned_agent_id`. That keeps notifications (027), the AI bot's "a human owns this" check, `/api/v1` output and the existing leaderboard working unchanged. |
| **Q2** | Three things **auto-assign** today, which rule 6 forbids: the fork's round-robin `assign_conversation` step and `round_robin_leads` template; AI handoff (`ai_configs.handoff_agent_id`); and the Flows `handoff` node's `assign_to`. | Keep them as **admin-configured routing**: they may assign an *unclaimed* contact, recorded in the audit log as `actor = system`. They never override an existing owner. The alternative is to disable them so every contact starts Unassigned. **Your call.** |
| **Q3** | `/api/v1` keys (and so MCP) belong to the **account**, not a person, so "is caller the owner?" has no answer. | Treat a key as **acting for its creator** (`api_keys.created_by`): admin-created keys may reply anywhere without claiming; agent-created keys follow agent rules. The alternative: add a `messages:send_any` scope that only admins can grant. |
| **Q4** | Multi-contact **broadcasts** by agents would message customers owned by other agents. The spec only covers "broadcasts to a single contact". | Agents' broadcasts **skip** contacts owned by someone else, shown as "skipped: owned by X". Admin broadcasts go to everyone. Broadcasts never claim. |
| **Q5** | Today any agent can reassign any conversation (the inbox Assign dropdown writes directly under RLS), and can edit or delete any message (S5). | Restrict both: only admins transfer or release, through an RPC, and message UPDATE/DELETE is limited to status columns and service role. Agents lose the Assign dropdown. |
| **Q6** | Should an agent be able to **close/reopen** a conversation they don't own? And does closing release ownership? | Non-owners are read-only, so they can't close it. Closing does **not** release: the customer comes back to the same owner (rule 3). |
| **Q7** | Deals: `deals.assigned_to` references `profiles.id`. | On claim or transfer, set `assigned_to` = the owner's `profiles.id` for **open** deals only. Won and lost deals keep their credit. |

**Before I write the Phase 2 plan, please:**
1. Approve merging `upstream/main` (and fixing B1/B3) as the first commits.
2. Answer Q2–Q4. Q1 and Q5–Q7 will follow my recommendation unless you say otherwise.
