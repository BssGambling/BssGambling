// api/admin.js
// Admin panel — coins can ONLY be managed via withdraw and balance checks
// Deposit/set are permanently disabled — coins only come from gameplay

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ADMIN_IDS = [
  'discord_595767263374737409',
  'discord_863482425417662475',
];

async function verifyAdmin(user_id, discord_token) {
  const dcRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${discord_token}` }
  });
  if (!dcRes.ok) throw new Error('Invalid Discord token');
  const dc = await dcRes.json();
  if (`discord_${dc.id}` !== user_id) throw new Error('ID mismatch');
  if (!ADMIN_IDS.includes(user_id)) throw new Error('Not an admin');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, discord_token, action, target_id, amount } = req.body;
    if (!user_id || !discord_token || !action) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    await verifyAdmin(user_id, discord_token);

    const targetId = /^\d{17,20}$/.test(target_id) ? `discord_${target_id}` : target_id;

    // ── PERMANENTLY DISABLED ─────────────────────────────────────────────
    if (action === 'deposit' || action === 'set') {
      return res.status(403).json({
        error: 'Coin deposits are permanently disabled. Coins can only be earned through gameplay.'
      });
    }

    // ── check_admin: frontend calls this on login to show/hide admin nav ─
    if (action === 'check_admin') {
      return res.json({ isAdmin: true });
    }

    // ── Fetch target user ────────────────────────────────────────────────
    const { data: row } = await supabase
      .from('users').select('data').eq('id', targetId).single();
    if (!row) return res.status(404).json({ error: 'Player not found' });

    const userData = row.data ?? {};
    const oldBalance = Math.floor(userData.chips ?? 0);

    // ── withdraw: only allowed action that changes coins ─────────────────
    if (action === 'withdraw') {
      const amt = Math.max(1, Math.floor(amount));
      const newBalance = Math.max(0, oldBalance - amt);
      await supabase.from('users').upsert(
        { id: targetId, data: { ...userData, chips: newBalance } },
        { onConflict: 'id' }
      );
      console.log(`[ADMIN] ${user_id} withdrew ${amt} from ${targetId} (${oldBalance} -> ${newBalance})`);
      return res.json({ ok: true, oldBalance, newBalance });
    }

    // ── lookup: check a player's balance ─────────────────────────────────
    if (action === 'lookup') {
      return res.json({ ok: true, balance: oldBalance, id: targetId });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    if (err.message === 'Not an admin') return res.status(403).json({ error: 'Forbidden' });
    if (err.message === 'Invalid Discord token') return res.status(401).json({ error: 'Invalid token' });
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
