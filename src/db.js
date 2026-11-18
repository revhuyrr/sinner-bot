import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

export async function rpc(name, args = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`rpc ${name}: ${error.message}`);
  return data;
}
export const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
