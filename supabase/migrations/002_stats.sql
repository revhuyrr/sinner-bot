-- SINNER · Stage 2 · dashboard statistics
create or replace function public.group_stats(p_chat bigint) returns json
language sql security definer set search_path = public as $$
  select json_build_object(
    'members',     (select count(*) from members where chat_id = p_chat and not is_left),
    'messages',    (select coalesce(sum(message_count),0) from members where chat_id = p_chat),
    'xp',          (select coalesce(sum(xp),0) from members where chat_id = p_chat),
    'warnings',    (select count(*) from warnings where chat_id = p_chat),
    'actions_24h', (select count(*) from activity_logs where chat_id = p_chat and created_at > now() - interval '24 hours'),
    'spam_24h',    (select count(*) from activity_logs where chat_id = p_chat and action = 'spam' and created_at > now() - interval '24 hours'),
    'daily',       (select coalesce(json_agg(d order by d.day), '[]'::json) from (
                      select date_trunc('day', created_at)::date as day, count(*) as n
                      from activity_logs where chat_id = p_chat and created_at > now() - interval '7 days' group by 1) d)
  )
$$;

create or replace function public.global_stats() returns json
language sql security definer set search_path = public as $$
  select json_build_object(
    'groups',      (select count(*) from groups where active),
    'users',       (select count(*) from users),
    'members',     (select count(*) from members where not is_left),
    'messages',    (select coalesce(sum(message_count),0) from members),
    'warnings',    (select count(*) from warnings),
    'actions_24h', (select count(*) from activity_logs where created_at > now() - interval '24 hours')
  )
$$;

revoke execute on function public.group_stats(bigint), public.global_stats() from public, anon, authenticated;
grant  execute on function public.group_stats(bigint), public.global_stats() to service_role;
