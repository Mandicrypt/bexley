//! Bexley core contract.
//!
//! Two kinds of people share one pool:
//! - **Savers** deposit the pool asset (tNEAR on testnet) and lock in its
//!   DOLLAR value plus a fixed yearly rate for a set time.
//! - **Risk-takers** post offers: they put up margin in the same asset and
//!   promise a rate to savers. In return they take all of the price move on
//!   the whole deal (saver deposit + their margin), so they get leveraged
//!   upside and absorb losses first.
//!
//! An AI agent (off-chain) matches each open saving to the best offer by
//! calling `match_deal`. The contract enforces every rule on-chain, so the
//! agent can only pair valid orders; it can never move anyone's funds.
//!
//! Settlement, in tokens:
//!   pot          = saver deposit + margin
//!   saver owed   = deposit x entry price / exit price x (1 + rate x time)
//!   saver gets   = min(saver owed, pot)
//!   risk-taker   = pot - saver gets (minus a fee on any profit)
//! If the price falls so far that the saver is owed 95% or more of the pot,
//! anyone may settle early, which protects the saver.
//!
//! Prices come from a price feeder account. On testnet this is a simple
//! signed feed run by Bexley (see README); a production version would read
//! a decentralized oracle.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

mod math;
use math::mul_div;

pub const SECONDS_PER_YEAR: u64 = 31_536_000;
pub const BPS: u128 = 10_000;
/// Prices older than this cannot be used to open or settle deals.
pub const MAX_PRICE_AGE_NS: u64 = 60 * 60 * 1_000_000_000;
/// Saver protection: settle early once the saver is owed this share of the pot.
pub const PROTECTION_BPS: u128 = 9_500;
pub const MAX_RATE_BPS: u32 = 50_000;
pub const MAX_COVER: u32 = 10;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Saves,
    Offers,
    Deals,
    Balances,
    Users,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SaveStatus {
    Open,
    Matched,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OfferStatus {
    Active,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum DealStatus {
    Active,
    Settled,
}

/// A saver's deposit waiting to be matched (or already matched).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SaveOrder {
    pub id: u64,
    pub owner: AccountId,
    pub amount: U128,
    pub duration_secs: u64,
    /// The lowest yearly rate the saver accepts, in basis points (500 = 5%).
    pub min_rate_bps: u32,
    pub created_at: U64,
    pub status: SaveStatus,
    pub deal_id: Option<u64>,
}

/// A risk-taker's standing offer.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Offer {
    pub id: u64,
    pub owner: AccountId,
    pub margin_total: U128,
    pub margin_available: U128,
    /// Yearly rate promised to savers, in basis points.
    pub rate_bps: u32,
    /// Deal lengths (seconds) this offer accepts.
    pub durations: Vec<u64>,
    /// How many tokens of saver deposit each token of margin may cover.
    /// 3 means margin >= deposit / 3, so the risk-taker has 4x exposure.
    pub max_cover: u32,
    pub created_at: U64,
    pub status: OfferStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub id: u64,
    pub save_id: u64,
    pub offer_id: u64,
    pub saver: AccountId,
    pub risk_taker: AccountId,
    pub saver_amount: U128,
    pub margin: U128,
    pub rate_bps: u32,
    pub duration_secs: u64,
    pub start_at: U64,
    pub end_at: U64,
    /// Micro-dollars per whole token at the start.
    pub entry_price: U128,
    pub matched_by: AccountId,
    pub status: DealStatus,
    pub exit_price: Option<U128>,
    pub saver_payout: Option<U128>,
    pub risk_taker_payout: Option<U128>,
    pub fee: Option<U128>,
    pub settled_early: bool,
}

/// What a deal would pay out if settled right now.
#[near(serializers = [json])]
pub struct Quote {
    pub deal_id: u64,
    pub price: U128,
    pub saver_payout: U128,
    pub risk_taker_payout: U128,
    pub fee: U128,
    pub can_settle: bool,
    pub at_risk: bool,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub asset: AccountId,
    pub asset_decimals: u8,
    pub agent: AccountId,
    pub price_feeder: AccountId,
    pub fee_bps: u32,
    pub min_deposit: U128,
    pub durations: Vec<u64>,
}

#[near(serializers = [json])]
pub struct Stats {
    pub users: u64,
    pub saves: u64,
    pub offers: u64,
    pub deals: u64,
    pub deals_settled: u64,
    pub total_saved: U128,
    pub total_margin_posted: U128,
    /// Sum of (deposit + margin) over all matched deals.
    pub matched_volume: U128,
    pub fees_earned: U128,
}

#[near(serializers = [json])]
pub struct PriceInfo {
    pub price: U128,
    pub updated_at: U64,
    pub fresh: bool,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub balance: U128,
    pub saves: Vec<SaveOrder>,
    pub offers: Vec<Offer>,
    pub deals: Vec<Deal>,
}

/// What a token transfer into Bexley asks for (`msg` of `ft_transfer_call`).
#[near(serializers = [json])]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DepositMsg {
    Save {
        duration_secs: u64,
        min_rate_bps: u32,
    },
    Offer {
        rate_bps: u32,
        durations: Vec<u64>,
        max_cover: u32,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    asset: AccountId,
    asset_decimals: u8,
    agent: AccountId,
    price_feeder: AccountId,
    fee_bps: u32,
    min_deposit: u128,
    durations: Vec<u64>,

    price: u128,
    price_updated_at: u64,

    saves: IterableMap<u64, SaveOrder>,
    offers: IterableMap<u64, Offer>,
    deals: IterableMap<u64, Deal>,
    balances: LookupMap<AccountId, u128>,
    users: LookupSet<AccountId>,

    next_save_id: u64,
    next_offer_id: u64,
    next_deal_id: u64,

    user_count: u64,
    deals_settled: u64,
    total_saved: u128,
    total_margin_posted: u128,
    matched_volume: u128,
    fees_earned: u128,
}

#[near]
impl Contract {
    /// `durations` are the deal lengths allowed, in seconds.
    #[init]
    pub fn new(
        asset: AccountId,
        asset_decimals: u8,
        agent: AccountId,
        price_feeder: AccountId,
        fee_bps: u32,
        min_deposit: U128,
        durations: Vec<u64>,
    ) -> Self {
        require!(fee_bps <= 5_000, "Fee can be at most 50%");
        require!(!durations.is_empty(), "Give at least one deal length");
        Self {
            owner: env::predecessor_account_id(),
            asset,
            asset_decimals,
            agent,
            price_feeder,
            fee_bps,
            min_deposit: min_deposit.0,
            durations,
            price: 0,
            price_updated_at: 0,
            saves: IterableMap::new(StorageKey::Saves),
            offers: IterableMap::new(StorageKey::Offers),
            deals: IterableMap::new(StorageKey::Deals),
            balances: LookupMap::new(StorageKey::Balances),
            users: LookupSet::new(StorageKey::Users),
            next_save_id: 0,
            next_offer_id: 0,
            next_deal_id: 0,
            user_count: 0,
            deals_settled: 0,
            total_saved: 0,
            total_margin_posted: 0,
            matched_volume: 0,
            fees_earned: 0,
        }
    }

    // ---------- Price ----------

    /// Post the latest price, in micro-dollars per whole token
    /// (e.g. $4.25 = 4250000). Only the price feeder.
    pub fn set_price(&mut self, price: U128) {
        require!(
            env::predecessor_account_id() == self.price_feeder,
            "Only the price feeder can post prices"
        );
        require!(price.0 > 0, "Price must be above zero");
        self.price = price.0;
        self.price_updated_at = env::block_timestamp();
        log!("PRICE {}", price.0);
    }

    fn fresh_price(&self) -> u128 {
        require!(self.price > 0, "No price has been posted yet");
        require!(
            env::block_timestamp() <= self.price_updated_at + MAX_PRICE_AGE_NS,
            "The price is out of date. Please try again shortly."
        );
        self.price
    }

    // ---------- Savers ----------

    /// Cancel a saving that has not been matched. The deposit becomes
    /// withdrawable.
    pub fn cancel_save(&mut self, save_id: u64) {
        let caller = env::predecessor_account_id();
        let mut save = self.saves.get(&save_id).expect("Saving not found").clone();
        require!(save.owner == caller, "This is not your saving");
        require!(save.status == SaveStatus::Open, "Only an open saving can be cancelled");
        save.status = SaveStatus::Cancelled;
        self.credit(&caller, save.amount.0);
        self.saves.insert(save_id, save);
        log!("SAVE_CANCELLED {}", save_id);
    }

    /// A saver can pick an offer themselves, without waiting for the agent.
    pub fn take_offer(&mut self, save_id: u64, offer_id: u64) -> u64 {
        let caller = env::predecessor_account_id();
        let save = self.saves.get(&save_id).expect("Saving not found");
        require!(save.owner == caller, "This is not your saving");
        self.internal_match(save_id, offer_id, caller)
    }

    // ---------- Risk-takers ----------

    /// Close an offer and make its unused margin withdrawable. Margin already
    /// locked in active deals stays there until those deals settle.
    pub fn close_offer(&mut self, offer_id: u64) {
        let caller = env::predecessor_account_id();
        let mut offer = self.offers.get(&offer_id).expect("Offer not found").clone();
        require!(offer.owner == caller, "This is not your offer");
        require!(offer.status == OfferStatus::Active, "This offer is already closed");
        let free = offer.margin_available.0;
        offer.margin_available = U128(0);
        offer.status = OfferStatus::Closed;
        self.offers.insert(offer_id, offer);
        self.credit(&caller, free);
        log!("OFFER_CLOSED {}", offer_id);
    }

    // ---------- Agent ----------

    /// Pair a saving with an offer. Only the agent (or the owner). Every rule
    /// is checked here, so the agent cannot make an unfair or invalid match.
    pub fn match_deal(&mut self, save_id: u64, offer_id: u64) -> u64 {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.agent || caller == self.owner,
            "Only the Bexley agent can match deals"
        );
        self.internal_match(save_id, offer_id, caller)
    }

    fn internal_match(&mut self, save_id: u64, offer_id: u64, matched_by: AccountId) -> u64 {
        let price = self.fresh_price();
        let mut save = self.saves.get(&save_id).expect("Saving not found").clone();
        let mut offer = self.offers.get(&offer_id).expect("Offer not found").clone();
        require!(save.status == SaveStatus::Open, "This saving is not open");
        require!(offer.status == OfferStatus::Active, "This offer is closed");
        require!(save.owner != offer.owner, "You cannot match with yourself");
        require!(
            offer.durations.contains(&save.duration_secs),
            "This offer does not accept that deal length"
        );
        require!(
            offer.rate_bps >= save.min_rate_bps,
            "This offer pays less than the saver's minimum rate"
        );
        let margin = required_margin(save.amount.0, offer.max_cover);
        require!(
            offer.margin_available.0 >= margin,
            "This offer does not have enough margin left"
        );

        let now = env::block_timestamp();
        let id = self.next_deal_id;
        self.next_deal_id += 1;

        offer.margin_available = U128(offer.margin_available.0 - margin);
        save.status = SaveStatus::Matched;
        save.deal_id = Some(id);

        let deal = Deal {
            id,
            save_id,
            offer_id,
            saver: save.owner.clone(),
            risk_taker: offer.owner.clone(),
            saver_amount: save.amount,
            margin: U128(margin),
            rate_bps: offer.rate_bps,
            duration_secs: save.duration_secs,
            start_at: U64(now),
            end_at: U64(now + save.duration_secs * 1_000_000_000),
            entry_price: U128(price),
            matched_by,
            status: DealStatus::Active,
            exit_price: None,
            saver_payout: None,
            risk_taker_payout: None,
            fee: None,
            settled_early: false,
        };
        self.matched_volume += save.amount.0 + margin;
        self.saves.insert(save_id, save);
        self.offers.insert(offer_id, offer);
        self.deals.insert(id, deal);
        log!("DEAL_MATCHED {} save {} offer {}", id, save_id, offer_id);
        id
    }

    // ---------- Settlement ----------

    /// Settle a deal and credit both sides. Anyone can call it once the deal
    /// has ended, or earlier if the saver needs protecting.
    pub fn settle(&mut self, deal_id: u64) {
        let price = self.fresh_price();
        let mut deal = self.deals.get(&deal_id).expect("Deal not found").clone();
        require!(deal.status == DealStatus::Active, "This deal is already settled");
        let now = env::block_timestamp();
        let ended = now >= deal.end_at.0;
        let (saver_out, rt_out, fee, at_risk) = self.payouts(&deal, price, now);
        require!(
            ended || at_risk,
            "This deal is still running. It can settle when it ends."
        );

        deal.status = DealStatus::Settled;
        deal.exit_price = Some(U128(price));
        deal.saver_payout = Some(U128(saver_out));
        deal.risk_taker_payout = Some(U128(rt_out));
        deal.fee = Some(U128(fee));
        deal.settled_early = !ended;

        self.credit(&deal.saver.clone(), saver_out);
        self.credit(&deal.risk_taker.clone(), rt_out);
        if fee > 0 {
            let owner = self.owner.clone();
            self.credit(&owner, fee);
            self.fees_earned += fee;
        }
        self.deals_settled += 1;
        self.deals.insert(deal_id, deal);
        log!("DEAL_SETTLED {} saver {} risk_taker {} fee {}", deal_id, saver_out, rt_out, fee);
    }

    /// (saver payout, risk-taker payout, fee, saver at risk) at `price`, `now`.
    fn payouts(&self, deal: &Deal, price: u128, now: u64) -> (u128, u128, u128, bool) {
        let pot = deal.saver_amount.0 + deal.margin.0;
        let elapsed_secs = ((now.min(deal.end_at.0)).saturating_sub(deal.start_at.0)) / 1_000_000_000;
        let owed = saver_owed(
            deal.saver_amount.0,
            deal.entry_price.0,
            price,
            deal.rate_bps,
            elapsed_secs,
        );
        let saver_out = owed.min(pot);
        let mut rt_out = pot - saver_out;
        let mut fee = 0;
        if rt_out > deal.margin.0 {
            fee = (rt_out - deal.margin.0) * self.fee_bps as u128 / BPS;
            rt_out -= fee;
        }
        let at_risk = owed >= pot * PROTECTION_BPS / BPS;
        (saver_out, rt_out, fee, at_risk)
    }

    // ---------- Withdrawals ----------

    /// Send your whole withdrawable balance back to your wallet.
    pub fn withdraw(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.balances.get(&caller).copied().unwrap_or(0);
        require!(amount > 0, "You have nothing to withdraw");
        self.balances.insert(caller.clone(), 0);
        ext_ft_core::ext(self.asset.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(caller.clone(), U128(amount), Some("Bexley withdrawal".into()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(caller, U128(amount)),
            )
    }

    /// If the transfer failed, give the balance back.
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            self.credit(&account_id, amount.0);
            log!("WITHDRAW_FAILED {} {}", account_id, amount.0);
        }
        ok
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let cur = self.balances.get(account).copied().unwrap_or(0);
        self.balances.insert(account.clone(), cur + amount);
    }

    fn track_user(&mut self, account: &AccountId) {
        if self.users.insert(account.clone()) {
            self.user_count += 1;
        }
    }

    // ---------- Owner ----------

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agent = agent;
    }

    pub fn set_price_feeder(&mut self, price_feeder: AccountId) {
        self.assert_owner();
        self.price_feeder = price_feeder;
    }

    pub fn set_fee_bps(&mut self, fee_bps: u32) {
        self.assert_owner();
        require!(fee_bps <= 5_000, "Fee can be at most 50%");
        self.fee_bps = fee_bps;
    }

    pub fn set_durations(&mut self, durations: Vec<u64>) {
        self.assert_owner();
        require!(!durations.is_empty(), "Give at least one deal length");
        self.durations = durations;
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    // ---------- Views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            asset: self.asset.clone(),
            asset_decimals: self.asset_decimals,
            agent: self.agent.clone(),
            price_feeder: self.price_feeder.clone(),
            fee_bps: self.fee_bps,
            min_deposit: U128(self.min_deposit),
            durations: self.durations.clone(),
        }
    }

    pub fn get_price(&self) -> PriceInfo {
        PriceInfo {
            price: U128(self.price),
            updated_at: U64(self.price_updated_at),
            fresh: self.price > 0
                && env::block_timestamp() <= self.price_updated_at + MAX_PRICE_AGE_NS,
        }
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            users: self.user_count,
            saves: self.next_save_id,
            offers: self.next_offer_id,
            deals: self.next_deal_id,
            deals_settled: self.deals_settled,
            total_saved: U128(self.total_saved),
            total_margin_posted: U128(self.total_margin_posted),
            matched_volume: U128(self.matched_volume),
            fees_earned: U128(self.fees_earned),
        }
    }

    pub fn get_save(&self, save_id: u64) -> Option<SaveOrder> {
        self.saves.get(&save_id).cloned()
    }

    pub fn get_offer(&self, offer_id: u64) -> Option<Offer> {
        self.offers.get(&offer_id).cloned()
    }

    pub fn get_deal(&self, deal_id: u64) -> Option<Deal> {
        self.deals.get(&deal_id).cloned()
    }

    /// Open savings waiting for a match (what the agent reads).
    pub fn get_open_saves(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SaveOrder> {
        self.saves
            .values()
            .filter(|s| s.status == SaveStatus::Open)
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    /// Active offers with margin left (what the agent reads).
    pub fn get_active_offers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Offer> {
        self.offers
            .values()
            .filter(|o| o.status == OfferStatus::Active && o.margin_available.0 > 0)
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    /// Active deals (so anyone, including the agent, can settle them on time).
    pub fn get_active_deals(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Deal> {
        self.deals
            .values()
            .filter(|d| d.status == DealStatus::Active)
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    /// Most recent deals first.
    pub fn get_recent_deals(&self, limit: Option<u32>) -> Vec<Deal> {
        let limit = limit.unwrap_or(20) as u64;
        let start = self.next_deal_id.saturating_sub(limit);
        (start..self.next_deal_id)
            .rev()
            .filter_map(|id| self.deals.get(&id).cloned())
            .collect()
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        AccountView {
            balance: U128(self.balances.get(&account_id).copied().unwrap_or(0)),
            saves: self
                .saves
                .values()
                .filter(|s| s.owner == account_id)
                .cloned()
                .collect(),
            offers: self
                .offers
                .values()
                .filter(|o| o.owner == account_id)
                .cloned()
                .collect(),
            deals: self
                .deals
                .values()
                .filter(|d| d.saver == account_id || d.risk_taker == account_id)
                .cloned()
                .collect(),
        }
    }

    /// What an active deal would pay if settled now, at the latest price.
    pub fn quote(&self, deal_id: u64) -> Option<Quote> {
        let deal = self.deals.get(&deal_id)?;
        if deal.status != DealStatus::Active || self.price == 0 {
            return None;
        }
        let now = env::block_timestamp();
        let (s, r, f, at_risk) = self.payouts(deal, self.price, now);
        let fresh = now <= self.price_updated_at + MAX_PRICE_AGE_NS;
        Some(Quote {
            deal_id,
            price: U128(self.price),
            saver_payout: U128(s),
            risk_taker_payout: U128(r),
            fee: U128(f),
            can_settle: fresh && (now >= deal.end_at.0 || at_risk),
            at_risk,
        })
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Deposits arrive here via `ft_transfer_call` on the asset token. Any
    /// error panics, and the token contract refunds the full amount.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.asset,
            "Bexley only accepts its pool token"
        );
        require!(
            amount.0 >= self.min_deposit,
            "The amount is below the minimum deposit"
        );
        let action: DepositMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("Could not read the deposit message"));
        let now = U64(env::block_timestamp());
        self.track_user(&sender_id);
        match action {
            DepositMsg::Save { duration_secs, min_rate_bps } => {
                require!(
                    self.durations.contains(&duration_secs),
                    "That deal length is not offered"
                );
                require!(min_rate_bps <= MAX_RATE_BPS, "Minimum rate is too high");
                let id = self.next_save_id;
                self.next_save_id += 1;
                self.saves.insert(
                    id,
                    SaveOrder {
                        id,
                        owner: sender_id,
                        amount,
                        duration_secs,
                        min_rate_bps,
                        created_at: now,
                        status: SaveStatus::Open,
                        deal_id: None,
                    },
                );
                self.total_saved += amount.0;
                log!("SAVE_CREATED {} amount {}", id, amount.0);
            }
            DepositMsg::Offer { rate_bps, durations, max_cover } => {
                require!(rate_bps > 0 && rate_bps <= MAX_RATE_BPS, "Rate must be between 0.01% and 500%");
                require!(max_cover >= 1 && max_cover <= MAX_COVER, "Cover must be between 1 and 10");
                require!(!durations.is_empty(), "Pick at least one deal length");
                for d in &durations {
                    require!(self.durations.contains(d), "That deal length is not offered");
                }
                let id = self.next_offer_id;
                self.next_offer_id += 1;
                self.offers.insert(
                    id,
                    Offer {
                        id,
                        owner: sender_id,
                        margin_total: amount,
                        margin_available: amount,
                        rate_bps,
                        durations,
                        max_cover,
                        created_at: now,
                        status: OfferStatus::Active,
                    },
                );
                self.total_margin_posted += amount.0;
                log!("OFFER_CREATED {} margin {}", id, amount.0);
            }
        }
        PromiseOrValue::Value(U128(0))
    }
}

/// Margin a risk-taker must lock for a saver deposit: deposit / cover,
/// rounded up.
pub fn required_margin(saver_amount: u128, max_cover: u32) -> u128 {
    let c = max_cover as u128;
    saver_amount.div_ceil(c)
}

/// Tokens the saver is owed: their deposit's dollar value at entry, grown by
/// the rate over `elapsed_secs`, converted back to tokens at `exit_price`.
pub fn saver_owed(
    amount: u128,
    entry_price: u128,
    exit_price: u128,
    rate_bps: u32,
    elapsed_secs: u64,
) -> u128 {
    let den = BPS * SECONDS_PER_YEAR as u128;
    let num = den + rate_bps as u128 * elapsed_secs as u128;
    // amount * entry / exit * num / den, in 256-bit math.
    mul_div(amount, entry_price * num, exit_price * den)
}

#[cfg(test)]
mod tests;
