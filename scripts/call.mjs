// Call a contract method as the owner account (bexley.testnet).
// Args: <contract id> <method> [args JSON] [deposit in yoctoNEAR]
// Env: NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, optional NEAR_RPC_URL

import { Account, JsonRpcProvider } from 'near-api-js';

const [contractId, methodName, argsJson = '{}', deposit = '0'] = process.argv.slice(2);
const ownerId = process.env.NEAR_ACCOUNT_ID;
const privateKey = process.env.NEAR_PRIVATE_KEY?.trim();
const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';

if (!contractId || !methodName || !ownerId || !privateKey) {
  console.error('Usage: node call.mjs <contract id> <method> [args JSON] [deposit]  (needs NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY)');
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const owner = new Account(ownerId, provider, privateKey);
const result = await owner.callFunction({
  contractId,
  methodName,
  args: JSON.parse(argsJson),
  deposit: BigInt(deposit),
  gas: 100_000_000_000_000n,
});
console.log(`Called ${contractId}.${methodName}`, result === undefined ? '' : JSON.stringify(result));
