import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  APP_ID, EXPLORER, TOKEN_ID, connect, disconnect, currentAccount, getConnector, loadMarket, loadAccount,
  claimTokens, createSave, createOffer, cancelSave, takeOffer, closeOffer, settleDeal, withdraw, errorText,
} from './lib/near.js';
import {
  parseAmount, formatAmount, formatUsd, usdValue, formatRate, parseRate, lengthLabel, grownAmount, timeLeft, shortAccount,
} from './lib/format.mjs';
import { rankOffers } from '../../agent/logic.mjs';

const REFRESH_MS = 15_000;

export default function App() {
  const [market, setMarket] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('save');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setMarket(await loadMarket());
      setLoadError('');
    } catch (e) {
      setLoadError('Could not reach NEAR testnet. Retrying…');
    }
    if (accountId) {
      try {
        setMe(await loadAccount(accountId));
      } catch {
        /* keep the last good data */
      }
    } else {
      setMe(null);
    }
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

  /** Run a wallet action with a busy state, a result message and a refresh. */
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

  const counts = me
    ? {
        mine:
          me.saves.filter((s) => s.status === 'Open').length +
          me.deals.filter((d) => d.status === 'Active').length,
      }
    : { mine: 0 };

  return (
    <>
      <Header accountId={accountId} me={me} onConnect={onConnect} onDisconnect={onDisconnect} run={run} busy={busy} />
      <main className="wrap">
        {!accountId && <Hero onConnect={onConnect} />}
        <Stats market={market} error={loadError} />
        <nav className="tabs" role="tablist" aria-label="Bexley sections">
          {[
            ['save', 'Save'],
            ['risk', 'Take risk'],
            ['mine', 'My deals', counts.mine],
            ['market', 'Market'],
          ].map(([id, label, n]) => (
            <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
              {n ? <span className="count">{n}</span> : null}
            </button>
          ))}
        </nav>
        {tab === 'save' && <SavePanel market={market} me={me} accountId={accountId} onConnect={onConnect} run={run} busy={busy} />}
        {tab === 'risk' && <RiskPanel market={market} me={me} accountId={accountId} onConnect={onConnect} run={run} busy={busy} />}
        {tab === 'mine' && <MyDeals market={market} me={me} accountId={accountId} onConnect={onConnect} run={run} busy={busy} />}
        {tab === 'market' && <Market market={market} />}
      </main>
      <footer>
        <div className="wrap">
          Bexley runs on NEAR testnet with tNEAR, a free test token with no real value. Contract:{' '}
          <a href={`${EXPLORER}/address/${APP_ID}`} target="_blank" rel="noreferrer">{APP_ID}</a>. Built for the NEAR Hackathon.
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

// ---------- Pieces ----------

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
              Wallet: <b className="num">{me ? formatAmount(me.tokenBalance) : '…'}</b> tNEAR
            </span>
            <button
              className="btn green small"
              disabled={!canClaim || busy === 'claim'}
              title={canClaim ? 'Get 100 free test tNEAR' : `You can claim again in ${me ? timeLeft(me.nextClaimAt) : '…'}`}
              onClick={() => run('claim', claimTokens, '100 tNEAR added to your wallet.')}
            >
              {busy === 'claim' ? 'Claiming…' : !me ? 'Get 100 tNEAR' : canClaim ? 'Get 100 tNEAR' : `Next claim in ${timeLeft(me.nextClaimAt)}`}
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
          Keep your dollars safe, or <em>take the upside</em>.
        </h1>
        <p>
          Bexley pairs savers and risk-takers in one pool on NEAR. Savers lock in the dollar value of their deposit plus a fixed rate.
          Risk-takers pay that rate and take the price move, with leverage. An AI agent finds each saver the best offer.
        </p>
        <button className="btn green" onClick={onConnect}>
          Connect a testnet wallet
        </button>
      </div>
      <div className="sides">
        <div className="side">
          <b>Savers</b>
          <span className="hint">Your deposit keeps its dollar value and earns a fixed rate. Risk-takers' margin pays you first if the price falls.</span>
        </div>
        <div className="side">
          <b>Risk-takers</b>
          <span className="hint">Put up margin, pay savers a rate, and keep the gains when NEAR rises, up to 11x exposure.</span>
        </div>
        <div className="side">
          <b>The agent</b>
          <span className="hint">Matches each saving with its best offer and settles deals on time. Its key can't move funds.</span>
        </div>
      </div>
    </section>
  );
}

function Stats({ market, error }) {
  const p = market?.price;
  const fresh = p?.fresh;
  return (
    <section className="stats" aria-label="Bexley numbers">
      <div className="stat">
        <div className="k">NEAR price</div>
        <div className="v num">{p && BigInt(p.price) > 0n ? formatUsd(p.price, 3) : '—'}</div>
        <div className="s">
          <span className={`dot${fresh && !error ? '' : ' off'}`} />
          {error ? error : fresh ? 'Live, posted by the agent' : 'Waiting for a fresh price'}
        </div>
      </div>
      <div className="stat">
        <div className="k">Matched volume</div>
        <div className="v num">{market ? formatAmount(market.stats.matched_volume, 0) : '—'}</div>
        <div className="s">tNEAR in deals</div>
      </div>
      <div className="stat">
        <div className="k">Deals</div>
        <div className="v num">{market ? market.stats.deals : '—'}</div>
        <div className="s">{market ? `${market.stats.deals_settled} settled` : ' '}</div>
      </div>
      <div className="stat">
        <div className="k">Users</div>
        <div className="v num">{market ? market.stats.users : '—'}</div>
        <div className="s">{market ? `${market.saves.length} waiting · ${market.offers.length} offers` : ' '}</div>
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

function LengthChips({ durations, value, onChange, multi }) {
  return (
    <div className="chips">
      {durations.map((d) => {
        const on = multi ? value.includes(d) : value === d;
        return (
          <button
            key={d}
            type="button"
            className="chip"
            aria-pressed={on}
            onClick={() => (multi ? onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b)) : onChange(d))}
          >
            {lengthLabel(d)}
          </button>
        );
      })}
    </div>
  );
}

function AmountInput({ id, value, onChange, max }) {
  return (
    <div className="inputrow">
      <input id={id} inputMode="decimal" placeholder="0.0" value={value} onChange={(e) => onChange(e.target.value)} />
      {max != null && BigInt(max) > 0n && (
        <button type="button" className="max" onClick={() => onChange(formatAmount(max, 6).replace(/,/g, ''))}>
          MAX
        </button>
      )}
      <span className="unit">tNEAR</span>
    </div>
  );
}

// ---------- Save ----------

function SavePanel({ market, me, accountId, onConnect, run, busy }) {
  const durations = market?.config?.durations || [600, 3600, 86400];
  const [amountText, setAmountText] = useState('10');
  const [length, setLength] = useState(600);
  const [minRateText, setMinRateText] = useState('0');

  const amount = parseAmount(amountText);
  const minRate = parseRate(minRateText);
  const price = market ? BigInt(market.price.price) : 0n;
  const minDeposit = market ? BigInt(market.config.min_deposit) : 0n;
  const wallet = me ? BigInt(me.tokenBalance) : 0n;

  // What the market would give this saving right now.
  const best = useMemo(() => {
    if (!market || !amount) return null;
    const fake = { id: -1, owner: accountId || '_', amount: amount.toString(), duration_secs: length, min_rate_bps: minRate ?? 0, created_at: '0' };
    const free = new Map(market.offers.map((o) => [o.id, BigInt(o.margin_available)]));
    return rankOffers(fake, market.offers, free)[0] || null;
  }, [market, amount, length, minRate, accountId]);

  let problem = '';
  if (!amount) problem = 'Enter an amount.';
  else if (amount < minDeposit) problem = `The minimum is ${formatAmount(minDeposit)} tNEAR.`;
  else if (accountId && !me) problem = 'Loading your wallet balance…';
  else if (accountId && amount > wallet) problem = 'That is more tNEAR than your wallet holds. Use "Get 100 tNEAR" at the top.';
  else if (minRate == null) problem = 'Enter a minimum rate between 0% and 500%.';

  const dollars = amount && price ? usdValue(amount, price) : 0n;
  const rateForPreview = best ? best.rate_bps : minRate ?? 0;
  const grownDollars = amount && price ? usdValue(grownAmount(amount, rateForPreview, length), price) : 0n;

  return (
    <div className="grid2">
      <section className="card">
        <h2>Save</h2>
        <p className="lead">Deposit tNEAR and lock in its dollar value plus a fixed rate. If NEAR falls, a risk-taker's margin covers you.</p>
        <div className="field">
          <label htmlFor="save-amount">Amount</label>
          <AmountInput id="save-amount" value={amountText} onChange={setAmountText} max={me?.tokenBalance} />
        </div>
        <div className="field">
          <span className="label">Deal length</span>
          <LengthChips durations={durations} value={length} onChange={setLength} />
          <span className="hint">10 minutes and 1 hour are for trying Bexley quickly.</span>
        </div>
        <div className="field">
          <label htmlFor="save-rate">Lowest rate you accept (per year)</label>
          <div className="inputrow">
            <input id="save-rate" inputMode="decimal" value={minRateText} onChange={(e) => setMinRateText(e.target.value)} />
            <span className="unit">%</span>
          </div>
          <span className="hint">The agent only matches you with offers at or above this.</span>
        </div>
        {problem && amountText !== '' ? <p className="err">{problem}</p> : null}
        {accountId ? (
          <button
            className="btn green wide"
            disabled={!!problem || busy === 'save'}
            onClick={() => run('save', () => createSave(amount, length, minRate), 'Saving created. The agent will match it soon, or pick an offer yourself in My deals.')}
          >
            {busy === 'save' ? 'Confirm in your wallet…' : 'Save'}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="save" />
        )}
      </section>
      <aside className="card soft">
        <h3>What you lock in</h3>
        <div className="rows">
          <div className="row"><span>NEAR price now</span><span>{price ? formatUsd(price, 3) : '—'}</span></div>
          <div className="row"><span>Your deposit's value</span><span>{dollars ? formatUsd(dollars) : '—'}</span></div>
          <div className="row"><span>Best offer now</span><span>{best ? `${formatRate(best.rate_bps)} a year` : 'None yet'}</span></div>
          <div className="sep" />
          <div className="row big"><span>Value at the end</span><span>{grownDollars ? formatUsd(grownDollars, 4) : '—'}</span></div>
          <div className="row"><span>Paid in tNEAR at the end price</span><span>{lengthLabel(length)}</span></div>
        </div>
        <p className="note" style={{ marginTop: 16 }}>
          {best
            ? `A risk-taker is ready: ${formatRate(best.rate_bps)} a year with ${best.max_cover + 1}x exposure on their side. You'll be matched within about 15 minutes, or right away from My deals.`
            : 'No offer fits this yet. Your saving waits safely until one does, and you can cancel any time before a match.'}
        </p>
      </aside>
    </div>
  );
}

// ---------- Take risk ----------

function RiskPanel({ market, me, accountId, onConnect, run, busy }) {
  const durations = market?.config?.durations || [600, 3600, 86400];
  const [amountText, setAmountText] = useState('20');
  const [rateText, setRateText] = useState('10');
  const [lengths, setLengths] = useState([600, 3600, 86400]);
  const [cover, setCover] = useState(3);

  const amount = parseAmount(amountText);
  const rate = parseRate(rateText);
  const price = market ? BigInt(market.price.price) : 0n;
  const minDeposit = market ? BigInt(market.config.min_deposit) : 0n;
  const wallet = me ? BigInt(me.tokenBalance) : 0n;

  let problem = '';
  if (!amount) problem = 'Enter your margin.';
  else if (amount < minDeposit) problem = `The minimum is ${formatAmount(minDeposit)} tNEAR.`;
  else if (accountId && !me) problem = 'Loading your wallet balance…';
  else if (accountId && amount > wallet) problem = 'That is more tNEAR than your wallet holds. Use "Get 100 tNEAR" at the top.';
  else if (rate == null || rate === 0) problem = 'Enter a rate above 0%.';
  else if (lengths.length === 0) problem = 'Pick at least one deal length.';

  const capacity = amount ? amount * BigInt(cover) : 0n;
  const exposure = cover + 1;
  const waiting = market?.saves.filter((s) => lengths.includes(s.duration_secs) && s.min_rate_bps <= (rate ?? 0)) || [];

  return (
    <div className="grid2">
      <section className="card">
        <h2>Take risk</h2>
        <p className="lead">Put up margin and pay savers a rate. You take the price move on the whole deal, so you gain more when NEAR rises and lose your margin first when it falls.</p>
        <div className="field">
          <label htmlFor="risk-amount">Margin</label>
          <AmountInput id="risk-amount" value={amountText} onChange={setAmountText} max={me?.tokenBalance} />
        </div>
        <div className="field">
          <label htmlFor="risk-rate">Rate you pay savers (per year)</label>
          <div className="inputrow">
            <input id="risk-rate" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
            <span className="unit">%</span>
          </div>
          <span className="hint">Higher rates win savers first.</span>
        </div>
        <div className="field">
          <span className="label">Deal lengths you accept</span>
          <LengthChips durations={durations} value={lengths} onChange={setLengths} multi />
        </div>
        <div className="field">
          <span className="label">Exposure</span>
          <div className="chips">
            {[1, 2, 3, 5, 10].map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={cover === c} onClick={() => setCover(c)}>
                {c + 1}x
              </button>
            ))}
          </div>
          <span className="hint">At {exposure}x, each tNEAR of margin backs {cover} tNEAR of savings.</span>
        </div>
        {problem && amountText !== '' ? <p className="err">{problem}</p> : null}
        {accountId ? (
          <button
            className="btn wide"
            disabled={!!problem || busy === 'offer'}
            onClick={() => run('offer', () => createOffer(amount, rate, lengths, cover), 'Offer posted. The agent will match savers to it.')}
          >
            {busy === 'offer' ? 'Confirm in your wallet…' : 'Post offer'}
          </button>
        ) : (
          <ConnectFirst onConnect={onConnect} what="take risk" />
        )}
      </section>
      <aside className="card soft">
        <h3>Your offer</h3>
        <div className="rows">
          <div className="row"><span>Margin value</span><span>{amount && price ? formatUsd(usdValue(amount, price)) : '—'}</span></div>
          <div className="row"><span>Savings you can back</span><span>{capacity ? `${formatAmount(capacity)} tNEAR` : '—'}</span></div>
          <div className="row"><span>Your exposure</span><span>{exposure}x NEAR</span></div>
          <div className="sep" />
          <div className="row"><span>If NEAR rises 10%</span><span>≈ +{(exposure * 10).toFixed(0)}% on margin</span></div>
          <div className="row"><span>If NEAR falls 10%</span><span>≈ −{Math.min(100, exposure * 10).toFixed(0)}% on margin</span></div>
          <div className="row"><span>Bexley fee</span><span>10% of profit only</span></div>
        </div>
        <p className={`note${waiting.length ? '' : ' warn'}`} style={{ marginTop: 16 }}>
          {waiting.length
            ? `${waiting.length} saving${waiting.length > 1 ? 's are' : ' is'} waiting that this offer could take.`
            : 'No savings are waiting for these terms right now. Your offer stays open until savers arrive, and you can close it any time.'}{' '}
          Before costs, rough figures; the rate you pay savers comes out of your share.
        </p>
      </aside>
    </div>
  );
}

// ---------- My deals ----------

function MyDeals({ market, me, accountId, onConnect, run, busy }) {
  if (!accountId) return <div className="card"><h2>My deals</h2><p className="lead">Connect your wallet to see your savings, offers and deals.</p><ConnectFirst onConnect={onConnect} what="see your deals" /></div>;
  if (!me || !market) return <p className="empty">Loading your deals…</p>;

  const balance = BigInt(me.balance);
  const freeMargins = new Map(market.offers.map((o) => [o.id, BigInt(o.margin_available)]));
  const saves = [...me.saves].sort((a, b) => b.id - a.id);
  const offers = [...me.offers].sort((a, b) => b.id - a.id);
  const deals = [...me.deals].sort((a, b) => b.id - a.id);

  return (
    <div>
      <section className="section card soft" style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div className="label">Ready to withdraw</div>
          <div className="num" style={{ fontSize: 24, fontWeight: 600 }}>{formatAmount(balance, 4)} tNEAR</div>
          <div className="hint">Settled deals, cancelled savings and closed offers land here.</div>
        </div>
        <button className="btn green" disabled={balance === 0n || busy === 'withdraw'} onClick={() => run('withdraw', withdraw, 'Sent to your wallet.')}>
          {busy === 'withdraw' ? 'Confirm in your wallet…' : 'Withdraw to wallet'}
        </button>
      </section>

      <section className="section">
        <div className="sectionhead"><h3>Deals</h3></div>
        {deals.length === 0 ? (
          <p className="empty">No deals yet. Save or post an offer, and matched deals appear here.</p>
        ) : (
          <div className="list">
            {deals.map((d) => (
              <DealItem key={d.id} d={d} me={accountId} quote={me.quoteById[d.id]} run={run} busy={busy} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="sectionhead"><h3>Savings</h3></div>
        {saves.length === 0 ? (
          <p className="empty">No savings yet.</p>
        ) : (
          <div className="list">
            {saves.map((s) => {
              const best = s.status === 'Open' ? rankOffers(s, market.offers, freeMargins)[0] : null;
              return (
                <div className="item" key={s.id}>
                  <div>
                    <div className="title">
                      <StatusTag status={s.status} /> {formatAmount(s.amount)} tNEAR for {lengthLabel(s.duration_secs)}
                    </div>
                    <div className="meta">
                      Saving #{s.id} · lowest rate {formatRate(s.min_rate_bps)}
                      {s.status === 'Open' && (best ? ` · best offer ${formatRate(best.rate_bps)}` : ' · waiting for an offer')}
                      {s.deal_id != null && ` · deal #${s.deal_id}`}
                    </div>
                  </div>
                  {s.status === 'Open' && (
                    <div className="actions">
                      {best && (
                        <button className="btn green small" disabled={busy === `take${s.id}`} onClick={() => run(`take${s.id}`, () => takeOffer(s.id, best.id), `Matched at ${formatRate(best.rate_bps)} a year.`)}>
                          Take {formatRate(best.rate_bps)} now
                        </button>
                      )}
                      <button className="btn ghost small" disabled={busy === `cancel${s.id}`} onClick={() => run(`cancel${s.id}`, () => cancelSave(s.id), 'Cancelled. Your deposit is ready to withdraw.')}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <div className="sectionhead"><h3>Offers</h3></div>
        {offers.length === 0 ? (
          <p className="empty">No offers yet.</p>
        ) : (
          <div className="list">
            {offers.map((o) => (
              <div className="item" key={o.id}>
                <div>
                  <div className="title">
                    <StatusTag status={o.status} /> {formatRate(o.rate_bps)} a year · {o.max_cover + 1}x
                  </div>
                  <div className="meta">
                    Offer #{o.id} · {formatAmount(o.margin_available)} of {formatAmount(o.margin_total)} tNEAR free · {o.durations.map((x) => lengthLabel(x, true)).join(', ')}
                  </div>
                </div>
                {o.status === 'Active' && (
                  <div className="actions">
                    <button className="btn ghost small" disabled={busy === `close${o.id}`} onClick={() => run(`close${o.id}`, () => closeOffer(o.id), 'Offer closed. Free margin is ready to withdraw.')}>
                      Close offer
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusTag({ status }) {
  const cls = { Open: 'green', Active: 'green', Matched: 'ink', Settled: '', Cancelled: '', Closed: '' }[status] ?? '';
  return <span className={`tag ${cls}`}>{status}</span>;
}

function DealItem({ d, me, quote, run, busy }) {
  const saver = d.saver === me;
  const role = saver ? 'Saver' : 'Risk-taker';
  const active = d.status === 'Active';
  const mineNow = quote ? (saver ? quote.saver_payout : quote.risk_taker_payout) : null;
  const mineFinal = saver ? d.saver_payout : d.risk_taker_payout;
  const put = saver ? d.saver_amount : d.margin;
  return (
    <div className="item">
      <div>
        <div className="title">
          <StatusTag status={d.status} />
          {quote?.at_risk && active ? <span className="tag red">Protection</span> : null}
          Deal #{d.id} · {role} · {formatAmount(d.saver_amount)} + {formatAmount(d.margin)} tNEAR
        </div>
        <div className="meta">
          {formatRate(d.rate_bps)} a year · {lengthLabel(d.duration_secs)} · entry {formatUsd(d.entry_price, 3)}
          {active ? ` · ${timeLeft(d.end_at)} left` : d.exit_price ? ` · exit ${formatUsd(d.exit_price, 3)}${d.settled_early ? ' (settled early)' : ''}` : ''}
        </div>
        <div className="meta">
          You put in <span className="num">{formatAmount(put, 4)}</span> ·{' '}
          {active
            ? mineNow != null
              ? <>if settled now you get <span className="num">{formatAmount(mineNow, 4)}</span> tNEAR</>
              : 'waiting for a price'
            : <>you got <span className="num">{formatAmount(mineFinal, 4)}</span> tNEAR</>}
        </div>
      </div>
      {active && quote?.can_settle && (
        <div className="actions">
          <button className="btn green small" disabled={busy === `settle${d.id}`} onClick={() => run(`settle${d.id}`, () => settleDeal(d.id), 'Deal settled. Your share is ready to withdraw.')}>
            Settle now
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Market ----------

function Market({ market }) {
  if (!market) return <p className="empty">Loading the market…</p>;
  const offers = [...market.offers].sort((a, b) => b.rate_bps - a.rate_bps || a.max_cover - b.max_cover);
  return (
    <div>
      <section className="section">
        <div className="sectionhead"><h3>Offers from risk-takers</h3><span className="hint">Best rate first</span></div>
        {offers.length === 0 ? (
          <p className="empty">No open offers right now.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Rate</th><th>Exposure</th><th>Free margin</th><th>Lengths</th><th>By</th></tr></thead>
              <tbody>
                {offers.map((o) => (
                  <tr key={o.id}>
                    <td className="num">{formatRate(o.rate_bps)}</td>
                    <td className="num">{o.max_cover + 1}x</td>
                    <td className="num">{formatAmount(o.margin_available)}</td>
                    <td>{o.durations.map((x) => lengthLabel(x, true)).join(', ')}</td>
                    <td>{shortAccount(o.owner)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="section">
        <div className="sectionhead"><h3>Savings waiting</h3></div>
        {market.saves.length === 0 ? (
          <p className="empty">Nobody is waiting. Every saving has been matched.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Amount</th><th>Length</th><th>Lowest rate</th><th>By</th></tr></thead>
              <tbody>
                {market.saves.map((s) => (
                  <tr key={s.id}>
                    <td className="num">{formatAmount(s.amount)}</td>
                    <td>{lengthLabel(s.duration_secs)}</td>
                    <td className="num">{formatRate(s.min_rate_bps)}</td>
                    <td>{shortAccount(s.owner)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="section">
        <div className="sectionhead"><h3>Recent deals</h3></div>
        {market.recent.length === 0 ? (
          <p className="empty">No deals yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Deal</th><th>Size</th><th>Rate</th><th>Length</th><th>Status</th><th>Matched by</th></tr></thead>
              <tbody>
                {market.recent.map((d) => (
                  <tr key={d.id}>
                    <td className="num">#{d.id}</td>
                    <td className="num">{formatAmount(BigInt(d.saver_amount) + BigInt(d.margin))}</td>
                    <td className="num">{formatRate(d.rate_bps)}</td>
                    <td>{lengthLabel(d.duration_secs, true)}</td>
                    <td><StatusTag status={d.status} /></td>
                    <td>{d.matched_by === market.config.agent ? 'Agent' : 'Saver'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="hint">
        Token: <a href={`${EXPLORER}/address/${TOKEN_ID}`} target="_blank" rel="noreferrer">{TOKEN_ID}</a> · Agent:{' '}
        <a href={`${EXPLORER}/address/${market.config.agent}`} target="_blank" rel="noreferrer">{market.config.agent}</a>
      </p>
    </div>
  );
}

