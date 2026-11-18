'use strict';
const $app = document.getElementById('app');
const state = { me: null, groups: [], gid: null, tab: 'overview', owner: false };

/* ───── helpers (all user data goes through textContent, never innerHTML) ───── */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
let toastT;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'sinner' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { state.me = null; renderLogin(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
const fmt = (n) => Number(n || 0).toLocaleString();
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const nm = (m) => m.first_name || (m.username ? '@' + m.username : m.user_id);
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

/* ───── login ───── */
function renderLogin(msg = '') {
  $app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('h1', {}, 'SINNER'),
    h('p', {}, 'Moderation, XP and logs for your Telegram groups.'),
    h('ol', {}, h('li', {}, 'Open Telegram and message the bot privately.'), h('li', {}, 'Send ', h('b', {}, 'panel'), '.'), h('li', {}, 'Tap the single-use link it sends you.')),
    h('p', { class: 'err' }, msg))));
}
async function boot() {
  const m = /^#code=([\w-]+)$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    try { await api('/login', { method: 'POST', body: { code: m[1] } }); } catch (e) { return renderLogin(e.message); }
  }
  try { state.me = await api('/me'); } catch { return renderLogin(); }
  state.owner = state.me.owner;
  state.groups = await api('/groups');
  state.gid = state.groups[0]?.chat_id ?? null;
  state.tab = state.gid ? 'overview' : (state.owner ? 'owner' : 'overview');
  renderShell();
}

/* ───── shell ───── */
function renderShell() {
  const side = h('aside', {},
    h('div', { class: 'brand' }, 'SINNER'),
    h('div', { class: 'glist' }, state.groups.length ? state.groups.map((g) =>
      h('button', { class: g.chat_id === state.gid ? 'on' : '', onclick: () => { state.gid = g.chat_id; if (state.tab === 'owner') state.tab = 'overview'; renderShell(); } }, g.title || g.chat_id))
      : h('p', { class: 'muted' }, 'No groups yet. Add the bot to a group as admin, then say a few words there.')),
    h('div', { class: 'who' }, h('span', {}, state.owner ? '👑 ' : '', state.me.first_name || state.me.username || state.me.id),
      h('button', { class: 'sm', onclick: guard(async () => { await api('/logout', { method: 'POST' }); state.me = null; renderLogin(); }) }, 'Sign out')));
  const tabs = ['overview', 'members', 'leaderboard', 'logs', 'settings'];
  const main = h('main', {});
  if (state.gid) {
    const g = state.groups.find((x) => x.chat_id === state.gid);
    main.append(h('h2', {}, g?.title || 'Group'));
  }
  const bar = h('div', { class: 'tabs' },
    state.gid ? tabs.map((t) => h('button', { class: state.tab === t ? 'on' : '', onclick: () => { state.tab = t; renderShell(); } }, t[0].toUpperCase() + t.slice(1))) : null,
    state.owner ? h('button', { class: state.tab === 'owner' ? 'on' : '', onclick: () => { state.tab = 'owner'; renderShell(); } }, '👑 Owner') : null);
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  main.append(bar, body);
  $app.replaceChildren(h('div', { class: 'shell' }, side, main));
  const view = { overview, members, leaderboard, logs, settings, owner: ownerPanel }[state.tab];
  if (state.tab !== 'owner' && !state.gid) { body.replaceChildren(h('p', { class: 'muted' }, 'Select a group.')); return; }
  view(body).catch((e) => body.replaceChildren(h('p', { class: 'err' }, e.message)));
}

const stat = (label, val) => h('div', { class: 'stat' }, h('b', {}, fmt(val)), h('span', {}, label));
const table = (head, rows) => h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rows)));

/* ───── tabs ───── */
async function overview(body) {
  const { stats } = await api(`/groups/${state.gid}/overview`);
  const days = stats.daily || [], max = Math.max(1, ...days.map((d) => d.n));
  body.replaceChildren(
    h('div', { class: 'grid' }, stat('Members', stats.members), stat('Messages', stats.messages), stat('Total XP', stats.xp), stat('Warnings', stats.warnings), stat('Actions 24h', stats.actions_24h), stat('Spam blocked 24h', stats.spam_24h)),
    h('div', { class: 'box' }, h('h3', {}, 'Activity · last 7 days'),
      days.length ? h('div', { class: 'bars' }, days.map((d) => h('div', {}, d.n, h('i', { style: `height:${Math.max(2, (d.n / max) * 90)}px` }), d.day.slice(5)))) : h('p', { class: 'muted' }, 'No logged activity yet.')));
}

async function members(body) {
  const draw = async (q = '') => {
    const rows = await api(`/groups/${state.gid}/members?q=${encodeURIComponent(q)}`);
    const act = (uid, action, label, cls = '') => h('button', { class: `sm ${cls}`, onclick: guard(async () => {
      if (!confirm(`${label} this member?`)) return;
      await api(`/groups/${state.gid}/members/${uid}/action`, { method: 'POST', body: { action, duration: '1h' } });
      toast('Done'); draw(q);
    }) }, label);
    list.replaceChildren(rows.length ? table(['Member', 'Level', 'XP', 'Msgs', 'Warns', 'State', 'Actions'], rows.map((m) => h('tr', {},
      h('td', {}, nm(m), h('div', { class: 'muted' }, m.user_id)), h('td', {}, m.level), h('td', {}, fmt(m.xp)), h('td', {}, fmt(m.message_count)), h('td', {}, m.warn_count),
      h('td', {}, m.is_banned ? h('span', { class: 'tag ban' }, 'banned') : (m.muted_until && new Date(m.muted_until) > new Date() ? h('span', { class: 'tag warn' }, 'muted') : h('span', { class: 'tag' }, 'ok'))),
      h('td', {}, h('div', { class: 'actions' }, act(m.user_id, 'mute', 'Mute 1h'), act(m.user_id, 'unmute', 'Unmute'), act(m.user_id, 'resetwarns', 'Clear warns'), act(m.user_id, 'kick', 'Kick', 'danger'), m.is_banned ? act(m.user_id, 'unban', 'Unban') : act(m.user_id, 'ban', 'Ban', 'danger')))))) : h('p', { class: 'muted' }, 'No members tracked yet — they appear as they chat or join.'));
  };
  const list = h('div', {});
  const search = h('input', { placeholder: 'Search name, @username or ID', oninput: guard(() => draw(search.value)) });
  body.replaceChildren(h('div', { class: 'box' }, search), h('div', { class: 'box' }, list));
  await draw();
}

async function leaderboard(body) {
  const rows = await api(`/groups/${state.gid}/leaderboard`);
  body.replaceChildren(h('div', { class: 'box' }, rows.length
    ? table(['#', 'Member', 'Level', 'XP', 'Messages'], rows.map((r) => h('tr', {}, h('td', {}, r.rank), h('td', {}, nm(r)), h('td', {}, r.level), h('td', {}, fmt(r.xp)), h('td', {}, fmt(r.message_count)))))
    : h('p', { class: 'muted' }, 'Nobody has earned XP yet.')));
}

async function logs(body, global = false) {
  const base = global ? '/owner/logs' : `/groups/${state.gid}/logs`;
  let last = null;
  const tbody = h('tbody', {}), more = h('button', {}, 'Load more');
  const filter = h('select', {}, ['', 'warn', 'mute', 'ban', 'kick', 'unban', 'unmute', 'spam', 'join', 'leave', 'levelup', 'setting_change', 'warn_limit'].map((a) => h('option', { value: a }, a || 'All actions')));
  const load = guard(async (reset) => {
    if (reset) { tbody.replaceChildren(); last = null; }
    const rows = await api(`${base}?limit=50&action=${filter.value}${last ? '&before=' + last : ''}`);
    rows.forEach((r) => tbody.append(h('tr', {}, h('td', {}, when(r.created_at)), h('td', {}, h('span', { class: `tag ${r.action}` }, r.action)), h('td', {}, r.actor ?? '—'), h('td', {}, r.target ?? '—'),
      h('td', { class: 'muted' }, [r.details?.reason, r.details?.via && 'via ' + r.details.via, r.details?.level && 'lvl ' + r.details.level, r.details?.keys?.join(', '), r.details?.secs && r.details.secs + 's'].filter(Boolean).join(' · ')),
      global ? h('td', { class: 'muted' }, r.chat_id) : null)));
    if (rows.length) last = rows.at(-1).id;
    more.style.display = rows.length < 50 ? 'none' : '';
  });
  filter.onchange = () => load(true); more.onclick = () => load(false);
  body.replaceChildren(h('div', { class: 'box' }, h('div', { class: 'field' }, filter),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Action', 'By', 'Target', 'Details', global ? 'Chat' : null].filter(Boolean).map((x) => h('th', {}, x)))), tbody)), h('p', {}, more)));
  await load(true);
}

async function settings(body) {
  const { settings: s } = await api(`/groups/${state.gid}/overview`);
  const inputs = {};
  const sw = (k, label) => { const i = h('input', { type: 'checkbox' }); i.checked = !!s[k]; inputs[k] = () => i.checked; return h('label', { class: 'sw' }, label, i); };
  const num = (k, label, min, max) => { const i = h('input', { type: 'number', min, max }); i.value = s[k]; inputs[k] = () => Number(i.value); return h('div', { class: 'field' }, h('label', {}, `${label} (${min}–${max})`), i); };
  const sel = (k, label, opts) => { const i = h('select', {}, opts.map((o) => h('option', { value: o }, o))); i.value = s[k]; inputs[k] = () => i.value; return h('div', { class: 'field' }, h('label', {}, label), i); };
  const txt = (k, label, max) => { const i = h('textarea', { maxlength: max }); i.value = s[k] || ''; inputs[k] = () => i.value; return h('div', { class: 'field' }, h('label', {}, label), i); };
  const wl = h('textarea', { placeholder: 'example.com' }); wl.value = (s.link_whitelist || []).join('\n'); inputs.link_whitelist = () => wl.value.split('\n').map((x) => x.trim()).filter(Boolean);
  const ch = h('input', { placeholder: 'e.g. -1001234567890 (optional)' }); ch.value = s.log_channel_id ?? ''; inputs.log_channel_id = () => (ch.value.trim() ? Number(ch.value) : null);
  const save = h('button', { class: 'primary', onclick: guard(async () => {
    const payload = {}; for (const [k, f] of Object.entries(inputs)) payload[k] = f();
    await api(`/groups/${state.gid}/settings`, { method: 'PUT', body: payload }); toast('Settings saved');
  }) }, 'Save settings');
  body.replaceChildren(
    h('div', { class: 'row' },
      h('div', { class: 'box' }, h('h3', {}, 'Welcome'), sw('welcome_enabled', 'Send welcome (with Sin Clan artwork)'), txt('welcome_text', 'Welcome text — {mention} {name} {group} {count} {id} {username}', 900), sw('goodbye_enabled', 'Send goodbye'), txt('goodbye_text', 'Goodbye text', 500), txt('rules_text', 'Rules (shown by the “rules” command)', 3000)),
      h('div', { class: 'box' }, h('h3', {}, 'Anti-spam'), sw('antispam_enabled', 'Enable anti-spam'), num('flood_limit', 'Messages allowed per window', 2, 50), num('flood_window_secs', 'Window (seconds)', 2, 120), sel('spam_action', 'Action on spam', ['delete', 'warn', 'mute', 'kick', 'ban']), num('spam_mute_secs', 'Mute length (seconds)', 10, 2592000), sw('antilink_enabled', 'Block links'), h('div', { class: 'field' }, h('label', {}, 'Allowed domains (one per line)'), wl))),
    h('div', { class: 'row' },
      h('div', { class: 'box' }, h('h3', {}, 'Warnings'), num('max_warns', 'Warnings before action', 1, 20), sel('warn_action', 'Action at limit', ['mute', 'kick', 'ban']), num('warn_action_secs', 'Mute length (seconds)', 60, 31536000)),
      h('div', { class: 'box' }, h('h3', {}, 'XP & logging'), sw('xp_enabled', 'XP leveling'), num('xp_per_message', 'XP per message', 1, 100), num('xp_cooldown_secs', 'XP cooldown (seconds)', 0, 3600), sw('levelup_announce', 'Announce level-ups'), sw('log_enabled', 'Record activity logs'), h('div', { class: 'field' }, h('label', {}, 'Log channel ID (bot must be admin there)'), ch))),
    save);
}

async function ownerPanel(body) {
  const { stats, groups } = await api('/owner/overview');
  const msg = h('textarea', { placeholder: 'Message to send to every active group…', maxlength: 3500 });
  body.replaceChildren(
    h('div', { class: 'grid' }, stat('Groups', stats.groups), stat('Users', stats.users), stat('Members', stats.members), stat('Messages', stats.messages), stat('Warnings', stats.warnings), stat('Actions 24h', stats.actions_24h)),
    h('div', { class: 'box' }, h('h3', {}, 'Groups'), groups.length ? table(['Group', 'Chat ID', 'Added', ''], groups.map((g) => h('tr', {}, h('td', {}, g.title || '—'), h('td', {}, g.chat_id), h('td', {}, when(g.added_at)),
      h('td', {}, h('button', { class: 'sm danger', onclick: guard(async () => { if (!confirm(`Make SINNER leave “${g.title}”?`)) return; await api(`/owner/groups/${g.chat_id}/leave`, { method: 'POST' }); toast('Left group'); state.groups = await api('/groups'); renderShell(); }) }, 'Leave'))))) : h('p', { class: 'muted' }, 'No groups yet.')),
    h('div', { class: 'box' }, h('h3', {}, 'Broadcast'), msg, h('p', {}, h('button', { class: 'primary', onclick: guard(async () => {
      if (!msg.value.trim() || !confirm('Send to ALL active groups?')) return;
      const r = await api('/owner/broadcast', { method: 'POST', body: { text: msg.value } }); toast(`Delivered to ${r.delivered}/${r.total}`); msg.value = '';
    }) }, 'Send broadcast'))),
    h('div', { class: 'box' }, h('h3', {}, 'Global activity'), h('div', { id: 'gl' })));
  await logs(document.getElementById('gl'), true);
}

boot();
