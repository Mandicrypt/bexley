// Deploy a Bexley contract to a sub-account of the owner account on NEAR testnet.
//
// First run: creates <prefix>.<owner>, funds it, gives the owner's key full
// access to it, deploys the wasm and calls the init method, all in one
// transaction. Later runs: only redeploy the code (no re-init).
//
// Env:
//   NEAR_ACCOUNT_ID   owner account, e.g. bexley.testnet
//   NEAR_PRIVATE_KEY  owner's private key, "ed25519:..." (from a GitHub secret)
//   NEAR_RPC_URL      optional, defaults to testnet RPC
// Args: <subaccount prefix> <wasm path> [init method] [init args JSON] [NEAR to fund]

import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from 'near-api-js';

const [prefix, wasmPath, initMethod = 'new', initArgs = '{}', fundNear = '3'] = process.argv.slice(2);
const ownerId = process.env.NEAR_ACCOUNT_ID;
const privateKey = process.env.NEAR_PRIVATE_KEY;
const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';

if (!prefix || !wasmPath) {
  console.error('Usage: node deploy.mjs <subaccount prefix> <wasm path> [init method] [init args JSON] [NEAR to fund]');
  process.exit(1);
}
if (!ownerId || !privateKey) {
  console.error('Missing NEAR_ACCOUNT_ID or NEAR_PRIVATE_KEY.');
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const keyPair = KeyPair.fromString(privateKey.trim());
const owner = new Account(ownerId, provider, privateKey.trim());
const contractId = `${prefix}.${ownerId}`;
const code = new Uint8Array(readFileSync(wasmPath));

async function exists(accountId) {
  try {
    await new Account(accountId, provider).getState();
    return true;
  } catch {
    return false;
  }
}

if (await exists(contractId)) {
  console.log(`${contractId} already exists. Redeploying code only.`);
  const contract = new Account(contractId, provider, privateKey.trim());
  await contract.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.deployContract(code)],
  });
  console.log(`Redeployed ${contractId}.`);
} else {
  console.log(`Creating ${contractId} and deploying...`);
  const initActions = initMethod === '-' ? [] : [
    actions.functionCall(initMethod, JSON.parse(initArgs), teraToGas('100'), 0n),
  ];
  await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(fundNear)),
      actions.addFullAccessKey(keyPair.getPublicKey()),
      actions.deployContract(code),
      ...initActions,
    ],
  });
  console.log(`Created and deployed ${contractId}.`);
}
console.log(`Explorer: https://testnet.nearblocks.io/address/${contractId}`);
