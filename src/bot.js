import { db, rpc, must } from './db.js';
import { tg, safe, send, sendWelcomePhoto, esc, nameOf, mention } from './tg.js';
import {
  bot, upsertUser, isOwnerUser, isAdmin, getSettings, bustSettings, logAction,
  issueLoginLink, applyAction, parseDur, fmtDur,
} from './core.js';
import { PUBLIC_URL } from './config.js';

const INFO = new Set(['id', 'profile', 'me', 'rank', 'top', 'leaderboard', 'lb', 'rules', 'help', 'warns']);
const MOD = new Set(['warn', 'unwarn', 'mute', 'unmute', 'ban', 'unban', 'kick', 'del']);
const CFG = new Set(['setrules', 'setwelcome', 'setwelcomeimage', 'welcome', 'antispam', 'antilink', 'panel', 'settings']);

const HELP = `🩸 <b>SINNER</b> — commands work with or without a /

<b>Everyone</b>
<code>id</code> · <code>profile</code> (reply to see someone else) · <code>rank</code> · <code>top</code> · <code>rules</code> · <code>warns</code>

<b>Admins</b> (reply to a user, or use @username / ID)
<code>warn [reason]</code> · <code>unwarn</code> · <code>mute [10m|2h|1d]</code> · <code>unmute</code> · <code>kick</code> · <code>ban</code> · <code>unban</code> · <code>del</code>
<code>setrules</code> · <code>setwelcome</code> · <code>setwelcomeimage</code> (reply to a photo)
<code>welcome on|off</code> · <code>antispam on|off</code> · <code>antilink on|off</code> · <code>panel</code>

Welcome text variables: {mention} {name} {group} {count} {id} {username}`;

// ───────────── entry ─────────────
export async function handleUpdate(u) {
  if (!(await rpc('record_update', { p_update_id: u.update_id }))) return; // duplicate delivery
  if (u.my_chat_member) return onBotStatus(u.my_chat_member);
  if (u.message) return onMessage(u.message);
}

async function onBotStatus(ev) {
  const chat = ev.chat;
  if (!['group', 'supergroup'].includes(chat.type)) return;
  const st = ev.new_chat_member.status;
  if (['member', 'administrator'].includes(st)) {
    const s = await getSettings(chat);
    await logAction(s, ev.from?.id, bot.id, 'bot_added', { title: chat.title });
  } else if (['left', 'kicked'].includes(st)) {
    await db.from('groups').update({ active: false, removed_at: new Date().toISOString() }).eq('chat_id', chat.id);
    bustSettings(chat.id);
  }
}

async function onMessage(m) {
  const { chat, from } = m;
  if (!from) return;
  await upsertUser(from);
  if (chat.type === 'private') return onPrivate(m);
  if (!['group', 'supergroup'].includes(chat.type)) return;

  const s = await getSettings(chat);
  if (m.new_chat_members) return onJoin(m, s);
  if (m.left_chat_member) return onLeave(m, s);
  if (from.is_bot) return;

  const text = m.text || m.caption || '';
  const admin = await isAdmin(chat.id, from.id);
  if (!admin && s.antispam_enabled && (await spamCheck(m, s, text))) return;
  if (text && (await command(m, s, text, admin))) return;
  if (s.xp_enabled && text.length >= 3) await giveXp(m, s);
}

// ───────────── welcome / goodbye ─────────────
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));

async function onJoin(m, s) {
  const count = await tg('getChatMemberCount', { chat_id: m.chat.id }).catch(() => '?');
  for (const u of m.new_chat_members) {
    if (u.id === bot.id) {
      await send(m.chat.id, '🩸 <b>SINNER</b> has arrived. Make me admin (delete, restrict, ban) and say <code>help</code>.');
      continue;
    }
    await upsertUser(u);
    must(await db.from('members').upsert({ chat_id: m.chat.id, user_id: u.id, is_left: false }, { onConflict: 'chat_id,user_id' }));
    await logAction(s, m.from?.id, u.id, 'join', { name: nameOf(u) });
    if (u.is_bot || !s.welcome_enabled) continue;
    const caption = fill(s.welcome_text, {
      group: esc(m.chat.title), mention: mention(u), name: esc(nameOf(u)),
      count, id: u.id, username: u.username ? '@' + u.username : esc(nameOf(u)),
    });
    await sendWelcomePhoto(m.chat.id, caption, s.welcome_image_file_id);
  }
}

async function onLeave(m, s) {
  const u = m.left_chat_member;
  if (u.id === bot.id) return;
  await upsertUser(u);
  await db.from('members').update({ is_left: true }).eq('chat_id', m.chat.id).eq('user_id', u.id);
  await logAction(s, m.from?.id, u.id, 'leave', { name: nameOf(u) });
  if (s.goodbye_enabled) await send(m.chat.id, fill(s.goodbye_text, { name: esc(nameOf(u)), group: esc(m.chat.title), id: u.id }));
}

// ───────────── anti-spam ─────────────
const LINK_RE = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)[^\s]+/gi;
function hasBadLink(m, text, whitelist) {
  const ents = [...(m.entities || []), ...(m.caption_entities || [])];
  const urls = [...(text.match(LINK_RE) || []), ...ents.filter((e) => e.type === 'text_link').map((e) => e.url)];
  return urls.some((u) => !whitelist.some((d) => u.toLowerCase().includes(d.toLowerCase())));
}

async function spamCheck(m, s, text) {
  const chatId = m.chat.id, uid = m.from.id;
  let reason = null, first = true;
  const hits = await rpc('register_flood', { p_chat: chatId, p_user: uid, p_window: s.flood_window_secs });
  if (hits > s.flood_limit) { reason = 'flood'; first = hits === s.flood_limit + 1; }
  else if (s.antilink_enabled && text && hasBadLink(m, text, s.link_whitelist || [])) reason = 'link';
  if (!reason) return false;

  await safe('deleteMessage', { chat_id: chatId, message_id: m.message_id });
  if (!first) return true; // already punished this burst; keep deleting silently
  await logAction(s, bot.id, uid, 'spam', { reason, action: s.spam_action });
  let note = null;
  try {
    if (s.spam_action === 'warn') await warnFlow(chatId, m.from, bot.id, `anti-spam: ${reason}`, s);
    else if (s.spam_action === 'mute') { await applyAction(chatId, uid, 'mute', s.spam_mute_secs); note = `🔇 ${mention(m.from)} muted ${fmtDur(s.spam_mute_secs)} for ${reason}.`; }
    else if (s.spam_action === 'kick') { await applyAction(chatId, uid, 'kick'); note = `👢 ${mention(m.from)} removed for ${reason}.`; }
    else if (s.spam_action === 'ban') { await applyAction(chatId, uid, 'ban'); note = `🔨 ${mention(m.from)} banned for ${reason}.`; }
    else note = `🚫 ${mention(m.from)}: ${reason} is not allowed here.`;
  } catch (e) { console.error('spam action failed:', e.message); }
  if (note) {
    const r = await send(chatId, note);
    if (r) setTimeout(() => safe('deleteMessage', { chat_id: chatId, message_id: r.message_id }), 10_000);
  }
  return true;
}

// ───────────── XP ─────────────
async function giveXp(m, s) {
  const rows = await rpc('award_xp', { p_chat: m.chat.id, p_user: m.from.id, p_amount: s.xp_per_message, p_cooldown: s.xp_cooldown_secs });
  const r = rows?.[0];
  if (r?.o_leveled_up && s.levelup_announce) {
    await send(m.chat.id, `🩸 ${mention(m.from)} ascended to <b>level ${r.o_level}</b>.`);
    await logAction(s, m.from.id, m.from.id, 'levelup', { level: r.o_level, xp: r.o_xp });
  }
}

// ───────────── commands ─────────────
function parse(text) {
  const t = text.trim();
  const prefixed = /^[\/!.]/.test(t);
  const mt = t.replace(/^[\/!.]/, '').match(/^([a-zA-Z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!mt) return null;
  if (mt[2] && mt[2].toLowerCase() !== bot.username.toLowerCase()) return null;
  return { cmd: mt[1].toLowerCase(), args: (mt[3] || '').trim(), prefixed };
}

async function command(m, s, text, admin) {
  const p = parse(text);
  if (!p) return false;
  const { cmd, args, prefixed } = p;
  const say = (t, extra = {}) => send(m.chat.id, t, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true }, ...extra });

  if (INFO.has(cmd)) {
    if (!prefixed && text.trim().split(/\s+/).length > 3) return false; // ordinary chat, not a command
    if (cmd === 'help') { await say(HELP); return true; }
    if (cmd === 'rules') { await say(s.rules_text ? `📜 <b>Rules</b>\n${esc(s.rules_text)}` : 'No rules have been set. Admins: <code>setrules …</code>'); return true; }
    if (['top', 'leaderboard', 'lb'].includes(cmd)) { await leaderboard(m, say); return true; }
    const t = (await resolveTarget(m, '', true))?.user || m.from;
    if (cmd === 'warns') { await showWarns(m, s, t, say); return true; }
    await profile(m, s, t, cmd === 'rank');
    return true;
  }

  if (!MOD.has(cmd) && !CFG.has(cmd)) return false;
  if (!admin) { if (prefixed) await say('⛔ Admins only.'); return false; }

  try {
    if (cmd === 'panel' || cmd === 'settings') {
      await say('🩸 Manage this group from the dashboard.', { reply_markup: { inline_keyboard: [[{ text: 'Open dashboard', url: `https://t.me/${bot.username}?start=panel` }]] } });
      return true;
    }
    if (['welcome', 'antispam', 'antilink'].includes(cmd)) {
      const on = /^(on|yes|enable)/i.test(args), off = /^(off|no|disable)/i.test(args);
      if (!on && !off) { await say(`Usage: <code>${cmd} on</code> or <code>${cmd} off</code>`); return true; }
      const col = { welcome: 'welcome_enabled', antispam: 'antispam_enabled', antilink: 'antilink_enabled' }[cmd];
      await saveSetting(m, s, { [col]: on });
      await say(`✅ ${cmd} is now <b>${on ? 'on' : 'off'}</b>.`);
      return true;
    }
    if (cmd === 'setrules' || cmd === 'setwelcome') {
      const body = (args || m.reply_to_message?.text || '').slice(0, cmd === 'setrules' ? 3000 : 900);
      if (!body) { await say(`Usage: <code>${cmd} your text</code>`); return true; }
      await saveSetting(m, s, { [cmd === 'setrules' ? 'rules_text' : 'welcome_text']: body });
      await say('✅ Saved.');
      return true;
    }
    if (cmd === 'setwelcomeimage') {
      const ph = m.reply_to_message?.photo?.at(-1);
      if (!ph) { await say('Reply to a photo with <code>setwelcomeimage</code>.'); return true; }
      await saveSetting(m, s, { welcome_image_file_id: ph.file_id });
      await say('✅ Welcome image updated.');
      return true;
    }
    if (cmd === 'del') {
      if (m.reply_to_message) await safe('deleteMessage', { chat_id: m.chat.id, message_id: m.reply_to_message.message_id });
      await safe('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id });
      return true;
    }

    // moderation on a target
    const tr = await resolveTarget(m, args);
    if (!tr) { await say('Reply to a user, or give an @username / numeric ID.'); return true; }
    const t = tr.user;
    if (t.id === bot.id) { await say('Nice try.'); return true; }
    if (await isAdmin(m.chat.id, t.id)) { await say('I will not act on admins.'); return true; }
    const rest = tr.rest;

    if (cmd === 'warn') {
      await warnFlow(m.chat.id, t, m.from.id, rest || null, s, say);
    } else if (cmd === 'unwarn') {
      const n = await rpc('remove_warning', { p_chat: m.chat.id, p_user: t.id });
      await logAction(s, m.from.id, t.id, 'unwarn', {});
      await say(`✅ Removed a warning from ${mention(t)} (${n}/${s.max_warns}).`);
    } else if (cmd === 'mute') {
      const [first, ...more] = rest.split(/\s+/);
      const dur = parseDur(first) ?? 3600;
      const reason = (parseDur(first) ? more.join(' ') : rest) || null;
      await applyAction(m.chat.id, t.id, 'mute', dur);
      await logAction(s, m.from.id, t.id, 'mute', { secs: dur, reason });
      await say(`🔇 ${mention(t)} muted for ${fmtDur(dur)}.${reason ? '\n' + esc(reason) : ''}`);
    } else {
      await applyAction(m.chat.id, t.id, cmd);
      await logAction(s, m.from.id, t.id, cmd, { reason: rest || null });
      const msg = { unmute: '🔊 unmuted', ban: '🔨 banned', unban: '✅ unbanned', kick: '👢 removed' }[cmd];
      await say(`${msg}: ${mention(t)}${rest && cmd !== 'unmute' ? '\n' + esc(rest) : ''}`);
    }
  } catch (e) {
    console.error(`${cmd} failed:`, e.message);
    await say(/rights|administrator|permission|CHAT_ADMIN/i.test(e.message)
      ? '⚠️ I need admin rights (delete messages, restrict & ban members) to do that.'
      : '⚠️ That did not work. Check my permissions and try again.');
  }
  return true;
}

async function saveSetting(m, s, patch) {
  must(await db.from('group_settings').update(patch).eq('chat_id', m.chat.id));
  bustSettings(m.chat.id);
  await logAction(s, m.from.id, null, 'setting_change', { via: 'chat', keys: Object.keys(patch) });
}

async function warnFlow(chatId, user, adminId, reason, s, say) {
  const n = await rpc('add_warning', { p_chat: chatId, p_user: user.id, p_admin: adminId, p_reason: reason });
  await logAction(s, adminId, user.id, 'warn', { reason, count: n });
  const post = say || ((t) => send(chatId, t));
  await post(`⚠️ ${mention(user)} warned (${n}/${s.max_warns}).${reason ? '\n' + esc(reason) : ''}`);
  if (n >= s.max_warns) {
    await applyAction(chatId, user.id, s.warn_action, s.warn_action_secs);
    await db.from('members').update({ warn_count: 0 }).eq('chat_id', chatId).eq('user_id', user.id);
    await logAction(s, bot.id, user.id, 'warn_limit', { action: s.warn_action });
    await post(`🚨 ${mention(user)} hit the warn limit — action: <b>${s.warn_action}</b>.`);
  }
}

async function resolveTarget(m, args, replyOnly = false) {
  const rep = m.reply_to_message;
  if (rep?.from && !rep.sender_chat) { await upsertUser(rep.from); return { user: rep.from, rest: args }; }
  if (replyOnly) return null;
  const [tok, ...more] = args.split(/\s+/);
  const rest = more.join(' ');
  if (/^@\w{3,}$/.test(tok || '')) {
    const { data } = await db.from('users').select('*').eq('username', tok.slice(1).toLowerCase()).maybeSingle();
    return data ? { user: { id: data.user_id, username: data.username, first_name: data.first_name, last_name: data.last_name }, rest } : null;
  }
  if (/^\d{5,}$/.test(tok || '')) {
    const id = Number(tok);
    await upsertUser({ id });
    const { data } = await db.from('users').select('*').eq('user_id', id).single();
    return { user: { id, username: data?.username, first_name: data?.first_name, last_name: data?.last_name }, rest };
  }
  return null;
}

// ───────────── profile / rank / top / warns ─────────────
const xpFor = (lvl) => 100 * lvl * lvl;
const bar = (p) => '█'.repeat(Math.round(p * 10)) + '░'.repeat(10 - Math.round(p * 10));

async function profile(m, s, t, rankOnly) {
  const uid = t.id ?? t.user_id;
  const { data: mem } = await db.from('members').select('*').eq('chat_id', m.chat.id).eq('user_id', uid).maybeSingle();
  const rank = mem ? await rpc('get_rank', { p_chat: m.chat.id, p_user: uid }) : null;
  const lvl = mem?.level ?? 0, xp = Number(mem?.xp ?? 0);
  const lo = xpFor(lvl), hi = xpFor(lvl + 1), prog = Math.min(1, (xp - lo) / (hi - lo));
  const status = await tg('getChatMember', { chat_id: m.chat.id, user_id: uid }).then((r) => r.status).catch(() => 'unknown');
  const lines = [
    `🩸 <b>${esc(nameOf(t))}</b>`,
    '━━━━━━━━━━━━',
    `🆔 <code>${uid}</code>`,
    `👤 ${t.username ? '@' + esc(t.username) : '—'}`,
    `🎖 ${status}`,
    `⚔️ Level <b>${lvl}</b> · ${xp} XP`,
    `${bar(prog)} ${xp}/${hi}`,
    `🏆 Rank ${rank ? '#' + rank : '—'}`,
  ];
  if (!rankOnly) lines.push(
    `💬 Messages: ${mem?.message_count ?? 0}`,
    `⚠️ Warns: ${mem?.warn_count ?? 0}/${s.max_warns}`,
    `📅 Joined: ${mem ? new Date(mem.joined_at).toISOString().slice(0, 10) : '—'}`,
  );
  const caption = lines.join('\n');
  const photos = await tg('getUserProfilePhotos', { user_id: uid, limit: 1 }).catch(() => null);
  const fid = photos?.photos?.[0]?.at(-1)?.file_id;
  const reply = { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } };
  if (fid && (await safe('sendPhoto', { chat_id: m.chat.id, photo: fid, caption, parse_mode: 'HTML', ...reply }))) return;
  await send(m.chat.id, caption, reply);
}

async function leaderboard(m, say) {
  const rows = await rpc('get_leaderboard', { p_chat: m.chat.id, p_limit: 10 });
  if (!rows?.length) return void (await say('No one has earned XP yet. Start talking.'));
  const medal = ['🥇', '🥈', '🥉'];
  await say('🏆 <b>Leaderboard</b>\n' + rows.map((r) =>
    `${medal[r.rank - 1] || `<b>${r.rank}.</b>`} ${esc(r.first_name || r.username || r.user_id)} — lvl ${r.level} · ${r.xp} XP`).join('\n'));
}

async function showWarns(m, s, t, say) {
  const uid = t.id ?? t.user_id;
  const { data } = await db.from('warnings').select('reason,created_at').eq('chat_id', m.chat.id).eq('user_id', uid)
    .order('created_at', { ascending: false }).limit(10);
  if (!data?.length) return void (await say(`${mention(t)} has no warnings.`));
  await say(`⚠️ <b>${esc(nameOf(t))}</b> — ${data.length}/${s.max_warns}\n` +
    data.map((w) => `• ${w.created_at.slice(0, 10)} — ${esc(w.reason || 'no reason')}`).join('\n'));
}

// ───────────── private chat: start, dashboard link, owner tools ─────────────
async function onPrivate(m) {
  const text = (m.text || '').trim();
  const p = parse(text);
  if (!p) return;
  const say = (t, extra) => send(m.chat.id, t, extra);
  const owner = await isOwnerUser(m.from);

  if (p.cmd === 'start' && !/panel/i.test(p.args)) {
    await sendWelcomePhoto(m.chat.id,
      '🩸 <b>SINNER</b>\nGroup management, moderation, XP and logs.\n\nAdd me to your group as admin, then say <code>help</code> there.\nSend <code>panel</code> here for your dashboard link.');
    return;
  }
  if (p.cmd === 'panel' || p.cmd === 'dashboard' || p.cmd === 'start') {
    const link = await issueLoginLink(m.from.id);
    if (!link) return void (await say('Dashboard URL is not configured yet (PUBLIC_URL).'));
    await say('🩸 Your dashboard login (single use, expires in 10 minutes). It shows only groups you administer.',
      { reply_markup: { inline_keyboard: [[{ text: 'Open dashboard', url: link }]] } });
    return;
  }
  if (p.cmd === 'help') return void (await say(HELP));
  if (!owner) return;

  if (p.cmd === 'stats') {
    const c = async (t, f) => (await (f ? f(db.from(t).select('*', { count: 'exact', head: true })) : db.from(t).select('*', { count: 'exact', head: true }))).count ?? 0;
    const [g, u, w, l] = await Promise.all([c('groups', (q) => q.eq('active', true)), c('users'), c('warnings'), c('activity_logs')]);
    return void (await say(`👑 <b>Owner stats</b>\nGroups: ${g}\nUsers seen: ${u}\nWarnings issued: ${w}\nLog entries: ${l}`));
  }
  if (p.cmd === 'groups') {
    const { data } = await db.from('groups').select('chat_id,title').eq('active', true).order('added_at', { ascending: false }).limit(40);
    return void (await say(data?.length ? '👑 <b>Groups</b>\n' + data.map((g) => `• ${esc(g.title)} — <code>${g.chat_id}</code>`).join('\n') : 'No active groups.'));
  }
  if (p.cmd === 'broadcast') {
    if (!p.args) return void (await say('Usage: <code>broadcast your message</code>'));
    const { data } = await db.from('groups').select('chat_id').eq('active', true);
    let ok = 0;
    for (const g of data || []) { if (await send(g.chat_id, p.args.slice(0, 3500))) ok++; await new Promise((r) => setTimeout(r, 60)); }
    return void (await say(`📣 Delivered to ${ok}/${data?.length ?? 0} groups.`));
  }
  if (p.cmd === 'leave' && /^-?\d+$/.test(p.args)) {
    await safe('leaveChat', { chat_id: Number(p.args) });
    await db.from('groups').update({ active: false, removed_at: new Date().toISOString() }).eq('chat_id', Number(p.args));
    bustSettings(p.args);
    return void (await say('Left.'));
  }
}
