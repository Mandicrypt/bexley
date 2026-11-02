# Bexley

Bexley pairs two kinds of people in one pool on NEAR:

- **Savers** want safety. They deposit and lock in the **dollar value** of their deposit, plus a fixed yearly rate, for a set time.
- **Risk-takers** want upside. They put up margin and pay savers that rate. In return they take the whole price move on the deal, so they get leveraged exposure and absorb losses first.

An AI agent matches each saver with the best offer. The contract checks every rule on-chain, so the agent can pair orders but can never move anyone's funds.

Built for the NEAR Hackathon (Nov 2026).

## Status

Work in progress. This README only describes what works today.

| Part | Status |
|---|---|
| Bexley core contract (`contracts/bexley`) | Written, 26 unit tests pass. Testnet launch ready, not yet run. |
| Test NEAR faucet token (`contracts/faucet-token`) | Written, 4 unit tests pass. Testnet launch ready, not yet run. |
| AI matching agent | Not started |
| Web app | Not started |
| Price feed | On testnet the owner account posts the NEAR/USD price. Not decentralized yet. |

## How a deal works

1. A saver sends tNEAR to Bexley with a chosen deal length and the lowest rate they accept.
2. A risk-taker sends tNEAR as margin with their rate, accepted deal lengths, and a **cover** level. Cover 3 means each token of margin covers 3 tokens of saver deposit (4x exposure).
3. The agent (or the saver directly) matches a saving to an offer. Margin needed = deposit / cover, rounded up. The entry price is recorded.
4. When the deal ends, anyone can settle it:

```
pot          = saver deposit + margin
saver owed   = deposit x entry price / exit price x (1 + rate x time)
saver gets   = min(saver owed, pot)
risk-taker   = pot - saver gets, minus a 10% fee on any profit
```

So if the price rises, the saver needs fewer tokens to keep their dollars and the risk-taker keeps the rest. If the price falls, the risk-taker's margin pays the saver first.

**Saver protection:** if the price falls so far that the saver is owed 95% or more of the pot, anyone can settle the deal early.

Balances are credited inside Bexley and sent to your wallet with `withdraw`.

Deal lengths on testnet: 10 minutes, 1 hour, 1 day, 7, 14 and 30 days. The short ones let testers see a full deal in one sitting.

## Accounts on testnet

| Account | What it is |
|---|---|
| `bexley.testnet` | Owner. For now also the agent and price feeder. |
| `tnear.bexley.testnet` | tNEAR, the test token deals are held in. Anyone can `claim()` 100 tNEAR per hour. No real value. |
| `app.bexley.testnet` | Bexley core contract. |

An early version used a test USDC token at `usdc.bexley.testnet`. The final design holds deals in tNEAR, so that account is retired.

## Run the tests

```bash
cargo test --workspace
```

## Deploy

GitHub Actions → **Deploy to NEAR testnet** → Run workflow. It needs the owner's key in the `NEAR_PRIVATE_KEY` repository secret.
