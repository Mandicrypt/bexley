import { useCallback, useEffect, useState } from 'react';
import {
  EXPLORER, GUARDIAN_ID, POOL_ID, XNEAR_ID, TNEAR_ID, connect, disconnect, currentAccount, getConnector, loadPool, loadAccount,
  quote, claimTnear, mintBx, mintX, redeemBx, redeemX, spDeposit, spWithdraw, vaultDeposit, vaultWithdraw, placeOrder,
  cancelOrder, claimStuck, errorText,
} from './lib/near.js';
import {
  parseAmount, formatAmount, formatUsd, usdValue, formatTimes, formatBacking, timeAgo, timeLeft, shortAccount, parseUsdPrice,
} from './lib/format.mjs';

const REFRESH_MS = 15_000;
const SLIPPAGE_BPS = 100n; // accept up to 1% less than quoted

const money = (units, places = 2) => `$${formatAmount(units ?? 0, places)}`;
const withSlippage = (v) => (v ? (BigInt(v) * (10_000n - SLIPPAGE_BPS)) / 10_000n : null);

export default function App() {
  const [pool, setPool] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('mint');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setPool(await loadPool());
      setLoadError('');
    } catch {
      setLoadError('Could not reach NEAR testnet. Retrying…');
    }
    if (accountId) {
      try {
        setMe(await loadAccount(accountId));
      } catch {
        /* keep the last good data */
      }
    } else setMe(null);
  }, [accountId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const c = getConnector();
    currentAccount().then(setAccountId);
    const onIn = (e) => setAccountId(e?.accounts?.[0]?.accountId || null);
    const onOut = () => setAccountId(null);
    c.on('wallet:signIn', onIn);
    c.on('wallet:signOut', onOut);
    return () => {
      c.off('wallet:signIn', onIn);
      c.off('wallet:signOut', onOut);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(
    async (key, fn, success) => {
      setBusy(key);
      try {
        await fn();
        setToast({ text: success });
      } catch (e) {
        setToast({ text: errorText(e), bad: true });
      } finally {
        setBusy('');
        refresh();
      }
    },
    [refresh],
  );

  const onConnect = () => connect().catch((e) => setToast({ text: errorText(e), bad: true }));
  const onDisconnect = () => disconnect().then(() => setAccountId(null));
  const ctx = { pool, me, accountId, onConnect, run, busy };
  const stuck = me && (BigInt(me.claim_tnear) > 0n || BigInt(me.claim_xnear) > 0n);
  const latest = pool?.notes?.[0];

  return (
    <>
      <Header {...ctx} onDisconnect={onDisconnect} />
      <main className="wrap">
        {!accountId && <Hero onConnect={onConnect} />}
        <Stats pool={pool} error={loadError} />
        {latest && (
          <button className="latest" onClick={() => setTab('guardian')}>
            <span className="tag ink">Guardian</span>
            <span className="latest-text">{latest.text}</span>
            <span className="hint">{timeAgo(latest.at)}</span>
          </button>
        )}
        {stuck && (
          <div className="note warn banner">
            A transfer to your wallet didn't go through, so Bexley is holding it for you.
            <button className="btn small" disabled={busy === 'stuck'} onClick={() => run('stuck', claimStuck, 'Sent again.')}>
              Send it again
            </button>
          </div>
        )}
        <nav className="tabs" role="tablist" aria-label="Bexley sections">
          {[
            ['mint', 'Mint'],
            ['redeem', 'Redeem'],
            ['earn', 'Earn'],
            ['vaults', 'Vaults'],
            ['orders', 'Orders'],
            ['guardian', 'Guardian'],
          ].map(([id, label]) => (
            <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        {tab === 'mint' && <Mint {...ctx} />}
        {tab === 'redeem' && <Redeem {...ctx} />}
        {tab === 'earn' && <Earn {...ctx} />}
        {tab === 'vaults' && <Vaults {...ctx} />}
        {tab === 'orders' && <Orders {...ctx} />}
        {tab === 'guardian' && <Guardian pool={pool} />}
      </main>
      <footer>
        <div className="wrap">
          Bexley runs on NEAR testnet with tNEAR, a free test token with no real value. Pool:{' '}
          <a href={`${EXPLORER}/address/${POOL_ID}`} target="_blank" rel="noreferrer">{POOL_ID}</a>. Built for the NEAR Hackathon.
        </div>
      </footer>
      {toast && (
        <div className={`toast${toast.bad ? ' bad' : ''}`} role="status">
          {toast.text}
        </div>
      )}
    </>
  );
}

// ---------- Shared pieces ----------

function Logo({ size = 28 }) {
  return (
    <svg width={size * 0.8} height={size} viewBox="36 16 132 164" aria-hidden="true">
      <path d="M40,40 L76,20 L76,124 L130,100 L130,140 L84,166 C62,178 40,170 40,146 Z" fill="#111111" />
      <path d="M76,58 L116,58 C143,58 166,80 166,106 L166,155 L130,176 L130,106 C130,99 124,94 117,94 L76,94 Z" fill="#12C47A" />
    </svg>
  );
}

function Header({ accountId, me, onConnect, onDisconnect, run, busy }) {
  const canClaim = me && BigInt(me.nextClaimAt || 0) === 0n;
  return (
    <header className="top">
      <div className="wrap">
        <div className="brand">
          <Logo />
          bexley
        </div>
        <span className="pill">Testnet</span>
        <div className="spacer" />
        {accountId ? (
          <div className="who">
            <span className="bal">
              <b className="num">{me ? formatAmount(me.tnear) : '…'}</b> tNEAR · <b className="num">{me ? formatAmount(me.bx) : '…'}</b> bxUSD ·{' '}
              <b className="num">{me ? formatAmount(me.xnear) : '…'}</b> xNEAR
            </span>
            <button
              className="btn green small"
              disabled={(me && !canClaim) || busy === 'claim'}
              onClick={() => run('claim', claimTnear, '100 tNEAR added to your wallet.')}
            >
              {busy === 'claim' ? 'Claiming…' : !me || canClaim ? 'Get 100 tNEAR' : `Next claim in ${timeLeft(me.nextClaimAt)}`}
            </button>
            <button className="btn ghost small" onClick={onDisconnect} title="Disconnect wallet">
              {shortAccount(accountId)}
            </button>
          </div>
        ) : (
          <button className="btn" onClick={onConnect}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}

function Hero({ onConnect }) {
  return (
    <section className="hero">
      <div>
        <h1>
          One pool of NEAR. <em>Two ways to hold it.</em>
        </h1>
        <p>
          Bexley splits NEAR into bxUSD, a stablecoin worth $1, and xNEAR, leveraged NEAR that takes the swings. An AI Guardian runs the
          pool's safety work around the clock and explains every move.
        </p>
        <button className="btn green" onClick={onConnect}>
          Connect a testnet wallet
        </button>
      </div>
      <div className="sides">
        <div className="side">
          <b>bxUSD</b>
          <span className="hint">Stays at $1. Put it in the Stability Pool to earn 80% of the pool's fees.</span>
        </div>
        <div className="side">
          <b>xNEAR</b>
          <span className="hint">Leveraged NEAR with no liquidations. Or pick a Steady 2x or 3x vault and let it hold its leverage.</span>
        </div>
        <div className="side">
          <b>AI Pool Guardian</b>
          <span className="hint">Posts prices, tunes fees to the market, protects bxUSD and runs your stop-losses. Its key can't move funds.</span>
        </div>
      </div>
    </section>
  );
}

const MODE_TEXT = {
  Healthy: 'Healthy',
  Caution: 'Caution',
  Stabilize: 'Protecting bxUSD',
};

function Stats({ pool, error }) {
  const s = pool?.state;
  const noX = s && BigInt(s.x_supply) === 0n;
  return (
    <section className="stats" aria-label="Pool numbers">
      <div className="stat">
        <div className="k">NEAR price</div>
        <div className="v num">{s && BigInt(s.price) > 0n ? formatUsd(s.price, 3) : '—'}</div>
        <div className="s">
          <span className={`dot${s?.price_fresh && !error ? '' : ' off'}`} />
          {error || (s?.price_fresh ? 'Live, from the Guardian' : 'Waiting for a fresh price')}
        </div>
      </div>
      <div className="stat">
        <div className="k">xNEAR</div>
        <div className="v num">{s ? formatUsd(s.x_price, 4) : '—'}</div>
        <div className="s">{s ? (noX ? 'Be the first to mint' : `${formatTimes(s.leverage_bps)} leverage`) : ' '}</div>
      </div>
      <div className="stat">
        <div className="k">Backing</div>
        <div className="v num">{s ? formatBacking(s.cr_bps) : '—'}</div>
        <div className="s">{s ? <span className={`mode ${s.mode}`}>{MODE_TEXT[s.mode]}</span> : ' '}</div>
      </div>
      <div className="stat">
        <div className="k">Pool value</div>
        <div className="v num">{s ? money(s.tvl, 0) : '—'}</div>
        <div className="s">{s ? `${money(s.bx_supply, 0)} in bxUSD` : ' '}</div>
      </div>
    </section>
  );
}

function ConnectFirst({ onConnect, what }) {
  return (
    <button className="btn wide" onClick={onConnect}>
      Connect wallet to {what}
    </button>
  );
}

function Seg({ value, onChange, options }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className="segbtn" onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function AmountInput({ id, value, onChange, max, unit }) {
  return (
    <div className="inputrow">
      <input id={id} inputMode="decimal" placeholder="0.0" value={value} onChange={(e) => onChange(e.target.value)} />
      {max != null && BigInt(max) > 0n && (
        <button type="button" className="max" onClick={() => onChange(formatAmount(max, 6).replace(/,/g, ''))}>
          MAX
        </button>
      )}
      <span className="unit">{unit}</span>
    </div>
  );
}

/** Live quote from the pool, refreshed as the amount changes. */
function useQuote(action, amount, pool) {
  const [q, setQ] = useState(null);
  const key = `${action}:${amount ?? ''}:${pool?.state?.price}:${pool?.state?.fee_level}`;
  useEffect(() => {
    if (!amount) return setQ(null);
    let live = true;
    const t = setTimeout(() => {
      quote(action, amount)
        .then((v) => live && setQ(BigInt(v)))
        .catch(() => live && setQ(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return q;
}

function feeLabel(bps) {
  return bps === 0 ? 'Free right now' : `${(bps / 100).toFixed(2)}%`;
}

function Rows({ children }) {
  return <div className="rows">{children}</div>;
}
function Row({ k, v, big }) {
  return (
    <div className={`row${big ? ' big' : ''}`}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

// ---------- Mint ----------

function Mint({ pool, me, accountId, onConnect, run, busy }) {
  const [which, setWhich] = useState('x');
  const [text, setText] = useState('10');
  const s = pool?.state;
  const amount = parseAmount(text);
  const action = which === 'x' ? 'mint_x' : 'mint_bx';
  const q = useQuote(action, amount, pool);
  const fee = s ? (which === 'x' ? s.fees_bps.mint_x : s.fees_bps.mint_bx) : 0;
  const paused = which === 'bx' && s && !s.fees_bps.mint_bx_open;
  const noX = s && BigInt(s.x_supply) === 0n;

  let problem = '';
  if (!amount) problem = 'Enter an amount.';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > BigInt(me.tnear)) problem = 'That is more tNEAR than your wallet holds. Use "Get 100 tNEAR" at the top.';
  else if (paused) problem = 'New bxUSD is paused while the pool rebuilds its backing.';
  else if (which === 'bx' && noX) problem = 'bxUSD needs xNEAR behind it first. Mint some xNEAR to start the pool.';
  else if (s && !s.price_fresh) problem = 'Waiting for a fresh price from the Guardian.';

  const unit = which === 'x' ? 'xNEAR' : 'bxUSD';
  const outUsd = q != null ? (which === 'x' ? (q * BigInt(s.x_price)) / 1_000_000n : q) : null;

  return (
    <div className="grid2">
      <section className="card">
        <h2>Mint</h2>
        <p className="lead">Turn tNEAR into the side you want.</p>
        <div className="field">
          <Seg value={which} onChange={setWhich} options={[['x', 'xNEAR · leverage'], ['bx', 'bxUSD · stable']]} />
        </div>
        <div className="field">
          <label htmlFor="mint-amount">You pay</label>
          <AmountInput id="mint-amount" value={text} onChange={setText} max={me?.tnear} unit="tNEAR" />
        </div>
        {problem && text !== '' ? <p className="err">{problem}</p> : null}
        {accountId ? (
          <button
            className="btn green wide"
            disabled={!!problem || q == null || busy === 'mint'}
            onClick={() =>
              run('mint', () => (which === 'x' ? mintX(amount, withSlippage(q)) : mintBx(amount, withSlippage(q))), `Minted ${formatAmount(q, 4)} ${unit}.`)
            }
          >
            {busy === 'mint' ? 'Confirm in your wallet…' : `Mint ${unit}`}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="mint" />
        )}
      </section>
      <aside className="card soft">
        <h3>You get</h3>
        <Rows>
          <Row big k={unit} v={q != null ? formatAmount(q, 4) : '—'} />
          <Row k="Worth" v={outUsd != null ? money(outUsd) : '—'} />
          <Row k="Fee" v={s ? feeLabel(fee) : '—'} />
          {which === 'x' && <Row k="Leverage now" v={s ? formatTimes(s.leverage_bps) : '—'} />}
        </Rows>
        <p className="note" style={{ marginTop: 16 }}>
          {which === 'x'
            ? 'xNEAR owns everything the pool holds above the bxUSD it owes. When NEAR rises, xNEAR rises faster; when NEAR falls, it falls faster. There are no liquidations.'
            : 'bxUSD is always redeemable for $1 of tNEAR. xNEAR holders absorb the price swings, and the Stability Pool steps in if backing falls under 130%.'}
        </p>
      </aside>
    </div>
  );
}

// ---------- Redeem ----------

function Redeem({ pool, me, accountId, onConnect, run, busy }) {
  const [which, setWhich] = useState('x');
  const [text, setText] = useState('');
  const s = pool?.state;
  const amount = parseAmount(text);
  const action = which === 'x' ? 'redeem_x' : 'redeem_bx';
  const q = useQuote(action, amount, pool);
  const fee = s ? (which === 'x' ? s.fees_bps.redeem_x : s.fees_bps.redeem_bx) : 0;
  const paused = which === 'x' && s && !s.fees_bps.redeem_x_open;
  const unit = which === 'x' ? 'xNEAR' : 'bxUSD';
  const have = me ? BigInt(which === 'x' ? me.xnear : me.bx) : 0n;

  let problem = '';
  if (!amount) problem = 'Enter an amount.';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > have) problem = `That is more ${unit} than you hold.`;
  else if (paused) problem = 'xNEAR exits are paused while the pool rebuilds its backing. Your xNEAR keeps its share; try again once backing is over 130%.';
  else if (s && !s.price_fresh) problem = 'Waiting for a fresh price from the Guardian.';

  return (
    <div className="grid2">
      <section className="card">
        <h2>Redeem</h2>
        <p className="lead">Turn bxUSD or xNEAR back into tNEAR at fair value.</p>
        <div className="field">
          <Seg value={which} onChange={setWhich} options={[['x', 'xNEAR'], ['bx', 'bxUSD']]} />
        </div>
        <div className="field">
          <label htmlFor="redeem-amount">You redeem</label>
          <AmountInput id="redeem-amount" value={text} onChange={setText} max={have} unit={unit} />
        </div>
        {problem && text !== '' ? <p className="err">{problem}</p> : null}
        {accountId ? (
          <button
            className="btn wide"
            disabled={!!problem || q == null || q === 0n || busy === 'redeem'}
            onClick={() =>
              run('redeem', () => (which === 'x' ? redeemX(amount, withSlippage(q)) : redeemBx(amount, withSlippage(q))), `Redeemed for ${formatAmount(q, 4)} tNEAR.`)
            }
          >
            {busy === 'redeem' ? 'Confirm in your wallet…' : `Redeem ${unit}`}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="redeem" />
        )}
      </section>
      <aside className="card soft">
        <h3>You get</h3>
        <Rows>
          <Row big k="tNEAR" v={q != null ? formatAmount(q, 4) : '—'} />
          <Row k="Worth" v={q != null && s ? money(usdValue(q, s.price)) : '—'} />
          <Row k="Fee" v={s ? (paused ? 'Paused' : feeLabel(fee)) : '—'} />
          <Row k={`Your ${unit}`} v={me ? formatAmount(have, 4) : '—'} />
        </Rows>
      </aside>
    </div>
  );
}

// ---------- Earn ----------

function Earn({ pool, me, accountId, onConnect, run, busy }) {
  const [text, setText] = useState('');
  const s = pool?.state;
  const sp = s?.stability_pool;
  const pos = me?.stability_pool;
  const amount = parseAmount(text);

  let problem = '';
  if (!amount) problem = 'Enter an amount.';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > BigInt(me.bx)) problem = 'That is more bxUSD than you hold. Mint some first.';

  const hasPos = pos && BigInt(pos.shares) > 0n;
  return (
    <div className="grid2">
      <section className="card">
        <h2>Stability Pool</h2>
        <p className="lead">
          Deposit bxUSD to earn 80% of every fee the pool charges. If backing ever falls under 130%, part of your bxUSD is converted
          into xNEAR at fair value to protect the pool, and you keep that xNEAR.
        </p>
        <div className="field">
          <label htmlFor="sp-amount">Deposit</label>
          <AmountInput id="sp-amount" value={text} onChange={setText} max={me?.bx} unit="bxUSD" />
        </div>
        {problem && text !== '' ? <p className="err">{problem}</p> : null}
        {accountId ? (
          <button className="btn green wide" disabled={!!problem || busy === 'sp'} onClick={() => run('sp', () => spDeposit(amount), 'Deposited. You are now earning fees.')}>
            {busy === 'sp' ? 'Confirm in your wallet…' : 'Deposit bxUSD'}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="earn" />
        )}
      </section>
      <aside className="card soft">
        <h3>Pool</h3>
        <Rows>
          <Row k="Total in the pool" v={sp ? money(sp.value) : '—'} />
          <Row k="Held as bxUSD" v={sp ? formatAmount(sp.bx) : '—'} />
          <Row k="Held as xNEAR" v={sp ? formatAmount(sp.x) : '—'} />
          <Row k="Fees paid so far" v={s ? money(s.stats.fees_usd) : '—'} />
        </Rows>
        <h3 style={{ marginTop: 20 }}>Your share</h3>
        <Rows>
          <Row big k="Value" v={hasPos ? money(pos.value) : '—'} />
          <Row k="bxUSD" v={hasPos ? formatAmount(pos.bx, 4) : '—'} />
          <Row k="xNEAR" v={hasPos ? formatAmount(pos.x, 4) : '—'} />
        </Rows>
        {hasPos && (
          <button className="btn ghost wide" style={{ marginTop: 16 }} disabled={busy === 'spw'} onClick={() => run('spw', spWithdraw, 'Withdrawn to your wallet.')}>
            {busy === 'spw' ? 'Confirm in your wallet…' : 'Withdraw all'}
          </button>
        )}
      </aside>
    </div>
  );
}

// ---------- Vaults ----------

function Vaults({ pool, me, accountId, onConnect, run, busy }) {
  if (!pool) return <p className="empty">Loading vaults…</p>;
  return (
    <div>
      <p className="lead">
        xNEAR's leverage floats as the pool changes. A Steady vault holds a mix of tNEAR and xNEAR and rebalances to keep one fixed
        leverage. The Guardian rebalances when a vault drifts more than 3%.
      </p>
      <div className="grid2 even">
        {pool.vaults.map((v) => (
          <VaultCard key={v.id} v={v} pool={pool} me={me} accountId={accountId} onConnect={onConnect} run={run} busy={busy} />
        ))}
      </div>
    </div>
  );
}

function VaultCard({ v, pool, me, accountId, onConnect, run, busy }) {
  const [text, setText] = useState('');
  const amount = parseAmount(text);
  const s = pool.state;
  const pos = me?.vaults?.find((p) => p.vault === v.id);
  const hasPos = pos && BigInt(pos.shares) > 0n;
  const capped = BigInt(v.value) > 0n && BigInt(v.t) === 0n;

  let problem = '';
  if (!amount) problem = 'Enter an amount.';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > BigInt(me.tnear)) problem = 'That is more tNEAR than your wallet holds.';
  else if (BigInt(s.x_supply) === 0n) problem = 'The pool needs some xNEAR first.';

  return (
    <section className="card">
      <div className="sectionhead">
        <h2>{v.name}</h2>
        <span className={`tag ${v.needs_rebalance ? 'red' : 'green'}`}>{v.needs_rebalance ? 'Rebalance due' : 'On target'}</span>
      </div>
      <Rows>
        <Row k="Leverage now" v={BigInt(v.value) > 0n ? formatTimes(v.leverage_bps) : formatTimes(v.target_bps)} />
        <Row k="Vault size" v={`${formatAmount(v.value)} tNEAR`} />
        <Row k="Your share" v={hasPos ? `${formatAmount(pos.value, 4)} tNEAR · ${money(usdValue(pos.value, s.price))}` : '—'} />
      </Rows>
      {capped && <p className="hint">xNEAR alone is under {formatTimes(v.target_bps)} right now, so this vault holds only xNEAR.</p>}
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor={`v${v.id}`}>Deposit</label>
        <AmountInput id={`v${v.id}`} value={text} onChange={setText} max={me?.tnear} unit="tNEAR" />
      </div>
      {problem && text !== '' ? <p className="err">{problem}</p> : null}
      <div className="btnrow">
        {accountId ? (
          <button className="btn green" disabled={!!problem || busy === `vd${v.id}`} onClick={() => run(`vd${v.id}`, () => vaultDeposit(v.id, amount), `Deposited into ${v.name}.`)}>
            {busy === `vd${v.id}` ? 'Confirm…' : 'Deposit'}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="deposit" />
        )}
        {hasPos && (
          <button className="btn ghost" disabled={busy === `vw${v.id}`} onClick={() => run(`vw${v.id}`, () => vaultWithdraw(v.id), 'Withdrawn to your wallet.')}>
            {busy === `vw${v.id}` ? 'Confirm…' : 'Withdraw all'}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- Orders ----------

function Orders({ pool, me, accountId, onConnect, run, busy }) {
  const [text, setText] = useState('');
  const [stopText, setStopText] = useState('');
  const [takeText, setTakeText] = useState('');
  const s = pool?.state;
  const amount = parseAmount(text);
  const stop = stopText ? parseUsdPrice(stopText) : null;
  const take = takeText ? parseUsdPrice(takeText) : null;
  const price = s ? BigInt(s.price) : 0n;

  let problem = '';
  if (!amount) problem = 'Enter how much xNEAR to protect.';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > BigInt(me.xnear)) problem = 'That is more xNEAR than you hold.';
  else if (!stop && !take) problem = 'Set a stop price, a take price, or both.';
  else if ((stopText && !stop) || (takeText && !take)) problem = 'Prices must be numbers in dollars, like 3.50.';
  else if (stop && take && stop >= take) problem = 'The stop price must be below the take price.';
  else if (stop && price && stop >= price) problem = 'The stop price must be below the current NEAR price.';
  else if (take && price && take <= price) problem = 'The take price must be above the current NEAR price.';

  const orders = [...(me?.orders || [])].sort((a, b) => b.id - a.id);
  return (
    <div className="grid2">
      <section className="card">
        <h2>Stop-loss and take-profit</h2>
        <p className="lead">Park xNEAR with a NEAR price to sell at. When NEAR reaches it, the Guardian sells and sends tNEAR to your wallet. The contract checks the price, so nobody can sell early.</p>
        <div className="field">
          <label htmlFor="o-amount">xNEAR to protect</label>
          <AmountInput id="o-amount" value={text} onChange={setText} max={me?.xnear} unit="xNEAR" />
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="o-stop">Sell if NEAR falls to</label>
            <div className="inputrow">
              <span className="unit">$</span>
              <input id="o-stop" inputMode="decimal" placeholder="optional" value={stopText} onChange={(e) => setStopText(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="o-take">Sell if NEAR rises to</label>
            <div className="inputrow">
              <span className="unit">$</span>
              <input id="o-take" inputMode="decimal" placeholder="optional" value={takeText} onChange={(e) => setTakeText(e.target.value)} />
            </div>
          </div>
        </div>
        <p className="hint">NEAR is {s ? formatUsd(s.price, 3) : '—'} now.</p>
        {problem && text !== '' ? <p className="err">{problem}</p> : null}
        {accountId ? (
          <button className="btn wide" disabled={!!problem || busy === 'order'} onClick={() => run('order', () => placeOrder(amount, stop, take), 'Order placed. The Guardian is watching it.')}>
            {busy === 'order' ? 'Confirm in your wallet…' : 'Place order'}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="place orders" />
        )}
      </section>
      <aside>
        <h3>Your orders</h3>
        {!accountId ? (
          <p className="empty">Connect your wallet to see your orders.</p>
        ) : orders.length === 0 ? (
          <p className="empty">No orders yet.</p>
        ) : (
          <div className="list">
            {orders.map((o) => (
              <div className="item" key={o.id}>
                <div>
                  <div className="title">
                    <span className={`tag ${o.status === 'Open' ? 'green' : o.status === 'Executed' ? 'ink' : ''}`}>{o.status}</span>
                    {formatAmount(o.x_amount, 4)} xNEAR
                  </div>
                  <div className="meta">
                    {o.stop_price ? `Stop ${formatUsd(o.stop_price, 3)}` : ''}
                    {o.stop_price && o.take_price ? ' · ' : ''}
                    {o.take_price ? `Take ${formatUsd(o.take_price, 3)}` : ''}
                    {o.status === 'Executed' && ` · sold at ${formatUsd(o.executed_price, 3)} for ${formatAmount(o.tnear_out, 4)} tNEAR`}
                  </div>
                </div>
                {o.status === 'Open' && (
                  <div className="actions">
                    <button className="btn ghost small" disabled={busy === `oc${o.id}`} onClick={() => run(`oc${o.id}`, () => cancelOrder(o.id), 'Cancelled. Your xNEAR is back.')}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------- Guardian ----------

const KIND_LABEL = { watch: 'Pool check', fees: 'Fees', protect: 'Protection', rebalance: 'Rebalance', order: 'Order', price: 'Price' };

function Guardian({ pool }) {
  if (!pool) return <p className="empty">Loading the Guardian's notes…</p>;
  const s = pool.state;
  return (
    <div className="grid2">
      <section>
        <div className="sectionhead">
          <h2>What the Guardian did</h2>
          <span className="hint">Written on-chain, newest first</span>
        </div>
        {pool.notes.length === 0 ? (
          <p className="empty">No notes yet. The Guardian runs every 15 minutes.</p>
        ) : (
          <ol className="notes">
            {pool.notes.map((n) => (
              <li key={n.id}>
                <div className="notehead">
                  <span className={`tag ${n.kind === 'protect' ? 'red' : n.kind === 'watch' ? '' : 'green'}`}>{KIND_LABEL[n.kind] || n.kind}</span>
                  <span className="hint">{timeAgo(n.at)}</span>
                </div>
                <p>{n.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
      <aside className="card soft">
        <h3>How it works</h3>
        <p className="hint">Every 15 minutes the Guardian reads NEAR's price from three sources, then:</p>
        <ul className="plain">
          <li>posts the price on-chain</li>
          <li>sets fees from the 24-hour move: normal under 5%, 2x at 5–10%, 3x above 10%</li>
          <li>protects bxUSD if backing falls under 130%</li>
          <li>rebalances Steady vaults that drifted</li>
          <li>runs stop-loss and take-profit orders</li>
        </ul>
        <Rows>
          <Row k="Fee level now" v={['Calm (1x)', 'Volatile (2x)', 'Stormy (3x)'][s.fee_level]} />
          <Row k="Protections run" v={s.stats.stabilizations} />
          <Row k="Rebalances" v={s.stats.rebalances} />
          <Row k="Orders run" v={s.stats.orders_executed} />
        </Rows>
        <p className="note" style={{ marginTop: 16 }}>
          It can't move anyone's money. Its account,{' '}
          <a href={`${EXPLORER}/address/${GUARDIAN_ID}`} target="_blank" rel="noreferrer">{GUARDIAN_ID}</a>, only has a key for those six jobs, and the pool
          contract checks every rule itself.
        </p>
        <p className="hint" style={{ marginTop: 12 }}>
          Tokens: <a href={`${EXPLORER}/address/${XNEAR_ID}`} target="_blank" rel="noreferrer">xNEAR</a> ·{' '}
          <a href={`${EXPLORER}/address/${POOL_ID}`} target="_blank" rel="noreferrer">bxUSD</a> ·{' '}
          <a href={`${EXPLORER}/address/${TNEAR_ID}`} target="_blank" rel="noreferrer">tNEAR</a>
        </p>
      </aside>
    </div>
  );
}
