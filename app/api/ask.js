// Vercel serverless function: Ask Bexley.
//
// Holds the NEAR AI key on the server (env NEARAI_API_KEY), so it never
// reaches the browser. Takes the user's message plus public facts the page
// already shows (prices, balances), asks the model for a plan, checks the
// plan, and returns it. It never signs or sends anything: the user approves
// every step in their own wallet.

import { checkPlan, parseJson, systemPrompt } from '../src/lib/intent.mjs';

const URL = process.env.NEARAI_URL || 'https://cloud-api.near.ai/v1';
const MODELS = (process.env.NEARAI_MODEL || 'deepseek-ai/DeepSeek-V4-Flash,z-ai/glm-5.2').split(',');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const key = process.env.NEARAI_API_KEY || process.env.NEAR_API_KEY;
  if (!key) return res.status(503).json({ error: 'Ask Bexley is not switched on yet.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const message = String(body.message || '').trim().slice(0, 400);
  if (message.length < 2) return res.status(400).json({ error: 'Type what you want to do.' });

  // Only small, numeric, public facts are passed on.
  const c = body.context || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(4)) : null);
  const ctx = {
    near_price_usd: num(c.near_price_usd),
    xnear_price_usd: num(c.xnear_price_usd),
    xnear_leverage: num(c.xnear_leverage),
    pool_mode: ['Healthy', 'Caution', 'Stabilize'].includes(c.pool_mode) ? c.pool_mode : null,
    savings_rate_pct: num(c.savings_rate_pct),
    mint_bx_open: !!c.mint_bx_open,
    redeem_x_open: !!c.redeem_x_open,
    wallet: {
      tNEAR: num(c.wallet?.tNEAR),
      xNEAR: num(c.wallet?.xNEAR),
      bxUSD: num(c.wallet?.bxUSD),
    },
    stability_pool_bxusd: num(c.stability_pool_bxusd),
  };

  let lastErr = 'The assistant did not answer.';
  for (const model of MODELS) {
    try {
      const r = await fetch(`${URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt(ctx) },
            { role: 'user', content: message },
          ],
        }),
        signal: AbortSignal.timeout(40_000),
      });
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const j = await r.json();
      const m = j?.choices?.[0]?.message || {};
      const text = m.content || m.reasoning_content || m.reasoning || '';
      if (!text) {
        lastErr = 'empty reply';
        continue;
      }
      const plan = checkPlan(parseJson(text), { price: ctx.near_price_usd });
      return res.status(200).json({ ...plan, model });
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }
  return res.status(502).json({ error: `Ask Bexley could not answer right now (${lastErr}). Try again in a moment.` });
}
