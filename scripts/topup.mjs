// Send testnet NEAR from the owner to an account (default: the Guardian) so it
// can keep paying gas. Usage: node scripts/topup.mjs [account] [NEAR]
import { Account, JsonRpcProvider, nearToYocto } from 'near-api-js';

const owner = process.env.NEAR_ACCOUNT_ID || 'bexley.testnet';
const [to = `guardian.${owner}`, amount = '5'] = process.argv.slice(2);
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com' });
const account = new Account(owner, provider, process.env.NEAR_PRIVATE_KEY.trim());
const show = async (id) => {
  const s = await new Account(id, provider).getState();
  const y = BigInt(s.balance?.available ?? s.balance?.total ?? s.amount ?? 0);
  return (Number(y / 10n ** 21n) / 1000).toFixed(3);
};
console.log(`Before: ${to} has ${await show(to)} NEAR, ${owner} has ${await show(owner)} NEAR`);
await account.transfer({ receiverId: to, amount: nearToYocto(amount) });
console.log(`Sent ${amount} NEAR. Now ${to} has ${await show(to)} NEAR.`);
