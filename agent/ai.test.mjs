import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDecision, parseReply, ruleDecision, askAI, buildFacts, volatilityFromCandles } from './ai.mjs';
import { sha256Hex, verifyProof } from './proof.mjs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const T = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
const pool = (over = {}) => ({
  price: '3905000', mode: 'Healthy', fee_level: 0, cr_bps: '34800', leverage_bps: '14000', x_supply: T(189),
  tvl: T(273), bx_supply: T(78), stability_pool: { value: T(10) }, savings_rate_bps: 800, savings_rate_set_bps: 800, ...over,
});

test('reads JSON even with extra text around it', () => {
  assert.deepEqual(parseReply('Sure:\n{"fee_level":1}\nDone'), { fee_level: 1 });
  assert.throws(() => parseReply('no json'));
});

test('clamps the rate to the step limit and the 0-20% range', () => {
  const d = checkDecision({ fee_level: 0, savings_rate_bps: 5000, reason: 'Backing is high, raise the rate.' }, pool());
  assert.equal(d.rate, 1200); // 800 + max step 400
  const d2 = checkDecision({ fee_level: 0, savings_rate_bps: -50, reason: 'Lower the rate a lot please.' }, pool({ savings_rate_set_bps: 200 }));
  assert.equal(d2.rate, 0);
});

test('forces a 0% rate outside Healthy mode', () => {
  const d = checkDecision({ fee_level: 2, savings_rate_bps: 900, reason: 'Backing is under 150 percent now.' }, pool({ mode: 'Caution' }));
  assert.equal(d.rate, 0);
});

test('rejects unusable answers', () => {
  assert.throws(() => checkDecision({ fee_level: 5, savings_rate_bps: 800, reason: 'xxxxxxxxxxxx' }, pool()));
  assert.throws(() => checkDecision({ fee_level: 1, savings_rate_bps: 'lots', reason: 'xxxxxxxxxxxx' }, pool()));
  assert.throws(() => checkDecision({ fee_level: 1, savings_rate_bps: 800, reason: '' }, pool()));
});

test('rules fallback gives a full decision', () => {
  const d = ruleDecision(pool(), { change24h: -6 });
  assert.equal(d.level, 1);
  assert.equal(d.rate, 1200);
  assert.match(d.reason, /12%/);
});

// A fake NEAR AI Cloud: attestation report, completion and a real signature.
function fakeNearAI({ failFirstModel = false, tamper = false } = {}) {
  const priv = secp256k1.utils.randomSecretKey();
  const addr = '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12));
  const sign = (text) => {
    const msg = utf8ToBytes(text);
    const d = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const rec = secp256k1.sign(d, priv, { prehash: false, format: 'recovered' });
    return '0x' + bytesToHex(rec.subarray(1)) + (27 + rec[0]).toString(16);
  };
  const seen = { completions: 0, lastRequest: null, lastResponse: null };
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('/attestation/report')) {
      assert.match(url, /nonce=[0-9a-f]{64}/);
      const raw = JSON.stringify({ gateway_attestation: { signing_address: addr, signing_algo: 'ecdsa' }, model_attestations: [] });
      return { ok: true, text: async () => raw };
    }
    if (url.includes('/chat/completions')) {
      seen.completions++;
      assert.equal(opts.headers.Authorization, 'Bearer k');
      if (failFirstModel && seen.completions === 1) return { ok: false, status: 404, text: async () => 'no model' };
      seen.lastRequest = opts.body;
      const content = '{"fee_level":1,"savings_rate_bps":1100,"reason":"NEAR swung 6% today, so fees go to 2x. Backing is 348%, so the rate rises to 11%.","status":"Healthy."}';
      seen.lastResponse = JSON.stringify({ id: 'chatcmpl-9', choices: [{ message: { content } }] });
      return { ok: true, text: async () => seen.lastResponse };
    }
    if (url.includes('/signature/chatcmpl-9')) {
      const resp = tamper ? seen.lastResponse + ' ' : seen.lastResponse;
      const text = `${sha256Hex(seen.lastRequest)}:${sha256Hex(resp)}`;
      return { ok: true, json: async () => ({ text, signature: sign(text), signing_address: addr, signing_algo: 'ecdsa', signature_kind: 'gateway' }) };
    }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, seen };
}

test('askAI decides and returns a proof that checks out', async () => {
  const { fetchImpl } = fakeNearAI();
  const r = await askAI(pool(), { change24h: -6, vol24h: 3.1, range24h: 7 }, { apiKey: 'k', fetchImpl });
  assert.equal(r.decision.level, 1);
  assert.equal(r.decision.rate, 1100);
  assert.equal(r.proof.id, 'chatcmpl-9');
  assert.equal(r.proof.check.ok, true);
  assert.equal(verifyProof(JSON.parse(JSON.stringify(r.proof))).ok, true);
});

test('a proof for different bytes fails the check', async () => {
  const { fetchImpl } = fakeNearAI({ tamper: true });
  const r = await askAI(pool(), { change24h: -6 }, { apiKey: 'k', fetchImpl });
  assert.equal(r.proof.check.ok, false);
});

test('askAI tries the next model when one fails', async () => {
  const { fetchImpl, seen } = fakeNearAI({ failFirstModel: true });
  const r = await askAI(pool(), { change24h: 1 }, { apiKey: 'k', fetchImpl });
  assert.equal(seen.completions, 2);
  assert.equal(r.decision.rate, 1100);
});

test('facts are plain numbers', () => {
  const f = buildFacts(pool(), { change24h: -2.345, vol24h: 3.21, range24h: 5 });
  assert.equal(f.near_price_usd, 3.905);
  assert.equal(f.backing_pct, 348);
  assert.equal(f.xnear_leverage, 1.4);
  assert.equal(f.near_change_24h_pct, -2.35);
});

test('volatility from candles', () => {
  const flat = volatilityFromCandles([4, 4, 4, 4], [4, 4, 4, 4], [4, 4, 4, 4]);
  assert.equal(flat.vol24h, 0);
  const moving = volatilityFromCandles([4, 4.2, 3.9, 4.1], [4.1, 4.3, 4.2, 4.2], [3.9, 4, 3.8, 3.9]);
  assert.ok(moving.vol24h > 0);
  assert.ok(Math.abs(moving.range24h - ((4.3 - 3.8) / 3.8) * 100) < 1e-9);
});

test('saveProof writes the proof, the report and the index', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveProof } = await import('./proofs.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'proofs-'));
  const { fetchImpl } = fakeNearAI();
  const r = await askAI(pool(), { change24h: -6 }, { apiKey: 'k', fetchImpl });
  const file = saveProof(dir, r.proof, r.attestation);
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.equal(index[0].file, file);
  assert.equal(index[0].verified, true);
  assert.ok(existsSync(join(dir, 'attest', `${r.attestation.report_sha256}.json`)));
  assert.equal(verifyProof(JSON.parse(readFileSync(join(dir, file), 'utf8'))).ok, true);
});

test('askAI switches to the real model name when given a nickname', async () => {
  const { fetchImpl: inner, seen } = fakeNearAI();
  const models = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/chat/completions')) {
      const m = JSON.parse(opts.body).model;
      models.push(m);
      if (m !== 'real/model') return { ok: false, status: 400, text: async () => `{"error":{"message":"Model '${m}' is an alias of 'real/model' and the request set x-no-aliasing."}}` };
    }
    return inner(url, opts);
  };
  const r = await askAI(pool(), { change24h: -6 }, { apiKey: 'k', fetchImpl });
  assert.equal(models[1], 'real/model');
  assert.equal(r.model, 'real/model');
  assert.equal(r.proof.check.ok, true);
});

test('savePriceReceipt appends a day file and a latest file', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { savePriceReceipt } = await import('./proofs.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'px-'));
  const at = Date.UTC(2026, 10, 4, 12);
  savePriceReceipt(dir, { at, asked: 4100000, accepted: 4100000, median_usd: 4.1, sources: { CoinGecko: 4.1 } });
  savePriceReceipt(dir, { at: at + 1, asked: 4200000, accepted: 4180000, median_usd: 4.2, sources: { CoinGecko: 4.2 } });
  assert.equal(readFileSync(join(dir, 'prices', '2026-11-04.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 'prices', 'latest.json'), 'utf8')).accepted, 4180000);
});
