-- SINNER · Stage 1 · Database schema
-- Run in Supabase SQL editor or via `supabase db push`.
-- Security model: RLS is enabled on every table with NO policies, so anon/authenticated
-- keys can read nothing. Only Edge Functions (service role) touch data.

create extension if not exists pgcrypto;

-- ───────── helpers ─────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create or replace function public.level_for_xp(p_xp bigint) returns int
language sql immutable as $$ select floor(sqrt(greatest(p_xp,0) / 100.0))::int $$;

-- ───────── core entities ─────────
create table public.users (
  user_id     bigint primary key,
  username    text,
  first_name  text,
  last_name   text,
  is_bot      boolean not null default false,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index users_username_idx on public.users (lower(username));

create table public.groups (
  chat_id    bigint primary key,
  title      text,
  username   text,
  chat_type  text not null default 'supergroup',
  active     boolean not null default true,
  added_at   timestamptz not null default now(),
  removed_at timestamptz
);

create table public.group_settings (
  chat_id               bigint primary key references public.groups(chat_id) on delete cascade,
  -- welcome
  welcome_enabled       boolean not null default true,
  welcome_text          text not null default E'Welcome to <b>{group}</b>, {mention}.\nYou are member #{count}. Read the rules and behave.',
  welcome_image_file_id text,
  goodbye_enabled       boolean not null default false,
  goodbye_text          text not null default 'Farewell, {name}.',
  rules_text            text,
  -- anti-spam
  antispam_enabled      boolean not null default true,
  flood_limit           int not null default 6  check (flood_limit between 2 and 50),
  flood_window_secs     int not null default 10 check (flood_window_secs between 2 and 120),
  antilink_enabled      boolean not null default false,
  link_whitelist        text[] not null default '{}',
  spam_action           text not null default 'mute' check (spam_action in ('delete','warn','mute','kick','ban')),
  spam_mute_secs        int not null default 600,
  -- moderation
  max_warns             int not null default 3 check (max_warns between 1 and 20),
  warn_action           text not null default 'mute' check (warn_action in ('mute','kick','ban')),
  warn_action_secs      int not null default 86400,
  -- xp
  xp_enabled            boolean not null default true,
  xp_per_message        int not null default 10 check (xp_per_message between 1 and 100),
  xp_cooldown_secs      int not null default 60 check (xp_cooldown_secs between 0 and 3600),
  levelup_announce      boolean not null default true,
  -- logging
  log_enabled           boolean not null default true,
  log_channel_id        bigint,
  updated_at            timestamptz not null default now()
);
create trigger group_settings_touch before update on public.group_settings
  for each row execute function public.touch_updated_at();

create table public.members (
  chat_id       bigint not null references public.groups(chat_id) on delete cascade,
  user_id       bigint not null references public.users(user_id)  on delete cascade,
  joined_at     timestamptz not null default now(),
  xp            bigint not null default 0,
  level         int    not null default 0,
  message_count bigint not null default 0,
  last_xp_at    timestamptz,
  warn_count    int not null default 0,
  muted_until   timestamptz,
  is_banned     boolean not null default false,
  is_left       boolean not null default false,
  primary key (chat_id, user_id)
);
create index members_leaderboard_idx on public.members (chat_id, xp desc) where not is_left;

create table public.warnings (
  id         bigserial primary key,
  chat_id    bigint not null references public.groups(chat_id) on delete cascade,
  user_id    bigint not null references public.users(user_id)  on delete cascade,
  admin_id   bigint references public.users(user_id) on delete set null,
  reason     text,
  created_at timestamptz not null default now()
);
create index warnings_member_idx on public.warnings (chat_id, user_id, created_at desc);

create table public.activity_logs (
  id         bigserial primary key,
  chat_id    bigint references public.groups(chat_id) on delete cascade,
  actor_id   bigint,
  target_id  bigint,
  action     text not null,   -- e.g. warn, mute, ban, kick, unban, join, leave, spam, levelup, setting_change
  details    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index activity_logs_chat_idx on public.activity_logs (chat_id, created_at desc);
create index activity_logs_action_idx on public.activity_logs (action, created_at desc);

-- ───────── ownership & dashboard auth ─────────
create table public.bot_owners (
  username   text primary key,          -- stored lowercase, no @
  user_id    bigint unique,             -- bound on first contact, then locked
  created_at timestamptz not null default now()
);
-- Real configuration, not sample data: the bot owner.
insert into public.bot_owners (username) values ('sinconviction') on conflict do nothing;

create table public.dashboard_sessions (
  token_hash text primary key,          -- sha256 of the session token; raw token never stored
  user_id    bigint not null references public.users(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index dashboard_sessions_exp_idx on public.dashboard_sessions (expires_at);

-- ───────── runtime support ─────────
create table public.processed_updates (   -- webhook idempotency (Telegram retries)
  update_id   bigint primary key,
  received_at timestamptz not null default now()
);
create index processed_updates_age_idx on public.processed_updates (received_at);

create table public.flood_counters (
  chat_id      bigint not null,
  user_id      bigint not null,
  window_start timestamptz not null default now(),
  hits         int not null default 1,
  primary key (chat_id, user_id)
);

-- ───────── atomic functions (service role only) ─────────
create or replace function public.record_update(p_update_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into processed_updates(update_id) values (p_update_id) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;                         -- true = first time seen, process it
end $$;

create or replace function public.register_flood(p_chat bigint, p_user bigint, p_window int)
returns int language plpgsql security definer set search_path = public as $$
declare v_hits int;
begin
  insert into flood_counters as f (chat_id, user_id, window_start, hits)
  values (p_chat, p_user, now(), 1)
  on conflict (chat_id, user_id) do update set
    window_start = case when f.window_start < now() - make_interval(secs => p_window) then now() else f.window_start end,
    hits         = case when f.window_start < now() - make_interval(secs => p_window) then 1 else f.hits + 1 end
  returning f.hits into v_hits;
  return v_hits;
end $$;

create or replace function public.award_xp(p_chat bigint, p_user bigint, p_amount int, p_cooldown int)
returns table (o_xp bigint, o_level int, o_leveled_up boolean)
language plpgsql security definer set search_path = public as $$
declare v_old int; v_new int; v_xp bigint; v_last timestamptz;
begin
  insert into members (chat_id, user_id) values (p_chat, p_user) on conflict do nothing;
  select m.level, m.xp, m.last_xp_at into v_old, v_xp, v_last
    from members m where m.chat_id = p_chat and m.user_id = p_user for update;

  if v_last is null or v_last <= now() - make_interval(secs => p_cooldown) then
    v_xp  := v_xp + p_amount;
    v_new := level_for_xp(v_xp);
    update members m set xp = v_xp, level = v_new, last_xp_at = now(), message_count = m.message_count + 1
      where m.chat_id = p_chat and m.user_id = p_user;
  else
    v_new := v_old;
    update members m set message_count = m.message_count + 1
      where m.chat_id = p_chat and m.user_id = p_user;
  end if;
  return query select v_xp, v_new, v_new > v_old;
end $$;

create or replace function public.add_warning(p_chat bigint, p_user bigint, p_admin bigint, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into members (chat_id, user_id) values (p_chat, p_user) on conflict do nothing;
  insert into warnings (chat_id, user_id, admin_id, reason) values (p_chat, p_user, p_admin, p_reason);
  update members m set warn_count = m.warn_count + 1
    where m.chat_id = p_chat and m.user_id = p_user returning m.warn_count into v_count;
  return v_count;
end $$;

create or replace function public.remove_warning(p_chat bigint, p_user bigint)
returns int language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_count int;
begin
  select id into v_id from warnings where chat_id = p_chat and user_id = p_user
    order by created_at desc limit 1;
  if v_id is not null then delete from warnings where id = v_id; end if;
  update members m set warn_count = greatest(m.warn_count - 1, 0)
    where m.chat_id = p_chat and m.user_id = p_user returning m.warn_count into v_count;
  return coalesce(v_count, 0);
end $$;

-- Binds the owner username to a numeric Telegram ID on first contact, then locks it,
-- so a later username change/transfer cannot hijack ownership.
create or replace function public.resolve_owner(p_user bigint, p_username text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update bot_owners set user_id = p_user
    where username = lower(coalesce(p_username,'')) and user_id is null;
  return exists (select 1 from bot_owners where user_id = p_user);
end $$;

create or replace function public.get_leaderboard(p_chat bigint, p_limit int default 10)
returns table (rank bigint, user_id bigint, username text, first_name text, xp bigint, level int, message_count bigint)
language sql security definer set search_path = public as $$
  select row_number() over (order by m.xp desc, m.joined_at asc),
         m.user_id, u.username, u.first_name, m.xp, m.level, m.message_count
  from members m join users u using (user_id)
  where m.chat_id = p_chat and not m.is_left
  order by m.xp desc, m.joined_at asc
  limit least(greatest(p_limit,1), 50)
$$;

create or replace function public.get_rank(p_chat bigint, p_user bigint)
returns bigint language sql security definer set search_path = public as $$
  select r from (
    select m.user_id, row_number() over (order by m.xp desc, m.joined_at asc) r
    from members m where m.chat_id = p_chat and not m.is_left
  ) t where t.user_id = p_user
$$;

create or replace function public.cleanup_runtime() returns void
language sql security definer set search_path = public as $$
  delete from processed_updates  where received_at < now() - interval '2 days';
  delete from flood_counters     where window_start < now() - interval '1 hour';
  delete from dashboard_sessions where expires_at < now();
$$;

-- ───────── lock everything down ─────────
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
