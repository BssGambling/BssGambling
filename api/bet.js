const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const MAX_CHIPS = 1_000_000;
const HOUSE_EDGE_EVERY = 17;
const userGameCounts = {};

function applyHE(userId) {
  userGameCounts[userId] = (userGameCounts[userId] || 0) + 1;
  return userGameCounts[userId] % HOUSE_EDGE_EVERY === 0;
}

function rollDie() { return Math.floor(Math.random() * 100) + 1; }

function dGetKey(rolls, cond, useTiebreak) {
  const sorted = [...rolls].sort((a, b) => b - a);
  if (cond === 'high') return useTiebreak ? sorted : [sorted[0]];
  return useTiebreak ? sorted.reverse() : [sorted[sorted.length - 1]];
}

function gameDice(bet, params, userId) {
  const { diceCount = 1, winCond = 'high', tiebreak = false } = params;
  const yourRolls = Array.from({ length: diceCount }, rollDie);
  const compRolls = Array.from({ length: diceCount }, rollDie);
  if (diceCount === 1 && applyHE(userId)) {
    if (winCond === 'high' && compRolls[0] <= yourRolls[0]) compRolls[0] = Math.min(100, yourRolls[0] + 1);
    else if (winCond === 'low' && compRolls[0] >= yourRolls[0]) compRolls[0] = Math.max(1, yourRolls[0] - 1);
  }
  const yourKey = dGetKey(yourRolls, winCond, tiebreak);
  const compKey = dGetKey(compRolls, winCond, tiebreak);
  let playerWins = false, tie = false;
  for (let i = 0; i < Math.max(yourKey.length, compKey.length); i++) {
    const y = yourKey[i] ?? 0, c = compKey[i] ?? 0;
    if (winCond === 'high') { if (y > c) { playerWins = true; break; } if (y < c) break; }
    else { if (y < c) { playerWins = true; break; } if (y > c) break; }
  }
  if (JSON.stringify(yourKey) === JSON.stringify(compKey)) tie = true;
  const payout = tie ? bet : playerWins ? Math.floor(bet * 2.00) : 0;
  return { yourRolls, compRolls, playerWins, tie, payout };
}

function gameCoinflip(bet, params, userId) {
  const { choice } = params;
  const forceHE = applyHE(userId);
  let result = Math.random() < 0.5 ? 'H' : 'T';
  if (forceHE) result = choice === 'H' ? 'T' : 'H';
  const win = result === choice;
  return { result, win, payout: win ? Math.floor(bet * 2.00) : 0 };
}

const redNums = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
function gameRoulette(bets, userId) {
  const forceHE = applyHE(userId);
  const rOrder = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const winIndex = forceHE ? rOrder.indexOf(0) : Math.floor(Math.random() * rOrder.length);
  const winNum = rOrder[winIndex];
  let totalWin = 0, totalBet = 0;
  for (let b in bets) {
    const amt = bets[b]; totalBet += amt;
    if (b === 'n' + winNum) totalWin += amt * 36;
    else if (b === 'red' && redNums.includes(winNum)) totalWin += amt * 2;
    else if (b === 'black' && winNum !== 0 && !redNums.includes(winNum)) totalWin += amt * 2;
    else if (b === 'even' && winNum !== 0 && winNum % 2 === 0) totalWin += amt * 2;
    else if (b === 'odd' && winNum % 2 === 1) totalWin += amt * 2;
    else if (b === '1-18' && winNum >= 1 && winNum <= 18) totalWin += amt * 2;
    else if (b === '19-36' && winNum >= 19 && winNum <= 36) totalWin += amt * 2;
    else if (b === '1st12' && winNum >= 1 && winNum <= 12) totalWin += amt * 3;
    else if (b === '2nd12' && winNum >= 13 && winNum <= 24) totalWin += amt * 3;
    else if (b === '3rd12' && winNum >= 25 && winNum <= 36) totalWin += amt * 3;
  }
  return { winNum, totalBet, totalWin, winIndex };
}

const KENO_PAYOUTS = {
  easy:   { 3:[0,1.20,3.00,7.00], 4:[0,0.80,2.20,5.50,13.00], 5:[0,0.60,1.60,4.00,10.00,30.00] },
  medium: { 3:[0,0.80,2.70,9.00], 4:[0,0.50,1.80,6.00,18.00], 5:[0,0.35,1.20,4.50,13.00,50.00] },
  hard:   { 3:[0,0.00,2.00,15.00],4:[0,0.00,1.20,8.00,35.00], 5:[0,0.00,0.80,5.00,20.00,100.00] }
};
function gameKeno(bet, params) {
  const { selected, mode = 'easy' } = params;
  if (!selected || selected.length < 3) throw new Error('Need 3-5 selections');
  const pool = Array.from({length:20}, (_,i) => i+1);
  const drawn = [];
  while (drawn.length < 5) { const idx = Math.floor(Math.random() * pool.length); drawn.push(pool.splice(idx,1)[0]); }
  const matches = selected.filter(n => drawn.includes(n)).length;
  const picks = Math.min(5, Math.max(3, selected.length));
  const payoutTable = (KENO_PAYOUTS[mode] || KENO_PAYOUTS.easy)[picks] || KENO_PAYOUTS.easy[5];
  const mult = payoutTable[Math.min(matches, payoutTable.length - 1)];
  const win = Math.floor(bet * mult);
  return { drawn, matches, mult, payout: win };
}

function gameCrash(bet, params) {
  const { target } = params;
  const u = Math.random();
  let crashPoint = u >= 0.99 ? 1.00 : Math.max(1.00, parseFloat((0.99 / (1 - u) + (Math.random() < 0.05 ? Math.random() * 20 : 0)).toFixed(2)));
  const win = crashPoint >= target;
  const payout = win ? Math.floor(bet * target) : 0;
  return { crashPoint, win, payout };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { user_id, discord_token, game, bet, params } = req.body;
    if (!user_id || !discord_token || !game) return res.status(400).json({ error: 'Missing fields' });

    const dcRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${discord_token}` } });
    if (!dcRes.ok) return res.status(401).json({ error: 'Invalid Discord token' });
    const dc = await dcRes.json();
    if (`discord_${dc.id}` !== user_id) return res.status(403).json({ error: 'ID mismatch' });

    const { data: row } = await supabase.from('users').select('data').eq('id', user_id).single();
    const userData = row?.data ?? {};
    const currentChips = Math.floor(userData.chips ?? 0);

    // Roulette has multiple bets - validate total
    const totalBet = game === 'roulette' ? Object.values(params?.bets || {}).reduce((a,b)=>a+b,0) : (bet || 0);
    if (typeof totalBet !== 'number' || totalBet < 50 || totalBet > 10000) return res.status(400).json({ error: 'Invalid bet' });
    if (currentChips < totalBet) return res.status(400).json({ error: 'Insufficient balance' });

    let result;
    if (game === 'dice') result = gameDice(bet, params ?? {}, user_id);
    else if (game === 'coinflip') result = gameCoinflip(bet, params ?? {}, user_id);
    else if (game === 'roulette') result = gameRoulette(params?.bets ?? {}, user_id);
    else if (game === 'keno') result = gameKeno(bet, params ?? {});
    else if (game === 'crash') result = gameCrash(bet, params ?? {});
    else return res.status(400).json({ error: 'Unknown game: ' + game });

    const payout = result.payout ?? result.totalWin ?? 0;
    const spent = game === 'roulette' ? result.totalBet : bet;
    const newChips = Math.min(MAX_CHIPS, currentChips - spent + payout);
    await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
    return res.json({ ...result, chips: newChips });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
