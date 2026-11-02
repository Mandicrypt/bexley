// Print the owner's available NEAR, so a failed deploy is easy to explain.
import { Account, JsonRpcProvider } from 'near-api-js';

const id = process.env.NEAR_ACCOUNT_ID || 'bexley.testnet';
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org' });
const state = await new Account(id, provider).getState();
const yocto = BigInt(state.balance?.available ?? state.balance?.total ?? state.amount ?? 0);
console.log(`${id} has ${(Number(yocto / 10n ** 21n) / 1000).toFixed(3)} NEAR available`);
