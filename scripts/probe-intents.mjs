// One-off: exercise app/api/intents.js against the real 1Click API.
import handler from '../app/api/intents.js';
const call = (req) => new Promise((resolve) => {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler(req, res);
});
const t = await call({ method: 'GET', query: { action: 'tokens' } });
console.log('tokens', t.code, JSON.stringify(t.body).slice(0, 900));
const usdc = t.body.find?.((x) => x.chain === 'base' && x.symbol === 'USDC');
const q = await call({ method: 'POST', query: {}, body: { action: 'quote', originAsset: usdc?.assetId, amount: '25', recipient: 'aurora.near', dry: true } });
console.log('dry quote', q.code, JSON.stringify(q.body));
const eth = t.body.find?.((x) => x.chain === 'eth' && x.symbol === 'ETH');
const q2 = await call({ method: 'POST', query: {}, body: { action: 'quote', originAsset: eth?.assetId, amount: '0.01', recipient: 'aurora.near', dry: true } });
console.log('dry quote eth', q2.code, JSON.stringify(q2.body));
const s = await call({ method: 'GET', query: { action: 'status', depositAddress: '0x0000000000000000000000000000000000000000' } });
console.log('status', s.code, JSON.stringify(s.body));
