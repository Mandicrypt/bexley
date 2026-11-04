// Vercel serverless function: NEAR Intents (1Click API) for the mainnet beta.
//
// Lets someone pay from another chain (USDC on Base, ETH, SOL, BTC, ...) and
// receive wNEAR in their own NEAR wallet, ready to mint bxUSD or xNEAR.
// Bexley never holds the funds: NEAR Intents gives a one-time deposit
// address, its solvers do the swap, and refunds go back to the sender's own
// address on the origin chain if anything fails.
//
//   GET  /api/intents?action=tokens                 popular origin tokens
//   POST /api/intents {action:"quote", ...}         live quote (dry) or deposit address
//   GET  /api/intents?action=status&depositAddress  progress of a deposit
//
// Optional env ONECLICK_API_KEY lowers the fee (partner key); without it
// NEAR Intents adds 0.25%.

const BASE = 'https://1click.chaindefuser.com/v0';
const DESTINATION = 'nep141:wrap.near';

// Origins worth showing first: [blockchain, symbol].
const POPULAR = [
  ['base', 'USDC'],
  ['eth', 'USDC'],
  ['arb', 'USDC'],
  ['sol', 'USDC'],
  ['eth', 'USDT'],
  ['tron', 'USDT'],
  ['eth', 'ETH'],
  ['base', 'ETH'],
  ['arb', 'ETH'],
  ['sol', 'SOL'],
  ['btc', 'BTC'],
];
const CHAIN_NAMES = { base: 'Base', eth: 'Ethereum', arb: 'Arbitrum', sol: 'Solana', tron: 'Tron', btc: 'Bitcoin' };

const headers = () => ({
  'Content-Type': 'application/json',
  ...(process.env.ONECLICK_API_KEY ? { 'X-API-Key': process.env.ONECLICK_API_KEY } : {}),
});

let tokenCache = { at: 0, list: null };
async function tokens() {
  if (tokenCache.list && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.list;
  const r = await fetch(`${BASE}/tokens`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`NEAR Intents tokens: HTTP ${r.status}`);
  const all = await r.json();
  const list = [];
  for (const [chain, sym] of POPULAR) {
    const t = all.find((x) => x.blockchain === chain && x.symbol === sym);
    if (t) list.push({ assetId: t.assetId, symbol: t.symbol, chain, chainName: CHAIN_NAMES[chain] || chain, decimals: t.decimals, price: Number(t.price) });
  }
  tokenCache = { at: Date.now(), list };
  return list;
}

/** Decimal string to integer string in the token's smallest units. */
export function toUnits(amount, decimals) {
  const m = String(amount).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
  const units = BigInt(m[1] + frac);
  return units > 0n ? units.toString() : null;
}

const isNearAccount = (a) => /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a) && a.length >= 2 && a.length <= 64;

export default async function handler(req, res) {
  try {
    const action = req.query?.action || (typeof req.body === 'object' ? req.body?.action : null);
    if (req.method === 'GET' && action === 'tokens') {
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.status(200).json(await tokens());
    }
    if (req.method === 'GET' && action === 'status') {
      const addr = String(req.query.depositAddress || '');
      if (!addr || addr.length > 128) return res.status(400).json({ error: 'Missing deposit address.' });
      const memo = req.query.depositMemo ? `&depositMemo=${encodeURIComponent(req.query.depositMemo)}` : '';
      const r = await fetch(`${BASE}/status?depositAddress=${encodeURIComponent(addr)}${memo}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ error: j.message || 'Status not found yet.' });
      const d = j.swapDetails || {};
      return res.status(200).json({
        status: j.status,
        updatedAt: j.updatedAt,
        amountOut: d.amountOut || null,
        amountOutFormatted: d.amountOutFormatted || null,
        refundReason: d.refundReason || null,
        originTx: d.originChainTxHashes?.[0]?.explorerUrl || null,
        nearTx: d.nearTxHashes?.[0] || null,
      });
    }
    if (req.method === 'POST' && action === 'quote') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const list = await tokens();
      const origin = list.find((t) => t.assetId === body.originAsset);
      if (!origin) return res.status(400).json({ error: 'Pick a token to pay with.' });
      const amount = toUnits(body.amount, origin.decimals);
      if (!amount) return res.status(400).json({ error: 'Enter an amount, like 25 or 0.5.' });
      const recipient = String(body.recipient || '').trim().toLowerCase();
      if (!isNearAccount(recipient)) return res.status(400).json({ error: 'Connect your NEAR wallet first.' });
      const dry = body.dry !== false;
      const refundTo = String(body.refundTo || '').trim();
      if (!dry && (refundTo.length < 20 || refundTo.length > 128)) {
        return res.status(400).json({ error: `Enter your ${origin.chainName} address, so a failed swap can be refunded to you.` });
      }
      const quoteReq = {
        dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: origin.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: DESTINATION,
        amount,
        refundTo: dry ? refundTo || recipient : refundTo,
        refundType: dry && !refundTo ? 'INTENTS' : 'ORIGIN_CHAIN',
        recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        referral: 'bexley',
      };
      const r = await fetch(`${BASE}/quote`, { method: 'POST', headers: headers(), body: JSON.stringify(quoteReq), signal: AbortSignal.timeout(30_000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status === 401 ? 502 : 400).json({ error: j.message || `NEAR Intents could not quote this (HTTP ${r.status}).` });
      const q = j.quote || {};
      return res.status(200).json({
        dry,
        origin,
        amountIn: q.amountInFormatted,
        amountInUsd: q.amountInUsd,
        amountOut: q.amountOut,
        amountOutFormatted: q.amountOutFormatted,
        amountOutUsd: q.amountOutUsd,
        minAmountOut: q.minAmountOut,
        timeEstimate: q.timeEstimate,
        depositAddress: q.depositAddress || null,
        depositMemo: q.depositMemo || null,
        deadline: q.deadline || null,
        correlationId: j.correlationId,
      });
    }
    return res.status(404).json({ error: 'Unknown request.' });
  } catch (e) {
    return res.status(502).json({ error: `NEAR Intents is not answering right now (${String(e.message || e).slice(0, 120)}).` });
  }
}
