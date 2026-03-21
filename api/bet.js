const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HOUSE_EDGE_EVERY = 17;
let gameCount = 0;

function serverRoll() {
  return Math.floor(Math.random() * 100) + 1;
}

function applyHouseEdge(win) {
  gameCount++;
  if (gameCount % HOUSE_EDGE_EVERY === 0) return false;
  return win;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, discord_token, game, bet, params } = req.body;

  if (!user_id || !discord_token || !game || !bet)
    return res.status(400).json({ error: 'Missing fields' });
  if (typeof bet !== 'number' || bet < 50 || bet > 1000)
    return res.status(400).json({ error: 'Invalid bet' });

  // Verify Discord token
  const dcRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${discord_token}` }
  });
  if (!dcRes.ok) return res.status(401).json({ error: 'Invalid token' });
  const dc = await dcRes.json();
  if (`discord_${dc.id}` !== user_id) return res.status(403).json({ error: 'ID mismatch' });

  // Get balance from DB
  const { data: row } = await supabase.from('users').select('data').eq('id', user_id).single();
  const userData = row?.data ?? {};
  const currentChips = Math.floor(userData.chips ?? 0);

  if (currentChips < bet) return res.status(400).json({ error: 'Insufficient balance' });

  // Run game server-side
  let result = {};
  if (game === 'dice') {
    const roll = serverRoll();
    const target = params?.target ?? 50;
    const over = params?.over ?? true;
    const rawWin = over ? roll > target : roll < target;
    const win = applyHouseEdge(rawWin);
    const payout = win ? Math.floor(bet * 1.94) : 0;
    result = { roll, win, payout };
  } else if (game === 'coinflip') {
    const flip = Math.random() < 0.5 ? 'heads' : 'tails';
    const rawWin = flip === params?.choice;
    const win = applyHouseEdge(rawWin);
    const payout = win ? Math.floor(bet * 1.94) : 0;
    result = { flip, win, payout };
  } else {
    return res.status(400).json({ error: 'Unknown game' });
  }

  const newChips = result.win ? currentChips - bet + result.payout : currentChips - bet;
  await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips } });

  return res.json({ ...result, chips: newChips });
};
