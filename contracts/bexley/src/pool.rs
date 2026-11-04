//! Pool math, safety modes, fees, minting and redeeming.

use crate::math::mul_div;
use crate::*;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;

/// Below this CR, new bxUSD and xNEAR exits are blocked (130%).
pub const STABILIZE_CR_BPS: u128 = 13_000;
/// Below this CR, fees push people toward safety (150%).
pub const CAUTION_CR_BPS: u128 = 15_000;
/// Stabilizing lifts the CR back to this (140%).
pub const STABILIZE_TARGET_BPS: u128 = 14_000;
/// Share of fees paid to the Stability Pool when it has depositors.
pub const SP_FEE_SHARE_BPS: u128 = 8_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Healthy,
    Caution,
    Stabilize,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Action {
    MintBx,
    RedeemBx,
    MintX,
    RedeemX,
}

/// What a deposit of tokens into the pool asks for (`msg` of `ft_transfer_call`).
#[near(serializers = [json])]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DepositMsg {
    /// tNEAR in, bxUSD out.
    MintBx { min_out: Option<U128> },
    /// tNEAR in, xNEAR out.
    MintX { min_out: Option<U128> },
    /// xNEAR in, tNEAR out.
    RedeemX { min_out: Option<U128> },
    /// tNEAR in, Steady vault shares out.
    VaultDeposit { vault: u8 },
    /// xNEAR in, held until the price hits a stop or take level.
    Order { stop_price: Option<U128>, take_price: Option<U128> },
}

#[near(serializers = [json])]
pub struct PoolView {
    pub price: U128,
    pub price_updated_at: U64,
    pub price_fresh: bool,
    pub mode: Mode,
    pub fee_level: u8,
    /// tNEAR backing the tokens.
    pub collateral: U128,
    /// Pool value in dollars (bxUSD units).
    pub tvl: U128,
    pub bx_supply: U128,
    pub x_supply: U128,
    /// Micro-dollars per xNEAR.
    pub x_price: U128,
    /// Collateral ratio in basis points (15000 = 150%). 0 means no bxUSD yet.
    pub cr_bps: U128,
    /// xNEAR leverage in basis points (20000 = 2x).
    pub leverage_bps: U128,
    pub fees_bps: FeeView,
    pub stability_pool: SpView,
    pub stats: Stats,
    /// Yearly rate the Stability Pool earns now (0 outside Healthy mode).
    pub savings_rate_bps: u32,
    /// The rate the Guardian has set.
    pub savings_rate_set_bps: u32,
    pub interest_paid: U128,
}

#[near(serializers = [json])]
pub struct FeeView {
    pub mint_bx: u32,
    pub redeem_bx: u32,
    pub mint_x: u32,
    pub redeem_x: u32,
    pub mint_bx_open: bool,
    pub redeem_x_open: bool,
}

#[near(serializers = [json])]
pub struct SpView {
    pub bx: U128,
    pub x: U128,
    pub total_shares: U128,
    /// Dollar value of the whole pool (bxUSD units).
    pub value: U128,
}

impl Contract {
    // ---------- Numbers ----------

    pub(crate) fn usd(&self, t: u128) -> u128 {
        mul_div(t, self.price, MICRO)
    }

    pub(crate) fn tnear_for_usd(&self, usd: u128) -> u128 {
        mul_div(usd, MICRO, self.price)
    }

    pub(crate) fn tvl(&self) -> u128 {
        self.usd(self.collateral)
    }

    /// All bxUSD: tokens people hold plus what sits in the Stability Pool.
    pub(crate) fn bx_supply(&self) -> u128 {
        self.bx.total_supply + self.sp_bx
    }

    /// All xNEAR: tokens people hold plus what the pool's features hold.
    pub(crate) fn x_supply(&self) -> u128 {
        self.x_external + self.sp_x + self.order_x + self.vaults.iter().map(|v| v.x).sum::<u128>()
    }

    /// Micro-dollars per xNEAR. $1 before any xNEAR exists; 0 if wiped out.
    pub(crate) fn x_price(&self) -> u128 {
        let x = self.x_supply();
        if x == 0 {
            return MICRO;
        }
        let tvl = self.tvl();
        let s = self.bx_supply();
        if tvl <= s {
            return 0;
        }
        mul_div(tvl - s, MICRO, x)
    }

    pub(crate) fn cr_bps(&self) -> u128 {
        let s = self.bx_supply();
        if s == 0 {
            return u128::MAX;
        }
        mul_div(self.tvl(), BPS, s)
    }

    pub(crate) fn leverage_bps(&self) -> u128 {
        let tvl = self.tvl();
        let s = self.bx_supply();
        if tvl == 0 {
            return BPS;
        }
        if tvl <= s {
            return u128::MAX;
        }
        mul_div(tvl, BPS, tvl - s)
    }

    pub(crate) fn mode(&self) -> Mode {
        Self::mode_at(self.cr_bps())
    }

    pub(crate) fn mode_at(cr: u128) -> Mode {
        if cr < STABILIZE_CR_BPS {
            Mode::Stabilize
        } else if cr < CAUTION_CR_BPS {
            Mode::Caution
        } else {
            Mode::Healthy
        }
    }

    /// Fee in basis points for an action right now (None = not allowed now).
    pub(crate) fn fee_bps(&self, action: Action) -> Option<u32> {
        self.fee_bps_in(self.mode(), action)
    }

    pub(crate) fn fee_bps_in(&self, mode: Mode, action: Action) -> Option<u32> {
        let mult = 1 + self.fee_level as u32;
        let base = match (mode, action) {
            (Mode::Healthy, Action::MintBx) => 20,
            (Mode::Healthy, Action::RedeemBx) => 20,
            (Mode::Healthy, Action::MintX) => 50,
            (Mode::Healthy, Action::RedeemX) => 50,
            (Mode::Caution, Action::MintBx) => 100,
            (Mode::Caution, Action::RedeemBx) => 0,
            (Mode::Caution, Action::MintX) => 0,
            (Mode::Caution, Action::RedeemX) => 200,
            (Mode::Stabilize, Action::MintBx) => return None,
            (Mode::Stabilize, Action::RedeemBx) => 0,
            (Mode::Stabilize, Action::MintX) => 0,
            (Mode::Stabilize, Action::RedeemX) => return None,
        };
        Some(base * mult)
    }

    pub(crate) fn fresh_price(&self) -> u128 {
        require!(self.price > 0, "No price has been posted yet");
        require!(
            now() <= self.price_at + MAX_PRICE_AGE_NS,
            "The price is out of date. Please try again in a few minutes."
        );
        self.price
    }

    fn check_cr_after(&self, what: &str) {
        let cr = self.cr_bps();
        require!(
            cr >= STABILIZE_CR_BPS,
            format!("{what} would push the pool below 130% backing. Try a smaller amount.")
        );
    }

    /// The tNEAR fee is already in the collateral. Share its dollar value:
    /// in Healthy mode as bxUSD (80% Stability Pool, the rest treasury);
    /// otherwise as xNEAR to the Stability Pool, which lifts the CR.
    pub(crate) fn distribute_fee(&mut self, fee_t: u128) {
        if fee_t == 0 {
            return;
        }
        let f = self.usd(fee_t);
        self.stats.fees_usd = U128(self.stats.fees_usd.0 + f);
        let has_sp = self.sp_total_shares > 0;
        if self.mode() == Mode::Healthy {
            let sp_part = if has_sp { f * SP_FEE_SHARE_BPS / BPS } else { 0 };
            self.sp_bx += sp_part;
            let owner = self.owner.clone();
            self.give_bx(&owner, f - sp_part);
        } else if has_sp {
            // Price xNEAR without the fee itself, which is not theirs yet.
            let tvl = self.tvl() - f;
            let s = self.bx_supply();
            let x = self.x_supply();
            if x > 0 && tvl > s {
                self.sp_x += mul_div(f, x, tvl - s);
            }
        }
        // With no Stability Pool depositors outside Healthy mode, the fee
        // simply stays in the pool and strengthens xNEAR.
    }

    // ---------- Core operations (state only; callers move tokens) ----------

    /// tNEAR in, bxUSD amount out.
    pub(crate) fn op_mint_bx(&mut self, t_in: u128) -> u128 {
        self.fresh_price();
        let fee = self.fee_bps(Action::MintBx).unwrap_or_else(|| {
            env::panic_str("New bxUSD is paused while the pool rebuilds its backing (below 130%).")
        });
        let fee_t = t_in * fee as u128 / BPS;
        let out = self.usd(t_in - fee_t);
        self.collateral += t_in;
        self.bx.total_supply += out; // checked below; the real mint follows
        self.check_cr_after("This mint");
        self.bx.total_supply -= out;
        self.distribute_fee(fee_t);
        self.record(Action::MintBx, self.usd(t_in));
        out
    }

    /// bxUSD already burned from the holder (`b` of it), tNEAR amount out.
    pub(crate) fn op_redeem_bx(&mut self, b: u128) -> u128 {
        self.fresh_price();
        let s_before = self.bx_supply() + b;
        let mode_before = Self::mode_at(mul_div(self.tvl(), BPS, s_before));
        let t_out = if self.tvl() < s_before {
            // Under 100% backing, everyone shares what is left, no fee.
            mul_div(b, self.collateral, s_before)
        } else {
            let fee = self.fee_bps_in(mode_before, Action::RedeemBx).unwrap_or(0) as u128;
            let fee_b = b * fee / BPS;
            let t = self.tnear_for_usd(b - fee_b);
            self.collateral -= t;
            self.distribute_fee(self.tnear_for_usd(fee_b));
            self.record(Action::RedeemBx, b);
            return t;
        };
        self.collateral -= t_out;
        self.record(Action::RedeemBx, b);
        t_out
    }

    /// tNEAR in, xNEAR amount out.
    pub(crate) fn op_mint_x(&mut self, t_in: u128) -> u128 {
        self.fresh_price();
        let nav = self.x_price();
        require!(nav > 0, "xNEAR has no value left right now, so new xNEAR cannot be priced.");
        let fee = self.fee_bps(Action::MintX).unwrap_or(0) as u128;
        let fee_t = t_in * fee / BPS;
        let out = mul_div(self.usd(t_in - fee_t), MICRO, nav);
        self.collateral += t_in;
        self.distribute_fee(fee_t);
        self.record(Action::MintX, self.usd(t_in));
        out
    }

    /// `x_amt` xNEAR, which the caller has ALREADY taken out of the tracked
    /// supply (from a holder, a vault or an order), turned into tNEAR.
    pub(crate) fn op_redeem_x(&mut self, x_amt: u128) -> u128 {
        self.fresh_price();
        let fee = self.fee_bps(Action::RedeemX).unwrap_or_else(|| {
            env::panic_str("xNEAR exits are paused while the pool rebuilds its backing (below 130%).")
        }) as u128;
        let nav = self.x_price_with_extra(x_amt);
        let value = mul_div(x_amt, nav, MICRO);
        let fee_v = value * fee / BPS;
        let t_out = self.tnear_for_usd(value - fee_v);
        self.collateral -= t_out;
        if self.bx_supply() > 0 {
            self.check_cr_after("This exit");
        }
        self.distribute_fee(self.tnear_for_usd(fee_v));
        self.record(Action::RedeemX, value);
        t_out
    }

    /// xNEAR price counting `extra` xNEAR that was just taken out of the
    /// tracked supply but has not been paid out yet.
    pub(crate) fn x_price_with_extra(&self, extra: u128) -> u128 {
        let x = self.x_supply() + extra;
        if x == 0 {
            return MICRO;
        }
        let tvl = self.tvl();
        let s = self.bx_supply();
        if tvl <= s {
            return 0;
        }
        mul_div(tvl - s, MICRO, x)
    }

    fn record(&mut self, a: Action, usd: u128) {
        match a {
            Action::MintBx | Action::MintX => self.stats.mints += 1,
            _ => self.stats.redeems += 1,
        }
        self.stats.volume_usd = U128(self.stats.volume_usd.0 + usd);
    }
}

#[near]
impl Contract {
    // ---------- Price ----------

    /// Micro-dollars per whole NEAR, e.g. $3.905 = 3905000. Price feeder only.
    ///
    /// Safety rails, so even a broken or dishonest feeder cannot crash the
    /// pool in one step: one post moves the price at most 5% from the
    /// current one, and at most 1% if the last post was under 4 minutes ago.
    /// A bigger real move is followed over several posts. Returns the price
    /// actually accepted.
    pub fn set_price(&mut self, price: U128) -> U128 {
        require!(
            env::predecessor_account_id() == self.price_feeder,
            "Only the price feeder can post prices"
        );
        require!(price.0 > 0, "Price must be above zero");
        self.accrue();
        let accepted = capped_price(self.price, self.price_at, price.0, now());
        if accepted != price.0 {
            env::log_str(&format!("Price capped: asked {} accepted {}", price.0, accepted));
        }
        self.apply_price(accepted);
        U128(accepted)
    }

    pub(crate) fn apply_price(&mut self, price: u128) {
        self.price = price;
        self.price_at = now();
    }

    // ---------- bxUSD out of the pool ----------

    /// Burn bxUSD and get tNEAR back at $1 each (less a small fee).
    #[payable]
    pub fn redeem_bx(&mut self, amount: U128, min_out: Option<U128>) -> U128 {
        near_sdk::assert_one_yocto();
        self.accrue();
        let me = env::predecessor_account_id();
        require!(amount.0 > 0, "Enter an amount");
        self.bx.internal_withdraw(&me, amount.0);
        let t = self.op_redeem_bx(amount.0);
        if let Some(m) = min_out {
            require!(t >= m.0, "The price moved. You would get less than your minimum.");
        }
        self.give_t(&me, t);
        U128(t)
    }

    // ---------- Views ----------

    pub fn get_pool(&self) -> PoolView {
        let fee = |a| self.fee_bps(a);
        let s = self.bx_supply();
        PoolView {
            price: U128(self.price),
            price_updated_at: U64(self.price_at),
            price_fresh: self.price > 0 && now() <= self.price_at + MAX_PRICE_AGE_NS,
            mode: self.mode(),
            fee_level: self.fee_level,
            collateral: U128(self.collateral),
            tvl: U128(self.tvl()),
            bx_supply: U128(s),
            x_supply: U128(self.x_supply()),
            x_price: U128(self.x_price()),
            cr_bps: U128(if s == 0 { 0 } else { self.cr_bps() }),
            leverage_bps: U128(self.leverage_bps().min(u128::MAX / 2)),
            fees_bps: FeeView {
                mint_bx: fee(Action::MintBx).unwrap_or(0),
                redeem_bx: fee(Action::RedeemBx).unwrap_or(0),
                mint_x: fee(Action::MintX).unwrap_or(0),
                redeem_x: fee(Action::RedeemX).unwrap_or(0),
                mint_bx_open: fee(Action::MintBx).is_some(),
                redeem_x_open: fee(Action::RedeemX).is_some(),
            },
            stability_pool: SpView {
                bx: U128(self.sp_bx),
                x: U128(self.sp_x),
                total_shares: U128(self.sp_total_shares),
                value: U128(self.sp_value()),
            },
            stats: self.stats.clone(),
            savings_rate_bps: self.get_savings_rate(),
            savings_rate_set_bps: self.savings_rate_bps,
            interest_paid: U128(self.interest_paid),
        }
    }

    pub fn get_config(&self) -> serde_json_config::Config {
        serde_json_config::Config {
            owner: self.owner.clone(),
            guardian: self.guardian.clone(),
            price_feeder: self.price_feeder.clone(),
            asset: self.asset.clone(),
            xtoken: self.xtoken.clone(),
        }
    }

    /// Preview what a mint or redeem would give right now, before fees move
    /// the pool. `action` is mint_bx, redeem_bx, mint_x or redeem_x.
    pub fn quote(&self, action: String, amount: U128) -> U128 {
        if self.price == 0 {
            return U128(0);
        }
        let a = amount.0;
        let out = match action.as_str() {
            "mint_bx" => self
                .fee_bps(Action::MintBx)
                .map(|f| self.usd(a - a * f as u128 / BPS))
                .unwrap_or(0),
            "redeem_bx" => {
                let f = self.fee_bps(Action::RedeemBx).unwrap_or(0) as u128;
                if self.tvl() < self.bx_supply() {
                    mul_div(a, self.collateral, self.bx_supply())
                } else {
                    self.tnear_for_usd(a - a * f / BPS)
                }
            }
            "mint_x" => {
                let nav = self.x_price();
                let f = self.fee_bps(Action::MintX).unwrap_or(0) as u128;
                if nav == 0 { 0 } else { mul_div(self.usd(a - a * f / BPS), MICRO, nav) }
            }
            "redeem_x" => self
                .fee_bps(Action::RedeemX)
                .map(|f| {
                    let v = mul_div(a, self.x_price(), MICRO);
                    self.tnear_for_usd(v - v * f as u128 / BPS)
                })
                .unwrap_or(0),
            _ => env::panic_str("Unknown action"),
        };
        U128(out)
    }
}

pub mod serde_json_config {
    use near_sdk::{near, AccountId};

    #[near(serializers = [json])]
    pub struct Config {
        pub owner: AccountId,
        pub guardian: AccountId,
        pub price_feeder: AccountId,
        pub asset: AccountId,
        pub xtoken: AccountId,
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// tNEAR and xNEAR arrive here via `ft_transfer_call`. Any error panics
    /// and the token contract refunds the whole amount.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        self.accrue();
        let token = env::predecessor_account_id();
        let action: DepositMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("Could not read the deposit message"));
        require!(amount.0 > 0, "Amount must be above zero");
        self.track_user(&sender_id);
        let min_ok = |out: u128, min: &Option<U128>| {
            if let Some(m) = min {
                require!(out >= m.0, "The price moved. You would get less than your minimum.");
            }
        };
        if token == self.asset {
            match action {
                DepositMsg::MintBx { min_out } => {
                    let out = self.op_mint_bx(amount.0);
                    min_ok(out, &min_out);
                    self.give_bx(&sender_id, out);
                }
                DepositMsg::MintX { min_out } => {
                    let out = self.op_mint_x(amount.0);
                    min_ok(out, &min_out);
                    self.give_x(&sender_id, out);
                }
                DepositMsg::VaultDeposit { vault } => self.vault_deposit_internal(&sender_id, vault, amount.0),
                _ => env::panic_str("Send xNEAR, not tNEAR, for this"),
            }
        } else if token == self.xtoken {
            // The xNEAR is now the pool's; take it out of circulation.
            self.x_external -= amount.0;
            self.burn_returned_x(amount.0);
            match action {
                DepositMsg::RedeemX { min_out } => {
                    let out = self.op_redeem_x(amount.0);
                    min_ok(out, &min_out);
                    self.give_t(&sender_id, out);
                }
                DepositMsg::Order { stop_price, take_price } => {
                    self.order_create_internal(&sender_id, amount.0, stop_price, take_price)
                }
                _ => env::panic_str("Send tNEAR, not xNEAR, for this"),
            }
        } else {
            env::panic_str("Bexley only accepts tNEAR and xNEAR");
        }
        PromiseOrValue::Value(U128(0))
    }
}

/// Largest move one price post can make, in basis points.
pub const PRICE_STEP_BPS: u128 = 500;
/// Largest move when the last post was recent.
pub const PRICE_STEP_FAST_BPS: u128 = 100;
/// Posts closer together than this get the smaller step.
pub const PRICE_FAST_GAP_NS: u64 = 4 * 60 * 1_000_000_000;

/// The price a post is allowed to set (see `set_price`).
pub fn capped_price(old: u128, old_at: u64, new: u128, at: u64) -> u128 {
    if old == 0 {
        return new; // the very first price
    }
    let step = if at.saturating_sub(old_at) >= PRICE_FAST_GAP_NS { PRICE_STEP_BPS } else { PRICE_STEP_FAST_BPS };
    let lo = old * (10_000 - step) / 10_000;
    let hi = old * (10_000 + step) / 10_000;
    new.clamp(lo, hi)
}
