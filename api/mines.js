const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const MAX_CHIPS = 1_000_000;

const MINES_MULT = {
  1:[,1.03,1.08,1.12,1.18,1.24,1.30,1.37,1.46,1.55,1.65,1.77,1.90,2.06,2.25,2.47,2.75,3.09,3.54,4.12,4.95,6.19,8.25,12.38,24.75],
  2:[,1.08,1.17,1.29,1.41,1.56,1.74,1.94,2.18,2.47,2.83,3.26,3.81,4.50,5.40,6.60,8.25,10.61,14.14,19.80,29.70,49.50,99,297],
  3:[,1.12,1.29,1.48,1.71,2.00,2.35,2.79,3.35,4.07,5.00,6.26,7.96,10.35,13.80,18.97,27.11,40.66,65.06,113.85,227.70,569.25,2277],
  4:[,1.18,1.41,1.71,2.09,2.58,3.23,4.09,5.26,6.88,9.17,12.51,17.52,25.30,37.95,59.64,99.39,178.91,357.81,834.90,2504.70,12523.50],
  5:[,1.24,1.56,2.00,2.58,3.39,4.52,6.14,8.50,12.04,17.52,26.27,40.87,66.41,113.85,208.72,417.45,939.26,2504.70,8766.45,52598.70]
};
function mCalcMult(bombs, gems) {
  const row = MINES_MULT[Math.min(bombs, 5)];
  if (!row || gems < 1) return 1.0;
  return row[gems] || row[row.length - 1] || 1.0;
}

async function verifyUser(user_id, discord_token) {
  const dcRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${discord_token}` } });
  if (!dcRes.ok) throw new Error('Invalid Discord token');
  const dc = await dcRes.json();
  if (`discord_${dc.id}` !== user_id) throw new Error('ID mismatch');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, discord_token, action, bet, bombCount, tileIndex } = req.body;
    if (!user_id || !discord_token || !action) return res.status(400).json({ error: 'Missing fields' });
    await verifyUser(user_id, discord_token);

    const { data: row } = await supabase.from('users').select('data').eq('id', user_id).single();
    const userData = row?.data ?? {};
    const currentChips = Math.floor(userData.chips ?? 0);

    if (action === 'start') {
      const b = Math.max(50, Math.min(600, Math.floor(bet || 50)));
      const bombs = Math.max(1, Math.min(5, Math.floor(bombCount || 3)));
      if (currentChips < b) return res.status(400).json({ error: 'Insufficient balance' });
      if (userData.active_game?.type === 'mines') return res.status(400).json({ error: 'Game already active — cashout first' });

      // Generate bomb positions server-side (never sent to client)
      const bombSet = new Set();
      while (bombSet.size < bombs) bombSet.add(Math.floor(Math.random() * 25));
      const bombPositions = [...bombSet];

      const gameState = { type: 'mines', bet: b, bombCount: bombs, bombs: bombPositions, revealed: [], gemsFound: 0, balBefore: currentChips, startedAt: new Date().toISOString() };
      const newChips = currentChips - b;
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: gameState } }, { onConflict: 'id' });
      return res.json({ ok: true, chips: newChips });
    }

    if (action === 'reveal') {
      const game = userData.active_game;
      if (!game || game.type !== 'mines') return res.status(400).json({ error: 'No active mines game' });
      const idx = Math.floor(tileIndex);
      if (idx < 0 || idx > 24) return res.status(400).json({ error: 'Invalid tile' });
      if (game.revealed.includes(idx)) return res.status(400).json({ error: 'Already revealed' });

      const isBomb = game.bombs.includes(idx);
      game.revealed.push(idx);

      if (isBomb) {
        // Game over - reveal all bombs
        await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: null } }, { onConflict: 'id' });
        return res.json({ isBomb: true, bombPositions: game.bombs, chips: currentChips });
      }

      game.gemsFound++;
      const mult = mCalcMult(game.bombCount, game.gemsFound);
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: game } }, { onConflict: 'id' });
      return res.json({ isBomb: false, gemsFound: game.gemsFound, mult, chips: currentChips });
    }

    if (action === 'cashout') {
      const game = userData.active_game;
      if (!game || game.type !== 'mines') return res.status(400).json({ error: 'No active mines game' });
      if (game.gemsFound < 1) return res.status(400).json({ error: 'Need at least 1 gem' });

      const mult = mCalcMult(game.bombCount, game.gemsFound);
      const win = Math.floor(game.bet * mult);
      const newChips = Math.min(MAX_CHIPS, currentChips + win);
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
      return res.json({ ok: true, mult, win, chips: newChips, bombPositions: game.bombs });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
