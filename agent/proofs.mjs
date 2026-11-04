// Saves Guardian AI proofs into a folder that is published as the repo's
// "proofs" branch (the web app reads it from there):
//   index.json                     newest first, one line per AI decision
//   YYYY-MM-DD/<answer id>.json    the full proof (exact request, response, signature)
//   attest/<sha256>.json           NEAR AI's raw hardware attestation report
//   prices/YYYY-MM-DD.jsonl        one line per price post: the exchange quotes, the
//                                  median asked for, and what the pool accepted
//   prices/latest.json             the newest of those

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_INDEX = 1000;

export function saveProof(dir, proof, attestation) {
  if (attestation?.raw) {
    const a = join(dir, 'attest');
    mkdirSync(a, { recursive: true });
    const f = join(a, `${attestation.report_sha256}.json`);
    if (!existsSync(f)) writeFileSync(f, attestation.raw);
  }
  const day = new Date(proof.at).toISOString().slice(0, 10);
  const safeId = String(proof.id || proof.at).replace(/[^A-Za-z0-9._-]/g, '_');
  const file = `${day}/${safeId}.json`;
  mkdirSync(join(dir, day), { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(proof, null, 2));

  const indexFile = join(dir, 'index.json');
  let index = [];
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {}
  index.unshift({
    at: proof.at,
    id: proof.id,
    file,
    model: proof.model,
    reason: proof.decision?.reason,
    level: proof.decision?.level,
    rate: proof.decision?.rate,
    kind: proof.signature?.signature_kind || null,
    signer: proof.signature?.signing_address || null,
    verified: !!proof.check?.ok,
  });
  writeFileSync(indexFile, JSON.stringify(index.slice(0, MAX_INDEX), null, 1));
  return file;
}

/** A receipt for one price post: where the number came from. */
export function savePriceReceipt(dir, receipt) {
  const d = join(dir, 'prices');
  mkdirSync(d, { recursive: true });
  const day = new Date(receipt.at).toISOString().slice(0, 10);
  appendFileSync(join(d, `${day}.jsonl`), JSON.stringify(receipt) + '\n');
  writeFileSync(join(d, 'latest.json'), JSON.stringify(receipt, null, 1));
}
