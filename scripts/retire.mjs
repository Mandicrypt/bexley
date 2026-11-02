// Delete a sub-account of the owner and send its remaining NEAR back to the
// owner. Used to retire usdc.bexley.testnet, which the final design no
// longer needs. Args: <subaccount prefix>

import { Account, JsonRpcProvider } from 'near-api-js';

const [prefix] = process.argv.slice(2);
const ownerId = process.env.NEAR_ACCOUNT_ID;
const privateKey = process.env.NEAR_PRIVATE_KEY?.trim();
const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';

if (!prefix || !ownerId || !privateKey) {
  console.error('Usage: node retire.mjs <subaccount prefix>  (needs NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY)');
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const accountId = `${prefix}.${ownerId}`;
const account = new Account(accountId, provider, privateKey);
try {
  await account.getState();
} catch {
  console.log(`${accountId} does not exist. Nothing to do.`);
  process.exit(0);
}
await account.deleteAccount(ownerId);
console.log(`Deleted ${accountId}. Its NEAR went back to ${ownerId}.`);
