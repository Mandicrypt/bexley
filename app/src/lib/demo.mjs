// Demo mode: a pretend wallet that lives only in this browser tab.
//
// It uses the live pool's prices (and the pool's own `quote` view for mints
// and redeems), but nothing is signed or sent. Balances and positions are
// kept in memory and start with a few example positions, so a visitor can
// see every screen filled in and try every action without a wallet.

export const DEMO_ID = 'demo.testnet';

const ONE = 10n ** 24n;
const YEAR_MS = 365 * 24 * 3600 * 1000;
const base = (n) => BigInt(Math.round(Math.max(0, n) * 1e6)) * 10n ** 18n;
const whole = (v) => Number(BigInt(v) / 10n ** 18n) / 1e6;
const nsNow = () => BigInt(Date.now()) * 1_000_000n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * getPool() returns the latest loaded pool ({state, vaults, notes}).
 * quoteFn(action, amountBigInt) is the pool's real quote view.
 */
export function createDemo(getPool, quoteFn) {
  let st = null;

  const live = () => {
    const s = getPool()?.state;
    if (!s) throw new Error('Waiting for live prices. Try again in a moment.');
    return { p: Number(s.price) / 1e6, xp: Number(s.x_price) / 1e6, rateBps: Number(s.savings_rate_bps), s };
  };

  const vaultLev = (id) => {
    const v = getPool()?.vaults?.find((x) => x.id === id);
    return v ? Number(v.target_bps) / 10000 : id + 2;
  };

  /** Seed the example positions from today's prices. */
  function seed() {
    const { p } = live();
    const now = Date.now();
    st = {
      tnear: 600,
      xnear: 100,
      bx: 50,
      sp: { bx: 200, since: now - 7 * 24 * 3600 * 1000 },
      vaults: { 0: { usd0: 100 * p * 0.97, p0: p * 0.97 } },
      orders: [
        { id: 1, x_amount: 50, stop: Math.round(p * 0.9 * 1e4) / 1e4, take: null, status: 'Open', created: now - 3600_000 },
      ],
      nextId: 2,
      nextClaimAt: 0,
    };
  }

  const spNow = () => {
    if (!st.sp.bx) return 0;
    const { rateBps } = live();
    return st.sp.bx * (1 + (rateBps / 10000) * ((Date.now() - st.sp.since) / YEAR_MS));
  };

  const vaultUsd = (id) => {
    const v = st.vaults[id];
    if (!v) return 0;
    const { p } = live();
    return Math.max(0, v.usd0 * (1 + vaultLev(id) * (p / v.p0 - 1)));
  };

  /** Orders whose price has been reached are sold, like the Guardian would. */
  function settleOrders() {
    const { p, xp } = live();
    for (const o of st.orders) {
      if (o.status !== 'Open') continue;
      if ((o.stop && p <= o.stop) || (o.take && p >= o.take)) {
        o.status = 'Executed';
        o.executed = p;
        o.out = (o.x_amount * xp) / p;
        st.tnear += o.out;
      }
    }
  }

  function account() {
    if (!st) seed();
    settleOrders();
    if (st.nextClaimAt && st.nextClaimAt <= Date.now()) st.nextClaimAt = 0;
    const { p } = live();
    const sp = spNow();
    return {
      demo: true,
      tnear: base(st.tnear).toString(),
      xnear: base(st.xnear).toString(),
      nextClaimAt: st.nextClaimAt ? (BigInt(st.nextClaimAt) * 1_000_000n).toString() : '0',
      bx: base(st.bx).toString(),
      stability_pool: { shares: base(sp).toString(), bx: base(sp).toString(), x: '0', value: base(sp).toString() },
      vaults: Object.keys(st.vaults).map((id) => {
        const t = vaultUsd(Number(id)) / p;
        return { vault: Number(id), shares: base(t).toString(), value: base(t).toString() };
      }),
      orders: st.orders.map((o) => ({
        id: o.id,
        owner: DEMO_ID,
        x_amount: base(o.x_amount).toString(),
        stop_price: o.stop ? String(Math.round(o.stop * 1e6)) : null,
        take_price: o.take ? String(Math.round(o.take * 1e6)) : null,
        created_at: (BigInt(o.created) * 1_000_000n).toString(),
        status: o.status,
        executed_price: o.executed ? String(Math.round(o.executed * 1e6)) : null,
        tnear_out: o.out ? base(o.out).toString() : null,
      })),
      claim_tnear: '0',
      claim_xnear: '0',
    };
  }

  const need = (have, amt, name) => {
    if (amt > have + 1e-9) throw new Error(`That is more ${name} than your demo wallet holds.`);
  };

  async function swap(action, units, payKey, getKey, name) {
    const amt = whole(units);
    need(st[payKey], amt, name);
    const out = BigInt(await quoteFn(action, units));
    if (out === 0n) throw new Error('The pool cannot do this right now.');
    await wait(500);
    st[payKey] -= amt;
    st[getKey] += whole(out);
  }

  return {
    reset: () => {
      st = null;
    },
    account,
    claimTnear: async () => {
      if (st.nextClaimAt > Date.now()) throw new Error('You can claim again in an hour.');
      await wait(400);
      st.tnear += 100;
      st.nextClaimAt = Date.now() + 3600_000;
    },
    mintX: (t) => swap('mint_x', t, 'tnear', 'xnear', 'tNEAR'),
    mintBx: (t) => swap('mint_bx', t, 'tnear', 'bx', 'tNEAR'),
    redeemX: (x) => swap('redeem_x', x, 'xnear', 'tnear', 'xNEAR'),
    redeemBx: (b) => swap('redeem_bx', b, 'bx', 'tnear', 'bxUSD'),
    spDeposit: async (b) => {
      const amt = whole(b);
      need(st.bx, amt, 'bxUSD');
      await wait(400);
      st.sp = { bx: spNow() + amt, since: Date.now() };
      st.bx -= amt;
    },
    spWithdraw: async () => {
      await wait(400);
      st.bx += spNow();
      st.sp = { bx: 0, since: Date.now() };
    },
    vaultDeposit: async (vault, t) => {
      const amt = whole(t);
      need(st.tnear, amt, 'tNEAR');
      const { p } = live();
      await wait(500);
      st.vaults[vault] = { usd0: vaultUsd(vault) + amt * p, p0: p };
      st.tnear -= amt;
    },
    vaultWithdraw: async (vault) => {
      const { p } = live();
      await wait(500);
      st.tnear += vaultUsd(vault) / p;
      delete st.vaults[vault];
    },
    placeOrder: async (x, stop, take) => {
      const amt = whole(x);
      need(st.xnear, amt, 'xNEAR');
      await wait(400);
      st.xnear -= amt;
      st.orders.push({
        id: st.nextId++,
        x_amount: amt,
        stop: stop ? Number(stop) / 1e6 : null,
        take: take ? Number(take) / 1e6 : null,
        status: 'Open',
        created: Date.now(),
      });
    },
    cancelOrder: async (id) => {
      const o = st.orders.find((o) => o.id === id);
      if (!o || o.status !== 'Open') throw new Error('That order is not open.');
      await wait(300);
      o.status = 'Cancelled';
      st.xnear += o.x_amount;
    },
    claimStuck: async () => {},
  };
}

export { ONE };
