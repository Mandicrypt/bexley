// Print a contract view call. Args: <contract id> <method> [args JSON]
import { JsonRpcProvider } from 'near-api-js';
const [contractId, method, args = '{}'] = process.argv.slice(2);
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org' });
console.log(JSON.stringify(await provider.callFunction({ contractId, method, args: JSON.parse(args) }), null, 2));
