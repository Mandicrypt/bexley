import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { attestedSigners, recoverSigner, sha256Hex, verifyProof } from './proof.mjs';

const priv = secp256k1.utils.randomSecretKey();
const addr = '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12));

function ethSign(text) {
  const msg = utf8ToBytes(text);
  const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rec = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' });
  return '0x' + bytesToHex(rec.subarray(1)) + (27 + rec[0]).toString(16);
}

function makeProof(kind = 'gateway') {
  const request = '{"model":"m","messages":[]}';
  const response = '{"id":"chatcmpl-1","choices":[]}';
  const text = kind === 'provider_tee' ? `m:${sha256Hex(request)}:${sha256Hex(response)}` : `${sha256Hex(request)}:${sha256Hex(response)}`;
  return {
    model: 'm', request, response,
    signature: { text, signature: ethSign(text), signing_address: addr, signing_algo: 'ecdsa', signature_kind: kind },
    attestation: { signers: [addr.toUpperCase().replace('0X', '0x')] },
  };
}

test('recovers the signer', () => {
  assert.equal(recoverSigner('hello', ethSign('hello')), addr);
});

test('a good proof passes, both kinds', () => {
  assert.equal(verifyProof(makeProof()).ok, true);
  assert.equal(verifyProof(makeProof('provider_tee')).ok, true);
});

test('an edited answer fails', () => {
  const p = makeProof();
  p.response = p.response.replace('1', '2');
  const r = verifyProof(p);
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].ok, false);
});

test('an unattested key fails', () => {
  const p = makeProof();
  p.attestation.signers = ['0x0000000000000000000000000000000000000001'];
  assert.equal(verifyProof(p).ok, false);
});

test('missing signature fails', () => {
  assert.equal(verifyProof({ model: 'm', request: '', response: '' }).ok, false);
});

test('finds signers anywhere in a report', () => {
  const r = { gateway_attestation: { signing_address: '0xAA', signing_algo: 'ecdsa' }, model_attestations: [{ signing_address: '0xbb' }, { signing_address: 'x', signing_algo: 'ed25519' }] };
  assert.deepEqual(attestedSigners(r).sort(), ['0xaa', '0xbb']);
});
