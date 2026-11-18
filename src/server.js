import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PORT, PUBLIC_URL, WEBHOOK_SECRET } from './config.js';
import { db, rpc, must } from './db.js';
import { tg, safe, send, esc } from './tg.js';
import { bot, sha256, upsertUser, isAdmin, applyAction, getSettings, bustSettings, logAction, parseDur } from './core.js';
import { handleUpdate } from './bot.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  next();
});

app.get('/healthz', (_q, r) => r.json({ ok: true }));

// ───────── Telegram webhook ─────────
const eq = (a, b) => { const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b)); return timingSafeEqual(x, y); };
app.post('/webhook', express.json({ limit: '1mb' }), (req, res) => {
  if (!eq(String(req.get('x-telegram-bot-api-secret-token') || ''), WEBHOOK_SECRET)) return res.sendStatus(401);
  res.sendStatus(200); // ack fast; Telegram retries are de-duplicated by record_update()
  handleUpdate(req.body).catch((e) => console.error('update failed:', e.message));
});

// ───────── dashboard API ─────────
const api = express.Router();
api.use(express.json({ limit: '100kb' }));
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'sinner') return res.status(403).json({ error: 'csrf' });
  next();
});

const hitsByIp = new Map();
const limited = (ip) => {
  const now = Date.now(), h = (hitsByIp.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now); hitsByIp.set(ip, h); return h.length > 10;
};
const secure = PUBLIC_URL.startsWith('https');
const cookie = (name, val, maxAge) =>
  `${name}=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const getCookie = (req, n) => (req.get('cookie') || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === n)?.[1];

api.post('/login', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'slow down' });
  const code = String(req.body?.code || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return res.status(400).json({ error: 'invalid code' });
  const { data } = await db.from('dashboard_sessions').delete() // single use: consumed even on success
    .eq('token_hash', sha256(code)).eq('user_agent', 'login-code').gt('expires_at', new Date().toISOString()).select().maybeSingle();
  if (!data) return res.status(401).json({ error: 'code expired or already used — send "panel" to the bot again' });
  const token = randomBytes(32).toString('base64url');
  must(await db.from('dashboard_sessions').insert({
    token_hash: sha256(token), user_id: data.user_id, user_agent: (req.get('user-agent') || '').slice(0, 200),
    expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  }));
  res.set('Set-Cookie', cookie('sid', token, 7 * 86400)).json({ ok: true });
});

api.post('/logout', async (req, res) => {
  const t = getCookie(req, 'sid');
  if (t) await db.from('dashboard_sessions').delete().eq('token_hash', sha256(t));
  res.set('Set-Cookie', cookie('sid', '', 0)).json({ ok: true });
});

const auth = async (req, res, next) => {
  const t = getCookie(req, 'sid');
  if (!t) return res.status(401).json({ error: 'auth' });
  const { data: s } = await db.from('dashboard_sessions').select('user_id').eq('token_hash', sha256(t))
    .neq('user_agent', 'login-code').gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!s) return res.status(401).json({ error: 'auth' });
  const { data: u } = await db.from('users').select('*').eq('user_id', s.user_id).single();
  const { data: o } = await db.from('bot_owners').select('user_id').eq('user_id', s.user_id).maybeSingle();
  req.user = { id: u.user_id, username: u.username, first_name: u.first_name, owner: !!o };
  next();
};
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e.message); res.status(500).json({ error: 'server error' }); });
const ownerOnly = (req, res, next) => (req.user.owner ? next() : res.status(403).json({ error: 'owner only' }));
const groupGuard = async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { data: g } = await db.from('groups').select('*').eq('chat_id', id).eq('active', true).maybeSingle();
  if (!g) return res.status(404).json({ error: 'group not found' });
  if (!(await isAdmin(id, req.user.id))) return res.status(403).json({ error: 'not an admin of this group' });
  req.group = g; next();
};

api.get('/me', auth, (req, res) => res.json(req.user));

api.get('/groups', auth, wrap(async (req, res) => {
  let q = db.from('groups').select('chat_id,title,username').eq('active', true).order('title');
  if (!req.user.owner) {
    const { data: ms } = await db.from('members').select('chat_id').eq('user_id', req.user.id).eq('is_left', false);
    if (!ms?.length) return res.json([]);
    q = q.in('chat_id', ms.map((m) => m.chat_id));
  }
  const { data } = await q;
  const keep = req.user.owner ? data : (await Promise.all(data.map(async (g) => (await isAdmin(g.chat_id, req.user.id)) ? g : null))).filter(Boolean);
  res.json(keep);
}));

api.get('/groups/:id/overview', auth, groupGuard, wrap(async (req, res) => {
  const [stats, settings] = await Promise.all([rpc('group_stats', { p_chat: req.group.chat_id }), getSettings({ id: req.group.chat_id, title: req.group.title, type: req.group.chat_type })]);
  res.json({ group: req.group, stats, settings });
}));

api.get('/groups/:id/leaderboard', auth, groupGuard, wrap(async (req, res) =>
  res.json(await rpc('get_leaderboard', { p_chat: req.group.chat_id, p_limit: 50 }))));

api.get('/groups/:id/members', auth, groupGuard, wrap(async (req, res) => {
  const search = String(req.query.q || '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').trim();
  let q = db.from('members').select('user_id,xp,level,message_count,warn_count,muted_until,is_banned,users(username,first_name,last_name)')
    .eq('chat_id', req.group.chat_id).eq('is_left', false).order('xp', { ascending: false }).limit(100);
  const { data } = await q;
  const rows = (data || []).map((m) => ({ ...m, ...m.users, users: undefined }))
    .filter((m) => !search || `${m.username || ''} ${m.first_name || ''} ${m.user_id}`.toLowerCase().includes(search));
  res.json(rows);
}));

api.post('/groups/:id/members/:uid/action', auth, groupGuard, wrap(async (req, res) => {
  const uid = Number(req.params.uid), action = String(req.body?.action);
  if (!Number.isSafeInteger(uid) || !['mute', 'unmute', 'kick', 'ban', 'unban', 'resetwarns'].includes(action)) return res.status(400).json({ error: 'bad request' });
  if (uid === bot.id || (await isAdmin(req.group.chat_id, uid))) return res.status(403).json({ error: 'cannot act on admins' });
  const s = await getSettings({ id: req.group.chat_id, title: req.group.title, type: req.group.chat_type });
  try {
    if (action === 'resetwarns') {
      await db.from('warnings').delete().eq('chat_id', req.group.chat_id).eq('user_id', uid);
      await db.from('members').update({ warn_count: 0 }).eq('chat_id', req.group.chat_id).eq('user_id', uid);
    } else {
      const secs = action === 'mute' ? Math.min(Math.max(parseDur(String(req.body?.duration || '1h')) || 3600, 60), 31536000) : undefined;
      await applyAction(req.group.chat_id, uid, action, secs);
    }
  } catch (e) { return res.status(502).json({ error: 'Telegram refused: ' + e.message }); }
  await logAction(s, req.user.id, uid, action === 'resetwarns' ? 'unwarn_all' : action, { via: 'dashboard' });
  res.json({ ok: true });
}));

api.get('/groups/:id/logs', auth, groupGuard, wrap(async (req, res) => res.json(await fetchLogs(req.group.chat_id, req.query))));
api.get('/owner/logs', auth, ownerOnly, wrap(async (req, res) => res.json(await fetchLogs(null, req.query))));

async function fetchLogs(chatId, qs) {
  const limit = Math.min(Number(qs.limit) || 50, 100);
  let q = db.from('activity_logs').select('*').order('id', { ascending: false }).limit(limit);
  if (chatId) q = q.eq('chat_id', chatId);
  if (/^[a-z_]{1,24}$/.test(String(qs.action || ''))) q = q.eq('action', qs.action);
  if (/^\d+$/.test(String(qs.before || ''))) q = q.lt('id', Number(qs.before));
  const { data } = await q;
  const ids = [...new Set((data || []).flatMap((r) => [r.actor_id, r.target_id]).filter(Boolean))];
  const names = {};
  if (ids.length) (await db.from('users').select('user_id,username,first_name').in('user_id', ids)).data?.forEach((u) => { names[u.user_id] = u.first_name || u.username || u.user_id; });
  return (data || []).map((r) => ({ ...r, actor: names[r.actor_id] ?? null, target: names[r.target_id] ?? null }));
}

const SETTINGS = {
  bool: ['welcome_enabled', 'goodbye_enabled', 'antispam_enabled', 'antilink_enabled', 'xp_enabled', 'levelup_announce', 'log_enabled'],
  text: { welcome_text: 900, goodbye_text: 500, rules_text: 3000 },
  int: { flood_limit: [2, 50], flood_window_secs: [2, 120], spam_mute_secs: [10, 2592000], max_warns: [1, 20], warn_action_secs: [60, 31536000], xp_per_message: [1, 100], xp_cooldown_secs: [0, 3600] },
  enums: { spam_action: ['delete', 'warn', 'mute', 'kick', 'ban'], warn_action: ['mute', 'kick', 'ban'] },
};
api.put('/groups/:id/settings', auth, groupGuard, wrap(async (req, res) => {
  const b = req.body || {}, patch = {};
  for (const k of SETTINGS.bool) if (k in b) { if (typeof b[k] !== 'boolean') return res.status(400).json({ error: k }); patch[k] = b[k]; }
  for (const [k, max] of Object.entries(SETTINGS.text)) if (k in b) {
    if (typeof b[k] !== 'string' || b[k].length > max || (k === 'welcome_text' && !b[k].trim())) return res.status(400).json({ error: k });
    patch[k] = b[k] || null; if (k !== 'rules_text' && !patch[k]) delete patch[k];
  }
  for (const [k, [lo, hi]] of Object.entries(SETTINGS.int)) if (k in b) {
    if (!Number.isInteger(b[k]) || b[k] < lo || b[k] > hi) return res.status(400).json({ error: `${k} must be ${lo}-${hi}` }); patch[k] = b[k];
  }
  for (const [k, opts] of Object.entries(SETTINGS.enums)) if (k in b) { if (!opts.includes(b[k])) return res.status(400).json({ error: k }); patch[k] = b[k]; }
  if ('link_whitelist' in b) {
    if (!Array.isArray(b.link_whitelist) || b.link_whitelist.length > 50 || b.link_whitelist.some((d) => typeof d !== 'string' || d.length > 100)) return res.status(400).json({ error: 'link_whitelist' });
    patch.link_whitelist = b.link_whitelist.map((d) => d.trim().toLowerCase()).filter(Boolean);
  }
  if ('log_channel_id' in b) {
    if (b.log_channel_id !== null && !Number.isSafeInteger(b.log_channel_id)) return res.status(400).json({ error: 'log_channel_id' });
    patch.log_channel_id = b.log_channel_id;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
  must(await db.from('group_settings').update(patch).eq('chat_id', req.group.chat_id));
  bustSettings(req.group.chat_id);
  const s = await getSettings({ id: req.group.chat_id, title: req.group.title, type: req.group.chat_type });
  await logAction(s, req.user.id, null, 'setting_change', { via: 'dashboard', keys: Object.keys(patch) });
  res.json(s);
}));

api.get('/owner/overview', auth, ownerOnly, wrap(async (_q, res) => {
  const [stats, { data: groups }] = await Promise.all([rpc('global_stats'), db.from('groups').select('chat_id,title,username,added_at').eq('active', true).order('added_at', { ascending: false })]);
  res.json({ stats, groups });
}));
api.post('/owner/groups/:id/leave', auth, ownerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'bad id' });
  await safe('leaveChat', { chat_id: id });
  await db.from('groups').update({ active: false, removed_at: new Date().toISOString() }).eq('chat_id', id);
  bustSettings(id); res.json({ ok: true });
}));
api.post('/owner/broadcast', auth, ownerOnly, wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 3500);
  if (!text) return res.status(400).json({ error: 'empty' });
  const { data } = await db.from('groups').select('chat_id').eq('active', true);
  let ok = 0;
  for (const g of data || []) { if (await send(g.chat_id, esc(text))) ok++; await new Promise((r) => setTimeout(r, 60)); }
  res.json({ delivered: ok, total: data?.length ?? 0 });
}));

app.use('/api', api);
app.use(express.static(new URL('../public/', import.meta.url).pathname, { index: 'index.html', maxAge: '1h' }));

// ───────── boot ─────────
const me = await tg('getMe');
bot.id = me.id; bot.username = me.username;
await upsertUser({ id: me.id, username: me.username, first_name: me.first_name, is_bot: true });
if (PUBLIC_URL) {
  await tg('setWebhook', { url: `${PUBLIC_URL}/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'my_chat_member'], max_connections: 40 });
  console.log(`Webhook set → ${PUBLIC_URL}/webhook`);
} else console.warn('PUBLIC_URL not set: webhook and dashboard links are disabled.');
await safe('setMyCommands', { commands: [{ command: 'help', description: 'Show commands' }, { command: 'id', description: 'Your ID profile' }, { command: 'rank', description: 'Your XP rank' }, { command: 'top', description: 'Leaderboard' }, { command: 'rules', description: 'Group rules' }, { command: 'panel', description: 'Open the dashboard' }] });
setInterval(() => rpc('cleanup_runtime').catch((e) => console.error(e.message)), 3600_000);
app.listen(PORT, () => console.log(`SINNER @${bot.username} listening on :${PORT}`));
