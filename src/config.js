const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
  return v;
};
export const BOT_TOKEN = need('BOT_TOKEN');
export const WEBHOOK_SECRET = need('WEBHOOK_SECRET');
export const SUPABASE_URL = need('SUPABASE_URL');
export const SUPABASE_KEY = need('SUPABASE_SERVICE_ROLE_KEY');
export const OWNER = (process.env.OWNER_USERNAME || 'Sinconviction').replace(/^@/, '').toLowerCase();
export const PORT = Number(process.env.PORT) || 3000;
export const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/$/, '');
if (!/^[A-Za-z0-9_-]{16,256}$/.test(WEBHOOK_SECRET)) {
  console.error('WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -');
  process.exit(1);
}
