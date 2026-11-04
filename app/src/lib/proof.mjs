// Provable AI: checks that a Guardian decision really came from NEAR AI's
// secure hardware, without trusting Bexley.
//
// NEAR AI Cloud runs models inside TEEs (secure hardware enclaves). For each
// answer it signs "request hash : response hash" (or, when the model's own
// TEE signs, "model : request hash : response hash") with a key that only
// exists inside that hardware. The hardware also publishes an attestation
// report that names the key.
//
// A proof file holds the exact request and response bytes, NEAR AI's
// signature, and the attested signing keys fetched before the request.
// verifyProof() redoes every check locally:
//   1. hash the exact request and response, and compare with the signed text
//   2. recover the signer from the signature (EIP-191, ecdsa)
//   3. confirm that signer is one of the keys the hardware attested
//
// This file is shared by the Guardian (agent/proof.mjs is a copy) and the
// web app, so the same code makes and checks every proof.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const sha256Hex = (text) => bytesToHex(sha256(utf8ToBytes(text)));

/** Ethereum-style address that signed `text` (EIP-191 personal message). */
export function recoverSigner(text, signatureHex) {
  const msg = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('Signature must be 65 bytes');
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('Bad recovery byte');
  const recovered = new Uint8Array(65);
  recovered[0] = v;
  recovered.set(sig.subarray(0, 64), 1);
  const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const full = secp256k1.Point.fromBytes(pub).toBytes(false);
  return '0x' + bytesToHex(keccak_256(full.subarray(1)).subarray(12));
}

/** Every signing address mentioned in an attestation report. */
export function attestedSigners(report) {
  const out = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.signing_address === 'string' && (!o.signing_algo || o.signing_algo === 'ecdsa')) {
      out.add(o.signing_address.toLowerCase());
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(report);
  return [...out];
}

/**
 * Check a proof. Returns { ok, checks: [{ name, ok, detail }] }.
 * proof = { model, request, response, signature: { text, signature, signing_address, signing_algo, signature_kind }, attestation: { signers } }
 */
export function verifyProof(proof) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const sig = proof?.signature;
  if (!sig?.signature) {
    add('NEAR AI signed this answer', false, 'No signature was returned for this answer.');
    return { ok: false, checks };
  }
  if (sig.signing_algo !== 'ecdsa') {
    add('Known signature type', false, `Unsupported: ${sig.signing_algo}`);
    return { ok: false, checks };
  }

  const reqHash = sha256Hex(proof.request);
  const resHash = sha256Hex(proof.response);
  const expected =
    sig.signature_kind === 'provider_tee' ? `${proof.model}:${reqHash}:${resHash}` : `${reqHash}:${resHash}`;
  add(
    'The question and answer are exactly what was signed',
    sig.text === expected,
    sig.text === expected ? `Fingerprints ${reqHash.slice(0, 10)}… and ${resHash.slice(0, 10)}… match.` : 'The saved question or answer was changed after signing.',
  );

  let signer = '';
  try {
    signer = recoverSigner(sig.text, sig.signature);
  } catch (e) {
    add('The signature is valid', false, String(e.message || e));
    return { ok: false, checks };
  }
  const sameKey = signer.toLowerCase() === String(sig.signing_address).toLowerCase();
  add('The signature is valid', sameKey, sameKey ? `Signed by ${signer.slice(0, 8)}…${signer.slice(-6)}.` : 'Signed by a different key.');

  const signers = (proof.attestation?.signers || []).map((s) => s.toLowerCase());
  const attested = signers.includes(signer.toLowerCase());
  add(
    'That key lives in NEAR AI secure hardware',
    attested,
    attested
      ? `The key is named in NEAR AI's hardware attestation report, fetched before the question was asked.`
      : 'The key is not in the attestation report.',
  );
  return { ok: checks.every((c) => c.ok), checks, signer };
}
