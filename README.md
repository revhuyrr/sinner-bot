# SINNER — Telegram group management bot + gothic dashboard

Node 20+ service (Express) · Supabase PostgreSQL · Telegram webhook · deploys to Render or Railway.

## 1. Database
Run in the Supabase SQL editor, in order:
`supabase/migrations/001_sinner_schema.sql` then `002_stats.sql`.

## 2. Bot
In @BotFather: create the bot, then `/setprivacy` → **Disable** (so it can read group messages), `/setjoingroups` → Enable.

## 3. Environment variables (host secrets only — never commit)
| Name | Value |
|---|---|
| `BOT_TOKEN` | from BotFather |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → service_role |
| `WEBHOOK_SECRET` | random 32+ chars (`A-Za-z0-9_-`) |
| `OWNER_USERNAME` | `Sinconviction` |

`PUBLIC_URL` is auto-detected on Render and Railway. The service registers the Telegram webhook itself on every boot.

## 4. Deploy
**Render:** push this folder to a Git repo → New → Blueprint (uses `render.yaml`) → fill the 3 secret values.
**Railway:** push to a Git repo → New Project → Deploy from repo → add the variables → Settings → Networking → Generate Domain (then redeploy once so `RAILWAY_PUBLIC_DOMAIN` is set).
Use a paid/always-on instance: free tiers sleep and delay webhooks.

## 5. First run
1. DM the bot from **@Sinconviction** and send `panel` — your numeric ID is bound as owner and locked.
2. Add the bot to a group as admin (delete messages, restrict + ban members).
3. In the group say `help`.

## Security notes
- Token, service key and webhook secret exist only as environment variables.
- Webhook requires Telegram's secret header (constant-time compare); duplicate updates are ignored.
- RLS is on for every table with no policies; only the server's service key reads data.
- Dashboard login is a single-use 10-minute link in the URL *fragment*; sessions are hashed server-side, httpOnly + SameSite=Strict, CSRF header required, strict CSP, all dashboard data rendered via textContent.
- Dashboard shows a group only to its Telegram admins (verified live) or the owner.
