import { createHash, randomBytes } from 'node:crypto';
import { db, rpc, must } from './db.js';
import { OWNER, PUBLIC_URL } from './config.js';
import { tg, send, esc } from './tg.js';

export const bot = { id: 0, username: '' };
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ───── users ─────
export async function upsertUser(u) {
  const row = { user_id: u.id ?? u.user_id, last_seen: new Date().toISOString() };
  if (u.username !== undefined || u.first_name !== undefined) {
    row.username = u.username ? u.username.toLowerCase() : null;
    row.first_name = u.first_name ?? null;
    row.last_name = u.last_name ?? null;
    row.is_bot = !!u.is_bot;
  }
  must(await db.from('users').upsert(row, { onConflict: 'user_id' }));
}

// ───── owner / admin checks ─────
let ownerId = null;
async function ownerIdLookup() {
  if (ownerId) return ownerId;
  const { data } = await db.from('bot_owners').select('user_id').eq('username', OWNER).maybeSingle();
  ownerId = data?.user_id ?? null;
  return ownerId;
}
export async function isOwnerUser(u) {
  const id = await ownerIdLookup();
  if (id) return id === u.id;
  if (u.username?.toLowerCase() === OWNER && (await rpc('resolve_owner', { p_user: u.id, p_username: u.username }))) {
    ownerId = u.id; return true;
  }
  return false;
}
const adminCache = new Map();
export async function isAdmin(chatId, userId) {
  if (userId === 1087968824) return true; // GroupAnonymousBot (anonymous admins)
  if (userId === (await ownerIdLookup())) return true;
  const key = `${chatId}:${userId}`, c = adminCache.get(key);
  if (c && c.exp > Date.now()) return c.v;
  let v = false;
  try { v = ['creator', 'administrator'].includes((await tg('getChatMember', { chat_id: chatId, user_id: userId })).status); } catch {}
  adminCache.set(key, { v, exp: Date.now() + 60_000 });
  return v;
}

// ───── group settings (cached 30s) ─────
const sCache = new Map();
export async function getSettings(chat) {
  const c = sCache.get(chat.id);
  if (c && c.exp > Date.now()) return c.s;
  must(await db.from('groups').upsert({
    chat_id: chat.id, title: chat.title ?? null, username: chat.username ?? null,
    chat_type: chat.type, active: true, removed_at: null,
  }, { onConflict: 'chat_id' }));
  must(await db.from('group_settings').upsert({ chat_id: chat.id }, { onConflict: 'chat_id', ignoreDuplicates: true }));
  const s = must(await db.from('group_settings').select('*').eq('chat_id', chat.id).single());
  sCache.set(chat.id, { s, exp: Date.now() + 30_000 });
  return s;
}
export const bustSettings = (id) => sCache.delete(Number(id));

// ───── activity log ─────
export async function logAction(s, actor, target, action, details = {}) {
  if (!s.log_enabled) return;
  const { error } = await db.from('activity_logs').insert({
    chat_id: s.chat_id, actor_id: actor ?? null, target_id: target ?? null, action, details,
  });
  if (error) console.error('log failed:', error.message);
  if (s.log_channel_id) {
    const line = `<b>${esc(action)}</b> · chat <code>${s.chat_id}</code>` +
      (target ? ` · target <code>${target}</code>` : '') +
      (details.reason ? `\n${esc(String(details.reason).slice(0, 300))}` : '');
    send(s.log_channel_id, line).catch(() => {});
  }
}

// ───── dashboard login codes (single use, 10 min) ─────
export async function issueLoginLink(userId) {
  if (!PUBLIC_URL) return null;
  const code = randomBytes(24).toString('base64url');
  must(await db.from('dashboard_sessions').insert({
    token_hash: sha256(code), user_id: userId,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), user_agent: 'login-code',
  }));
  return `${PUBLIC_URL}/#code=${code}`;
}

// ───── punishments ─────
const PERM_KEYS = ['can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos',
  'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages', 'can_add_web_page_previews'];
const NO_PERMS = Object.fromEntries(PERM_KEYS.map((k) => [k, false]));
const MAX_SECS = 366 * 86400;

export async function applyAction(chatId, userId, action, secs = 600) {
  const keyed = { chat_id: chatId, user_id: userId };
  if (action === 'mute') {
    const until = Math.floor(Date.now() / 1000) + Math.min(secs, MAX_SECS);
    await tg('restrictChatMember', { ...keyed, permissions: NO_PERMS, until_date: until });
    must(await db.from('members').upsert({ ...keyed, muted_until: new Date(until * 1000).toISOString() }, { onConflict: 'chat_id,user_id' }));
  } else if (action === 'unmute') {
    const perms = (await tg('getChat', { chat_id: chatId })).permissions || Object.fromEntries(PERM_KEYS.map((k) => [k, true]));
    await tg('restrictChatMember', { ...keyed, permissions: perms });
    must(await db.from('members').upsert({ ...keyed, muted_until: null }, { onConflict: 'chat_id,user_id' }));
  } else if (action === 'ban') {
    await tg('banChatMember', keyed);
    must(await db.from('members').upsert({ ...keyed, is_banned: true }, { onConflict: 'chat_id,user_id' }));
  } else if (action === 'unban') {
    await tg('unbanChatMember', { ...keyed, only_if_banned: true });
    must(await db.from('members').upsert({ ...keyed, is_banned: false }, { onConflict: 'chat_id,user_id' }));
  } else if (action === 'kick') {
    await tg('banChatMember', keyed);
    await tg('unbanChatMember', { ...keyed, only_if_banned: true });
    must(await db.from('members').upsert({ ...keyed, is_left: true }, { onConflict: 'chat_id,user_id' }));
  }
}

export function parseDur(tok) {
  const m = /^(\d+)([smhdw])$/i.exec(tok || '');
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
}
export function fmtDur(s) {
  if (s >= 86400) return `${Math.round(s / 86400)}d`;
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  return `${Math.max(1, Math.round(s / 60))}m`;
}
