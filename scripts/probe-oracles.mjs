// One-off check: which price oracles are alive on NEAR (testnet and mainnet)?
import { JsonRpcProvider } from 'near-api-js';
const T = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const M = new JsonRpcProvider({ url: 'https://free.rpc.fastnear.com' });
const NEAR_USD = 'c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750';
const show = async (label, f) => {
  try { const v = await f(); console.log(`OK   ${label}: ${JSON.stringify(v).slice(0, 600)}`); }
  catch (e) { console.log(`FAIL ${label}: ${String(e.message || e).slice(0, 300)}`); }
};
const now = Date.now();
const age = (sec) => `${Math.round((now / 1000 - Number(sec)) / 60)} min ago`;
await show('pyth testnet price_feed_exists NEAR/USD', () => T.callFunction({ contractId: 'pyth-oracle.testnet', method: 'price_feed_exists', args: { price_identifier: NEAR_USD } }));
await show('pyth testnet get_price NEAR/USD', async () => { const p = await T.callFunction({ contractId: 'pyth-oracle.testnet', method: 'get_price_unsafe', args: { price_identifier: NEAR_USD } }); return { ...p, age: p && age(p.publish_time) }; });
await show('pyth mainnet get_price_unsafe NEAR/USD', async () => { const p = await M.callFunction({ contractId: 'pyth-oracle.near', method: 'get_price_unsafe', args: { price_identifier: NEAR_USD } }); return { ...p, age: p && age(p.publish_time) }; });
for (const host of ['https://hermes-beta.pyth.network', 'https://hermes.pyth.network']) {
  await show(`${host} latest NEAR/USD`, async () => { const r = await fetch(`${host}/v2/updates/price/latest?ids[]=${NEAR_USD}&parsed=true`); const j = await r.json(); const p = j.parsed?.[0]?.price; return { status: r.status, price: p, age: p && age(p.publish_time), bytes: j.binary?.data?.[0]?.length }; });
}
await show('pyth testnet update fee', () => T.callFunction({ contractId: 'pyth-oracle.testnet', method: 'get_update_fee_estimate', args: { data: '00' } }));
await show('priceoracle.testnet get_assets', () => T.callFunction({ contractId: 'priceoracle.testnet', method: 'get_assets', args: {} }));
await show('priceoracle.testnet get_price_data', async () => { const d = await T.callFunction({ contractId: 'priceoracle.testnet', method: 'get_price_data', args: { asset_ids: ['wrap.testnet'] } }); return { ...d, age: d && age(Number(d.timestamp) / 1e9) }; });
await show('priceoracle.near get_price_data', async () => { const d = await M.callFunction({ contractId: 'priceoracle.near', method: 'get_price_data', args: { asset_ids: ['wrap.near'] } }); return { ...d, age: d && age(Number(d.timestamp) / 1e9) }; });
await show('priceoracle.near get_oracles count', async () => (await M.callFunction({ contractId: 'priceoracle.near', method: 'get_oracles', args: { from_index: 0, limit: 100 } }))?.length);
await show('priceoracle.testnet get_oracles count', async () => (await T.callFunction({ contractId: 'priceoracle.testnet', method: 'get_oracles', args: { from_index: 0, limit: 100 } }))?.length);
