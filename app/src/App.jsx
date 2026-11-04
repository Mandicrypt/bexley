import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EXPLORER, GUARDIAN_ID, POOL_ID, XNEAR_ID, TNEAR_ID, connect, disconnect, currentAccount, getConnector, loadPool, loadAccount,
  quote, claimTnear, mintBx, mintX, redeemBx, redeemX, spDeposit, spWithdraw, vaultDeposit, vaultWithdraw, placeOrder,
  cancelOrder, claimStuck, errorText,
} from './lib/near.js';
import {
  parseAmount, formatAmount, formatUsd, usdValue, formatTimes, formatBacking, timeAgo, timeLeft, shortAccount, parseUsdPrice,
} from './lib/format.mjs';
import { poolNumbers, scenario, leverage, xPriceAt, dailyVolatility, suggestStop, riskWord } from './lib/risk.mjs';
import { ACTIONS } from './lib/intent.mjs';

const REFRESH_MS = 15_000;
const SLIPPAGE_BPS = 100n; // accept up to 1% less than quoted
const PAGES = [
  ['trade', 'Trade'],
  ['earn', 'Earn'],
  ['vaults', 'Vaults'],
  ['orders', 'Orders'],
  ['guardian', 'Guardian'],
];

const money = (units, places = 2) => `$${formatAmount(units ?? 0, places)}`;
const withSlippage = (v) => (v ? (BigInt(v) * (10_000n - SLIPPAGE_BPS)) / 10_000n : null);
const toNum = (units) => Number(BigInt(units ?? 0) / 10n ** 18n) / 1e6; // 24-decimal units to a float
const pctRate = (bps) => `${(Number(bps) / 100).toFixed(0)}%`;

// ---------- Theme ----------

function readTheme() {
  try {
    return localStorage.getItem('bexley-theme') || 'system';
  } catch {
    return 'system';
  }
}

function useTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('bexley-theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  const isDark = () =>
    theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return [isDark, () => setTheme(isDark() ? 'light' : 'dark')];
}

// ---------- App ----------

function pageFromHash() {
  const h = location.hash.replace('#', '');
  return PAGES.some(([id]) => id === h) ? h : 'trade';
}

export default function App() {
  const [pool, setPool] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [me, setMe] = useState(null);
  const [page, setPage] = useState(pageFromHash);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);
  const [isDark, toggleTheme] = useTheme();

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
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const go = (id) => {
    location.hash = id === 'trade' ? '' : id;
    setPage(id);
    window.scrollTo({ top: 0 });
  };

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

  return (
    <>
      <Header
        page={page}
        go={go}
        accountId={accountId}
        me={me}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        run={run}
        busy={busy}
        isDark={isDark()}
        toggleTheme={toggleTheme}
      />
      <main className="wrap">
        {stuck && (
          <div className="note warn banner">
            A transfer to your wallet didn't go through, so Bexley is holding it for you.
            <button className="btn sm" disabled={busy === 'stuck'} onClick={() => run('stuck', claimStuck, 'Sent again.')}>
              Send it again
            </button>
          </div>
        )}
        {page === 'trade' && (
          <>
            {!accountId && <Hero onConnect={onConnect} />}
            <Split pool={pool} error={loadError} />
            <section className="page cols">
              <TradePanel {...ctx} />
              <GuardianFeed pool={pool} limit={3} onMore={() => go('guardian')} />
            </section>
            <AskBexley {...ctx} />
            <RiskCheck {...ctx} onOrders={() => go('orders')} />
          </>
        )}
        {page === 'earn' && <Earn {...ctx} />}
        {page === 'vaults' && <Vaults {...ctx} />}
        {page === 'orders' && <Orders {...ctx} />}
        {page === 'guardian' && <GuardianPage pool={pool} />}
      </main>
      <footer>
        <div className="wrap">
          <span>Bexley runs on NEAR testnet with tNEAR, a free test token with no value.</span>
          <span>
            <a href={`${EXPLORER}/address/${POOL_ID}`} target="_blank" rel="noreferrer">Pool contract</a>{'  '}
            <a href="https://github.com/Mandicrypt/bexley" target="_blank" rel="noreferrer" style={{ marginLeft: 14 }}>Code</a>
          </span>
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

// ---------- Header ----------

function Logo({ size = 26 }) {
  return (
    <svg width={size * 0.8} height={size} viewBox="36 16 132 164" aria-hidden="true">
      <path d="M40,40 L76,20 L76,124 L130,100 L130,140 L84,166 C62,178 40,170 40,146 Z" fill="currentColor" />
      <path d="M76,58 L116,58 C143,58 166,80 166,106 L166,155 L130,176 L130,106 C130,99 124,94 117,94 L76,94 Z" fill="var(--green)" />
    </svg>
  );
}

function ThemeIcon({ dark }) {
  return dark ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
    </svg>
  );
}

function Header({ page, go, accountId, me, onConnect, onDisconnect, run, busy, isDark, toggleTheme }) {
  const canClaim = !me || BigInt(me.nextClaimAt || 0) === 0n;
  const nav = (cls) =>
    PAGES.map(([id, label]) => (
      <button key={id} className="navbtn" aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}>
        {label}
      </button>
    ));
  return (
    <header className="top">
      <div className="wrap row">
        <a className="brand" href="#" onClick={(e) => (e.preventDefault(), go('trade'))}>
          <Logo />
          bexley
          <span className="net hide-sm">testnet</span>
        </a>
        <nav className="nav" aria-label="Sections">{nav()}</nav>
        <div className="spacer" />
        <div className="right">
          <button className="iconbtn" onClick={toggleTheme} aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
            <ThemeIcon dark={isDark} />
          </button>
          {accountId ? (
            <>
              <button
                className="btn go sm"
                disabled={!canClaim || busy === 'claim'}
                onClick={() => run('claim', claimTnear, '100 tNEAR added to your wallet.')}
                title={canClaim ? 'Free test tokens' : `Next claim in ${timeLeft(me.nextClaimAt)}`}
              >
                {busy === 'claim' ? 'Claiming…' : canClaim ? 'Get 100 tNEAR' : `Next in ${timeLeft(me.nextClaimAt)}`}
              </button>
              <button className="btn line sm" onClick={onDisconnect} title="Disconnect wallet">
                <span className="hide-sm">{me ? `${formatAmount(me.tnear, 0)} tNEAR  ` : ''}</span>
                {shortAccount(accountId)}
              </button>
            </>
          ) : (
            <button className="btn sm" onClick={onConnect}>
              Connect wallet
            </button>
          )}
        </div>
      </div>
      <div className="wrap">
        <nav className="mobnav" aria-label="Sections">{nav()}</nav>
      </div>
    </header>
  );
}

// ---------- Hero and the split ----------

function Hero({ onConnect }) {
  return (
    <section className="hero">
      <h1>Double the possibilities from one pool.</h1>
      <p>Hold bxUSD at $1 and earn, or ride NEAR with leverage in xNEAR. No liquidations, and an AI Guardian keeps the pool safe.</p>
      <div className="cta">
        <button className="btn go" onClick={onConnect}>
          Connect a testnet wallet
        </button>
        <a className="btn quiet" href="#how" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
          See how it splits
        </a>
      </div>
    </section>
  );
}

const MODE_NOTE = {
  Healthy: 'Healthy',
  Caution: 'Caution: fees favor rebuilding backing',
  Stabilize: 'Protecting bxUSD',
};

function modeAt(cr) {
  if (!Number.isFinite(cr)) return 'Healthy';
  if (cr < 1.3) return 'Stabilize';
  if (cr < 1.5) return 'Caution';
  return 'Healthy';
}

/** The pool as a single bar: bxUSD's claim on the left, xNEAR's on the right. */
function Split({ pool, error }) {
  const [move, setMove] = useState(0);
  const [open, setOpen] = useState(false);
  const s = pool?.state;

  const m = useMemo(() => {
    if (!s) return null;
    const price = Number(s.price) / 1e6;
    const coll = toNum(s.collateral);
    const bx = toNum(s.bx_supply);
    const x = toNum(s.x_supply);
    const tvl0 = coll * price;
    const nav0 = x > 0 && tvl0 > bx ? (tvl0 - bx) / x : 1;
    const p1 = price * (1 + move / 100);
    const tvl = coll * p1;
    const nav = x > 0 ? Math.max(0, (tvl - bx) / x) : 1;
    const cr = bx > 0 ? tvl / bx : Infinity;
    const lev = tvl > bx ? tvl / (tvl - bx) : Infinity;
    return { price, p1, tvl, bx, nav, nav0, cr, lev, empty: tvl0 === 0, xChange: nav0 > 0 ? nav / nav0 - 1 : 0 };
  }, [s, move]);

  const bxFrac = m && m.tvl > 0 ? Math.min(1, m.bx / m.tvl) : 0;
  const mode = m ? modeAt(m.cr) : 'Healthy';
  const fmt$ = (v) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const sign = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

  return (
    <section className="split" id="how" aria-label="The pool">
      <div className="split-head">
        <div>
          <h2>The split</h2>
          <div className="sub">
            {error ||
              (s ? (
                <>
                  NEAR {formatUsd(s.price, 3)}, posted by the Guardian {timeAgo(s.price_updated_at)}. Backing {formatBacking(s.cr_bps)},{' '}
                  {MODE_NOTE[s.mode].toLowerCase()}.
                </>
              ) : (
                'Loading the pool…'
              ))}
          </div>
        </div>
        <button className="linkbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide what-if' : 'What if NEAR moves?'}
        </button>
      </div>

        <div className="figs">
          <div className="fig stable">
            <div className="n">{m ? fmt$(m.bx) : '—'}</div>
            <div className="l">bxUSD, held at $1</div>
          </div>
          <div className="fig total">
            <div className="n">{m ? fmt$(m.tvl) : '—'}</div>
            <div className="l">Pool value{move ? ' (what if)' : ''}</div>
          </div>
          <div className="fig lev">
            <div className="n">{m ? `$${m.nav.toFixed(4)}` : '—'}</div>
            <div className="l">xNEAR at {m && Number.isFinite(m.lev) ? `${m.lev.toFixed(2)}x` : '—'}</div>
          </div>
        </div>

      <div className="bar" role="img" aria-label={m ? `bxUSD is ${(bxFrac * 100).toFixed(0)}% of the pool; xNEAR owns the rest.` : 'Pool loading'}>
        <div className="bar-track">
          <div className="seg-bx" style={{ width: `${bxFrac * 100}%` }}>
            {bxFrac > 0.12 && <span>bxUSD {(bxFrac * 100).toFixed(0)}%</span>}
          </div>
          <div className="seg-x">{m && !m.empty && <span>xNEAR {((1 - bxFrac) * 100).toFixed(0)}%</span>}</div>
        </div>
        <div className="tick first" style={{ left: `${(1 / 1.5) * 100}%` }}>
          <b><span className="long">Caution at </span>150%</b>
        </div>
        <div className="tick second" style={{ left: `${(1 / 1.3) * 100}%` }}>
          <b><span className="long">Protection at </span>130%</b>
        </div>
      </div>

      {open && (
      <div className="whatif">
        <div className="slider">
          <label htmlFor="whatif">
            What if NEAR moves {move === 0 ? '…' : sign(move / 100)}
            <span className="hint">Drag to see each side respond.</span>
          </label>
          <input id="whatif" type="range" min="-60" max="100" step="5" value={move} onChange={(e) => setMove(Number(e.target.value))} />
          <div className="scale">
            <span>-60%</span>
            <button className="linkbtn" onClick={() => setMove(0)} disabled={move === 0}>
              Reset
            </button>
            <span>+100%</span>
          </div>
        </div>
        <div className="outcome">
          <div className="o">
            <div className="n">{m ? fmt$(m.p1) : '—'}</div>
            <div className="l">NEAR</div>
          </div>
          <div className="o">
            <div className="n" style={{ color: 'var(--slate)' }}>$1.00</div>
            <div className="l">bxUSD</div>
          </div>
          <div className="o">
            <div className={`n ${m && m.xChange > 0 ? 'up' : m && m.xChange < 0 ? 'down' : ''}`}>{m ? sign(m.xChange) : '—'}</div>
            <div className="l">xNEAR</div>
          </div>
          <div className="o">
            <div className="n">{m && Number.isFinite(m.cr) ? `${(m.cr * 100).toFixed(0)}%` : '—'}</div>
            <div className="l">{mode === 'Healthy' ? 'Backing, healthy' : mode === 'Caution' ? 'Backing, caution' : 'Backing, protecting'}</div>
          </div>
        </div>
      </div>
      )}
    </section>
  );
}

// ---------- Shared bits ----------

function Fact({ k, v, big }) {
  return (
    <div className={`fact${big ? ' big' : ''}`}>
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

function ConnectFirst({ onConnect, what }) {
  return (
    <button className="btn wide" onClick={onConnect}>
      Connect wallet to {what}
    </button>
  );
}

function AmountRow({ id, value, onChange, max, unit }) {
  return (
    <div className="inputrow">
      <input id={id} inputMode="decimal" placeholder="0.0" value={value} onChange={(e) => onChange(e.target.value)} />
      {max != null && BigInt(max) > 0n && (
        <button type="button" className="linkbtn" onClick={() => onChange(formatAmount(max, 6).replace(/,/g, ''))}>
          Max
        </button>
      )}
      <span className="unit">{unit}</span>
    </div>
  );
}

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

const feeLabel = (bps) => (bps === 0 ? 'Free right now' : `${(bps / 100).toFixed(2)}%`);

// ---------- Trade ----------

const TOKENS = { t: ['tNEAR', 't'], x: ['xNEAR', 'x'], bx: ['bxUSD', 'bx'] };

function Token({ k }) {
  const [name, dot] = TOKENS[k];
  return (
    <span className="token">
      <i className={`dot ${dot}`} aria-hidden="true" />
      {name}
    </span>
  );
}

function TradePanel({ pool, me, accountId, onConnect, run, busy }) {
  const [side, setSide] = useState('x');
  const [dir, setDir] = useState('mint');
  const [text, setText] = useState('10');
  const s = pool?.state;
  const amount = parseAmount(text);
  const action = `${dir}_${side}`;
  const q = useQuote(action, amount, pool);

  const payK = dir === 'mint' ? 't' : side;
  const getK = dir === 'mint' ? side : 't';
  const bal = (k) => (me ? BigInt(k === 't' ? me.tnear : k === 'x' ? me.xnear : me.bx) : null);
  const have = bal(payK);
  const fee = s ? s.fees_bps[`${dir === 'mint' ? 'mint' : 'redeem'}_${side}`] : 0;
  const noX = s && BigInt(s.x_supply) === 0n;

  let problem = '';
  if (!amount) problem = '';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > have) problem = `That is more ${TOKENS[payK][0]} than you hold.${payK === 't' ? ' Use "Get 100 tNEAR" at the top.' : ''}`;
  else if (dir === 'mint' && side === 'bx' && s && !s.fees_bps.mint_bx_open) problem = 'New bxUSD is paused while the pool rebuilds its backing.';
  else if (dir === 'mint' && side === 'bx' && noX) problem = 'bxUSD needs xNEAR behind it. Mint some xNEAR first to start the pool.';
  else if (dir === 'redeem' && side === 'x' && s && !s.fees_bps.redeem_x_open) problem = 'xNEAR exits are paused until backing is back over 130%. Your xNEAR keeps its share.';
  else if (s && !s.price_fresh) problem = 'Waiting for a fresh price from the Guardian.';

  const getUsd = q == null || !s ? null : getK === 'x' ? (q * BigInt(s.x_price)) / 1_000_000n : getK === 'bx' ? q : usdValue(q, s.price);
  const verb = dir === 'mint' ? `Mint ${TOKENS[side][0]}` : `Redeem ${TOKENS[side][0]}`;

  const submit = () => {
    const min = withSlippage(q);
    const fn = { mint_x: () => mintX(amount, min), mint_bx: () => mintBx(amount, min), redeem_x: () => redeemX(amount, min), redeem_bx: () => redeemBx(amount, min) }[action];
    run('trade', fn, `${dir === 'mint' ? 'Minted' : 'Received'} ${formatAmount(q, 4)} ${TOKENS[getK][0]}.`);
  };

  return (
    <section className="panel" aria-label="Trade">
      <div className="sides" role="radiogroup" aria-label="Which side">
        <button className="side x" role="radio" aria-checked={side === 'x'} onClick={() => setSide('x')}>
          <b>xNEAR</b>
          <small>{s ? `${formatTimes(s.leverage_bps)} leverage, ${formatUsd(s.x_price, 4)}` : 'Leveraged NEAR'}</small>
        </button>
        <button className="side bx" role="radio" aria-checked={side === 'bx'} onClick={() => setSide('bx')}>
          <b>bxUSD</b>
          <small>{s ? `$1.00, savers earn ${pctRate(s.savings_rate_bps)}` : 'Stable at $1'}</small>
        </button>
      </div>

      <div className="box">
        <div className="top-row">
          <span>You pay</span>
          {have != null && (
            <button className="linkbtn" onClick={() => setText(formatAmount(have, 6).replace(/,/g, ''))}>
              Balance {formatAmount(have, 2)}
            </button>
          )}
        </div>
        <div className="main">
          <input aria-label="Amount to pay" inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value)} />
          <Token k={payK} />
        </div>
      </div>
      <div className="flip-wrap">
        <button className="flip" onClick={() => setDir(dir === 'mint' ? 'redeem' : 'mint')} aria-label={dir === 'mint' ? 'Switch to redeem' : 'Switch to mint'}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
          </svg>
        </button>
      </div>
      <div className="box">
        <div className="top-row">
          <span>You get</span>
          <span>{getUsd != null ? money(getUsd) : ''}</span>
        </div>
        <div className="main">
          <div className={`out${q == null ? ' empty' : ''}`}>{q != null ? formatAmount(q, 4) : '0'}</div>
          <Token k={getK} />
        </div>
      </div>

      <div className="facts">
        <Fact k="Fee" v={s ? (problem.includes('paused') ? 'Paused' : feeLabel(fee)) : '—'} />
        {side === 'x' && <Fact k="xNEAR leverage now" v={s ? formatTimes(s.leverage_bps) : '—'} />}
        <Fact k="You receive at least" v={q ? `${formatAmount(withSlippage(q), 4)} ${TOKENS[getK][0]}` : '—'} />
      </div>

      {problem && <p className="err">{problem}</p>}
      {accountId ? (
        <button className="btn go wide" disabled={!amount || !!problem || q == null || q === 0n || busy === 'trade'} onClick={submit}>
          {busy === 'trade' ? 'Confirm in your wallet…' : verb}
        </button>
      ) : (
        <ConnectFirst onConnect={onConnect} what="trade" />
      )}
    </section>
  );
}

// ---------- Guardian ----------

const KIND_LABEL = { watch: 'Pool check', fees: 'Fees', rate: 'Savings rate', protect: 'Protection', rebalance: 'Rebalance', order: 'Order', price: 'Price' };

function GuardianFeed({ pool, limit, onMore, more }) {
  const s = pool?.state;
  const [shown, setShown] = useState(limit);
  const all = pool?.notes ?? [];
  const notes = all.slice(0, shown);
  const live = s?.price_fresh;
  return (
    <section aria-label="Guardian">
      <div className="feed-head">
        <h3>Pool Guardian</h3>
        <span className="alive">
          <i className={`pulse${live ? '' : ' off'}`} aria-hidden="true" />
          {s ? (live ? `Active, last price ${timeAgo(s.price_updated_at)}` : 'Waiting for its next check') : 'Loading'}
        </span>
      </div>
      {notes.length === 0 ? (
        <p className="empty">No notes yet. The Guardian checks the pool every 5 minutes.</p>
      ) : (
        <ol className="feed">
          {notes.map((n) => (
            <li key={n.id} className={`k-${n.kind}`}>
              <div className="meta">
                <span className="k">{KIND_LABEL[n.kind] || n.kind}</span>
                <span>{timeAgo(n.at)}</span>
              </div>
              <p>{n.text}</p>
            </li>
          ))}
        </ol>
      )}
      {onMore && all.length > limit && (
        <button className="linkbtn" onClick={onMore}>
          View all
        </button>
      )}
      {more && all.length > shown && (
        <button className="btn quiet sm" onClick={() => setShown(shown + 6)}>
          View more
        </button>
      )}
      {more && shown > limit && all.length <= shown && all.length > limit && (
        <button className="btn quiet sm" onClick={() => setShown(limit)}>
          Show less
        </button>
      )}
    </section>
  );
}

function GuardianPage({ pool }) {
  const s = pool?.state;
  return (
    <section className="page">
      <div className="pagehead">
        <h2>The Pool Guardian</h2>
        <p>
          An agent that runs the pool's safety work every 5 minutes. An AI model on NEAR AI Cloud reads the market and the pool and
          sets the fees and the savers' rate, then explains why in the notes below. It works inside hard limits, and it can't move
          anyone's money: its account only holds a key for these jobs, and the pool checks every rule itself.
        </p>
      </div>
      <div className="cols">
        <div className="panel">
          <h3>What it does</h3>
          <div className="facts" style={{ marginTop: 0 }}>
            <Fact k="Posts the NEAR price" v="Median of 3 exchanges" />
            <Fact k="Fees, set by AI" v={s ? ['Normal, 1x', 'Volatile, 2x', 'Stormy, 3x'][s.fee_level] : '—'} />
            <Fact k="Savers' rate, set by AI" v={s ? `${pctRate(s.savings_rate_bps)} a year` : '—'} />
            <Fact k="Protections run" v={s ? s.stats.stabilizations : '—'} />
            <Fact k="Vault rebalances" v={s ? s.stats.rebalances : '—'} />
            <Fact k="Orders run" v={s ? s.stats.orders_executed : '—'} />
          </div>
          <p className="hint">
            Hard limits on every AI decision: fees 1x to 3x, rate 0% to 20%, at most 4 points of rate change at a time, and 0% whenever the
            pool isn't healthy. If the AI is unreachable, fixed rules take over.
          </p>
          <p className="hint" style={{ marginTop: 10 }}>
            Account: <a href={`${EXPLORER}/address/${GUARDIAN_ID}`} target="_blank" rel="noreferrer">{GUARDIAN_ID}</a>
          </p>
        </div>
        <GuardianFeed pool={pool} limit={6} more />
      </div>
    </section>
  );
}

// ---------- Earn ----------

function Earn({ pool, me, accountId, onConnect, run, busy }) {
  const [text, setText] = useState('');
  const s = pool?.state;
  const sp = s?.stability_pool;
  const pos = me?.stability_pool;
  const amount = parseAmount(text);
  const hasPos = pos && BigInt(pos.shares) > 0n;

  let problem = '';
  if (amount && accountId && !me) problem = 'Loading your wallet…';
  else if (amount && accountId && amount > BigInt(me.bx)) problem = 'That is more bxUSD than you hold. Mint some on Trade first.';

  return (
    <section className="page">
      <div className="pagehead">
        <h2>Earn on bxUSD</h2>
        <p>
          Put bxUSD in the Stability Pool. You earn a savings rate paid by xNEAR holders, plus 80% of every fee. If backing ever drops
          under 130%, part of your bxUSD turns into xNEAR at fair value to protect the pool, and that xNEAR is yours.
        </p>
      </div>
      <div className="cols">
        <div className="panel">
          <div className="facts" style={{ marginTop: 0 }}>
            <Fact big k="Savings rate" v={s ? `${pctRate(s.savings_rate_bps)} a year` : '—'} />
            <Fact k="Plus" v="80% of all fees" />
          </div>
          <div className="field">
            <label htmlFor="sp-amount">Deposit</label>
            <AmountRow id="sp-amount" value={text} onChange={setText} max={me?.bx} unit="bxUSD" />
          </div>
          {problem && <p className="err">{problem}</p>}
          {accountId ? (
            <button className="btn go wide" disabled={!amount || !!problem || busy === 'sp'} onClick={() => run('sp', () => spDeposit(amount), 'Deposited. You are now earning.')}>
              {busy === 'sp' ? 'Confirm in your wallet…' : 'Deposit bxUSD'}
            </button>
          ) : (
            <ConnectFirst onConnect={onConnect} what="earn" />
          )}
        </div>
        <div>
          <h3 style={{ fontSize: 17, marginBottom: 10 }}>Your share</h3>
          <div className="facts" style={{ marginTop: 0 }}>
            <Fact big k="Value" v={hasPos ? money(pos.value, 4) : '—'} />
            <Fact k="bxUSD" v={hasPos ? formatAmount(pos.bx, 4) : '—'} />
            <Fact k="xNEAR from protection" v={hasPos ? formatAmount(pos.x, 4) : '—'} />
          </div>
          {hasPos && (
            <button className="btn line" disabled={busy === 'spw'} onClick={() => run('spw', spWithdraw, 'Withdrawn to your wallet.')}>
              {busy === 'spw' ? 'Confirm in your wallet…' : 'Withdraw all'}
            </button>
          )}
          <h3 style={{ fontSize: 17, margin: '28px 0 10px' }}>The whole pool</h3>
          <div className="facts" style={{ marginTop: 0 }}>
            <Fact k="Deposited" v={sp ? money(sp.value) : '—'} />
            <Fact k="Interest paid so far" v={s ? money(s.interest_paid, 4) : '—'} />
            <Fact k="Fees paid so far" v={s ? money(s.stats.fees_usd) : '—'} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Vaults ----------

function Vaults({ pool, me, accountId, onConnect, run, busy }) {
  return (
    <section className="page">
      <div className="pagehead">
        <h2>Steady vaults</h2>
        <p>
          xNEAR's leverage floats as the pool changes. A Steady vault mixes tNEAR and xNEAR to hold one leverage, and the Guardian
          rebalances it when it drifts more than 3%.
        </p>
      </div>
      {!pool ? (
        <p className="empty">Loading vaults…</p>
      ) : (
        <div className="cols even">
          {pool.vaults.map((v) => (
            <VaultCard key={v.id} v={v} pool={pool} me={me} accountId={accountId} onConnect={onConnect} run={run} busy={busy} />
          ))}
        </div>
      )}
    </section>
  );
}

function VaultCard({ v, pool, me, accountId, onConnect, run, busy }) {
  const [text, setText] = useState('');
  const amount = parseAmount(text);
  const s = pool.state;
  const pos = me?.vaults?.find((p) => p.vault === v.id);
  const hasPos = pos && BigInt(pos.shares) > 0n;
  const filled = BigInt(v.value) > 0n;
  const lev = filled ? Number(v.leverage_bps) : Number(v.target_bps);
  const capped = filled && BigInt(v.t) === 0n;
  const maxLev = 40_000;

  let problem = '';
  if (amount && accountId && !me) problem = 'Loading your wallet…';
  else if (amount && accountId && amount > BigInt(me.tnear)) problem = 'That is more tNEAR than your wallet holds.';
  else if (amount && BigInt(s.x_supply) === 0n) problem = 'The pool needs some xNEAR first.';

  return (
    <div className="panel vault">
      <div className="vault-top">
        <h3>{v.name}</h3>
        <span className={`chip ${v.needs_rebalance ? 'amber' : 'green'}`}>{v.needs_rebalance ? 'Rebalance due' : 'On target'}</span>
      </div>
      <div>
        <div className="gauge" aria-label={`Leverage ${formatTimes(lev)}, target ${formatTimes(v.target_bps)}`}>
          <i style={{ width: `${Math.min(100, (lev / maxLev) * 100)}%` }} />
          <u style={{ left: `${(Number(v.target_bps) / maxLev) * 100}%` }} />
        </div>
        <div className="facts">
          <Fact k="Leverage now" v={formatTimes(lev)} />
          <Fact k="Vault size" v={`${formatAmount(v.value)} tNEAR`} />
          <Fact k="Your share" v={hasPos ? `${formatAmount(pos.value, 4)} tNEAR, ${money(usdValue(pos.value, s.price))}` : '—'} />
        </div>
        {capped && <p className="hint">xNEAR itself is under {formatTimes(v.target_bps)} right now, so this vault holds only xNEAR.</p>}
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`v${v.id}`}>Deposit</label>
        <AmountRow id={`v${v.id}`} value={text} onChange={setText} max={me?.tnear} unit="tNEAR" />
      </div>
      {problem && <p className="err">{problem}</p>}
      <div className="btnrow">
        {accountId ? (
          <button className="btn go" disabled={!amount || !!problem || busy === `vd${v.id}`} onClick={() => run(`vd${v.id}`, () => vaultDeposit(v.id, amount), `Deposited into ${v.name}.`)}>
            {busy === `vd${v.id}` ? 'Confirm…' : 'Deposit'}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="deposit" />
        )}
        {hasPos && (
          <button className="btn line" disabled={busy === `vw${v.id}`} onClick={() => run(`vw${v.id}`, () => vaultWithdraw(v.id), 'Withdrawn to your wallet.')}>
            {busy === `vw${v.id}` ? 'Confirm…' : 'Withdraw all'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Orders ----------

function Orders({ pool, me, accountId, onConnect, run, busy }) {
  const vol = useVolatility();
  const [text, setText] = useState('');
  const [stopText, setStopText] = useState('');
  const [takeText, setTakeText] = useState('');
  const s = pool?.state;
  const amount = parseAmount(text);
  const stop = stopText ? parseUsdPrice(stopText) : null;
  const take = takeText ? parseUsdPrice(takeText) : null;
  const price = s ? BigInt(s.price) : 0n;

  let problem = '';
  if (!amount) problem = '';
  else if (accountId && !me) problem = 'Loading your wallet…';
  else if (accountId && amount > BigInt(me.xnear)) problem = 'That is more xNEAR than you hold.';
  else if (!stop && !take) problem = 'Set a stop price, a take price, or both.';
  else if ((stopText && !stop) || (takeText && !take)) problem = 'Prices are in dollars, like 3.50.';
  else if (stop && take && stop >= take) problem = 'The stop price must be below the take price.';
  else if (stop && price && stop >= price) problem = 'The stop price must be below the current NEAR price.';
  else if (take && price && take <= price) problem = 'The take price must be above the current NEAR price.';

  const orders = [...(me?.orders || [])].sort((a, b) => b.id - a.id);
  return (
    <section className="page">
      <div className="pagehead">
        <h2>Stop-loss and take-profit</h2>
        <p>Park xNEAR with a NEAR price to sell at. When NEAR gets there, the Guardian sells it and sends tNEAR to your wallet. The pool checks the price itself, so nobody can sell early.</p>
      </div>
      <div className="cols">
        <div className="panel">
          <div className="field">
            <label htmlFor="o-amount">xNEAR to protect</label>
            <AmountRow id="o-amount" value={text} onChange={setText} max={me?.xnear} unit="xNEAR" />
          </div>
          <div className="two">
            <div className="field">
              <label htmlFor="o-stop">Sell if NEAR falls to</label>
              <div className="inputrow">
                <span className="unit">$</span>
                <input id="o-stop" inputMode="decimal" placeholder="Optional" value={stopText} onChange={(e) => setStopText(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="o-take">Sell if NEAR rises to</label>
              <div className="inputrow">
                <span className="unit">$</span>
                <input id="o-take" inputMode="decimal" placeholder="Optional" value={takeText} onChange={(e) => setTakeText(e.target.value)} />
              </div>
            </div>
          </div>
          <p className="hint" style={{ marginBottom: 14 }}>
            NEAR is {s ? formatUsd(s.price, 3) : '—'} now.{' '}
            {s && (
              <button
                className="linkbtn"
                onClick={() => setStopText(String(suggestStop(Number(s.price) / 1e6, vol).price))}
                title="Two days of NEAR's usual moves below today's price"
              >
                Suggest a stop
              </button>
            )}
          </p>
          {problem && <p className="err">{problem}</p>}
          {accountId ? (
            <button className="btn go wide" disabled={!amount || !!problem || busy === 'order'} onClick={() => run('order', () => placeOrder(amount, stop, take), 'Order placed. The Guardian is watching it.')}>
              {busy === 'order' ? 'Confirm in your wallet…' : 'Place order'}
            </button>
          ) : (
            <ConnectFirst onConnect={onConnect} what="place orders" />
          )}
        </div>
        <div>
          <h3 style={{ fontSize: 17, marginBottom: 10 }}>Your orders</h3>
          {!accountId ? (
            <p className="empty">Connect your wallet to see your orders.</p>
          ) : orders.length === 0 ? (
            <p className="empty">No orders yet.</p>
          ) : (
            <div className="rowlist">
              {orders.map((o) => (
                <div className="rowitem" key={o.id}>
                  <div>
                    <div className="t">
                      <span className={`chip ${o.status === 'Open' ? 'green' : o.status === 'Executed' ? 'slate' : ''}`}>{o.status}</span>
                      {formatAmount(o.x_amount, 4)} xNEAR
                    </div>
                    <div className="m">
                      {[o.stop_price && `Stop at ${formatUsd(o.stop_price, 3)}`, o.take_price && `Take at ${formatUsd(o.take_price, 3)}`]
                        .filter(Boolean)
                        .join(', ')}
                      {o.status === 'Executed' && `. Sold at ${formatUsd(o.executed_price, 3)} for ${formatAmount(o.tnear_out, 4)} tNEAR`}
                    </div>
                  </div>
                  {o.status === 'Open' && (
                    <button className="btn line sm" disabled={busy === `oc${o.id}`} onClick={() => run(`oc${o.id}`, () => cancelOrder(o.id), 'Cancelled. Your xNEAR is back.')}>
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="hint" style={{ marginTop: 16 }}>
            Tokens: <a href={`${EXPLORER}/address/${XNEAR_ID}`} target="_blank" rel="noreferrer">xNEAR</a>,{' '}
            <a href={`${EXPLORER}/address/${POOL_ID}`} target="_blank" rel="noreferrer">bxUSD</a>,{' '}
            <a href={`${EXPLORER}/address/${TNEAR_ID}`} target="_blank" rel="noreferrer">tNEAR</a>
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------- Risk check ----------

/** NEAR's daily volatility from the last day of CoinGecko prices (null if unavailable). */
function useVolatility() {
  const [vol, setVol] = useState(null);
  useEffect(() => {
    let live = true;
    fetch('https://api.coingecko.com/api/v3/coins/near/market_chart?vs_currency=usd&days=1')
      .then((r) => r.json())
      .then((j) => live && setVol(dailyVolatility(j?.prices)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return vol;
}

const MOVES = [-20, -10, 10, 20];

export function RiskCheck({ pool, me, accountId, run, busy, onOrders }) {
  const vol = useVolatility();
  if (!accountId || !me || !pool) return null;
  const p = poolNumbers(pool.state);
  const x = Number(BigInt(me.xnear) / 10n ** 18n) / 1e6;
  const bx = Number(BigInt(me.bx) / 10n ** 18n) / 1e6 + Number(BigInt(me.stability_pool.value) / 10n ** 18n) / 1e6;
  if (x <= 0 && bx <= 0) return null;

  const lev = leverage(p);
  const xValue = x * xPriceAt(p, p.price);
  const total = xValue + bx;
  const posLev = total > 0 ? (xValue * (Number.isFinite(lev) ? lev : 1)) / total : 0;
  const stop = suggestStop(p.price, vol);
  const atStop = scenario(p, x, bx, -stop.gapPct);
  const openStops = (me.orders || []).filter((o) => o.status === 'Open' && o.stop_price);
  const $ = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <section className="risk" aria-label="Your risk">
      <div className="risk-head">
        <div>
          <h2>Your risk</h2>
          <p className="hint">
            Worth {$(total)} now: {$(xValue)} in xNEAR and {$(bx)} in bxUSD. Overall you move about {posLev.toFixed(2)}x with NEAR.
          </p>
        </div>
        <span className={`chip ${posLev < 1.5 ? 'green' : posLev < 2.5 ? 'amber' : 'red'}`}>{riskWord(posLev)} risk</span>
      </div>
      <div className="scen" role="table" aria-label="If NEAR moves">
        {MOVES.map((mv) => {
          const r = scenario(p, x, bx, mv);
          return (
            <div key={mv} className="scen-cell" role="row">
              <div className="l" role="rowheader">If NEAR {mv > 0 ? 'rises' : 'falls'} {Math.abs(mv)}%</div>
              <div className={`n ${r.change >= 0 ? 'up' : 'down'}`} role="cell">{r.change >= 0 ? '+' : ''}{$(r.change)}</div>
              <div className="l" role="cell">{r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(1)}%</div>
            </div>
          );
        })}
      </div>
      {x > 0 && (
        <div className="note good stopnote">
          <div>
            <b>Suggested stop-loss: NEAR at ${stop.price.toFixed(3)}</b>, {stop.gapPct.toFixed(0)}% below today.{' '}
            {vol != null ? `NEAR usually moves about ${vol.toFixed(1)}% a day, so this leaves room for normal swings. ` : ''}
            If it's hit, your xNEAR is sold and you keep about {$(atStop.then)}.
            {openStops.length > 0 && ` You already have ${openStops.length} open stop order${openStops.length > 1 ? 's' : ''}.`}
          </div>
          <div className="btnrow">
            <button
              className="btn go sm"
              disabled={busy === 'protect'}
              onClick={() =>
                run('protect', () => placeOrder(BigInt(me.xnear), BigInt(Math.round(stop.price * 1e6)), null), `Stop-loss set at $${stop.price.toFixed(3)}. The Guardian is watching it.`)
              }
            >
              {busy === 'protect' ? 'Confirm in your wallet…' : 'Protect all my xNEAR'}
            </button>
            <button className="btn line sm" onClick={onOrders}>
              Set my own
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Ask Bexley ----------

const EXAMPLES = [
  'Make me 2x long with 50 tNEAR',
  'Put 30 tNEAR into bxUSD and earn on it',
  'Protect all my xNEAR if NEAR drops 10%',
];

function askContext(pool, me) {
  const s = pool?.state;
  const n = (units) => (units == null ? null : Number(BigInt(units) / 10n ** 18n) / 1e6);
  return {
    near_price_usd: s ? Number(s.price) / 1e6 : null,
    xnear_price_usd: s ? Number(s.x_price) / 1e6 : null,
    xnear_leverage: s ? Number(s.leverage_bps) / 10000 : null,
    pool_mode: s?.mode,
    savings_rate_pct: s ? s.savings_rate_bps / 100 : null,
    mint_bx_open: s?.fees_bps.mint_bx_open,
    redeem_x_open: s?.fees_bps.redeem_x_open,
    wallet: me ? { tNEAR: n(me.tnear), xNEAR: n(me.xnear), bxUSD: n(me.bx) } : null,
    stability_pool_bxusd: me ? n(me.stability_pool.value) : null,
  };
}

/** Turn one checked step into a wallet transaction, using fresh balances. */
async function runStep(step, accountId) {
  const fresh = await loadAccount(accountId);
  const bal = { tNEAR: fresh.tnear, xNEAR: fresh.xnear, bxUSD: fresh.bx };
  const pays = ACTIONS[step.action].pays;
  let units = null;
  if (pays) {
    units = step.amount === 'all' ? BigInt(bal[pays]) : parseAmount(String(step.amount));
    if (!units || units <= 0n) throw new Error(`You have no ${pays} for this step.`);
    if (units > BigInt(bal[pays])) throw new Error(`This step needs more ${pays} than you hold.`);
  }
  const usd = (v) => (v == null ? null : BigInt(Math.round(v * 1e6)));
  switch (step.action) {
    case 'mint_x':
    case 'mint_bx':
    case 'redeem_x':
    case 'redeem_bx': {
      const q = BigInt(await quote(step.action, units));
      if (q === 0n) throw new Error('The pool cannot do this right now.');
      const fn = { mint_x: mintX, mint_bx: mintBx, redeem_x: redeemX, redeem_bx: redeemBx }[step.action];
      return fn(units, withSlippage(q));
    }
    case 'sp_deposit':
      return spDeposit(units);
    case 'sp_withdraw':
      return spWithdraw();
    case 'vault_deposit':
      return vaultDeposit(step.vault - 2, units);
    case 'vault_withdraw':
      return vaultWithdraw(step.vault - 2);
    case 'place_order':
      return placeOrder(units, usd(step.stop_price), usd(step.take_price));
    default:
      throw new Error('Unknown step');
  }
}

function AskBexley({ pool, me, accountId, onConnect, run, busy }) {
  const [text, setText] = useState('');
  const [plan, setPlan] = useState(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(0);

  const ask = async (msg) => {
    const message = (msg ?? text).trim();
    if (message.length < 2) return setError('Type what you want to do.');
    setText(message);
    setAsking(true);
    setError('');
    setPlan(null);
    setDone(0);
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, context: askContext(pool, me) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Ask Bexley could not answer right now.');
      setPlan(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setAsking(false);
    }
  };

  const next = plan?.steps?.[done];
  return (
    <section className="ask" aria-label="Ask Bexley">
      <form
        className="askbar"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <label htmlFor="ask" className="sr">Ask Bexley</label>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
        </svg>
        <input id="ask" placeholder="Ask Bexley: tell it what you want to do" value={text} onChange={(e) => setText(e.target.value)} maxLength={400} />
        <button className="btn sm" type="submit" disabled={asking}>
          {asking ? 'Thinking…' : 'Ask'}
        </button>
      </form>
      {!plan && !error && !asking && (
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e} className="example" onClick={() => ask(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
      {error && <p className="err" style={{ marginTop: 10 }}>{error}</p>}
      {plan && (
        <div className="plan">
          <p>{plan.reply}</p>
          {plan.steps.length > 0 && (
            <>
              <ol className="steps">
                {plan.steps.map((st, i) => (
                  <li key={i} className={i < done ? 'done' : i === done ? 'now' : ''}>
                    {st.label}
                  </li>
                ))}
              </ol>
              {done >= plan.steps.length ? (
                <p className="hint">All done. Your balances update in a few seconds.</p>
              ) : accountId ? (
                <div className="btnrow">
                  <button
                    className="btn go sm"
                    disabled={busy === 'ask'}
                    onClick={() =>
                      run('ask', async () => {
                        await runStep(next, accountId);
                        setDone((d) => d + 1);
                      }, `Step ${done + 1} done.`)
                    }
                  >
                    {busy === 'ask' ? 'Confirm in your wallet…' : plan.steps.length > 1 ? `Approve step ${done + 1} of ${plan.steps.length}` : 'Approve in wallet'}
                  </button>
                  <button className="btn line sm" onClick={() => setPlan(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn sm" onClick={onConnect}>
                  Connect wallet to run this plan
                </button>
              )}
            </>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            Planned by an AI model on NEAR AI Cloud. Check each step: nothing happens until you approve it in your wallet.
          </p>
        </div>
      )}
    </section>
  );
}
