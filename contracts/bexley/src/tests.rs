use super::*;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const T: u128 = ONE;
const P: u128 = 4_000_000; // $4.00
const NS: u64 = 1_000_000_000;
const START: u64 = 1_000 * NS;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, ts: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .current_account_id(acc("pool.test"))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts)
        .build());
}

fn setup() -> Contract {
    ctx("owner.test", START, 0);
    let mut c = Contract::new(acc("tnear.test"), acc("xnear.test"), acc("guardian.test"), acc("feeder.test"));
    price(&mut c, P);
    c
}

fn price(c: &mut Contract, p: u128) {
    ctx("feeder.test", START, 0);
    c.set_price(U128(p));
}

fn send(c: &mut Contract, token: &str, from: &str, amount: u128, msg: &str) {
    ctx(token, START, 0);
    let _ = c.ft_on_transfer(acc(from), U128(amount), msg.to_string());
}

fn mint_x(c: &mut Contract, who: &str, t: u128) {
    send(c, "tnear.test", who, t, r#"{"type":"mint_x"}"#);
}

fn mint_bx(c: &mut Contract, who: &str, t: u128) {
    send(c, "tnear.test", who, t, r#"{"type":"mint_bx"}"#);
}

fn bx_of(c: &Contract, who: &str) -> u128 {
    c.ft_balance_of(acc(who)).0
}

/// Within 0.01% (rounding).
fn close(a: u128, b: u128) -> bool {
    let d = a.abs_diff(b);
    d * 10_000 <= b.max(1)
}

/// A pool with 100 tNEAR of xNEAR and 150 tNEAR worth of bxUSD:
/// TVL $1000, bxUSD ~$600, backing ~167%, xNEAR ~2.5x.
fn seeded() -> Contract {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 100 * T); // $400 of xNEAR
    mint_bx(&mut c, "saver.test", 150 * T); // $600 of bxUSD
    c
}

// ---------- Basics ----------

#[test]
fn first_xnear_mints_at_one_dollar() {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 10 * T);
    let p = c.get_pool();
    // 10 tNEAR = $40, minus 0.5% fee = $39.80 of xNEAR at $1.
    assert_eq!(p.x_supply.0, 3980 * T / 100);
    assert_eq!(p.collateral.0, 10 * T);
    assert_eq!(p.mode, Mode::Healthy);
    assert_eq!(c.x_external, 3980 * T / 100);
}

#[test]
fn bxusd_mints_at_price_minus_fee() {
    let c = seeded();
    // 150 tNEAR * $4 = $600, minus 0.2% = $598.80.
    assert_eq!(bx_of(&c, "saver.test"), 59880 * T / 100);
}

#[test]
fn bxusd_needs_xnear_backing_first() {
    let mut c = setup();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| mint_bx(&mut c, "saver.test", 10 * T)));
    assert!(r.is_err(), "bxUSD with no xNEAR behind it must be refused");
}

#[test]
fn ratios_and_leverage() {
    let c = seeded();
    let p = c.get_pool();
    // TVL $1000, bxUSD ~$600 -> CR ~167%, leverage ~2.5x.
    assert!(p.cr_bps.0 >= 16_500 && p.cr_bps.0 <= 16_800, "cr {}", p.cr_bps.0);
    assert!(p.leverage_bps.0 >= 24_500 && p.leverage_bps.0 <= 25_500, "lev {}", p.leverage_bps.0);
}

#[test]
fn minting_does_not_move_xnear_price_except_fees() {
    let mut c = seeded();
    let nav0 = c.get_pool().x_price.0;
    mint_x(&mut c, "other.test", 50 * T);
    let nav1 = c.get_pool().x_price.0;
    // Fees only ever add value to existing holders.
    assert!(nav1 >= nav0);
    assert!(close(nav1, nav0) || nav1 - nav0 < nav0 / 100);
}

#[test]
fn xnear_is_leveraged() {
    let mut c = seeded();
    let nav0 = c.get_pool().x_price.0;
    price(&mut c, P * 110 / 100); // NEAR +10%
    let nav1 = c.get_pool().x_price.0;
    let gain_bps = (nav1 - nav0) * 10_000 / nav0;
    // About 2.5x leverage -> about +25%.
    assert!(gain_bps > 2_300 && gain_bps < 2_700, "xNEAR gained {gain_bps} bps");
}

#[test]
fn bxusd_holds_one_dollar_through_a_drop() {
    let mut c = seeded();
    price(&mut c, P * 80 / 100); // NEAR -20%: TVL $800, above the ~$600 owed
    ctx("saver.test", START, 1);
    let got = c.redeem_bx(U128(100 * T), None).0;
    // $100 less 0% fee in Caution, at $3.20 per NEAR = 31.25 tNEAR.
    let expected = 100 * T * MICRO / (P * 80 / 100);
    assert!(close(got, expected), "got {got} expected {expected}");
}

#[test]
#[should_panic(expected = "below 130% backing")]
fn xnear_exit_cannot_break_backing() {
    let mut c = seeded();
    let x = c.x_external;
    send(&mut c, "xnear.test", "risk.test", x, r#"{"type":"redeem_x"}"#);
}

#[test]
fn small_xnear_exit_works() {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 100 * T);
    mint_bx(&mut c, "saver.test", 50 * T);
    let x = c.x_external / 10;
    let before = c.collateral;
    send(&mut c, "xnear.test", "risk.test", x, r#"{"type":"redeem_x"}"#);
    assert!(c.collateral < before);
    assert!(c.cr_bps() >= STABILIZE_CR_BPS);
}

#[test]
fn modes_follow_backing() {
    let mut c = seeded(); // ~167%
    price(&mut c, P * 88 / 100); // ~147%
    assert_eq!(c.get_pool().mode, Mode::Caution);
    assert_eq!(c.get_pool().fees_bps.mint_x, 0);
    assert_eq!(c.get_pool().fees_bps.redeem_bx, 0);
    price(&mut c, P * 75 / 100); // ~125%
    let p = c.get_pool();
    assert_eq!(p.mode, Mode::Stabilize);
    assert!(!p.fees_bps.mint_bx_open);
    assert!(!p.fees_bps.redeem_x_open);
}

#[test]
#[should_panic(expected = "New bxUSD is paused")]
fn no_new_bxusd_in_stabilize() {
    let mut c = seeded();
    price(&mut c, P * 75 / 100);
    mint_bx(&mut c, "saver2.test", T);
}

#[test]
fn guardian_fee_levels_multiply_fees() {
    let mut c = seeded();
    ctx("guardian.test", START, 0);
    c.set_fee_level(2, "NEAR is swinging hard; fees x3 for now.".into());
    assert_eq!(c.get_pool().fees_bps.mint_x, 150);
    assert_eq!(c.get_notes(None)[0].kind, "fees");
}

#[test]
#[should_panic(expected = "Only the Pool Guardian")]
fn only_guardian_sets_fees() {
    let mut c = seeded();
    ctx("random.test", START, 0);
    c.set_fee_level(2, "x".into());
}

#[test]
#[should_panic(expected = "price is out of date")]
fn stale_price_blocks_minting() {
    let mut c = setup();
    ctx("tnear.test", START + 2 * 3600 * NS, 0);
    let _ = c.ft_on_transfer(acc("risk.test"), U128(T), r#"{"type":"mint_x"}"#.into());
}

#[test]
#[should_panic(expected = "only accepts tNEAR and xNEAR")]
fn rejects_other_tokens() {
    let mut c = setup();
    send(&mut c, "scam.test", "risk.test", T, r#"{"type":"mint_x"}"#);
}

// ---------- Stability Pool ----------

#[test]
fn stability_pool_earns_fees() {
    let mut c = seeded();
    ctx("saver.test", START, 1);
    c.sp_deposit(U128(100 * T));
    let before = c.get_sp_position(acc("saver.test")).value.0;
    mint_x(&mut c, "other.test", 100 * T); // pays a 0.5% fee, 80% to the pool
    let after = c.get_sp_position(acc("saver.test")).value.0;
    assert!(after > before, "pool value should grow from fees");
    // 100 tNEAR * $4 * 0.5% * 80% = $1.60
    assert!(close(after - before, 16 * T / 10), "earned {}", after - before);
}

#[test]
fn stabilize_converts_pool_bxusd_to_xnear() {
    let mut c = seeded();
    ctx("saver.test", START, 1);
    c.sp_deposit(U128(300 * T));
    price(&mut c, P * 75 / 100); // backing ~125%
    assert_eq!(c.mode(), Mode::Stabilize);
    let nav0 = c.x_price();
    ctx("guardian.test", START, 0);
    c.stabilize();
    assert!(c.cr_bps() >= 13_990, "cr {}", c.cr_bps());
    assert!(c.sp_x > 0);
    // Converting at fair value leaves xNEAR's price alone.
    assert!(close(c.x_price(), nav0));
    // The depositor's value is unchanged by the conversion itself.
    assert_eq!(c.get_notes(None)[0].kind, "protect");
}

#[test]
fn stability_pool_withdraw_returns_both_tokens() {
    let mut c = seeded();
    ctx("saver.test", START, 1);
    c.sp_deposit(U128(300 * T));
    price(&mut c, P * 75 / 100);
    c.stabilize();
    ctx("saver.test", START, 1);
    let bx_before = bx_of(&c, "saver.test");
    c.sp_withdraw(None);
    assert!(bx_of(&c, "saver.test") > bx_before);
    assert_eq!(c.sp_total_shares, 0);
    assert_eq!(c.sp_x, 0);
}

#[test]
#[should_panic(expected = "Nothing to stabilize")]
fn stabilize_only_when_needed() {
    let mut c = seeded();
    c.stabilize();
}

// ---------- Steady vaults ----------

#[test]
fn steady_vault_hits_target_leverage() {
    let mut c = seeded(); // xNEAR ~2.5x
    send(&mut c, "tnear.test", "v.test", 50 * T, r#"{"type":"vault_deposit","vault":0}"#);
    let v = &c.get_vaults()[0];
    let lev = v.leverage_bps.0;
    assert!(lev > 19_000 && lev < 21_000, "Steady 2x at {lev}");
    assert!(!v.needs_rebalance);
}

#[test]
fn steady_vault_rebalances_after_a_move() {
    let mut c = seeded();
    send(&mut c, "tnear.test", "v.test", 50 * T, r#"{"type":"vault_deposit","vault":0}"#);
    price(&mut c, P * 93 / 100); // xNEAR gets more levered as NEAR falls
    let drifted = c.get_vaults()[0].leverage_bps.0;
    assert!(c.get_vaults()[0].needs_rebalance, "drifted to {drifted}");
    ctx("guardian.test", START, 0);
    assert!(c.rebalance(0));
    let v = &c.get_vaults()[0];
    let lev = v.leverage_bps.0;
    assert!(lev > 19_000 && lev < 21_000, "back to {lev}; xNEAR lev {} t {} x {}", c.leverage_bps(), v.t.0 / T, v.x.0 / T);
    assert_eq!(c.get_notes(None)[0].kind, "rebalance");
}

#[test]
fn steady_vault_caps_at_xnear_leverage() {
    // If xNEAR itself is less levered than the target, the vault goes all
    // in xNEAR and sits at xNEAR's leverage.
    let mut c = seeded();
    send(&mut c, "tnear.test", "v.test", 50 * T, r#"{"type":"vault_deposit","vault":1}"#);
    let v = &c.get_vaults()[1];
    assert_eq!(v.t.0, 0);
    assert!(v.leverage_bps.0 < 30_000);
}

#[test]
fn steady_vault_withdraw_pays_out() {
    let mut c = seeded();
    send(&mut c, "tnear.test", "v.test", 50 * T, r#"{"type":"vault_deposit","vault":1}"#);
    let pos = c.get_vault_positions(acc("v.test"))[1].value.0;
    assert!(close(pos, 50 * T) || pos > 49 * T);
    ctx("v.test", START, 1);
    c.vault_withdraw(1, None);
    assert_eq!(c.get_vault_positions(acc("v.test"))[1].shares.0, 0);
    assert_eq!(c.vaults[1].total_shares, 0);
}

// ---------- Orders ----------

#[test]
fn stop_loss_executes_only_at_its_price() {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 100 * T);
    mint_bx(&mut c, "saver.test", 50 * T);
    let x = c.x_external / 4;
    send(&mut c, "xnear.test", "risk.test", x, r#"{"type":"order","stop_price":"3600000"}"#);
    assert_eq!(c.order_x, x);
    assert!(c.get_triggered_orders(None).is_empty());
    price(&mut c, 3_500_000);
    assert_eq!(c.get_triggered_orders(None).len(), 1);
    ctx("guardian.test", START, 0);
    let out = c.execute_order(0).0;
    assert!(out > 0);
    assert_eq!(c.orders.get(&0).unwrap().status, OrderStatus::Executed);
    assert_eq!(c.order_x, 0);
    assert_eq!(c.get_notes(None)[0].kind, "order");
}

#[test]
#[should_panic(expected = "has not been reached")]
fn order_waits_for_price() {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 100 * T);
    send(&mut c, "xnear.test", "risk.test", T, r#"{"type":"order","take_price":"5000000"}"#);
    c.execute_order(0);
}

#[test]
fn take_profit_and_cancel() {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 100 * T);
    send(&mut c, "xnear.test", "risk.test", T, r#"{"type":"order","take_price":"5000000"}"#);
    ctx("risk.test", START, 1);
    c.cancel_order(0);
    assert_eq!(c.orders.get(&0).unwrap().status, OrderStatus::Cancelled);
    assert_eq!(c.order_x, 0);
}

#[test]
#[should_panic(expected = "stop price must be below the take price")]
fn order_prices_must_make_sense() {
    let mut c = setup();
    mint_x(&mut c, "risk.test", 100 * T);
    send(&mut c, "xnear.test", "risk.test", T, r#"{"type":"order","stop_price":"5000000","take_price":"4000000"}"#);
}

// ---------- Accounting ----------

#[test]
fn every_token_is_accounted_for() {
    let mut c = seeded();
    ctx("saver.test", START, 1);
    c.sp_deposit(U128(100 * T));
    send(&mut c, "tnear.test", "v.test", 30 * T, r#"{"type":"vault_deposit","vault":0}"#);
    let x = c.x_external / 10;
    send(&mut c, "xnear.test", "risk.test", x, r#"{"type":"order","stop_price":"1000000"}"#);
    let vx: u128 = c.vaults.iter().map(|v| v.x).sum();
    assert_eq!(c.x_supply(), c.x_external + c.sp_x + c.order_x + vx);
    assert_eq!(c.bx_supply(), c.bx.total_supply + c.sp_bx);
    // xNEAR price * supply + bxUSD = pool value.
    let lhs = c.x_supply() * c.x_price() / MICRO + c.bx_supply();
    assert!(close(lhs, c.tvl()), "{lhs} vs {}", c.tvl());
}

#[test]
fn whole_formats() {
    assert_eq!(whole(1234 * T / 100), "12.34");
    assert_eq!(times(21_500), "2.15");
    assert_eq!(dollars(3_905_250), "3.905");
}
