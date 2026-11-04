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
// Args: <subaccount prefix> <wasm path> [init method or '-'] [init args JSON] [NEAR to fund or 'auto']

import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from 'near-api-js';

const [prefix, wasmPath, initMethod = 'new', initArgs = '{}', fundNear = 'auto'] = process.argv.slice(2);
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
  // Optional: top up the contract's NEAR first (bigger code needs more storage).
  if (process.env.TOPUP_NEAR) {
    await owner.transfer({ receiverId: contractId, amount: nearToYocto(process.env.TOPUP_NEAR) });
    console.log(`Sent ${process.env.TOPUP_NEAR} NEAR to ${contractId} for storage.`);
  }
  // Optional: run a migration in the same transaction as the new code, so the
  // contract is never live with old data and new code.
  const migrate = process.env.MIGRATE_METHOD;
  console.log(`${contractId} already exists. Redeploying code${migrate ? ` and calling ${migrate}` : ' only'}.`);
  const contract = new Account(contractId, provider, privateKey.trim());
  await contract.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.deployContract(code),
      ...(migrate ? [actions.functionCall(migrate, {}, teraToGas('200'), 0n)] : []),
    ],
  });
  console.log(`Redeployed ${contractId}.`);
} else {
  console.log(`Creating ${contractId} and deploying...`);
  const initActions = initMethod === '-' ? [] : [
    actions.functionCall(initMethod, JSON.parse(initArgs), teraToGas('100'), 0n),
  ];
  // 'auto': just enough for the code's storage (1 NEAR per 100 KB) plus
  // 0.5 NEAR for the contract's own data.
  const fund = fundNear === 'auto'
    ? BigInt(code.length) * 10n ** 19n + nearToYocto('0.5')
    : nearToYocto(fundNear);
  console.log(`Code size ${code.length} bytes, funding ${Number(fund / 10n ** 21n) / 1000} NEAR`);
  await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(fund),
      actions.addFullAccessKey(keyPair.getPublicKey()),
      actions.deployContract(code),
      ...initActions,
    ],
  });
  console.log(`Created and deployed ${contractId}.`);
}
console.log(`Explorer: https://testnet.nearblocks.io/address/${contractId}`);
