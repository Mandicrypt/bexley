// One-time setup of the Pool Guardian account, run by the owner.
//
// Creates guardian.bexley.testnet with NO full-access key. Its only key is a
// function-call key that can call the Guardian's methods on the Bexley pool
// (prices, fee level, notes, stabilize, rebalance, execute orders), with a
// small gas allowance. So even if its key leaked, it could not send anyone's
// money anywhere: none of those methods move funds to the caller, and the
// contract checks every rule itself.
//
// Then makes that account the pool's Guardian and price feeder.
// Safe to run again: it skips what is already done.

import { Account, JsonRpcProvider, PublicKey, actions, nearToYocto } from 'near-api-js';
import { deriveAgentKey } from './key.mjs';

const OWNER_ID = process.env.NEAR_ACCOUNT_ID || 'bexley.testnet';
const APP_ID = process.env.APP_ID || 'pool.bexley.testnet';
const AGENT_ID = process.env.AGENT_ID || `guardian.${OWNER_ID}`;
const RPC = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const OWNER_KEY = process.env.NEAR_PRIVATE_KEY?.trim();
const FUND = process.env.AGENT_FUND_NEAR || '0.5';
const ALLOWED = ['set_price', 'set_fee_level', 'post_note', 'stabilize', 'rebalance', 'execute_order'];

if (!OWNER_KEY) {
  console.error('Missing NEAR_PRIVATE_KEY');
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: RPC });
const owner = new Account(OWNER_ID, provider, OWNER_KEY);
const agentKey = deriveAgentKey(OWNER_KEY);

const ownerState = await owner.getState();
console.log(`Owner ${OWNER_ID} balance: ${ownerState.balance?.available ?? JSON.stringify(ownerState.balance)}`);

let exists = true;
try {
  await new Account(AGENT_ID, provider).getState();
} catch {
  exists = false;
}

if (!exists) {
  console.log(`Creating ${AGENT_ID} with a limited key (${ALLOWED.join(', ')} on ${APP_ID})...`);
  await owner.signAndSendTransaction({
    receiverId: AGENT_ID,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(FUND)),
      actions.addFunctionCallAccessKey(
        PublicKey.fromString(agentKey.publicKey),
        APP_ID,
        ALLOWED,
        nearToYocto(FUND),
      ),
    ],
  });
  console.log(`Created ${AGENT_ID}.`);
} else {
  console.log(`${AGENT_ID} already exists.`);
}

const keys = await new Account(AGENT_ID, provider).getAccessKeyList();
console.log('Agent keys:');
for (const k of keys.keys) {
  console.log(`  ${k.public_key}: ${JSON.stringify(k.access_key.permission)}`);
}
if (keys.keys.some((k) => k.access_key.permission === 'FullAccess')) {
  console.log('::warning::The agent account has a full-access key. It should only have the limited key.');
}

const config = await provider.callFunction({ contractId: APP_ID, method: 'get_config', args: {} });
if (config.guardian !== AGENT_ID) {
  await owner.callFunction({ contractId: APP_ID, methodName: 'set_guardian', args: { guardian: AGENT_ID } });
  console.log(`Set guardian to ${AGENT_ID}.`);
}
if (config.price_feeder !== AGENT_ID) {
  await owner.callFunction({ contractId: APP_ID, methodName: 'set_price_feeder', args: { price_feeder: AGENT_ID } });
  console.log(`Set price feeder to ${AGENT_ID}.`);
}
console.log('Guardian setup done.');
