// Talking to NEAR: reading the pool and sending transactions.

import { NearConnector } from '@hot-labs/near-connect';
import { FailoverRpcProvider, JsonRpcProvider } from 'near-api-js';

// Two networks: the free testnet pool (default) and the small mainnet beta.
// The choice is kept in this browser; switching reloads the page.
import mainnetConfig from '../config/mainnet.json';

export const MAINNET_OWNER = mainnetConfig.owner || null;
export const MAINNET_READY = !!MAINNET_OWNER;

function readNetwork() {
  try {
    if (MAINNET_READY && localStorage.getItem('bexley-net') === 'mainnet') return 'mainnet';
  } catch {}
  return 'testnet';
}

export function switchNetwork(net) {
  try {
    localStorage.setItem('bexley-net', net);
  } catch {}
  location.hash = '';
  location.reload();
}

export const NETWORK = readNetwork();
export const IS_MAINNET = NETWORK === 'mainnet';

const NETS = {
  testnet: {
    POOL_ID: 'pool.bexley.testnet', // also the bxUSD token
    XNEAR_ID: 'xnear.bexley.testnet',
    TNEAR_ID: 'tnear.bexley.testnet',
    GUARDIAN_ID: 'guardian.bexley.testnet',
    EXPLORER: 'https://testnet.nearblocks.io',
    RPC_URLS: ['https://test.rpc.fastnear.com', 'https://near-testnet.lava.build', 'https://rpc.testnet.near.org'],
    ASSET: 'tNEAR',
  },
  mainnet: {
    POOL_ID: `pool.${MAINNET_OWNER}`,
    XNEAR_ID: `xnear.${MAINNET_OWNER}`,
    TNEAR_ID: mainnetConfig.asset || 'wrap.near', // wNEAR; the app wraps NEAR for you
    GUARDIAN_ID: `guardian.${MAINNET_OWNER}`,
    EXPLORER: 'https://nearblocks.io',
    RPC_URLS: ['https://free.rpc.fastnear.com', 'https://near.lava.build', 'https://rpc.mainnet.near.org'],
    ASSET: 'NEAR',
  },
};
const N = NETS[NETWORK];
export const { POOL_ID, XNEAR_ID, TNEAR_ID, GUARDIAN_ID, EXPLORER, RPC_URLS } = N;
/** What users pay with: free tNEAR on testnet, real NEAR on mainnet. */
export const ASSET = N.ASSET;
export const MAINNET_CAP_NEAR = mainnetConfig.cap_near;

const TGAS = 1_000_000_000_000n;
const provider = new FailoverRpcProvider(RPC_URLS.map((url) => new JsonRpcProvider({ url })));

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
const pool = (method, args) => view(POOL_ID, method, args);

/** Everything public, for every screen. */
export async function loadPool() {
  const [state, vaults, notes] = await Promise.all([pool('get_pool'), pool('get_vaults'), pool('get_notes', { limit: 30 })]);
  return { state, vaults, notes };
}

/** One account: wallet balances plus positions in the pool. */
// Demo mode (see demo.mjs): while on, actions and the account come from the
// in-browser demo wallet instead of the chain.
let demo = null;
export const setDemo = (d) => {
  demo = d;
};
const d = (name, real) => (...a) => (demo ? demo[name](...a) : real(...a));

/** NEAR kept back on mainnet for gas and storage when paying with NEAR. */
export const NEAR_RESERVE = 2n * 10n ** 23n; // 0.2 NEAR

export async function loadAccount(accountId) {
  if (demo) return demo.account();
  if (IS_MAINNET) {
    const [wnear, xnear, account, state] = await Promise.all([
      view(TNEAR_ID, 'ft_balance_of', { account_id: accountId }),
      view(XNEAR_ID, 'ft_balance_of', { account_id: accountId }),
      pool('get_account', { account_id: accountId }),
      provider.viewAccount({ accountId }),
    ]);
    // Storage already used is locked; keep a little more back for gas.
    const native = BigInt(state?.amount ?? 0);
    const locked = BigInt(state?.storage_usage ?? 0) * 10n ** 19n + NEAR_RESERVE;
    const spendable = native > locked ? native - locked : 0n;
    // "tnear" is what the user can pay with: wNEAR plus spendable NEAR.
    return { tnear: (BigInt(wnear) + spendable).toString(), wnear, native: native.toString(), xnear, nextClaimAt: '0', ...account };
  }
  const [tnear, xnear, nextClaimAt, account] = await Promise.all([
    view(TNEAR_ID, 'ft_balance_of', { account_id: accountId }),
    view(XNEAR_ID, 'ft_balance_of', { account_id: accountId }),
    view(TNEAR_ID, 'next_claim_at', { account_id: accountId }),
    pool('get_account', { account_id: accountId }),
  ]);
  return { tnear, xnear, nextClaimAt, ...account };
}

/** What a mint or redeem gives right now (mint_bx, redeem_bx, mint_x, redeem_x). */
export const quote = (action, amount) => pool('quote', { action, amount: amount.toString() });

// ---- Wallet ----

let connector;
export function getConnector() {
  if (!connector) {
    connector = new NearConnector({
      network: NETWORK,
      providers: { testnet: RPC_URLS },
      features: { testnet: true, signAndSendTransaction: true },
      footerBranding: null,
    });
  }
  return connector;
}

export async function currentAccount() {
  try {
    const { accounts } = await getConnector().getConnectedWallet();
    return accounts?.[0]?.accountId || null;
  } catch {
    return null;
  }
}

export async function connect() {
  const c = getConnector();
  await c.whenManifestLoaded;
  await c.connect();
}

export const disconnect = () => getConnector().disconnect();

const fc = (methodName, args, { deposit = '0', gasTgas = 60n } = {}) => ({
  type: 'FunctionCall',
  params: { methodName, args, gas: (gasTgas * TGAS).toString(), deposit: deposit.toString() },
});

async function sendActions(receiverId, actions) {
  const wallet = await getConnector().wallet();
  return wallet.signAndSendTransaction({ receiverId, actions });
}

const send = (receiverId, methodName, args, opts) => sendActions(receiverId, [fc(methodName, args, opts)]);

async function signerId() {
  const { accounts } = await getConnector().getConnectedWallet();
  return accounts?.[0]?.accountId;
}

/**
 * Send tokens into the pool with an instruction (ft_transfer_call). On
 * mainnet, paying with NEAR: one transaction to wrap.near that registers the
 * user (if needed), wraps only the NEAR that isn't already wNEAR, and sends it.
 */
async function sendToPool(token, amount, msg) {
  const transfer = fc('ft_transfer_call', { receiver_id: POOL_ID, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: '1', gasTgas: 200n });
  if (!IS_MAINNET || token !== TNEAR_ID) return sendActions(token, [transfer]);
  const me = await signerId();
  const have = BigInt(await view(TNEAR_ID, 'ft_balance_of', { account_id: me }));
  const wrap = BigInt(amount) > have ? BigInt(amount) - have : 0n;
  return sendActions(TNEAR_ID, [
    fc('storage_deposit', { account_id: me, registration_only: true }, { deposit: 1_250_000_000_000_000_000_000n, gasTgas: 10n }),
    ...(wrap > 0n ? [fc('near_deposit', {}, { deposit: wrap, gasTgas: 10n })] : []),
    transfer,
  ]);
}

/** Mainnet: turn wNEAR back into NEAR. */
export const unwrapNear = (amount) => send(TNEAR_ID, 'near_withdraw', { amount: amount.toString() }, { deposit: '1', gasTgas: 20n });

const minOut = (v) => (v ? { min_out: v.toString() } : {});

// ---- Actions ----

export const claimTnear = d('claimTnear', () => send(TNEAR_ID, 'claim', {}, { gasTgas: 30n }));

export const mintBx = d('mintBx', (t, min) => sendToPool(TNEAR_ID, t, { type: 'mint_bx', ...minOut(min) }));
export const mintX = d('mintX', (t, min) => sendToPool(TNEAR_ID, t, { type: 'mint_x', ...minOut(min) }));
export const redeemX = d('redeemX', (x, min) => sendToPool(XNEAR_ID, x, { type: 'redeem_x', ...minOut(min) }));
export const redeemBx = d('redeemBx', (b, min) =>
  send(POOL_ID, 'redeem_bx', { amount: b.toString(), ...(min ? { min_out: min.toString() } : {}) }, { deposit: '1', gasTgas: 100n }));

export const spDeposit = d('spDeposit', (b) => send(POOL_ID, 'sp_deposit', { amount: b.toString() }, { deposit: '1' }));
export const spWithdraw = d('spWithdraw', () => send(POOL_ID, 'sp_withdraw', {}, { deposit: '1', gasTgas: 100n }));

export const vaultDeposit = d('vaultDeposit', (vault, t) => sendToPool(TNEAR_ID, t, { type: 'vault_deposit', vault }));
export const vaultWithdraw = d('vaultWithdraw', (vault) => send(POOL_ID, 'vault_withdraw', { vault }, { deposit: '1', gasTgas: 250n }));

export const placeOrder = d('placeOrder', (x, stop, take) =>
  sendToPool(XNEAR_ID, x, {
    type: 'order',
    ...(stop ? { stop_price: stop.toString() } : {}),
    ...(take ? { take_price: take.toString() } : {}),
  }));
export const cancelOrder = d('cancelOrder', (id) => send(POOL_ID, 'cancel_order', { order_id: id }, { deposit: '1', gasTgas: 100n }));

export const claimStuck = d('claimStuck', () => send(POOL_ID, 'claim', {}, { gasTgas: 100n }));

/** Turn a wallet or contract error into one plain sentence. */
export function errorText(e) {
  const m = String(e?.message || e || 'Something went wrong');
  const panic = m.match(/Smart contract panicked: ([^"\n}]+)/);
  if (panic) return panic[1].trim();
  if (/reject|cancel|denied|closed/i.test(m)) return 'You cancelled the request in your wallet.';
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}
