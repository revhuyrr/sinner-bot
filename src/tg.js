import { readFile } from 'node:fs/promises';
import { BOT_TOKEN } from './config.js';

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export async function tg(method, params = {}) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) { const e = new Error(`${method}: ${j.description}`); e.code = j.error_code; throw e; }
  return j.result;
}
export const safe = (m, p) => tg(m, p).catch((e) => { console.error(e.message); return null; });

let welcomeFileId = null;
// Sends the bundled welcome art. Uploads once, then reuses Telegram's file_id.
export async function sendWelcomePhoto(chat_id, caption, fileId) {
  const base = { chat_id, caption: caption.slice(0, 1024), parse_mode: 'HTML' };
  const id = fileId || welcomeFileId;
  try {
    if (id) return await tg('sendPhoto', { ...base, photo: id });
    const buf = await readFile(new URL('../public/welcome.jpg', import.meta.url));
    const fd = new FormData();
    fd.set('chat_id', String(chat_id)); fd.set('caption', base.caption); fd.set('parse_mode', 'HTML');
    fd.set('photo', new Blob([buf], { type: 'image/jpeg' }), 'welcome.jpg');
    const r = await fetch(`${API}/sendPhoto`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description);
    welcomeFileId = j.result.photo.at(-1).file_id;
    return j.result;
  } catch (e) {
    console.error('welcome photo failed:', e.message);
    return safe('sendMessage', { chat_id, text: caption, parse_mode: 'HTML' }) ||
           safe('sendMessage', { chat_id, text: caption.replace(/<[^>]+>/g, '') });
  }
}

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const nameOf = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.user_id ?? u.id);
export const mention = (u) => `<a href="tg://user?id=${u.user_id ?? u.id}">${esc(nameOf(u))}</a>`;

export async function send(chat_id, text, extra = {}) {
  try { return await tg('sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }); }
  catch (e) {
    if (/parse entities/i.test(e.message))
      return safe('sendMessage', { chat_id, text: text.replace(/<[^>]+>/g, ''), ...extra });
    console.error(e.message); return null;
  }
}
