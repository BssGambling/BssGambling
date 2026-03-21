const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const MAX_CHIPS = 1_000_000;

async function sendBetWebhook(playerName, game, bet, payout, balBefore) {
    const WEBHOOK_BETS = process.env.DISCORD_WEBHOOK_BETS;
    if(!WEBHOOK_BETS) return;
    const isWin = payout > bet;
    const profit = payout - bet;
    try {
        await fetch(WEBHOOK_BETS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [{
                title: (isWin ? '✅ ' : '❌ ') + game,
                color: isWin ? 0x27ae60 : 0xe74c3c,
                description: '**Player:** ' + playerName + '\n**Bet:** ' + bet + ' ★\n**' + (isWin ? 'Payout' : 'Lost') + ':** ' + (isWin ? '+' + payout : '-' + bet) + ' ★\n\n**Balance:** ' + balBefore + ' → ' + (balBefore - bet + payout),
                fields: [
                    { name: 'Result', value: isWin ? '🟢 WIN' : '🔴 LOSS', inline: true },
                    { name: 'Profit', value: (profit >= 0 ? '+' : '') + profit + ' ★', inline: true }
                ],
                footer: { text: 'BSS Gambling' },
                timestamp: new Date().toISOString()
            }]})
        });
    } catch(e) {}
}

const HOUSE_EDGE_EVERY = 17;
const userTowerCounts = {};

const tRiskConfig = {
  easy:   { bombs:1, cols:4, mults:[1.28,1.70,2.27,3.03,4.04,5.39,7.19,9.58,12.77] },
  medium: { bombs:1, cols:3, mults:[1.35,1.95,2.80,4.00,5.80,8.40,12.20,17.70,25.70] },
  hard:   { bombs:1, cols:2, mults:[1.70,3.00,5.50,10.00,18.50,34.00,63.00,118.00,220.00] },
  expert: { bombs:2, cols:3, mults:[2.88,8.64,25.92,77.76,233.28,699.84,2099.52,6298.56,18895.68] },
  master: { bombs:3, cols:4, mults:[2.50,8.50,28.00,95.00,320.00,1080.00,3600.00,12000.00,40000.00] }
};
const TOWER_ROWS = 9;

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
    const { user_id, discord_token, action, bet, risk, colIndex } = req.body;
    if (!user_id || !discord_token || !action) return res.status(400).json({ error: 'Missing fields' });
    await verifyUser(user_id, discord_token);

    const { data: row } = await supabase.from('users').select('data').eq('id', user_id).single();
    const userData = row?.data ?? {};
    const currentChips = Math.floor(userData.chips ?? 0);

    if (action === 'start') {
      const b = Math.max(50, Math.min(1000, Math.floor(bet || 50)));
      const riskKey = tRiskConfig[risk] ? risk : 'medium';
      if (currentChips < b) return res.status(400).json({ error: 'Insufficient balance' });

      const cfg = tRiskConfig[riskKey];
      // Generate all bomb positions server-side
      const allBombs = [];
      for (let i = 0; i < TOWER_ROWS; i++) {
        const bombs = new Set();
        while (bombs.size < cfg.bombs) bombs.add(Math.floor(Math.random() * cfg.cols));
        allBombs.push([...bombs]);
      }

      userTowerCounts[user_id] = (userTowerCounts[user_id] || 0) + 1;
      const forceHE = userTowerCounts[user_id] % HOUSE_EDGE_EVERY === 0;

      const gameState = { type: 'tower', bet: b, risk: riskKey, bombs: allBombs, level: 0, forceHE, startedAt: new Date().toISOString() };
      const newChips = currentChips - b;
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: gameState } }, { onConflict: 'id' });
      return res.json({ ok: true, chips: newChips });
    }

    if (action === 'click') {
      const game = userData.active_game;
      if (!game || game.type !== 'tower') return res.status(400).json({ error: 'No active tower game' });
      const cfg = tRiskConfig[game.risk];
      const col = Math.floor(colIndex);
      if (col < 0 || col >= cfg.cols) return res.status(400).json({ error: 'Invalid column' });
      const rowIdx = game.level;
      if (rowIdx >= TOWER_ROWS) return res.status(400).json({ error: 'Game already complete' });

      const isBomb = game.bombs[rowIdx].includes(col) || (game.forceHE && !game.bombs[rowIdx].includes(col) && rowIdx === game.level);
      if (isBomb) {
        await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: null } }, { onConflict: 'id' });
        return res.json({ isBomb: true, bombCols: game.bombs[rowIdx], chips: currentChips });
      }

      game.level++;
      const isComplete = game.level >= TOWER_ROWS;
      const mult = cfg.mults[rowIdx];

      if (isComplete) {
        const win = Math.floor(game.bet * mult);
        const newChips = Math.min(MAX_CHIPS, currentChips + win);
        await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
        const pName = userData?.displayName || userData?.discordName || user_id;
        sendBetWebhook(pName, 'Tower', game.bet, win, game.bet);
        return res.json({ isBomb: false, level: game.level, mult, isComplete: true, win, chips: newChips });
      }

      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: game } }, { onConflict: 'id' });
      return res.json({ isBomb: false, level: game.level, mult, isComplete: false, chips: currentChips });
    }

    if (action === 'cashout') {
      const game = userData.active_game;
      if (!game || game.type !== 'tower') return res.status(400).json({ error: 'No active tower game' });
      if (game.level < 1) return res.status(400).json({ error: 'Need to pass at least 1 floor' });
      const cfg = tRiskConfig[game.risk];
      const mult = cfg.mults[game.level - 1];
      const win = Math.floor(game.bet * mult);
      const newChips = Math.min(MAX_CHIPS, currentChips + win);
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
      const pName2 = userData?.displayName || userData?.discordName || user_id;
      sendBetWebhook(pName2, 'Tower', game.bet, win, game.bet);
      return res.json({ ok: true, mult, win, chips: newChips });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
