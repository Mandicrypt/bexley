// Talking to NEAR: reading contract data and sending transactions.

import { NearConnector } from '@hot-labs/near-connect';
import { JsonRpcProvider } from 'near-api-js';

export const NETWORK = 'testnet';
export const APP_ID = 'app.bexley.testnet';
export const TOKEN_ID = 'tnear.bexley.testnet';
export const RPC_URL = 'https://rpc.testnet.near.org';
export const EXPLORER = 'https://testnet.nearblocks.io';

const TGAS = 1_000_000_000_000n;
const provider = new JsonRpcProvider({ url: RPC_URL });

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
export const viewApp = (method, args) => view(APP_ID, method, args);

/** Everything the app needs for one screen refresh. */
export async function loadMarket() {
  const [config, price, stats, saves, offers, recent] = await Promise.all([
    viewApp('get_config'),
    viewApp('get_price'),
    viewApp('get_stats'),
    viewApp('get_open_saves', { limit: 100 }),
    viewApp('get_active_offers', { limit: 100 }),
    viewApp('get_recent_deals', { limit: 20 }),
  ]);
  return { config, price, stats, saves, offers, recent };
}

export async function loadAccount(accountId) {
  const [account, tokenBalance, nextClaimAt] = await Promise.all([
    viewApp('get_account', { account_id: accountId }),
    view(TOKEN_ID, 'ft_balance_of', { account_id: accountId }),
    view(TOKEN_ID, 'next_claim_at', { account_id: accountId }),
  ]);
  const active = account.deals.filter((d) => d.status === 'Active');
  const quotes = await Promise.all(active.map((d) => viewApp('quote', { deal_id: d.id })));
  const quoteById = Object.fromEntries(quotes.filter(Boolean).map((q) => [q.deal_id, q]));
  return { ...account, tokenBalance, nextClaimAt, quoteById };
}

// ---- Wallet ----

let connector;
export function getConnector() {
  if (!connector) {
    connector = new NearConnector({
      network: NETWORK,
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

export async function disconnect() {
  await getConnector().disconnect();
}

async function send(receiverId, methodName, args, { deposit = '0', gasTgas = 50n } = {}) {
  const wallet = await getConnector().wallet();
  return wallet.signAndSendTransaction({
    receiverId,
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName, args, gas: (gasTgas * TGAS).toString(), deposit },
      },
    ],
  });
}

// ---- Actions ----

export const claimTokens = () => send(TOKEN_ID, 'claim', {}, { gasTgas: 30n });

/** Deposit into Bexley: tokens move with ft_transfer_call and a message. */
function depositToApp(amount, msg) {
  return send(
    TOKEN_ID,
    'ft_transfer_call',
    { receiver_id: APP_ID, amount: amount.toString(), msg: JSON.stringify(msg) },
    { deposit: '1', gasTgas: 100n },
  );
}

export const createSave = (amount, durationSecs, minRateBps) =>
  depositToApp(amount, { type: 'save', duration_secs: durationSecs, min_rate_bps: minRateBps });

export const createOffer = (amount, rateBps, durations, maxCover) =>
  depositToApp(amount, { type: 'offer', rate_bps: rateBps, durations, max_cover: maxCover });

export const cancelSave = (saveId) => send(APP_ID, 'cancel_save', { save_id: saveId });
export const takeOffer = (saveId, offerId) => send(APP_ID, 'take_offer', { save_id: saveId, offer_id: offerId });
export const closeOffer = (offerId) => send(APP_ID, 'close_offer', { offer_id: offerId });
export const settleDeal = (dealId) => send(APP_ID, 'settle', { deal_id: dealId });
export const withdraw = () => send(APP_ID, 'withdraw', {}, { gasTgas: 60n });

/** Turn a wallet or contract error into one plain sentence. */
export function errorText(e) {
  const m = String(e?.message || e || 'Something went wrong');
  const panic = m.match(/Smart contract panicked: ([^"\n}]+)/);
  if (panic) return panic[1].trim();
  if (/reject|cancel|denied|closed/i.test(m)) return 'You cancelled the request in your wallet.';
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}
