import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EXPLORER, GUARDIAN_ID, POOL_ID, XNEAR_ID, TNEAR_ID, connect, disconnect, currentAccount, getConnector, loadPool, loadAccount,
  quote, quote as quote_, claimTnear, mintBx, mintX, redeemBx, redeemX, spDeposit, spWithdraw, vaultDeposit, vaultWithdraw, placeOrder,
  cancelOrder, claimStuck, errorText, setDemo, ASSET, IS_MAINNET, MAINNET_READY, MAINNET_CAP_NEAR, NETWORK, switchNetwork, unwrapNear,
} from './lib/near.js';
import { DEMO_ID, createDemo } from './lib/demo.mjs';
import { verifyProof } from './lib/proof.mjs';
import {
  parseAmount, formatAmount, formatUsd, usdValue, formatTimes, formatBacking, timeAgo, timeLeft, shortAccount, parseUsdPrice,
} from './lib/format.mjs';
import { poolNumbers, scenario, leverage, xPriceAt, dailyVolatility, suggestStop, riskWord } from './lib/risk.mjs';
import { ACTIONS } from './lib/intent.mjs';

const REFRESH_MS = 15_000;
const SLIPPAGE_BPS = 100n; // accept up to 1% less than quoted
const PAGES = [
  ['home', 'Home'],
  ['trade', 'Trade'],
  ['portfolio', 'Portfolio'],
  ['earn', 'Earn'],
  ['vaults', 'Vaults'],
  ['guardian', 'Guardian'],
];

const money = (units, places = 2) => `$${formatAmount(units ?? 0, places)}`;
const withSlippage = (v) => (v ? (BigInt(v) * (10_000n - SLIPPAGE_BPS)) / 10_000n : null);
const toNum = (units) => Number(BigInt(units ?? 0) / 10n ** 18n) / 1e6; // 24-decimal units to a float
const pctRate = (bps) => `${(Number(bps) / 100).toFixed(0)}%`;

// ---------- Theme ----------

// Light by default for everyone; dark only when the visitor picks it.
function readTheme() {
  try {
    return localStorage.getItem('bexley-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function useTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('bexley-theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  const isDark = () => theme === 'dark';
  return [isDark, () => setTheme(theme === 'dark' ? 'light' : 'dark')];
}

// ---------- App ----------

function pageFromHash() {
  const h = location.hash.replace('#', '');
  if (h === 'crash-test' || h === 'attack-test') return h;
  if (h === 'orders') return 'portfolio'; // Orders now live inside Portfolio
  return PAGES.some(([id]) => id === h) ? h : 'home';
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
  const [explain, setExplain] = useState(false);
  const [demoOn, setDemoOn] = useState(false);
  const poolRef = useRef(null);
  const demoRef = useRef(null);
  poolRef.current = pool;
  const acct = demoOn ? DEMO_ID : accountId;

  const refresh = useCallback(async () => {
    try {
      setPool(await loadPool());
      setLoadError('');
    } catch {
      setLoadError('Could not reach NEAR testnet. Retrying…');
    }
    if (acct) {
      try {
        setMe(await loadAccount(acct));
      } catch {
        /* keep the last good data */
      }
    } else setMe(null);
  }, [acct]);

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
    location.hash = id === 'home' ? '' : id;
    setPage(id);
    window.scrollTo({ top: 0 });
  };
  // Stop-loss and take-profit orders sit at the bottom of Portfolio.
  const goOrders = () => {
    if (page !== 'portfolio') go('portfolio');
    setTimeout(() => document.getElementById('orders')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
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

  const startDemo = () => {
    if (!demoRef.current) demoRef.current = createDemo(() => poolRef.current, quote);
    demoRef.current.reset();
    setDemo(demoRef.current);
    setMe(null);
    setDemoOn(true);
    setToast({ text: 'Demo on: a pretend wallet with example positions. Nothing is sent.' });
  };
  const stopDemo = () => {
    setDemo(null);
    setMe(null);
    setDemoOn(false);
  };

  const onConnect = () => (demoOn ? stopDemo() : null, connect()).catch((e) => setToast({ text: errorText(e), bad: true }));
  const onDisconnect = () => disconnect().then(() => setAccountId(null));
  const ctx = { pool, me, accountId: acct, onConnect, run, busy };
  const stuck = me && (BigInt(me.claim_tnear) > 0n || BigInt(me.claim_xnear) > 0n);

  return (
    <>
      <Header
        page={page}
        go={go}
        accountId={acct}
        me={me}
        onConnect={onConnect}
        onDisconnect={demoOn ? stopDemo : onDisconnect}
        demoOn={demoOn}
        onDemo={demoOn ? stopDemo : startDemo}
        run={run}
        busy={busy}
        isDark={isDark()}
        toggleTheme={toggleTheme}
      />
      {IS_MAINNET && <BetaBar pool={pool} />}
      {demoOn && (
        <div className="demobar" role="status">
          <div className="wrap">
            <span>
              <b>Demo.</b> A pretend wallet with live prices. Nothing here is real and nothing is sent.
            </span>
            <button className="btn sm line" onClick={stopDemo}>
              Exit demo
            </button>
          </div>
        </div>
      )}
      <main className="wrap">
        {stuck && (
          <div className="note warn banner">
            A transfer to your wallet didn't go through, so Bexley is holding it for you.
            <button className="btn sm" disabled={busy === 'stuck'} onClick={() => run('stuck', claimStuck, 'Sent again.')}>
              Send it again
            </button>
          </div>
        )}
        {page === 'home' && (
          <Landing
            pool={pool}
            onLaunch={() => go('trade')}
            onDemo={() => {
              if (!demoOn) startDemo();
              go('trade');
            }}
            go={go}
          />
        )}
        {page === 'trade' && (
          <>
            <div className="pagehead trade-head">
              <h2>Trade</h2>
              <p>Mint or redeem bxUSD and xNEAR from one pool, at fair value.</p>
            </div>
            <Split pool={pool} error={loadError} open={explain} setOpen={setExplain} />
            <section className="page cols" id="trade">
              <TradePanel {...ctx} />
              <div className="side-col">
                <GuardianFeed pool={pool} limit={1} title="Latest from the Guardian" onMore={() => go('guardian')} />
                <PoolPulse pool={pool} />
              </div>
            </section>
            <CrossChain {...ctx} />
            {!IS_MAINNET && <AskBexley {...ctx} />}
            <RiskCheck {...ctx} onOrders={() => goOrders()} />
          </>
        )}
        {page === 'earn' && <Earn {...ctx} />}
        {page === 'vaults' && <Vaults {...ctx} />}
        {page === 'portfolio' && (
          <Portfolio
            {...ctx}
            go={go}
            onDemo={() => (demoOn ? null : startDemo())}
            onOrders={goOrders}
          />
        )}
        {page === 'guardian' && <GuardianPage pool={pool} go={go} />}
        {page === 'crash-test' && <CrashTest />}
        {page === 'attack-test' && <AttackTest />}
      </main>
      <footer>
        <div className="wrap">
          <span>
            {IS_MAINNET
              ? 'Mainnet beta: real NEAR, unaudited code, capped pool. Only put in what you can afford to lose.'
              : 'Bexley runs on NEAR testnet with tNEAR, a free test token with no value.'}
          </span>
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

// ---------- Deposit from another chain (NEAR Intents) ----------

const STATUS_WORDS = {
  PENDING_DEPOSIT: 'Waiting for your deposit',
  KNOWN_DEPOSIT_TX: 'Deposit seen, confirming',
  INCOMPLETE_DEPOSIT: 'Deposit was less than the quote. Send the rest, or wait for a refund',
  PROCESSING: 'Swapping to NEAR',
  SUCCESS: 'Done',
  REFUNDED: 'Refunded to your address',
  FAILED: 'Failed. Any funds are refunded to your address',
};

function readPending() {
  try {
    return JSON.parse(localStorage.getItem('bexley-intent') || 'null');
  } catch {
    return null;
  }
}
function writePending(v) {
  try {
    if (v) localStorage.setItem('bexley-intent', JSON.stringify(v));
    else localStorage.removeItem('bexley-intent');
  } catch {}
}

function CrossChain({ pool, me, accountId, onConnect, run, busy }) {
  const [tokens, setTokens] = useState([]);
  const [pick, setPick] = useState('');
  const [amount, setAmount] = useState('25');
  const [quote, setQuote] = useState(null);
  const [qErr, setQErr] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [deposit, setDeposit] = useState(() => (IS_MAINNET ? readPending() : null));
  const [status, setStatus] = useState(null);
  const [getting, setGetting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/intents?action=tokens')
      .then((r) => (r.ok ? r.json() : []))
      .then((t) => {
        if (Array.isArray(t) && t.length) {
          setTokens(t);
          setPick((p) => p || t[0].assetId);
        }
      })
      .catch(() => {});
  }, []);

  const token = tokens.find((t) => t.assetId === pick);

  // Live preview quote (no deposit address).
  useEffect(() => {
    if (!token || !amount || deposit) return;
    let live = true;
    setQErr('');
    const t = setTimeout(() => {
      fetch('/api/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'quote', dry: true, originAsset: token.assetId, amount, recipient: (IS_MAINNET && accountId) || 'bexley.near' }),
      })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || 'No quote right now.');
          live && setQuote(j);
        })
        .catch((e) => live && (setQuote(null), setQErr(e.message)));
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pick, amount, accountId, deposit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow a real deposit.
  useEffect(() => {
    if (!deposit) return;
    let live = true;
    const poll = () =>
      fetch(`/api/intents?action=status&depositAddress=${encodeURIComponent(deposit.depositAddress)}${deposit.depositMemo ? `&depositMemo=${encodeURIComponent(deposit.depositMemo)}` : ''}`)
        .then((r) => r.json())
        .then((j) => live && j.status && setStatus(j))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [deposit]);

  const getAddress = async () => {
    setGetting(true);
    setQErr('');
    try {
      const r = await fetch('/api/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'quote', dry: false, originAsset: token.assetId, amount, recipient: accountId, refundTo }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.depositAddress) throw new Error(j.error || 'NEAR Intents did not give a deposit address. Try again.');
      const d = { ...j, at: Date.now(), account: accountId };
      writePending(d);
      setDeposit(d);
      setStatus(null);
    } catch (e) {
      setQErr(e.message);
    } finally {
      setGetting(false);
    }
  };

  const reset = () => {
    writePending(null);
    setDeposit(null);
    setStatus(null);
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const got = status?.status === 'SUCCESS' ? BigInt(status.amountOut || deposit?.amountOut || 0) : 0n;
  const mintWith = (side) =>
    run(`cc-${side}`, async () => {
      const q = BigInt(await quote_(side === 'x' ? 'mint_x' : 'mint_bx', got));
      const min = withSlippage(q);
      await (side === 'x' ? mintX(got, min) : mintBx(got, min));
      reset();
    }, side === 'x' ? 'Minted xNEAR with your deposit.' : 'Minted bxUSD with your deposit.');

  if (!tokens.length) return null;
  return (
    <section className="crosschain" aria-label="Deposit from another chain">
      <div className="cc-head">
        <h3>Deposit from another chain</h3>
        <p className="hint">
          Pay with USDC, USDT, ETH, SOL or BTC from their own chains. NEAR Intents swaps it and sends NEAR to your wallet, ready to mint.
          {!IS_MAINNET && ' Live quotes; deposits run on the mainnet beta.'}
        </p>
      </div>

      {!deposit ? (
        <div className="cc-grid">
          <div className="field">
            <label htmlFor="cc-token">You send</label>
            <div className="inputrow">
              <input id="cc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount to send" />
              <select id="cc-token" value={pick} onChange={(e) => setPick(e.target.value)}>
                {tokens.map((t) => (
                  <option key={t.assetId} value={t.assetId}>
                    {t.symbol} on {t.chainName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="cc-out">
            <span className="hint">You get, in your NEAR wallet</span>
            <b>{quote ? `${Number(quote.amountOutFormatted).toFixed(3)} NEAR` : '—'}</b>
            <span className="hint">{quote ? `About $${Number(quote.amountOutUsd).toFixed(2)}, in about ${quote.timeEstimate} seconds. Swap fee included.` : qErr || 'Getting a live quote…'}</span>
          </div>
          {IS_MAINNET ? (
            accountId ? (
              <div className="cc-go">
                <div className="field">
                  <label htmlFor="cc-refund">Your {token?.chainName} address, for refunds</label>
                  <div className="inputrow">
                    <input id="cc-refund" placeholder={token?.chain === 'sol' ? 'Solana address' : token?.chain === 'btc' ? 'bc1…' : token?.chain === 'tron' ? 'T…' : '0x…'} value={refundTo} onChange={(e) => setRefundTo(e.target.value.trim())} />
                  </div>
                </div>
                <button className="btn go" disabled={!quote || refundTo.length < 20 || getting} onClick={getAddress}>
                  {getting ? 'Getting address…' : 'Get my deposit address'}
                </button>
              </div>
            ) : (
              <button className="btn" onClick={onConnect}>
                Connect your NEAR wallet to deposit
              </button>
            )
          ) : (
            <button className="btn line" onClick={() => switchNetwork('mainnet')} disabled={!MAINNET_READY}>
              {MAINNET_READY ? 'Deposit on the mainnet beta' : 'Mainnet beta opening soon'}
            </button>
          )}
        </div>
      ) : (
        <div className="cc-deposit">
          {status?.status !== 'SUCCESS' && (
            <>
              <p>
                Send exactly <b>{deposit.amountIn} {deposit.origin.symbol}</b> on <b>{deposit.origin.chainName}</b> to this address:
              </p>
              <div className="cc-addr">
                <code>{deposit.depositAddress}</code>
                <button className="btn sm line" onClick={() => copy(deposit.depositAddress)}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {deposit.depositMemo && (
                <p>
                  Memo (required): <code>{deposit.depositMemo}</code>
                </p>
              )}
              <p className="hint">
                Only {deposit.origin.symbol} on {deposit.origin.chainName}. You'll get about {Number(deposit.amountOutFormatted).toFixed(3)} NEAR. If it can't finish
                by {deposit.deadline ? new Date(deposit.deadline).toLocaleTimeString() : 'the deadline'}, it's refunded to your address.
              </p>
            </>
          )}
          <div className={`cc-status s-${status?.status || 'PENDING_DEPOSIT'}`}>
            <i className="pulse" aria-hidden="true" />
            {STATUS_WORDS[status?.status] || 'Waiting for your deposit'}
          </div>
          {status?.status === 'SUCCESS' && got > 0n && (
            <>
              <p>
                <b>{formatAmount(got, 3)} wNEAR</b> arrived in your wallet. Mint with it now:
              </p>
              <div className="btnrow">
                <button className="btn go" disabled={!!busy} onClick={() => mintWith('bx')}>
                  Mint bxUSD
                </button>
                <button className="btn" disabled={!!busy} onClick={() => mintWith('x')}>
                  Mint xNEAR
                </button>
                <button className="btn line" onClick={reset}>
                  Keep it as NEAR
                </button>
              </div>
            </>
          )}
          {status && ['REFUNDED', 'FAILED'].includes(status.status) && (
            <button className="btn line" onClick={reset}>
              Start again
            </button>
          )}
          {(!status || status.status === 'PENDING_DEPOSIT') && (
            <button className="linkbtn" onClick={reset}>
              Cancel (only if you haven't sent anything)
            </button>
          )}
        </div>
      )}
      <p className="hint cc-foot">
        Powered by <a href="https://near-intents.org" target="_blank" rel="noreferrer">NEAR Intents</a>. Bexley never holds these funds.
      </p>
    </section>
  );
}

// ---------- Mainnet beta ----------

function BetaBar({ pool }) {
  const s = pool?.state;
  const cap = s ? BigInt(s.max_collateral || 0) : 0n;
  const used = s ? BigInt(s.collateral) : 0n;
  const pct = cap > 0n ? Number((used * 1000n) / cap) / 10 : 0;
  return (
    <div className="betabar" role="note">
      <div className="wrap">
        <span>
          <b>Mainnet beta.</b> Real NEAR and unaudited code. Only put in what you can afford to lose.
        </span>
        <span className="cap">
          {s ? (cap > 0n ? `Pool cap: ${formatAmount(used, 1)} of ${formatAmount(cap, 0)} NEAR used` : 'No cap set') : `Pool cap: ${MAINNET_CAP_NEAR} NEAR`}
          {s?.paused && <b className="paused"> Deposits paused</b>}
          {cap > 0n && (
            <i className="capbar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, pct)}%` }} />
            </i>
          )}
        </span>
      </div>
    </div>
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

function Header({ page, go, accountId, me, onConnect, onDisconnect, run, busy, isDark, toggleTheme, demoOn, onDemo }) {
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
        <a className="brand" href="#" onClick={(e) => (e.preventDefault(), go('home'))}>
          <Logo />
          bexley
          {!MAINNET_READY && <span className="net hide-sm">testnet</span>}
        </a>
        <nav className="nav" aria-label="Sections">{nav()}</nav>
        <div className="spacer" />
        <div className="right">
          {MAINNET_READY && (
            <div className="netswitch" role="group" aria-label="Network">
              <button aria-pressed={!IS_MAINNET} onClick={() => IS_MAINNET && switchNetwork('testnet')}>
                Testnet
              </button>
              <button aria-pressed={IS_MAINNET} onClick={() => !IS_MAINNET && switchNetwork('mainnet')}>
                Mainnet<span className="hide-sm"> beta</span>
              </button>
            </div>
          )}
          {!IS_MAINNET && !demoOn && !accountId && (
            <button className="btn sm demo-btn" onClick={onDemo} title="Try Bexley with a pretend wallet">
              Demo
            </button>
          )}
          <button className="iconbtn" onClick={toggleTheme} aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
            <ThemeIcon dark={isDark} />
          </button>
          {accountId ? (
            <>
              {IS_MAINNET ? (
                me && BigInt(me.wnear || 0) > 0n && (
                  <button
                    className="btn line sm"
                    disabled={busy === 'unwrap'}
                    onClick={() => run('unwrap', () => unwrapNear(me.wnear), 'Unwrapped to NEAR.')}
                    title="Turn your wNEAR back into NEAR"
                  >
                    {busy === 'unwrap' ? 'Unwrapping…' : `Unwrap ${formatAmount(me.wnear, 2)} wNEAR`}
                  </button>
                )
              ) : (
                (canClaim || busy === 'claim') && (
                  <button
                    className="btn go sm"
                    disabled={busy === 'claim'}
                    onClick={() => run('claim', claimTnear, '100 tNEAR added to your wallet.')}
                    title="Free test tokens, 100 every hour"
                  >
                    {busy === 'claim' ? 'Claiming…' : <><span className="hide-sm">Get </span>100 tNEAR</>}
                  </button>
                )
              )}
              <button
                className="btn line sm acct"
                onClick={onDisconnect}
                title={`${me ? `${formatAmount(me.tnear, IS_MAINNET ? 2 : 0)} ${ASSET}. ` : ''}${
                  !IS_MAINNET && me && !canClaim ? `Next free tNEAR in ${timeLeft(me.nextClaimAt)}. ` : ''
                }Click to disconnect.`}
              >
                <span className="show-xl">{me ? `${formatAmount(me.tnear, IS_MAINNET ? 2 : 0)} ${ASSET} · ` : ''}</span>
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

// ---------- Landing ----------

function Landing({ pool, onLaunch, onDemo, go }) {
  const s = pool?.state;
  const proofs = useProofIndex(pool?.notes?.[0]?.id);
  const verified = proofs.filter((p) => p.verified).length;
  const tvl = s ? toNum(s.tvl) : null;
  const bx = s ? toNum(s.bx_supply) : null;
  const bxFrac = tvl ? Math.min(1, bx / tvl) : 0.5;
  const lev = s ? formatTimes(s.leverage_bps) : '2x';
  const rate = s ? pctRate(s.savings_rate_bps) : null;
  const usd = (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  return (
    <div className="landing">
      <section className="l-hero">
        <h1>Double the possibilities from one pool.</h1>
        <p>
          Bexley splits one pool of NEAR in two. Hold <b className="t-bx">bxUSD</b> at $1 and earn, or ride NEAR with leverage in{' '}
          <b className="t-x">xNEAR</b>. No liquidations. An AI Guardian keeps the pool safe.
        </p>
        <div className="l-cta">
          <button className="btn go" onClick={onLaunch}>
            Launch app
          </button>
          {!IS_MAINNET && (
            <button className="btn quiet" onClick={onDemo}>
              Try the demo
            </button>
          )}
        </div>
      </section>

      <section className="l-pool" aria-label="The pool right now">
        <div className="l-bar">
          <div className="l-bx" style={{ width: `${bxFrac * 100}%` }}>
            <span>
              <b>bxUSD</b> {s ? usd(bx) : ''}
            </span>
          </div>
          <div className="l-x">
            <span>
              <b>xNEAR</b> {s && tvl > bx ? usd(tvl - bx) : ''}
            </span>
          </div>
        </div>
        <p className="hint">{s ? `One pool worth ${usd(tvl)} right now, live on NEAR ${IS_MAINNET ? 'mainnet' : 'testnet'}.` : 'Loading the live pool…'}</p>
      </section>

      <section className="l-ways">
        <article className="way bx">
          <h2>Hold $1. Earn {rate ? `${rate} a year` : 'a savings rate'}.</h2>
          <p>bxUSD stays at $1. Put it in the Stability Pool and earn a savings rate paid by xNEAR holders, plus 80% of every fee.</p>
          <button className="btn line" onClick={() => go('earn')}>
            Start earning
          </button>
        </article>
        <article className="way x">
          <h2>Ride NEAR at {lev}. No liquidations.</h2>
          <p>xNEAR owns everything the pool is worth above its bxUSD, so it moves more than NEAR, both ways. Nobody can force you out.</p>
          <button className="btn line" onClick={onLaunch}>
            Get xNEAR
          </button>
        </article>
      </section>

      <section className="l-steps">
        <h2>How it works</h2>
        <ol>
          <li>
            <b>Bring NEAR.</b>
            <span>Or USDC, ETH, SOL and BTC from other chains, through NEAR Intents.</span>
          </li>
          <li>
            <b>Pick your side.</b>
            <span>bxUSD to stay steady and earn, xNEAR for leverage, or a Steady 2x or 3x vault.</span>
          </li>
          <li>
            <b>The Guardian watches.</b>
            <span>Every 5 minutes it checks the pool, adjusts fees and the savings rate, and protects backing if NEAR falls.</span>
          </li>
        </ol>
      </section>

      <section className="l-trust">
        <h2>Built so you don't have to trust us</h2>
        <div className="trust-grid">
          <div>
            <h3>Provable AI</h3>
            <p>Every AI decision is signed inside NEAR AI's secure hardware. Your browser can check the proof.</p>
          </div>
          <div>
            <h3>Safety rails</h3>
            <p>The Guardian can't move funds, and one price update can move the pool's price at most 5%.</p>
          </div>
          <div>
            <h3>Exits you control</h3>
            <p>Steady vaults hold a fixed leverage, and stop-loss or take-profit orders sell at your price.</p>
          </div>
          <div>
            <h3>Any chain in</h3>
            <p>Deposit from Base, Ethereum, Solana or Bitcoin with NEAR Intents. Bexley never holds those funds.</p>
          </div>
        </div>
        <button className="linkbtn" onClick={() => go('guardian')}>
          See the Guardian at work
        </button>
      </section>

      <section className="l-stats" aria-label="Live numbers">
        <div>
          <b>{s ? usd(tvl) : '—'}</b>
          <span>Pool value</span>
        </div>
        <div>
          <b>{s ? formatBacking(s.cr_bps) : '—'}</b>
          <span>Backing for every bxUSD</span>
        </div>
        <div>
          <b>{rate || '—'}</b>
          <span>Savings rate, set by AI</span>
        </div>
        <div>
          <b>{verified || '—'}</b>
          <span>AI decisions with public proof</span>
        </div>
      </section>

      <section className="l-end">
        <h2>See it for yourself.</h2>
        <div className="l-cta">
          <button className="btn go" onClick={onLaunch}>
            Launch app
          </button>
          {!IS_MAINNET && (
            <button className="btn quiet" onClick={onDemo}>
              Try the demo
            </button>
          )}
        </div>
        <p className="hint">{IS_MAINNET ? 'Mainnet beta: real NEAR, unaudited code.' : 'On testnet with free tNEAR. No real money needed.'}</p>
      </section>
    </div>
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
function Split({ pool, error, open, setOpen }) {
  const [move, setMove] = useState(0);
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

const TOKENS = { t: [ASSET, 't'], x: ['xNEAR', 'x'], bx: ['bxUSD', 'bx'] };

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
  else if (accountId && amount > have) problem = `That is more ${TOKENS[payK][0]} than you hold.${payK === 't' && !IS_MAINNET ? ' Use "Get 100 tNEAR" at the top.' : ''}`;
  else if (dir === 'mint' && side === 'bx' && s && !s.fees_bps.mint_bx_open) problem = 'New bxUSD is paused while the pool rebuilds its backing.';
  else if (dir === 'mint' && side === 'bx' && noX) problem = 'bxUSD needs xNEAR behind it. Mint some xNEAR first to start the pool.';
  else if (dir === 'redeem' && side === 'x' && s && !s.fees_bps.redeem_x_open) problem = 'xNEAR exits are paused until backing is back over 130%. Your xNEAR keeps its share.';
  else if (s && !s.price_fresh) problem = 'Waiting for a fresh price from the Guardian.';

  const getUsd = q == null || !s ? null : getK === 'x' ? (q * BigInt(s.x_price)) / 1_000_000n : getK === 'bx' ? q : (q * BigInt(s.price)) / 1_000_000n;
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

      {side === 'x' && s && (
        <p className="hint lever-line">Your xNEAR moves about {formatTimes(s.leverage_bps)} as much as NEAR, up and down.</p>
      )}
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

// ---------- Provable AI ----------

const PROOFS_RAW = `https://raw.githubusercontent.com/Mandicrypt/bexley/proofs${IS_MAINNET ? '/mainnet' : ''}`;
const PROOFS_WEB = `https://github.com/Mandicrypt/bexley/blob/proofs${IS_MAINNET ? '/mainnet' : ''}`;

/** The public index of AI proofs, refreshed when new notes arrive. */
function useProofIndex(key) {
  const [index, setIndex] = useState([]);
  useEffect(() => {
    let live = true;
    fetch(`${PROOFS_RAW}/index.json?t=${Math.floor(Date.now() / 60000)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => live && Array.isArray(j) && setIndex(j))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return index;
}

/** Downloads one proof and checks it in this browser. */
function ProofPanel({ entry }) {
  const [res, setRes] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`${PROOFS_RAW}/${entry.file}`)
      .then((r) => {
        if (!r.ok) throw new Error('Could not download the proof.');
        return r.json();
      })
      .then((p) => {
        let answer = '';
        try {
          const m = JSON.parse(p.response)?.choices?.[0]?.message;
          answer = m?.content || m?.reasoning_content || '';
        } catch {}
        live && setRes({ ...verifyProof(p), answer, model: p.model, kind: p.signature?.signature_kind });
      })
      .catch((e) => live && setRes({ error: e.message }));
    return () => {
      live = false;
    };
  }, [entry.file]);

  if (!res) return <div className="proof">Checking the proof in your browser…</div>;
  if (res.error) return <div className="proof bad">{res.error}</div>;
  return (
    <div className={`proof${res.ok ? '' : ' bad'}`}>
      <b>{res.ok ? 'Checked in your browser: this decision came from NEAR AI secure hardware.' : 'This proof did not check out.'}</b>
      <ul>
        {res.checks.map((c) => (
          <li key={c.name} className={c.ok ? 'ok' : 'no'}>
            <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span>
            <div>
              {c.name}
              <small>{c.detail}</small>
            </div>
          </li>
        ))}
      </ul>
      <p className="hint">
        Model {res.model}
        {res.kind === 'provider_tee' ? ', signed by the model\'s own enclave' : res.kind === 'gateway' ? ', signed by the NEAR AI gateway enclave' : ''}.
      </p>
      {res.answer && (
        <details>
          <summary>The AI's exact answer</summary>
          <pre>{res.answer}</pre>
        </details>
      )}
      <p className="hint links">
        <a href={`${PROOFS_WEB}/${entry.file}`} target="_blank" rel="noreferrer">Proof file</a>
        <a href="https://cloud.near.ai/verify" target="_blank" rel="noreferrer">NEAR AI verification center</a>
        <a href="https://github.com/Mandicrypt/bexley/blob/main/app/src/lib/proof.mjs" target="_blank" rel="noreferrer">Checking code</a>
      </p>
    </div>
  );
}

function GuardianFeed({ pool, limit, onMore, more, title = 'Pool Guardian' }) {
  const proofs = useProofIndex(pool?.notes?.[0]?.id);
  const [open, setOpen] = useState(null);
  const proofFor = (n) => (n.kind === 'fees' || n.kind === 'rate' ? proofs.find((p) => p.reason === n.text) : null);
  const s = pool?.state;
  const [shown, setShown] = useState(limit);
  const all = pool?.notes ?? [];
  const notes = all.slice(0, shown);
  const live = s?.price_fresh;
  return (
    <section aria-label="Guardian">
      <div className="feed-head">
        <h3>{title}</h3>
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
                {proofFor(n) && (
                  <button className="verified" onClick={() => setOpen(open === n.id ? null : n.id)} aria-expanded={open === n.id}>
                    {open === n.id ? 'Hide proof' : 'AI, verified'}
                  </button>
                )}
              </div>
              <p>{n.text}</p>
              {open === n.id && proofFor(n) && <ProofPanel entry={proofFor(n)} />}
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

/** Three numbers the Guardian manages, beside the trade box. */
function PoolPulse({ pool }) {
  const s = pool?.state;
  if (!s) return null;
  const feeWord = ['Normal', 'Volatile, 2x', 'Very volatile, 3x'][s.fee_level] || 'Normal';
  return (
    <div className="pulse-facts">
      <Fact k="Backing" v={`${formatBacking(s.cr_bps)}, ${s.mode.toLowerCase()}`} />
      <Fact k="Savings rate, set by AI" v={`${pctRate(s.savings_rate_bps)} a year`} />
      <Fact k="Fees, set by AI" v={feeWord} />
    </div>
  );
}

/** A clearly labeled example, shown only where the user has nothing yet. */
function Example({ children }) {
  return (
    <div className="example-card">
      <span className="chip">Example</span>
      <p>{children}</p>
    </div>
  );
}

function LatestDecision({ pool }) {
  const proofs = useProofIndex(pool?.notes?.[0]?.id);
  const [open, setOpen] = useState(false);
  const p = proofs[0];
  if (!p) return null;
  return (
    <div className="latest">
      <div className="meta">
        <span className="k">Latest AI decision</span>
        <span>{timeAgo(String(BigInt(p.at) * 1_000_000n))}</span>
        {p.verified && (
          <button className="verified" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide proof' : 'AI, verified'}
          </button>
        )}
      </div>
      <p>{p.reason}</p>
      {open && <ProofPanel entry={p} />}
      <p className="hint">{(() => {
          const n = proofs.filter((x) => x.verified).length;
          return `${n} AI decision${n === 1 ? '' : 's'} with a public proof so far.`;
        })()}</p>
    </div>
  );
}

// ---------- Crash test replay ----------

const CRASH_RAW = 'https://raw.githubusercontent.com/Mandicrypt/bexley/proofs/crashtest';
const TESTNET_EXPLORER = 'https://testnet.nearblocks.io';

function CrashChart({ events, at }) {
  const pts = events.filter((e) => e.backing_pct != null);
  if (pts.length < 2) return null;
  const W = 640;
  const H = 200;
  const lo = 100;
  const hi = Math.max(220, ...pts.map((e) => e.backing_pct)) + 10;
  const x = (i) => 8 + (i / (pts.length - 1)) * (W - 16);
  const y = (v) => H - 8 - ((v - lo) / (hi - lo)) * (H - 16);
  const line = pts.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e.backing_pct).toFixed(1)}`).join(' ');
  const cur = Math.min(pts.length - 1, pts.findIndex((e) => e.at >= (events[at]?.at ?? 0)) === -1 ? pts.length - 1 : pts.findIndex((e) => e.at >= events[at].at));
  return (
    <svg className="crash-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Backing during the crash test">
      {[150, 130].map((v) => (
        <g key={v}>
          <line x1="0" x2={W} y1={y(v)} y2={y(v)} className={v === 150 ? 'l150' : 'l130'} />
          <text x={10} y={y(v) - 6}>
            {v === 150 ? 'Caution 150%' : 'Protection 130%'}
          </text>
        </g>
      ))}
      <path d={line} className="bk" />
      <circle cx={x(cur)} cy={y(pts[cur].backing_pct)} r="6" className="dot" />
    </svg>
  );
}

function CrashTest() {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    fetch(`${CRASH_RAW}/timeline.json?t=${Math.floor(Date.now() / 60000)}`)
      .then((r) => {
        if (!r.ok) throw new Error('The crash test has not run yet.');
        return r.json();
      })
      .then((j) => {
        setT(j);
        setAt(0);
      })
      .catch((e) => setErr(e.message));
  }, []);

  const evs = t?.events || [];
  useEffect(() => {
    if (!playing) return;
    if (at >= evs.length - 1) return setPlaying(false);
    const id = setTimeout(() => setAt((a) => a + 1), 1400);
    return () => clearTimeout(id);
  }, [playing, at, evs.length]);

  // Latest full state at or before this step.
  const state = [...evs.slice(0, at + 1)].reverse().find((e) => e.backing_pct != null);
  const first = evs.find((e) => e.backing_pct != null);
  const mins = t ? Math.round(((t.finished_at || evs[evs.length - 1]?.at || t.started_at) - t.started_at) / 60000) : 0;

  return (
    <section className="page crash">
      <div className="pagehead">
        <h2>Crash test</h2>
        <p>
          A real stress test on NEAR testnet, on a separate test pool so the live pool is never touched. NEAR's price was pushed down{' '}
          {t ? `${t.drop_target_pct}%` : ''} on purpose to show what Bexley does: the safety rails slow the fall, the AI Guardian raises
          fees, and the Stability Pool steps in below 130% backing. bxUSD stays at $1 the whole time.
        </p>
      </div>
      {err && <p className="empty">{err}</p>}
      {t && state && (
        <>
          <div className="crash-top">
            <div className="crash-now">
              <div>
                <span className="hint">NEAR</span>
                <b>${state.price.toFixed(3)}</b>
                <small className={state.price < first.price ? 'down' : ''}>{(((state.price / first.price) - 1) * 100).toFixed(1)}%</small>
              </div>
              <div>
                <span className="hint">Backing</span>
                <b>{state.backing_pct.toFixed(0)}%</b>
                <small className={`chip ${state.mode === 'Healthy' ? 'green' : state.mode === 'Caution' ? 'amber' : 'red'}`}>{state.mode}</small>
              </div>
              <div>
                <span className="hint">bxUSD</span>
                <b className="t-bx">$1.00</b>
                <small>Held at $1</small>
              </div>
              <div>
                <span className="hint">xNEAR</span>
                <b className="t-x">${state.x_price.toFixed(4)}</b>
                <small>{state.leverage.toFixed(2)}x</small>
              </div>
              <div>
                <span className="hint">Stability Pool</span>
                <b>{state.sp_bx.toFixed(1)} bxUSD</b>
                <small>{state.sp_x > 0 ? `+ ${state.sp_x.toFixed(2)} xNEAR from protection` : 'No protection used yet'}</small>
              </div>
            </div>
            <CrashChart events={evs} at={at} />
            <div className="crash-controls">
              <button className="btn go sm" onClick={() => (at >= evs.length - 1 ? (setAt(0), setPlaying(true)) : setPlaying(!playing))}>
                {playing ? 'Pause' : at >= evs.length - 1 ? 'Replay' : at === 0 ? 'Play the crash' : 'Resume'}
              </button>
              <input type="range" min="0" max={evs.length - 1} value={at} onChange={(e) => (setPlaying(false), setAt(Number(e.target.value)))} aria-label="Step" />
              <span className="hint">
                Step {at + 1} of {evs.length} · {mins} minutes in real time
              </span>
            </div>
          </div>
          <ol className="feed crash-feed">
            {evs.slice(0, at + 1).map((e, i) => (
              <li key={i} className={`k-${e.kind === 'ai' ? 'rate' : e.kind === 'protect' ? 'protect' : e.kind === 'mode' ? 'order' : 'watch'}`}>
                <div className="meta">
                  <span className="k">{{ start: 'Start', price: 'Price post', ai: 'AI Guardian', mode: 'Mode change', protect: 'Protection', note: 'Note' }[e.kind] || e.kind}</span>
                  <span>{new Date(e.at).toLocaleTimeString()}</span>
                  {e.tx && (
                    <a href={`${TESTNET_EXPLORER}/txns/${e.tx}`} target="_blank" rel="noreferrer">
                      Transaction
                    </a>
                  )}
                  {e.proof_file && e.verified && (
                    <button className="verified" onClick={() => setOpen(open === i ? null : i)}>
                      {open === i ? 'Hide proof' : 'AI, verified'}
                    </button>
                  )}
                </div>
                <p>
                  {e.text}
                  {e.backing_pct != null && e.kind === 'price' && ` Backing ${e.backing_pct.toFixed(0)}%.`}
                </p>
                {open === i && e.proof_file && <ProofPanel entry={{ file: e.proof_file }} />}
              </li>
            ))}
          </ol>
          <p className="hint">
            Test pool: <a href={`${TESTNET_EXPLORER}/address/${t.pool}`} target="_blank" rel="noreferrer">{t.pool}</a>. Full log:{' '}
            <a href="https://github.com/Mandicrypt/bexley/blob/proofs/crashtest/timeline.json" target="_blank" rel="noreferrer">
              timeline.json
            </a>
          </p>
        </>
      )}
    </section>
  );
}

// ---------- Attack test ----------
const ATTACK_RAW = 'https://raw.githubusercontent.com/Mandicrypt/bexley/proofs/attacktest';
const LAYERS = [
  ['agent', 'The agent', "Bexley's code checks every AI answer before anything is sent."],
  ['key', 'The key', "NEAR itself refuses anything outside the Guardian key's limits."],
  ['contract', 'The contract', 'The pool enforces its own rules, even for the Guardian.'],
];

function AttackTest() {
  const [log, setLog] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch(`${ATTACK_RAW}/log.json?t=${Math.floor(Date.now() / 60000)}`)
      .then((r) => {
        if (!r.ok) throw new Error('The attack test has not run yet.');
        return r.json();
      })
      .then(setLog)
      .catch((e) => setErr(e.message));
  }, []);
  const word = { blocked: 'Blocked', capped: 'Capped', allowed: 'Went through' };
  const tone = { blocked: 'green', capped: 'amber', allowed: 'red' };
  return (
    <section className="page attack">
      <div className="pagehead">
        <h2>Attack test</h2>
        <p>
          What if the AI Guardian is hijacked, or its key is stolen? A test Guardian with the same limited key as the real one tried to do
          damage, on a separate test pool so the live pool is never touched. Every attempt below is a real testnet transaction or a real
          check in Bexley's code.
        </p>
      </div>
      {err && <p className="empty">{err}</p>}
      {log && (
        <>
          <p className="attack-sum">
            <b>{log.summary}</b> Run {new Date(log.started_at).toLocaleString()}.
          </p>
          {LAYERS.map(([id, name, what]) => {
            const rows = log.attempts.filter((a) => a.layer === id);
            if (!rows.length) return null;
            return (
              <div className="attack-layer" key={id}>
                <h3>{name}</h3>
                <p className="hint">{what}</p>
                <ul className="attack-list">
                  {rows.map((a, i) => (
                    <li key={i}>
                      <div className="meta">
                        <span className={`chip ${tone[a.result]}`}>{word[a.result]}</span>
                        <b>{a.title}</b>
                        {a.hash && (
                          <a href={`${TESTNET_EXPLORER}/txns/${a.hash}`} target="_blank" rel="noreferrer">
                            Transaction
                          </a>
                        )}
                      </div>
                      <p>{a.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="hint">
            Test Guardian: <a href={`${TESTNET_EXPLORER}/address/${log.guardian}`} target="_blank" rel="noreferrer">{log.guardian}</a>, whose
            only key can call {log.allowed_methods.join(', ')} on {log.pool}. Full log:{' '}
            <a href="https://github.com/Mandicrypt/bexley/blob/proofs/attacktest/log.json" target="_blank" rel="noreferrer">
              log.json
            </a>
            . Script: <a href="https://github.com/Mandicrypt/bexley/blob/main/agent/attack.mjs" target="_blank" rel="noreferrer">agent/attack.mjs</a>.
          </p>
        </>
      )}
    </section>
  );
}

function GuardianPage({ pool, go }) {
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
            <Fact
              k="Posts the NEAR price"
              v={
                <a href={`https://github.com/Mandicrypt/bexley/tree/proofs${IS_MAINNET ? '/mainnet' : ''}/prices`} target="_blank" rel="noreferrer">
                  Median of 3 exchanges
                </a>
              }
            />
            <Fact k="Fees, set by AI" v={s ? ['Normal, 1x', 'Volatile, 2x', 'Stormy, 3x'][s.fee_level] : '—'} />
            <Fact k="Savers' rate, set by AI" v={s ? `${pctRate(s.savings_rate_bps)} a year` : '—'} />
            <Fact k="Protections run" v={s ? s.stats.stabilizations : '—'} />
            <Fact k="Vault rebalances" v={s ? s.stats.rebalances : '—'} />
            <Fact k="Orders run" v={s ? s.stats.orders_executed : '—'} />
          </div>
          <p className="hint">
            Hard limits on every AI decision: fees 1x to 3x, rate 0% to 20%, at most 4 points of rate change at a time, and 0% whenever the
            pool isn't healthy. If the AI is unreachable, fixed rules take over. Every price post has a public receipt with the three
            exchange quotes, and the pool lets one post move the price at most 5%.
          </p>
          <LatestDecision pool={pool} />
          <div className="crash-links">
            <button className="btn line sm" onClick={() => go('crash-test')}>
              Watch the crash test
            </button>
            <button className="btn line sm" onClick={() => go('attack-test')}>
              See the attack test
            </button>
          </div>
          <div className="note provable">
            <b>Provable AI.</b> Every AI decision is signed inside NEAR AI's secure hardware. Click <em>AI, verified</em> on a note and
            your browser checks the signature itself, so you don't have to trust Bexley.
          </div>
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

// ---------- Portfolio ----------

/**
 * Everything one account holds in Bexley, valued in dollars at today's
 * prices, plus how much it moves with NEAR. Exposure: tNEAR 1x, xNEAR and
 * parked xNEAR at xNEAR's leverage, Steady vaults at their target, bxUSD 0x.
 */
export function portfolioRows(state, me, vaults) {
  const price = Number(state.price) / 1e6;
  const xp = Number(state.x_price) / 1e6;
  const xlev = Number(state.leverage_bps) / 10000 || 1;
  const rows = [];
  const add = (r) => r.usd > 0.005 && rows.push(r);
  add({ key: 'tnear', group: 'near', name: IS_MAINNET ? 'NEAR (wallet)' : 'tNEAR', where: 'Wallet', amount: `${toNum(me.tnear).toFixed(2)} ${IS_MAINNET ? 'NEAR' : 'tNEAR'}`, usd: toNum(me.tnear) * price, lev: 1, page: 'trade' });
  add({ key: 'xnear', group: 'lev', name: 'xNEAR', where: 'Wallet', amount: `${toNum(me.xnear).toFixed(2)} xNEAR`, usd: toNum(me.xnear) * xp, lev: xlev, page: 'trade' });
  add({ key: 'bx', group: 'stable', name: 'bxUSD', where: 'Wallet', amount: `${toNum(me.bx).toFixed(2)} bxUSD`, usd: toNum(me.bx), lev: 0, page: 'earn' });
  const sp = toNum(me.stability_pool?.value);
  add({ key: 'sp', group: 'stable', name: 'Stability Pool', where: `Earning ${pctRate(state.savings_rate_bps)} a year plus fees`, amount: `${sp.toFixed(2)} bxUSD`, usd: sp, lev: 0, page: 'earn' });
  for (const v of me.vaults || []) {
    const info = (vaults || []).find((x) => x.id === v.vault);
    const target = info ? Number(info.target_bps) / 10000 : v.vault + 2;
    add({ key: `v${v.vault}`, group: 'lev', name: `Steady ${target}x`, where: 'Vault', amount: `${toNum(v.value).toFixed(2)} ${IS_MAINNET ? 'NEAR' : 'tNEAR'}`, usd: toNum(v.value) * price, lev: target, page: 'vaults' });
  }
  for (const o of (me.orders || []).filter((o) => o.status === 'Open')) {
    const parts = [o.stop_price && `stop $${(Number(o.stop_price) / 1e6).toFixed(2)}`, o.take_price && `take $${(Number(o.take_price) / 1e6).toFixed(2)}`].filter(Boolean).join(', ');
    add({ key: `o${o.id}`, group: 'lev', name: `Order #${o.id}`, where: `Sells at ${parts}`, amount: `${toNum(o.x_amount).toFixed(2)} xNEAR`, usd: toNum(o.x_amount) * xp, lev: xlev, page: 'orders' });
  }
  const claim = toNum(me.claim_tnear) * price + toNum(me.claim_xnear) * xp;
  add({ key: 'claim', group: 'near', name: 'Waiting to be claimed', where: 'From earlier transfers', amount: '', usd: claim, lev: 1, page: 'claim' });
  const total = rows.reduce((a, r) => a + r.usd, 0);
  const exposure = total > 0 ? rows.reduce((a, r) => a + r.usd * r.lev, 0) / total : 0;
  const by = (g) => rows.filter((r) => r.group === g).reduce((a, r) => a + r.usd, 0);
  return { rows, total, exposure, mix: { stable: by('stable'), lev: by('lev'), near: by('near') } };
}

function Portfolio({ pool, me, accountId, onConnect, run, busy, go, onDemo, onOrders }) {
  const s = pool?.state;
  useEffect(() => {
    if (location.hash === '#orders') setTimeout(() => document.getElementById('orders')?.scrollIntoView({ block: 'start' }), 300);
  }, []);
  const $ = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (!accountId) {
    return (
      <section className="page portfolio">
        <div className="pagehead">
          <h2>Portfolio</h2>
          <p>Everything you hold in Bexley in one place: your tokens, savings, vaults and orders, in dollars.</p>
        </div>
        <div className="pf-empty">
          <button className="btn go" onClick={onConnect}>
            Connect wallet
          </button>
          {!IS_MAINNET && (
            <button className="btn quiet" onClick={onDemo}>
              Try the demo
            </button>
          )}
        </div>
      </section>
    );
  }
  if (!me || !s) {
    return (
      <section className="page portfolio">
        <div className="pagehead">
          <h2>Portfolio</h2>
        </div>
        <p className="empty">Loading your portfolio…</p>
      </section>
    );
  }

  const { rows, total, exposure, mix } = portfolioRows(s, me, pool.vaults);
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const manage = (r) => {
    if (r.page === 'orders') return onOrders();
    if (r.page === 'claim') return run('claim-stuck', claimStuck, 'Claimed.');
    go(r.page);
  };

  return (
    <>
      <section className="page portfolio">
        <div className="pagehead">
          <h2>Portfolio</h2>
          <p>Everything you hold in Bexley, valued at today's prices.</p>
        </div>

        <div className="pf-top">
          <div>
            <span className="hint">Total value</span>
            <b className="pf-total">{$(total)}</b>
          </div>
          <div>
            <span className="hint">Moves with NEAR</span>
            <b className="pf-exp">{exposure.toFixed(2)}x</b>
            <span className="hint">{exposure < 0.2 ? 'Mostly steady' : exposure < 1.2 ? 'About like holding NEAR' : 'More than NEAR, both ways'}</span>
          </div>
        </div>

        {total > 0 ? (
          <>
            <div className="pf-mix" role="img" aria-label="How your money is split">
              {mix.stable > 0 && <i className="m-stable" style={{ width: `${pct(mix.stable)}%` }} />}
              {mix.near > 0 && <i className="m-near" style={{ width: `${pct(mix.near)}%` }} />}
              {mix.lev > 0 && <i className="m-lev" style={{ width: `${pct(mix.lev)}%` }} />}
            </div>
            <div className="pf-legend">
              <span>
                <i className="m-stable" /> Steady {pct(mix.stable).toFixed(0)}%
              </span>
              <span>
                <i className="m-near" /> {IS_MAINNET ? 'NEAR' : 'tNEAR'} {pct(mix.near).toFixed(0)}%
              </span>
              <span>
                <i className="m-lev" /> Leveraged {pct(mix.lev).toFixed(0)}%
              </span>
            </div>

            <div className="pf-table" role="table" aria-label="Your holdings">
              {rows.map((r) => (
                <div className="pf-row" role="row" key={r.key}>
                  <div role="cell">
                    <b>{r.name}</b>
                    <span className="hint">{r.where}</span>
                  </div>
                  <div role="cell" className="pf-amt">
                    {r.amount}
                  </div>
                  <div role="cell" className="pf-usd">
                    <b>{$(r.usd)}</b>
                    <span className="hint">{pct(r.usd).toFixed(0)}%</span>
                  </div>
                  <div role="cell">
                    <button className="btn line sm" onClick={() => manage(r)} disabled={r.page === 'claim' && busy === 'claim-stuck'}>
                      {r.page === 'claim' ? 'Claim' : 'Manage'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="pf-what">
              <h3>If NEAR moves</h3>
              <div className="scen">
                {[-20, -10, 10, 20].map((mv) => {
                  const ch = rows.reduce((a, r) => a + r.usd * r.lev * (mv / 100), 0);
                  return (
                    <div key={mv} className="scen-cell">
                      <div className="l">If NEAR {mv > 0 ? 'rises' : 'falls'} {Math.abs(mv)}%</div>
                      <div className={`n ${ch >= 0 ? 'up' : 'down'}`}>
                        {ch >= 0 ? '+' : ''}
                        {$(ch)}
                      </div>
                      <div className="l">about {ch >= 0 ? '+' : ''}{pct(ch).toFixed(1)}%</div>
                    </div>
                  );
                })}
              </div>
              <p className="hint">Rough guide at today's leverage. bxUSD stays at $1 either way.</p>
            </div>
          </>
        ) : (
          <div className="pf-empty">
            <p>Nothing in Bexley yet.</p>
            <button className="btn go" onClick={() => go('trade')}>
              Make your first trade
            </button>
          </div>
        )}
      </section>
      <RiskCheck pool={pool} me={me} accountId={accountId} run={run} busy={busy} onOrders={onOrders} stopOnly />
      <Orders pool={pool} me={me} accountId={accountId} onConnect={onConnect} run={run} busy={busy} />
    </>
  );
}

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
        <p>Put bxUSD in the Stability Pool. You earn a savings rate paid by xNEAR holders, plus 80% of every fee.</p>
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
          <div className="note shield">
            <b>How it protects the pool.</b> If backing ever drops under 130%, part of your bxUSD turns into xNEAR at fair value. That
            xNEAR is yours, and you can withdraw any time.
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
          {!hasPos && s && (
            <Example>
              100 bxUSD in for 30 days at {pctRate(s.savings_rate_bps)} grows to about{' '}
              {(100 * (1 + Number(s.savings_rate_bps) / 10000 * 30 / 365)).toFixed(2)} bxUSD, plus a share of fees.
            </Example>
          )}
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
        <p>Steady means one fixed leverage, 2x or 3x, kept on target by the Guardian. xNEAR's own leverage floats; these vaults don't.</p>
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
  else if (amount && accountId && amount > BigInt(me.tnear)) problem = `That is more ${ASSET} than your wallet holds.`;
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
          <Fact k="Vault size" v={`${formatAmount(me?.demo && hasPos ? BigInt(v.value) + BigInt(pos.value) : v.value)} ${ASSET}`} />
          <Fact k="Your share" v={hasPos ? `${formatAmount(pos.value, 4)} ${ASSET}, ${money((BigInt(pos.value) * BigInt(s.price)) / 1_000_000n)}` : '—'} />
        </div>
        {!hasPos && s && (
          <Example>
            100 {ASSET} (about ${(100 * Number(s.price) / 1e6).toFixed(0)}) in Steady {Number(v.target_bps) / 10000}x: if NEAR rises 10%, about $
            {(100 * Number(s.price) / 1e6 * (1 + 0.1 * Number(v.target_bps) / 10000)).toFixed(0)}. If it falls 10%, about $
            {(100 * Number(s.price) / 1e6 * (1 - 0.1 * Number(v.target_bps) / 10000)).toFixed(0)}.
          </Example>
        )}
        {capped && <p className="hint">xNEAR itself is under {formatTimes(v.target_bps)} right now, so this vault holds only xNEAR.</p>}
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`v${v.id}`}>Deposit</label>
        <AmountRow id={`v${v.id}`} value={text} onChange={setText} max={me?.tnear} unit={ASSET} />
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
    <section className="page" id="orders">
      <div className="pagehead">
        <h2>Stop-loss and take-profit</h2>
        <p>Park xNEAR with a NEAR price to sell at. When NEAR gets there, the Guardian sells it and sends {IS_MAINNET ? 'wNEAR' : 'tNEAR'} to your wallet. The pool checks the price itself, so nobody can sell early.</p>
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
          {orders.length === 0 ? (
            s && (
              <Example>
                Protect 50 xNEAR: sell if NEAR falls to ${Number(suggestStop(Number(s.price) / 1e6, vol).price).toFixed(2)}. If NEAR gets there, the Guardian sells
                and sends {IS_MAINNET ? 'wNEAR' : 'tNEAR'} straight to your wallet. Until then you keep every gain.
              </Example>
            )
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
                      {o.status === 'Executed' && `. Sold at ${formatUsd(o.executed_price, 3)} for ${formatAmount(o.tnear_out, 4)} ${IS_MAINNET ? 'wNEAR' : 'tNEAR'}`}
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
            <a href={`${EXPLORER}/address/${TNEAR_ID}`} target="_blank" rel="noreferrer">{IS_MAINNET ? 'wNEAR' : 'tNEAR'}</a>
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

export function RiskCheck({ pool, me, accountId, run, busy, onOrders, stopOnly = false }) {
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

  if (stopOnly && x <= 0) return null;
  return (
    <section className={`risk${stopOnly ? ' stop-only' : ''}`} aria-label={stopOnly ? 'Suggested stop-loss' : 'Your risk'}>
      {!stopOnly && (
      <>
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
      </>
      )}
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
          {plan.steps.length > 0 && (plan.outcome || plan.risk) && (
            <div className="plan-facts">
              {plan.outcome && <Fact k="You'd end with" v={plan.outcome} />}
              {plan.risk && <Fact k="Main risk" v={plan.risk} />}
            </div>
          )}
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
