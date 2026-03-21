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


function makeDeck() {
  const suits = ['♠','♣','♥','♦'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const s of suits) for (const v of vals) deck.push({v,s});
  for (let i = deck.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
function getBJScore(hand) {
  let s = 0, a = 0;
  for (const c of hand) { if (c.v==='A') a++; else if (['J','Q','K','10'].includes(c.v)) s+=10; else s+=parseInt(c.v); }
  for (let i=0; i<a; i++) s += (s+11<=21) ? 11 : 1;
  return s;
}
function isBJ(hand) { return hand.length === 2 && getBJScore(hand) === 21; }
function dealerPlay(hand, deck) {
  while (getBJScore(hand) < 17) hand.push(deck.pop());
  return hand;
}
function resolveHand(playerHand, dealerHand, bet) {
  const ps = getBJScore(playerHand), ds = getBJScore(dealerHand);
  const playerBust = ps > 21, dealerBust = ds > 21;
  if (playerBust) return { outcome: 'bust', payout: 0 };
  if (dealerBust) return { outcome: 'dealer_bust', payout: Math.floor(bet * 2) };
  if (ps > ds) return { outcome: 'win', payout: Math.floor(bet * 2) };
  if (ps < ds) return { outcome: 'lose', payout: 0 };
  return { outcome: 'push', payout: bet };
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
    const { user_id, discord_token, action, bet } = req.body;
    if (!user_id || !discord_token || !action) return res.status(400).json({ error: 'Missing fields' });
    await verifyUser(user_id, discord_token);

    const { data: row } = await supabase.from('users').select('data').eq('id', user_id).single();
    const userData = row?.data ?? {};
    let currentChips = Math.floor(userData.chips ?? 0);

    if (action === 'deal') {
      const b = Math.max(50, Math.min(1000, Math.floor(bet || 50)));
      if (currentChips < b) return res.status(400).json({ error: 'Insufficient balance' });
      const deck = makeDeck();
      const playerHand = [deck.pop(), deck.pop()];
      const dealerHand = [deck.pop(), deck.pop()];
      const newChips = currentChips - b;
      const gameState = { type: 'blackjack', bet: b, deck, playerHand, dealerHand, insurance: 0, splitHand: null, splitBet: 0, balBefore: currentChips };
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: gameState } }, { onConflict: 'id' });
      // Check natural BJ immediately
      const playerBJ = isBJ(playerHand), dealerBJ = isBJ(dealerHand);
      return res.json({ playerHand, dealerCard: dealerHand[0], chips: newChips, dealerShowsAce: dealerHand[0].v === 'A', playerBJ, dealerBJ: playerBJ && dealerBJ });
    }

    const game = userData.active_game;
    if (!game || game.type !== 'blackjack') return res.status(400).json({ error: 'No active blackjack game' });

    if (action === 'insurance') {
      const { take } = req.body;
      const insAmt = Math.floor(game.bet / 2);
      if (take && currentChips < insAmt) return res.status(400).json({ error: 'Not enough for insurance' });
      if (take) { game.insurance = insAmt; currentChips -= insAmt; }
      const dealerBJ = isBJ(game.dealerHand);
      if (dealerBJ) {
        let payout = take ? insAmt * 3 : 0; // insurance pays 2:1 (return stake + 2x)
        const playerBJ = isBJ(game.playerHand);
        if (playerBJ) payout += game.bet; // push on main bet
        const newChips = Math.min(MAX_CHIPS, currentChips + payout);
        await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
        return res.json({ dealerBJ: true, playerBJ, payout, dealerHand: game.dealerHand, chips: newChips });
      }
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: game } }, { onConflict: 'id' });
      return res.json({ dealerBJ: false, chips: currentChips });
    }

    if (action === 'hit') {
      const card = game.deck.pop();
      game.playerHand.push(card);
      const score = getBJScore(game.playerHand);
      if (score > 21) {
        // Bust
        await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: null } }, { onConflict: 'id' });
        return res.json({ card, score, bust: true, chips: currentChips });
      }
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: currentChips, active_game: game } }, { onConflict: 'id' });
      return res.json({ card, score, bust: false, chips: currentChips });
    }

    if (action === 'double') {
      if (currentChips < game.bet) return res.status(400).json({ error: 'Not enough to double' });
      currentChips -= game.bet; game.bet *= 2;
      const card = game.deck.pop(); game.playerHand.push(card);
      // Auto-stand after double - dealer plays out
      dealerPlay(game.dealerHand, game.deck);
      const { outcome, payout } = resolveHand(game.playerHand, game.dealerHand, game.bet);
      const newChips = Math.min(MAX_CHIPS, currentChips + payout);
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
      return res.json({ card, playerHand: game.playerHand, dealerHand: game.dealerHand, outcome, payout, chips: newChips });
    }

    if (action === 'stand') {
      dealerPlay(game.dealerHand, game.deck);
      const { outcome, payout } = resolveHand(game.playerHand, game.dealerHand, game.bet);
      const newChips = Math.min(MAX_CHIPS, currentChips + payout);
      await supabase.from('users').upsert({ id: user_id, data: { ...userData, chips: newChips, active_game: null } }, { onConflict: 'id' });
      const pName = userData?.displayName || userData?.discordName || user_id;
      if(outcome !== 'push') sendBetWebhook(pName, 'Blackjack', game.bet, payout, game.balBefore || game.bet);
      return res.json({ dealerHand: game.dealerHand, outcome, payout, chips: newChips });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
