# Bexley Guardian proofs

Every fee and savings-rate decision made by Bexley's AI Pool Guardian is saved here with the proof that it came from NEAR AI's secure hardware.

- `index.json`: one line per AI decision, newest first.
- `YYYY-MM-DD/<id>.json`: the full proof. The exact request sent to NEAR AI Cloud, the exact response, NEAR AI's signature (`/v1/signature/{id}`) and the signing keys from the hardware attestation report fetched before the question.
- `attest/<sha256>.json`: the raw attestation reports.

To check a proof: hash the exact `request` and `response` with SHA-256, compare with `signature.text`, recover the signer of `signature.text` (EIP-191), and confirm it is one of `attestation.signers`. The Bexley app does this in your browser (Guardian page, "Check proof"). The code is `app/src/lib/proof.mjs` on the main branch.

Written automatically by the Guardian. Do not edit.
