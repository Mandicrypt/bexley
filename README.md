# Bexley

Bexley splits one pool of NEAR into two tokens:

- **bxUSD**: a stablecoin worth $1, for people who want safety.
- **xNEAR**: leveraged NEAR. It owns everything the pool is worth above the bxUSD it owes, so it moves more than NEAR in both directions.

On top of that core (the idea behind Hylo on Solana and f(x) Protocol on Ethereum), Bexley adds a **Stability Pool**, **Steady 2x/3x vaults**, **stop-loss and take-profit orders**, and an **AI Pool Guardian** that runs the pool's safety work and explains every move in public notes.

Built for the NEAR Hackathon (Nov 2026).

## Status

This README only describes what works today.

| Part | Status |
|---|---|
| Pool and bxUSD (`contracts/bexley`) | Live on testnet at [`pool.bexley.testnet`](https://testnet.nearblocks.io/address/pool.bexley.testnet). 29 unit tests pass. |
| xNEAR token (`contracts/xtoken`) | Live at [`xnear.bexley.testnet`](https://testnet.nearblocks.io/address/xnear.bexley.testnet). Only the pool can mint or burn it. 3 unit tests pass. |
| tNEAR faucet token (`contracts/faucet-token`) | Live at [`tnear.bexley.testnet`](https://testnet.nearblocks.io/address/tnear.bexley.testnet). Anyone can claim 100 per hour. 4 unit tests pass. |
| AI Pool Guardian (`agent/`) | Live as [`guardian.bexley.testnet`](https://testnet.nearblocks.io/address/guardian.bexley.testnet). Runs every 5 minutes in a self-restarting GitHub Actions loop. 9 logic tests pass. |
| Web app (`app/`) | Mint, Redeem, Earn (Stability Pool), Vaults, Orders and a live Guardian feed. Published on GitHub Pages. |
| Price feed | The Guardian posts the median NEAR/USD price from CoinGecko, Coinbase and Kraken. Not decentralized yet. |
| Deposits from other chains | Not built. |

On testnet the pool holds **tNEAR**, a free test token with no value, in place of real NEAR.

## How the pool works

```
pool value (TVL)   = tNEAR in the pool x NEAR price
xNEAR price        = (TVL - bxUSD supply) / xNEAR supply
backing (CR)       = TVL / bxUSD supply
xNEAR leverage     = TVL / (TVL - bxUSD supply)
```

- **Mint bxUSD**: send tNEAR, get $1 of bxUSD per dollar deposited.
- **Mint xNEAR**: send tNEAR, get xNEAR at its current price.
- **Redeem** either one back to tNEAR at fair value.

Every mint and redeem happens at fair value, so it never moves anyone else's xNEAR price; fees only add to it.

### Safety modes

| Mode | Backing | What changes |
|---|---|---|
| Healthy | 150% or more | Normal fees (0.2% bxUSD, 0.5% xNEAR) |
| Caution | 130% to 150% | Minting xNEAR and redeeming bxUSD become free; minting bxUSD costs 1%, leaving xNEAR costs 2% |
| Stabilize | under 130% | New bxUSD and xNEAR exits pause. The Stability Pool converts bxUSD into xNEAR to lift backing back to 140% |

bxUSD can never be minted if it would push backing under 130%. If backing ever fell under 100%, bxUSD holders would share what is left equally.

### Stability Pool

bxUSD holders deposit to earn **80% of all fees** while the pool is healthy. In return, when backing drops under 130%, part of their bxUSD is converted into xNEAR at fair value. Withdraw any time and get back your share of both.

### Steady vaults

xNEAR's leverage floats with the pool. **Steady 2x** and **Steady 3x** hold a mix of tNEAR and xNEAR so the whole vault stays at its target. When the vault drifts more than 3%, it rebalances on-chain. If xNEAR itself is less levered than the target, the vault holds only xNEAR.

### Exit orders

Park xNEAR with a **stop price**, a **take price**, or both. When NEAR reaches one, the order can be executed and the tNEAR goes straight to the owner. The contract checks the price itself, so whoever executes it cannot cheat.

## The AI Pool Guardian

Every 5 minutes the Guardian:

1. **Prices**: posts the median NEAR/USD price when it moved 0.1% or is 20 minutes old. The pool refuses prices older than an hour.
2. **Sets fees**: reads NEAR's 24-hour move. Under 5% is calm (normal fees), 5–10% volatile (2x fees), over 10% stormy (3x fees). Higher fees in rough markets slow churn and pay the Stability Pool more for its extra risk.
3. **Protects**: calls `stabilize` when backing is under 130%.
4. **Rebalances** Steady vaults that drifted.
5. **Executes** stop-loss and take-profit orders whose price is reached.
6. **Explains**: writes a plain-English note on the pool contract for every fee change, protection, rebalance and order, plus a pool check when the mode changes, the pool changes a lot, or every 6 hours. Read them with `get_notes`.

**It cannot move funds.** `guardian.bexley.testnet` has no full-access key. Its only key can call `set_price`, `set_fee_level`, `post_note`, `stabilize`, `rebalance` and `execute_order` on the pool, with a small gas allowance. None of these send money to the caller, and the contract checks every rule itself. The Guardian's key is derived from the owner key in CI and only the derived key is passed to the running agent.

Each run's decision log is on its GitHub Actions page.

## Accounts on testnet

| Account | What it is |
|---|---|
| `bexley.testnet` | Owner. Receives the 20% of fees not paid to the Stability Pool. |
| `pool.bexley.testnet` | The pool. Also the bxUSD token. |
| `xnear.bexley.testnet` | xNEAR token. |
| `tnear.bexley.testnet` | tNEAR, the test collateral. |
| `guardian.bexley.testnet` | The AI Pool Guardian and price feeder. Limited key only. |

Earlier designs are kept in the repo but no longer deployed: a test USDC token, and a one-to-one deals contract (`contracts/bexley-deals-v1`) whose matching agent was `agent.bexley.testnet`.

## Use it from the command line

Deposits use `ft_transfer_call` on the token with a JSON message:

```bash
# Mint xNEAR with 10 tNEAR
near call tnear.bexley.testnet ft_transfer_call \
  '{"receiver_id":"pool.bexley.testnet","amount":"10000000000000000000000000","msg":"{\"type\":\"mint_x\"}"}' \
  --accountId YOU.testnet --depositYocto 1 --gas 150000000000000
```

Messages: `mint_bx`, `mint_x`, `vault_deposit` (with `vault`: 0 or 1) for tNEAR; `redeem_x` and `order` (with `stop_price` and/or `take_price` in micro-dollars) for xNEAR.

Other calls: `redeem_bx`, `sp_deposit`, `sp_withdraw`, `vault_withdraw`, `cancel_order` (each needs 1 yoctoNEAR attached). Views: `get_pool`, `get_vaults`, `get_account`, `get_notes`, `quote`.

## Run the tests

```bash
cargo test --workspace          # contracts
cd agent && npm test             # Guardian decisions
cd app && npm test               # app number formatting
```

## Deploy

GitHub Actions → **Deploy to NEAR testnet** → Run workflow. It needs the owner's key in the `NEAR_PRIVATE_KEY` repository secret.
