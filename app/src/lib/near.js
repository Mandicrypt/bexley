// Talking to NEAR: reading the pool and sending transactions.

import { NearConnector } from '@hot-labs/near-connect';
import { FailoverRpcProvider, JsonRpcProvider } from 'near-api-js';

export const NETWORK = 'testnet';
export const POOL_ID = 'pool.bexley.testnet'; // also the bxUSD token
export const XNEAR_ID = 'xnear.bexley.testnet';
export const TNEAR_ID = 'tnear.bexley.testnet';
export const GUARDIAN_ID = 'guardian.bexley.testnet';
export const EXPLORER = 'https://testnet.nearblocks.io';

// Several public testnet RPCs: the NEAR-run one rate-limits busy pages.
export const RPC_URLS = ['https://test.rpc.fastnear.com', 'https://near-testnet.lava.build', 'https://rpc.testnet.near.org'];

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
export async function loadAccount(accountId) {
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

async function send(receiverId, methodName, args, { deposit = '0', gasTgas = 60n } = {}) {
  const wallet = await getConnector().wallet();
  return wallet.signAndSendTransaction({
    receiverId,
    actions: [{ type: 'FunctionCall', params: { methodName, args, gas: (gasTgas * TGAS).toString(), deposit } }],
  });
}

/** Send tokens into the pool with an instruction (ft_transfer_call). */
const sendToPool = (token, amount, msg) =>
  send(token, 'ft_transfer_call', { receiver_id: POOL_ID, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: '1', gasTgas: 250n });

const minOut = (v) => (v ? { min_out: v.toString() } : {});

// ---- Actions ----

export const claimTnear = () => send(TNEAR_ID, 'claim', {}, { gasTgas: 30n });

export const mintBx = (t, min) => sendToPool(TNEAR_ID, t, { type: 'mint_bx', ...minOut(min) });
export const mintX = (t, min) => sendToPool(TNEAR_ID, t, { type: 'mint_x', ...minOut(min) });
export const redeemX = (x, min) => sendToPool(XNEAR_ID, x, { type: 'redeem_x', ...minOut(min) });
export const redeemBx = (b, min) =>
  send(POOL_ID, 'redeem_bx', { amount: b.toString(), ...(min ? { min_out: min.toString() } : {}) }, { deposit: '1', gasTgas: 100n });

export const spDeposit = (b) => send(POOL_ID, 'sp_deposit', { amount: b.toString() }, { deposit: '1' });
export const spWithdraw = () => send(POOL_ID, 'sp_withdraw', {}, { deposit: '1', gasTgas: 100n });

export const vaultDeposit = (vault, t) => sendToPool(TNEAR_ID, t, { type: 'vault_deposit', vault });
export const vaultWithdraw = (vault) => send(POOL_ID, 'vault_withdraw', { vault }, { deposit: '1', gasTgas: 250n });

export const placeOrder = (x, stop, take) =>
  sendToPool(XNEAR_ID, x, {
    type: 'order',
    ...(stop ? { stop_price: stop.toString() } : {}),
    ...(take ? { take_price: take.toString() } : {}),
  });
export const cancelOrder = (id) => send(POOL_ID, 'cancel_order', { order_id: id }, { deposit: '1', gasTgas: 100n });

export const claimStuck = () => send(POOL_ID, 'claim', {}, { gasTgas: 100n });

/** Turn a wallet or contract error into one plain sentence. */
export function errorText(e) {
  const m = String(e?.message || e || 'Something went wrong');
  const panic = m.match(/Smart contract panicked: ([^"\n}]+)/);
  if (panic) return panic[1].trim();
  if (/reject|cancel|denied|closed/i.test(m)) return 'You cancelled the request in your wallet.';
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}
