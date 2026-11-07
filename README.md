# Bexley

Bexley splits one pool of NEAR into two tokens:

- **bxUSD**: a stablecoin worth $1, for people who want safety.
- **xNEAR**: leveraged NEAR. It owns everything the pool is worth above the bxUSD it owes, so it moves more than NEAR in both directions.

On top of that core (the idea behind Hylo on Solana and f(x) Protocol on Ethereum), Bexley adds a **Stability Pool** with a **savings rate paid by xNEAR**, **Steady 2x/3x vaults**, **stop-loss and take-profit orders**, and an **AI Pool Guardian** that runs the pool's safety work, sets the savings rate from demand, and explains every move in public notes.

**Try it:** [bexley-sigma.vercel.app](https://bexley-sigma.vercel.app) (NEAR testnet; get free tNEAR in the app). No wallet? Click **Demo** for a pretend wallet with example positions and live prices; nothing is sent.

Built for the NEAR Hackathon (Nov 2026).

## Try it step by step

No wallet needed for steps 1 to 6. Open [bexley-sigma.vercel.app](https://bexley-sigma.vercel.app).

1. Click **Demo** in the header. You see an amber demo bar, and the app now uses a pretend wallet with example positions and live prices. Nothing is sent on-chain.
2. Click **Portfolio**. You see everything the pretend wallet holds, in dollars, and how much it moves when NEAR moves.
3. Click **Trade**. Pick bxUSD or xNEAR and type an amount. You see exactly what you would get, at fair value, before anything happens.
4. On the Trade page, find **Ask Bexley** and click the example "Make me 2x long with 50 tNEAR" (or type your own). You see a plan with the result and the main risk. Nothing runs until you approve it.
5. Click **Guardian**. Under **Latest AI decision**, click **AI, verified**. You see the proof checked in your browser: "Checked in your browser: this decision came from NEAR AI secure hardware."
6. On the Guardian page, click **Watch the crash test**. You see a replay of a real testnet crash: NEAR falls 37%, the Stability Pool steps in, and bxUSD holds $1.
7. On the Trade page, find **Deposit from another chain**. Pick a token like USDC on Ethereum and an amount. You see a live NEAR Intents quote ("You get, in your NEAR wallet"). Deposits open with the mainnet beta; on testnet this shows quotes only.
8. To use real testnet tokens: click **Exit demo**, then **Connect wallet** with a NEAR testnet account, and click **Get 100 tNEAR**. Then mint bxUSD or xNEAR on the Trade page. You see the new balance on Portfolio, and the transaction on [testnet.nearblocks.io](https://testnet.nearblocks.io/address/pool.bexley.testnet).

## Credit

The core design of Bexley is inspired by [Hylo](https://hylo.so) on Solana: one pool split into a stablecoin and a leveraged token, with no liquidations. f(x) Protocol on Ethereum uses a similar idea. Bexley rebuilds that core for NEAR as its own contracts, written from scratch, and adds what is new here:

- an **AI Pool Guardian** whose every decision is signed inside NEAR AI's secure hardware and checked in your browser,
- a **public on-chain crash test** that anyone can replay,
- **deposits from other chains** through NEAR Intents,
- **Steady 2x/3x vaults**, **stop-loss and take-profit orders**, a **savings rate paid by xNEAR**, and **Ask Bexley**.

## Status

This README only describes what works today. A [live check](.github/workflows/smoke.yml) tests it every day against the real site and chain: the website, a fresh pool price, the Guardian's recent posts, AI proofs, Ask Bexley, NEAR Intents quotes and the crash-test replay ([`scripts/smoke.mjs`](scripts/smoke.mjs)).

| Part | Status |
|---|---|
| Pool and bxUSD (`contracts/bexley`) | Live on testnet at [`pool.bexley.testnet`](https://testnet.nearblocks.io/address/pool.bexley.testnet). 47 unit tests pass. |
| xNEAR token (`contracts/xtoken`) | Live at [`xnear.bexley.testnet`](https://testnet.nearblocks.io/address/xnear.bexley.testnet). Only the pool can mint or burn it. 3 unit tests pass. |
| tNEAR faucet token (`contracts/faucet-token`) | Live at [`tnear.bexley.testnet`](https://testnet.nearblocks.io/address/tnear.bexley.testnet). Anyone can claim 100 per hour. 4 unit tests pass. |
| AI Pool Guardian (`agent/`) | Live as [`guardian.bexley.testnet`](https://testnet.nearblocks.io/address/guardian.bexley.testnet). Runs every 5 minutes in a self-restarting GitHub Actions loop. Fee and rate decisions by an AI model on NEAR AI Cloud, each with a public proof, and fixed rules as backup. 25 tests pass. |
| Web app (`app/`) | Landing page, Trade (mint and redeem), Ask Bexley, Your risk, Deposit from another chain, Portfolio (everything you hold in dollars, how much it moves with NEAR, and your stop-loss and take-profit orders), Earn (Stability Pool), Vaults, the Guardian page with AI proofs, and the crash-test replay. **Demo** mode gives a pretend wallet with example positions, no wallet needed. 26 tests pass. Live at [bexley-sigma.vercel.app](https://bexley-sigma.vercel.app), deployed by Vercel on every push. |
| Crash test | NEAR pushed down 37% on a separate testnet pool (`crash.bexley.testnet`): the safety rails slowed the fall, the AI raised fees, and the Stability Pool lifted backing from 125% back to 140%. bxUSD held $1. Every step is a real transaction; replay it in the app at `#crash-test`. Run it again with GitHub Actions → **Crash test**. |
| Price feed | The Guardian posts the median NEAR/USD price from CoinGecko, Coinbase and Kraken, with a public receipt for every post. The pool limits each post to a 5% move. Pyth no longer serves NEAR, so there is no decentralized NEAR feed to use on testnet yet. |
| Deposits from other chains | Built with NEAR Intents (1Click API): pay with USDC, USDT, ETH, SOL or BTC from their own chains and receive NEAR, then mint. Live quotes on testnet; real deposits on the mainnet beta. |
| Mainnet beta | Code ready: wNEAR collateral (the app wraps NEAR for you), a hard cap on the whole pool, and an owner pause that stops new deposits while every exit stays open. Deploy with GitHub Actions → **Mainnet beta**. |

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

### Savings rate

xNEAR's leverage comes from bxUSD, so in effect xNEAR borrows from bxUSD holders. xNEAR pays bxUSD in the Stability Pool a yearly savings rate, a little at a time: the pool mints new bxUSD into the Stability Pool, and since the pool's value is unchanged, that bxUSD comes out of xNEAR's share.

- The rate only runs while the pool is Healthy, and never pushes backing under 150%.
- The Guardian sets it between 0% and 20% from how much leverage people want (see below). It starts at 8%.
- Stability Pool savers earn this rate **plus** 80% of all fees.

### Steady vaults

xNEAR's leverage floats with the pool. **Steady 2x** and **Steady 3x** hold a mix of tNEAR and xNEAR so the whole vault stays at its target. When the vault drifts more than 3%, it rebalances on-chain. If xNEAR itself is less levered than the target, the vault holds only xNEAR.

### Exit orders

Park xNEAR with a **stop price**, a **take price**, or both. When NEAR reaches one, the order can be executed and the tNEAR goes straight to the owner. The contract checks the price itself, so whoever executes it cannot cheat.

## The AI Pool Guardian

Every 5 minutes the Guardian:

1. **Prices**: posts the median NEAR/USD price when it moved 0.1% or is 20 minutes old. The pool refuses prices older than an hour. Each post leaves a receipt (the three exchange quotes, the median, and what the pool accepted) in [`proofs/prices`](https://github.com/Mandicrypt/bexley/tree/proofs/prices).
   **Safety rails in the pool:** one post moves the price at most 5%, or 1% if the previous post was under 4 minutes ago. A broken or dishonest feeder cannot crash the pool in one step; a real crash is followed over a few posts (30% takes about 7 posts, 35 minutes), in public.
2. **Decides fees and the savings rate with an AI model.** Every 30 minutes (or at once if the pool's mode changes), an AI model on [NEAR AI Cloud](https://cloud.near.ai) reads the facts: NEAR's price, 24-hour move, hourly volatility and range (from Kraken candles), backing, xNEAR leverage, Stability Pool size, and the current settings. It picks a fee level (normal, 2x or 3x) and a savings rate, and writes the reason users see. Its answer must pass hard limits before anything is sent: fee level 0–2, rate 0–20%, at most 4 points of rate change per decision, and 0% outside Healthy mode. The contract enforces the fee and rate limits again on its own.
3. **Falls back to fixed rules** if the AI is unreachable, answers badly, or no API key is set: normal / 2x / 3x fees at under 5% / 5–10% / over 10% daily moves, and a 12% / 8% / 5% / 0% rate by backing (over 300%, 200–300%, under 200%, not Healthy).
4. **Protects**: calls `stabilize` when backing is under 130%.
5. **Rebalances** Steady vaults that drifted.
6. **Executes** stop-loss and take-profit orders whose price is reached.
7. **Explains**: writes a plain-English note on the pool contract for every fee or rate change (the AI's own words when the AI decided), protection, rebalance and order, plus a pool check when the mode changes, the pool changes a lot, or every 6 hours. Read them with `get_notes`.

### Provable AI

Every AI decision comes with a public proof that it was made by the AI model inside NEAR AI's secure hardware (a TEE), and that nobody changed it afterwards, including us.

1. Before asking, the Guardian fetches NEAR AI's hardware attestation report for the model, with a fresh random nonce. The report names the signing keys that exist only inside the enclave.
2. It sends the question and keeps the exact request and response bytes.
3. It fetches NEAR AI's signature for that answer (`/v1/signature/{id}`). The model's enclave signs `model:sha256(request):sha256(response)`.
4. It checks the proof itself (`agent/proof.mjs`) and publishes it to the [`proofs` branch](https://github.com/Mandicrypt/bexley/tree/proofs): the exact request and response, the signature, and the attestation report.

On the Guardian page, click **AI, verified** on a note and your browser downloads the proof and redoes every check (`app/src/lib/proof.mjs`): the hashes match the signed text, the signature recovers to the signing key, and that key is in the hardware report. You can also inspect the model's hardware report in [NEAR AI's verification center](https://cloud.near.ai/verify).

**It cannot move funds.** `guardian.bexley.testnet` has no full-access key. Its only key can call `set_price`, `set_fee_level` (which also sets the savings rate), `post_note`, `stabilize`, `rebalance` and `execute_order` on the pool, with a small gas allowance. None of these send money to the caller, and the contract checks every rule itself. The Guardian's key is derived from the owner key in CI and only the derived key is passed to the running agent.

Each run's decision log is on its GitHub Actions page.

## Deposit from another chain (NEAR Intents)

NEAR Intents has no testnet, so this runs on the mainnet beta (the testnet app shows live quotes).

1. Pick what you'll send (for example 25 USDC on Base) and see a live quote: about how much NEAR arrives and how fast.
2. Enter your address on that chain for refunds, and get a one-time deposit address from NEAR Intents.
3. Send the funds from any wallet. NEAR Intents' solvers swap them and send wNEAR to your NEAR account; the app follows the status.
4. When it lands, mint bxUSD or xNEAR with one click.

Bexley never holds these funds: the deposit address belongs to NEAR Intents, and failed swaps are refunded to your own address. The API calls go through a small server function (`app/api/intents.js`).

## Mainnet beta

Real NEAR, unaudited code, so it is deliberately small:

- **Hard cap** on the pool's total collateral (`app/src/config/mainnet.json`, 100 NEAR at launch). Deposits over it are refused and refunded.
- **Pause**: the owner can stop new deposits (minting, vault deposits, Stability Pool deposits, new orders). Redeems, withdrawals and order cancels keep working.
- The same Guardian runs it, with its own limited key, the same price safety rails and its own public proofs (`proofs/mainnet`).
- In the app, use the **Testnet / Mainnet** switch at the top. Mainnet uses NEAR: the app wraps exactly what a mint needs into wNEAR in the same transaction, and an **Unwrap** button turns wNEAR back into NEAR.

## Ask Bexley

A chat box on the Trade page. Type what you want, like *"Make me 2x long with 50 tNEAR and sell if NEAR drops to $3.50"*, and an AI model on NEAR AI Cloud turns it into a short plan of steps (mint, redeem, Stability Pool, Steady vaults, stop-loss and take-profit orders).

- The AI only sees public numbers the page already shows (prices, leverage, your balances) and your message.
- Every plan is checked twice, on the server and in the browser (`app/src/lib/intent.mjs`): only known actions, positive amounts, at most 4 steps, sensible stop and take prices. Anything else is dropped.
- Nothing happens until you approve each step in your own wallet. Amounts are re-checked against fresh balances right before each step, and mints and redeems keep the 1% price guard.
- The AI key stays on the server, in a Vercel function (`app/api/ask.js`).

## Your risk

Connected users with xNEAR or bxUSD see what their holdings would gain or lose if NEAR moves 10% or 20%, how much they move with NEAR overall, and a suggested stop-loss: two days of NEAR's usual moves below today (between 5% and 25%), from the last day of CoinGecko prices. One click protects all their xNEAR with that stop. The Orders page has the same suggestion.

## Accounts on testnet

| Account | What it is |
|---|---|
| `bexley.testnet` | Owner. Receives the 20% of fees not paid to the Stability Pool. |
| `pool.bexley.testnet` | The pool. Also the bxUSD token. |
| `xnear.bexley.testnet` | xNEAR token. |
| `tnear.bexley.testnet` | tNEAR, the test collateral. |
| `guardian.bexley.testnet` | The AI Pool Guardian and price feeder. Limited key only. |

Earlier designs are kept in the repo but no longer deployed: a test USDC token, and a one-to-one deals contract (`contracts/bexley-deals-v1`) whose matching agent was `agent.bexley.testnet`.

## Roadmap

- **Staked NEAR as collateral (mainnet).** Back the pool with liquid-staked NEAR instead of plain NEAR, so bxUSD savers also earn NEAR's staking yield on top of the savings rate and fees.
- **Deposits from any chain** through NEAR Intents: mint bxUSD or xNEAR with USDC, ETH or SOL from other chains.
- **More pools**: leveraged ETH, BTC and other assets brought to NEAR through NEAR Intents, each with its own stablecoin backing.
- **Decentralized price feed.** Pyth has left NEAR. On mainnet, switch to RHEA's multi-reporter `priceoracle.near` (or a TEE-attested price agent) and keep the safety rails.
- **Security audit** before any real funds.

## Use it from the command line

Deposits use `ft_transfer_call` on the token with a JSON message:

```bash
# Mint xNEAR with 10 tNEAR
near call tnear.bexley.testnet ft_transfer_call \
  '{"receiver_id":"pool.bexley.testnet","amount":"10000000000000000000000000","msg":"{\"type\":\"mint_x\"}"}' \
  --accountId YOU.testnet --depositYocto 1 --gas 150000000000000
```

Messages: `mint_bx`, `mint_x`, `vault_deposit` (with `vault`: 0 or 1) for tNEAR; `redeem_x` and `order` (with `stop_price` and/or `take_price` in micro-dollars) for xNEAR.

Other calls: `redeem_bx`, `sp_deposit`, `sp_withdraw`, `vault_withdraw`, `cancel_order` (each needs 1 yoctoNEAR attached). Views: `get_pool`, `get_vaults`, `get_account`, `get_notes`, `get_savings_rate`, `quote`. Anyone can call `accrue_interest` to bring the savings interest up to date.

## Run the tests

```bash
cargo test --workspace          # contracts
cd agent && npm test             # Guardian decisions
cd app && npm test               # app: formatting, risk math, Ask Bexley plan checks, AI proof checks
node scripts/smoke.mjs           # live check of the real site and chain (after cd scripts && npm ci)
```

## Deploy

GitHub Actions → **Deploy to NEAR testnet** → Run workflow. It needs the owner's key in the `NEAR_PRIVATE_KEY` repository secret.

## Built with

- **Contracts:** Rust, [near-sdk](https://github.com/near/near-sdk-rs) and near-contract-standards (NEP-141 tokens), [uint](https://crates.io/crates/uint).
- **App:** React, Vite, [near-api-js](https://github.com/near/near-api-js), [@hot-labs/near-connect](https://github.com/hot-dao/near-connect) for wallets, hosted on Vercel.
- **AI Guardian:** Node.js, [NEAR AI Cloud](https://cloud.near.ai) for private, provable inference, and [@noble/curves](https://github.com/paulmillr/noble-curves) and [@noble/hashes](https://github.com/paulmillr/noble-hashes) to check the proofs. Runs on GitHub Actions.
- **Cross-chain:** the [NEAR Intents 1Click API](https://docs.near-intents.org/).
- **AI coding tools:** most of the code was written with Claude (Anthropic) as a coding assistant, directed and reviewed by the team.

## Hackathon notes

- All code in this repository was written during the hackathon. The first commit is from 2 Nov 2026; there is no earlier baseline.
- This is one project. The team has no other submission.
- Bexley runs on NEAR testnet. NEAR Intents has no testnet, so the app shows live mainnet quotes for cross-chain deposits.

## License

[Business Source License 1.1](LICENSE). You can read, run and test Bexley on testnet, and use it for review, research and learning. Running it as a production service needs a license from the author. On 7 Nov 2030 the code moves to GPL v2.0 or later.
