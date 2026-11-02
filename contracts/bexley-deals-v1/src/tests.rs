use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const T: u128 = 1_000_000_000_000_000_000_000_000; // 1 token (24 decimals)
const PRICE: u128 = 5_000_000; // $5.00
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;
const NS: u64 = 1_000_000_000;
const START: u64 = 1_000 * NS;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_(who: &str, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .current_account_id(acc("app.test"))
        .block_timestamp(ts)
        .build());
}

fn setup() -> Contract {
    as_("owner.test", START);
    let mut c = Contract::new(
        acc("tnear.test"),
        24,
        acc("agent.test"),
        acc("feeder.test"),
        1_000, // 10% fee on risk-taker profit
        U128(T / 10),
        vec![HOUR, DAY, 7 * DAY],
    );
    as_("feeder.test", START);
    c.set_price(U128(PRICE));
    c
}

fn save(c: &mut Contract, who: &str, amount: u128, dur: u64, min_rate: u32, ts: u64) -> u64 {
    as_("tnear.test", ts);
    let msg = format!(r#"{{"type":"save","duration_secs":{},"min_rate_bps":{}}}"#, dur, min_rate);
    let _ = c.ft_on_transfer(acc(who), U128(amount), msg);
    c.get_stats().saves - 1
}

fn offer(c: &mut Contract, who: &str, margin: u128, rate: u32, durs: &[u64], cover: u32, ts: u64) -> u64 {
    as_("tnear.test", ts);
    let d: Vec<String> = durs.iter().map(|x| x.to_string()).collect();
    let msg = format!(
        r#"{{"type":"offer","rate_bps":{},"durations":[{}],"max_cover":{}}}"#,
        rate,
        d.join(","),
        cover
    );
    let _ = c.ft_on_transfer(acc(who), U128(margin), msg);
    c.get_stats().offers - 1
}

fn price_at(c: &mut Contract, p: u128, ts: u64) {
    as_("feeder.test", ts);
    c.set_price(U128(p));
}

fn balance(c: &Contract, who: &str) -> u128 {
    c.get_account(acc(who)).balance.0
}

/// One standard deal: saver 30 tokens for 7 days, risk-taker 10% APR,
/// cover 3 (so margin 10). Returns deal id.
fn standard_deal(c: &mut Contract) -> u64 {
    let s = save(c, "saver.test", 30 * T, 7 * DAY, 500, START);
    let o = offer(c, "rt.test", 100 * T, 1_000, &[DAY, 7 * DAY], 3, START);
    as_("agent.test", START);
    c.match_deal(s, o)
}

#[test]
fn save_creates_open_order() {
    let mut c = setup();
    let id = save(&mut c, "saver.test", 5 * T, DAY, 500, START);
    let s = c.get_save(id).unwrap();
    assert_eq!(s.status, SaveStatus::Open);
    assert_eq!(s.amount.0, 5 * T);
    assert_eq!(c.get_open_saves(None, None).len(), 1);
    assert_eq!(c.get_stats().users, 1);
    assert_eq!(c.get_stats().total_saved.0, 5 * T);
}

#[test]
#[should_panic(expected = "only accepts its pool token")]
fn rejects_other_tokens() {
    let mut c = setup();
    as_("scam.test", START);
    let _ = c.ft_on_transfer(acc("saver.test"), U128(T), r#"{"type":"save","duration_secs":3600,"min_rate_bps":0}"#.into());
}

#[test]
#[should_panic(expected = "deal length is not offered")]
fn rejects_unknown_duration() {
    let mut c = setup();
    save(&mut c, "saver.test", T, 123, 0, START);
}

#[test]
#[should_panic(expected = "below the minimum deposit")]
fn rejects_tiny_deposit() {
    let mut c = setup();
    save(&mut c, "saver.test", T / 100, DAY, 0, START);
}

#[test]
#[should_panic(expected = "Could not read the deposit message")]
fn rejects_bad_message() {
    let mut c = setup();
    as_("tnear.test", START);
    let _ = c.ft_on_transfer(acc("saver.test"), U128(T), "hello".into());
}

#[test]
fn agent_matches_and_locks_margin() {
    let mut c = setup();
    let id = standard_deal(&mut c);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.saver_amount.0, 30 * T);
    assert_eq!(d.margin.0, 10 * T); // 30 / cover 3
    assert_eq!(d.entry_price.0, PRICE);
    assert_eq!(d.end_at.0, START + 7 * DAY * NS);
    assert_eq!(c.get_offer(0).unwrap().margin_available.0, 90 * T);
    assert_eq!(c.get_save(0).unwrap().status, SaveStatus::Matched);
    assert_eq!(c.get_stats().matched_volume.0, 40 * T);
    assert!(c.get_open_saves(None, None).is_empty());
}

#[test]
#[should_panic(expected = "Only the Bexley agent")]
fn only_agent_can_match() {
    let mut c = setup();
    let s = save(&mut c, "saver.test", 30 * T, DAY, 0, START);
    let o = offer(&mut c, "rt.test", 100 * T, 1_000, &[DAY], 3, START);
    as_("random.test", START);
    c.match_deal(s, o);
}

#[test]
#[should_panic(expected = "less than the saver's minimum rate")]
fn agent_cannot_break_saver_minimum() {
    let mut c = setup();
    let s = save(&mut c, "saver.test", 30 * T, DAY, 2_000, START);
    let o = offer(&mut c, "rt.test", 100 * T, 1_000, &[DAY], 3, START);
    as_("agent.test", START);
    c.match_deal(s, o);
}

#[test]
#[should_panic(expected = "does not accept that deal length")]
fn agent_cannot_break_offer_duration() {
    let mut c = setup();
    let s = save(&mut c, "saver.test", 30 * T, HOUR, 0, START);
    let o = offer(&mut c, "rt.test", 100 * T, 1_000, &[DAY], 3, START);
    as_("agent.test", START);
    c.match_deal(s, o);
}

#[test]
#[should_panic(expected = "not have enough margin")]
fn offer_needs_enough_margin() {
    let mut c = setup();
    let s = save(&mut c, "saver.test", 30 * T, DAY, 0, START);
    let o = offer(&mut c, "rt.test", 5 * T, 1_000, &[DAY], 3, START);
    as_("agent.test", START);
    c.match_deal(s, o);
}

#[test]
#[should_panic(expected = "price is out of date")]
fn stale_price_blocks_matching() {
    let mut c = setup();
    let s = save(&mut c, "saver.test", 30 * T, DAY, 0, START);
    let o = offer(&mut c, "rt.test", 100 * T, 1_000, &[DAY], 3, START);
    as_("agent.test", START + 2 * HOUR * NS);
    c.match_deal(s, o);
}

#[test]
#[should_panic(expected = "cannot match with yourself")]
fn no_self_match() {
    let mut c = setup();
    let s = save(&mut c, "same.test", 30 * T, DAY, 0, START);
    let o = offer(&mut c, "same.test", 100 * T, 1_000, &[DAY], 3, START);
    as_("agent.test", START);
    c.match_deal(s, o);
}

#[test]
fn saver_can_take_offer_without_agent() {
    let mut c = setup();
    let s = save(&mut c, "saver.test", 30 * T, DAY, 0, START);
    let o = offer(&mut c, "rt.test", 100 * T, 1_000, &[DAY], 3, START);
    as_("saver.test", START);
    let id = c.take_offer(s, o);
    assert_eq!(c.get_deal(id).unwrap().matched_by, acc("saver.test"));
}

#[test]
#[should_panic(expected = "still running")]
fn cannot_settle_early_when_safe() {
    let mut c = setup();
    let id = standard_deal(&mut c);
    price_at(&mut c, PRICE, START + DAY * NS);
    as_("anyone.test", START + DAY * NS);
    c.settle(id);
}

#[test]
fn flat_price_saver_gets_rate() {
    let mut c = setup();
    let id = standard_deal(&mut c);
    let end = START + 7 * DAY * NS;
    price_at(&mut c, PRICE, end);
    as_("anyone.test", end);
    c.settle(id);
    // 30 tokens * (1 + 10% * 7/365)
    let expected = 30 * T + 30 * T * 1_000 * 7 / (10_000 * 365);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.saver_payout.unwrap().0, expected);
    assert_eq!(d.risk_taker_payout.unwrap().0, 40 * T - expected);
    assert_eq!(d.fee.unwrap().0, 0); // risk-taker lost, no fee
    assert_eq!(balance(&c, "saver.test"), expected);
    assert_eq!(c.get_stats().deals_settled, 1);
}

#[test]
fn price_up_risk_taker_wins_saver_keeps_dollars() {
    let mut c = setup();
    let id = standard_deal(&mut c);
    let end = START + 7 * DAY * NS;
    price_at(&mut c, 6_000_000, end); // +20%
    as_("anyone.test", end);
    c.settle(id);
    let d = c.get_deal(id).unwrap();
    let saver = d.saver_payout.unwrap().0;
    // Saver's dollars: 30 tokens * $5 = $150, grown by the rate, now at $6.
    let owed = saver_owed(30 * T, PRICE, 6_000_000, 1_000, 7 * DAY);
    assert_eq!(saver, owed);
    let dollars_out = saver * 6 / T; // whole dollars
    assert!(dollars_out >= 150, "saver keeps at least $150, got {dollars_out}");
    // Risk-taker gets the rest minus 10% of profit.
    let gross = 40 * T - saver;
    let fee = (gross - 10 * T) * 1_000 / 10_000;
    assert_eq!(d.fee.unwrap().0, fee);
    assert_eq!(d.risk_taker_payout.unwrap().0, gross - fee);
    assert!(gross > 10 * T, "risk-taker profits when price rises");
    assert_eq!(balance(&c, "owner.test"), fee);
    // Nothing is created or lost.
    assert_eq!(saver + gross, 40 * T);
}

#[test]
fn price_crash_saver_protected_early() {
    let mut c = setup();
    let id = standard_deal(&mut c);
    let t = START + DAY * NS;
    price_at(&mut c, 3_500_000, t); // -30%
    let q = c.quote(id).unwrap();
    assert!(q.at_risk);
    assert!(q.can_settle);
    as_("anyone.test", t);
    c.settle(id);
    let d = c.get_deal(id).unwrap();
    assert!(d.settled_early);
    // Saver is owed more than the pot, so takes the whole pot.
    assert_eq!(d.saver_payout.unwrap().0, 40 * T);
    assert_eq!(d.risk_taker_payout.unwrap().0, 0);
}

#[test]
fn cancel_save_makes_deposit_withdrawable() {
    let mut c = setup();
    let id = save(&mut c, "saver.test", 5 * T, DAY, 0, START);
    as_("saver.test", START);
    c.cancel_save(id);
    assert_eq!(c.get_save(id).unwrap().status, SaveStatus::Cancelled);
    assert_eq!(balance(&c, "saver.test"), 5 * T);
}

#[test]
#[should_panic(expected = "not your saving")]
fn cannot_cancel_someone_elses_save() {
    let mut c = setup();
    let id = save(&mut c, "saver.test", 5 * T, DAY, 0, START);
    as_("thief.test", START);
    c.cancel_save(id);
}

#[test]
fn close_offer_returns_only_free_margin() {
    let mut c = setup();
    standard_deal(&mut c);
    as_("rt.test", START);
    c.close_offer(0);
    assert_eq!(balance(&c, "rt.test"), 90 * T); // 10 still locked in the deal
    assert!(c.get_active_offers(None, None).is_empty());
}

#[test]
fn withdraw_clears_balance() {
    let mut c = setup();
    let id = save(&mut c, "saver.test", 5 * T, DAY, 0, START);
    as_("saver.test", START);
    c.cancel_save(id);
    let _ = c.withdraw();
    assert_eq!(balance(&c, "saver.test"), 0);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdraw_needs_balance() {
    let mut c = setup();
    as_("saver.test", START);
    let _ = c.withdraw();
}

#[test]
#[should_panic(expected = "Only the price feeder")]
fn only_feeder_sets_price() {
    let mut c = setup();
    as_("random.test", START);
    c.set_price(U128(1));
}

#[test]
fn saver_owed_one_year_ten_percent() {
    let owed = saver_owed(100 * T, PRICE, PRICE, 1_000, SECONDS_PER_YEAR);
    assert_eq!(owed, 110 * T);
}

#[test]
fn big_amounts_do_not_overflow() {
    // A billion tokens at $1,000 each, price drops 10x, 500% rate for a year.
    let owed = saver_owed(1_000_000_000 * T, 1_000_000_000, 100_000_000, 50_000, SECONDS_PER_YEAR);
    assert_eq!(owed, 60_000_000_000 * T);
}

#[test]
fn margin_rounds_up() {
    assert_eq!(required_margin(10, 3), 4);
    assert_eq!(required_margin(9, 3), 3);
}
