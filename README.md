# Bexley

Bexley pairs two kinds of people in one pool on NEAR:

- **Savers** want safety. They deposit and get a steady, protected return.
- **Risk-takers** want upside. They pay savers for the use of their deposit.

An AI agent matches each saver with the best risk-taker offer and manages the deals.

Built for the NEAR Hackathon (Nov 2026).

## Status

Work in progress. This README only describes what works today.

| Part | Status |
|---|---|
| Test USDC token (`contracts/test-usdc`) | Written and unit-tested. Not deployed yet. |
| Bexley core contract | Not started |
| AI matching agent | Not started |
| Web app | Not started |

## Test USDC (tUSDC)

A standard NEP-141 token with 6 decimals, like real USDC. It has no real value.
Anyone can call `claim()` to get 1,000 tUSDC, once per hour per account.

Run the tests:

```bash
cargo test -p test-usdc
```
