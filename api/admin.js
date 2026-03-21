// api/admin.js  — Deploy this as a new Vercel serverless function
// Add to vercel.json: { "source": "/api/admin", "destination": "/api/admin" }
//
// WHAT THIS FIXES:
// Previously adminDeposit() ran entirely in the browser — anyone could call it
// from the console. Now ALL admin actions require a valid Discord token that
// matches a real admin account, verified server-side.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MAX_CHIPS = 10_000;

// ── Admin list lives ONLY on the server, never in the browser ──
const ADMIN_IDS = [
  'discord_595767263374737409',
  'discord_863482425417662475',
];

async function verifyAdmin(user_id, discord_token) {
  // 1. Verify Discord token is real and belongs to user_id
  const dcRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${discord_token}` }
  });
  if (!dcRes.ok) throw new Error('Invalid Discord token');
  const dc = await dcRes.json();
  if (`discord_${dc.id}` !== user_id) throw new Error('ID mismatch');

  // 2. Check they're actually an admin
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

    // Every request must pass admin verification — no exceptions
    await verifyAdmin(user_id, discord_token);

    // Resolve target (can pass raw Discord ID or full discord_xxx string)
    const targetId = /^\d{17,20}$/.test(target_id)
      ? `discord_${target_id}`
      : target_id;

    const { data: row } = await supabase
      .from('users').select('data').eq('id', targetId).single();

    if (!row) return res.status(404).json({ error: 'Player not found' });

    const userData = row.data ?? {};
    const oldBalance = Math.floor(userData.chips ?? 0);

    if (action === 'deposit') {
      // Hard cap — can never exceed MAX_CHIPS regardless of amount
      if (oldBalance >= MAX_CHIPS) {
        return res.status(400).json({ error: `Player already at max balance (${MAX_CHIPS})` });
      }
      const amt = Math.max(1, Math.min(MAX_CHIPS, Math.floor(amount)));
      const newBalance = Math.min(MAX_CHIPS, oldBalance + amt);
      // Log the admin action with timestamp for audit trail
      const adminLog = { action: 'deposit', by: user_id, target: targetId, amount: amt, oldBalance, newBalance, at: new Date().toISOString() };
      await supabase.from('users').upsert(
        { id: targetId, data: { ...userData, chips: newBalance, lastAdminAction: adminLog } },
        { onConflict: 'id' }
      );
      console.log(`[ADMIN] ${user_id} deposited ${amt} to ${targetId} (${oldBalance} -> ${newBalance})`);
      return res.json({ ok: true, oldBalance, newBalance });
    }

    if (action === 'withdraw') {
      const amt = Math.max(1, Math.floor(amount));
      const newBalance = Math.max(0, oldBalance - amt);
      await supabase.from('users').upsert(
        { id: targetId, data: { ...userData, chips: newBalance } },
        { onConflict: 'id' }
      );
      return res.json({ ok: true, oldBalance, newBalance });
    }

    if (action === 'set') {
      const newBalance = Math.max(0, Math.min(MAX_CHIPS, Math.floor(amount)));
      const adminLog = { action: 'set', by: user_id, target: targetId, newBalance, oldBalance, at: new Date().toISOString() };
      await supabase.from('users').upsert(
        { id: targetId, data: { ...userData, chips: newBalance, lastAdminAction: adminLog } },
        { onConflict: 'id' }
      );
      console.log(`[ADMIN] ${user_id} set ${targetId} chips to ${newBalance}`);
      return res.json({ ok: true, oldBalance, newBalance });
    }

    if (action === 'check_admin') {
      // Frontend calls this on login to find out if user is admin
      // Returns true/false — admin IDs are never sent to the browser
      return res.json({ isAdmin: true }); // verifyAdmin() already threw if not admin
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    // verifyAdmin throws "Not an admin" — return 403, not 500
    if (err.message === 'Not an admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
