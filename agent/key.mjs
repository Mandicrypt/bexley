// The agent's key is derived from the owner's key, so no extra secret has to
// be stored anywhere. The agent account only ever holds this key as a
// limited "function call" key: it can call match_deal, set_price and settle
// on the Bexley contract, and nothing else. It cannot send tokens or NEAR.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

export function deriveAgentKey(ownerPrivateKey) {
  if (!ownerPrivateKey) throw new Error('Missing owner key');
  const seed = sha256(new TextEncoder().encode(`bexley-agent-v1:${ownerPrivateKey.trim()}`));
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  return {
    privateKey: `ed25519:${bs58.encode(secret)}`,
    publicKey: `ed25519:${bs58.encode(pub)}`,
  };
}
