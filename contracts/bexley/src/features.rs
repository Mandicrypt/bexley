//! Stability Pool, Steady vaults, exit orders and the AI Pool Guardian.

use crate::math::mul_div;
use crate::*;

// ===================== Stability Pool =====================
//
// bxUSD holders deposit here to earn the pool's fees. In return, when the
// pool's backing drops below 130%, part of their bxUSD is converted into
// xNEAR at fair value. That removes bxUSD debt and lifts the backing back up.

impl Contract {
    pub(crate) fn sp_value(&self) -> u128 {
        self.sp_bx + mul_div(self.sp_x, self.x_price(), MICRO)
    }
}

#[near(serializers = [json])]
pub struct SpPosition {
    pub shares: U128,
    pub bx: U128,
    pub x: U128,
    pub value: U128,
}

#[near]
impl Contract {
    /// Put bxUSD into the Stability Pool.
    #[payable]
    pub fn sp_deposit(&mut self, amount: U128) -> U128 {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        require!(amount.0 > 0, "Enter an amount");
        let value = self.sp_value();
        self.bx.internal_withdraw(&me, amount.0);
        let shares = if self.sp_total_shares == 0 || value == 0 {
            amount.0
        } else {
            mul_div(amount.0, self.sp_total_shares, value)
        };
        self.sp_bx += amount.0;
        self.sp_total_shares += shares;
        let cur = self.sp_shares.get(&me).copied().unwrap_or(0);
        self.sp_shares.insert(me.clone(), cur + shares);
        self.track_user(&me);
        U128(shares)
    }

    /// Take out your share of the Stability Pool: bxUSD, plus any xNEAR it
    /// received while protecting the pool.
    #[payable]
    pub fn sp_withdraw(&mut self, shares: Option<U128>) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mine = self.sp_shares.get(&me).copied().unwrap_or(0);
        let s = shares.map(|v| v.0).unwrap_or(mine);
        require!(s > 0 && s <= mine, "You do not have that many Stability Pool shares");
        let bx_out = mul_div(self.sp_bx, s, self.sp_total_shares);
        let x_out = mul_div(self.sp_x, s, self.sp_total_shares);
        self.sp_bx -= bx_out;
        self.sp_x -= x_out;
        self.sp_total_shares -= s;
        self.sp_shares.insert(me.clone(), mine - s);
        self.give_bx(&me, bx_out);
        self.give_x(&me, x_out);
    }

    /// When the backing is under 130%, convert Stability Pool bxUSD into
    /// xNEAR until it is back at 140% (or the pool runs out). Anyone can
    /// call it; the Guardian does so automatically.
    pub fn stabilize(&mut self) -> U128 {
        self.fresh_price();
        require!(
            self.mode() == Mode::Stabilize,
            "The pool is above 130% backing. Nothing to stabilize."
        );
        let nav = self.x_price();
        require!(nav > 0, "xNEAR has no value left, so it cannot absorb more.");
        let s = self.bx_supply();
        let tvl = self.tvl();
        let needed = s.saturating_sub(mul_div(tvl, BPS, STABILIZE_TARGET_BPS));
        let b = needed.min(self.sp_bx);
        require!(b > 0, "The Stability Pool is empty.");
        let x_new = mul_div(b, MICRO, nav);
        self.sp_bx -= b;
        self.sp_x += x_new;
        self.stats.stabilizations += 1;
        self.add_note(
            "protect",
            format!(
                "Backing fell below 130%. Converted {} bxUSD in the Stability Pool into xNEAR. Backing is now {}%.",
                whole(b),
                self.cr_bps() / 100
            ),
        );
        U128(b)
    }

    pub fn get_sp_position(&self, account_id: AccountId) -> SpPosition {
        let shares = self.sp_shares.get(&account_id).copied().unwrap_or(0);
        if shares == 0 || self.sp_total_shares == 0 {
            return SpPosition { shares: U128(0), bx: U128(0), x: U128(0), value: U128(0) };
        }
        let bx = mul_div(self.sp_bx, shares, self.sp_total_shares);
        let x = mul_div(self.sp_x, shares, self.sp_total_shares);
        SpPosition {
            shares: U128(shares),
            bx: U128(bx),
            x: U128(x),
            value: U128(bx + mul_div(x, self.x_price(), MICRO)),
        }
    }
}

// ===================== Steady vaults =====================
//
// xNEAR's leverage floats with the pool. A Steady vault holds a mix of tNEAR
// and xNEAR so that the whole vault keeps a fixed leverage (2x or 3x).
// Rebalancing is computed on-chain; anyone can trigger it and the Guardian
// does when the vault drifts.

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Vault {
    pub id: u8,
    pub target_bps: u32,
    /// Plain tNEAR held by the vault.
    pub t: u128,
    /// xNEAR held by the vault (part of the xNEAR supply).
    pub x: u128,
    pub total_shares: u128,
}

impl Vault {
    pub fn new(id: u8, target_bps: u32) -> Self {
        Self { id, target_bps, t: 0, x: 0, total_shares: 0 }
    }
}

#[near(serializers = [json])]
pub struct VaultView {
    pub id: u8,
    pub name: String,
    pub target_bps: u32,
    pub t: U128,
    pub x: U128,
    /// Vault value in tNEAR.
    pub value: U128,
    pub total_shares: U128,
    /// Leverage on NEAR right now, basis points.
    pub leverage_bps: U128,
    pub needs_rebalance: bool,
}

#[near(serializers = [json])]
pub struct VaultPosition {
    pub vault: u8,
    pub shares: U128,
    /// Your share of the vault, in tNEAR.
    pub value: U128,
}

/// A vault rebalances when it is this far (in basis points of value) from target.
pub const REBALANCE_DRIFT_BPS: u128 = 300;

impl Contract {
    fn vkey(vault: u8, a: &AccountId) -> String {
        format!("{vault}:{a}")
    }

    /// tNEAR value of some xNEAR at the current price.
    pub(crate) fn x_in_tnear(&self, x: u128) -> u128 {
        if self.price == 0 {
            return 0;
        }
        mul_div(mul_div(x, self.x_price(), MICRO), MICRO, self.price)
    }

    pub(crate) fn vault_value(&self, v: &Vault) -> u128 {
        v.t + self.x_in_tnear(v.x)
    }

    /// The vault's leverage on NEAR: plain tNEAR counts 1x, xNEAR counts at
    /// xNEAR's leverage.
    pub(crate) fn vault_leverage_bps(&self, v: &Vault) -> u128 {
        let value = self.vault_value(v);
        if value == 0 {
            return v.target_bps as u128;
        }
        let lx = self.leverage_bps().min(100 * BPS);
        let exposure = v.t * BPS + self.x_in_tnear(v.x) * lx;
        exposure / value
    }

    /// How much of the vault (in tNEAR) should be xNEAR to hit the target.
    fn vault_target_x_value(&self, v: &Vault) -> u128 {
        let value = self.vault_value(v);
        let lx = self.leverage_bps();
        let target = v.target_bps as u128;
        if lx <= target || lx > 100 * BPS {
            // xNEAR alone is not levered enough (or the pool is broken): go all in.
            return if lx > 100 * BPS { 0 } else { value };
        }
        mul_div(value, target - BPS, lx - BPS)
    }

    pub(crate) fn vault_needs_rebalance(&self, v: &Vault) -> bool {
        let value = self.vault_value(v);
        if value == 0 || self.price == 0 {
            return false;
        }
        let have = self.x_in_tnear(v.x);
        let want = self.vault_target_x_value(v);
        let diff = have.abs_diff(want);
        diff * BPS > value * REBALANCE_DRIFT_BPS
    }

    /// Move the vault to its target leverage. Each trade shifts the pool a
    /// little (and so xNEAR's leverage), so it takes a few small passes.
    pub(crate) fn rebalance_internal(&mut self, id: u8) -> bool {
        let mut traded = false;
        for _ in 0..4 {
            if !self.rebalance_once(id) {
                break;
            }
            traded = true;
        }
        if traded {
            self.stats.rebalances += 1;
        }
        traded
    }

    fn rebalance_once(&mut self, id: u8) -> bool {
        let idx = id as usize;
        let v = self.vaults[idx].clone();
        if !self.vault_needs_rebalance(&v) {
            return false;
        }
        let have = self.x_in_tnear(v.x);
        let want = self.vault_target_x_value(&v);
        if want > have {
            // Turn some plain tNEAR into xNEAR.
            let t = (want - have).min(v.t);
            if t == 0 || self.x_price() == 0 {
                return false;
            }
            let x = self.op_mint_x(t);
            let vm = &mut self.vaults[idx];
            vm.t -= t;
            vm.x += x;
        } else {
            // Turn some xNEAR back into tNEAR, if exits are open.
            if self.fee_bps(Action::RedeemX).is_none() {
                return false;
            }
            let x = mul_div(v.x, have - want, have.max(1)).min(v.x);
            if x == 0 {
                return false;
            }
            self.vaults[idx].x -= x;
            let t = self.op_redeem_x(x);
            self.vaults[idx].t += t;
        }
        true
    }

    pub(crate) fn vault_deposit_internal(&mut self, who: &AccountId, vault: u8, t_in: u128) {
        require!((vault as usize) < self.vaults.len(), "That vault does not exist");
        self.fresh_price();
        let v = self.vaults[vault as usize].clone();
        let value = self.vault_value(&v);
        let shares = if v.total_shares == 0 || value == 0 { t_in } else { mul_div(t_in, v.total_shares, value) };
        {
            let vm = &mut self.vaults[vault as usize];
            vm.t += t_in;
            vm.total_shares += shares;
        }
        let k = Self::vkey(vault, who);
        let cur = self.vault_shares.get(&k).copied().unwrap_or(0);
        self.vault_shares.insert(k, cur + shares);
        self.rebalance_internal(vault);
    }
}

#[near]
impl Contract {
    /// Leave a Steady vault. You get tNEAR; if xNEAR exits are paused
    /// (backing under 130%), your xNEAR part comes as xNEAR tokens instead.
    #[payable]
    pub fn vault_withdraw(&mut self, vault: u8, shares: Option<U128>) {
        near_sdk::assert_one_yocto();
        require!((vault as usize) < self.vaults.len(), "That vault does not exist");
        self.fresh_price();
        let me = env::predecessor_account_id();
        let k = Self::vkey(vault, &me);
        let mine = self.vault_shares.get(&k).copied().unwrap_or(0);
        let s = shares.map(|v| v.0).unwrap_or(mine);
        require!(s > 0 && s <= mine, "You do not have that many vault shares");
        let v = self.vaults[vault as usize].clone();
        let t_part = mul_div(v.t, s, v.total_shares);
        let x_part = mul_div(v.x, s, v.total_shares);
        {
            let vm = &mut self.vaults[vault as usize];
            vm.t -= t_part;
            vm.x -= x_part;
            vm.total_shares -= s;
        }
        self.vault_shares.insert(k, mine - s);
        let mut t_out = t_part;
        if x_part > 0 {
            if self.fee_bps(Action::RedeemX).is_some() {
                t_out += self.op_redeem_x(x_part);
            } else {
                self.give_x(&me, x_part);
            }
        }
        self.give_t(&me, t_out);
    }

    /// Bring a vault back to its target leverage. Anyone can call it.
    pub fn rebalance(&mut self, vault: u8) -> bool {
        require!((vault as usize) < self.vaults.len(), "That vault does not exist");
        self.fresh_price();
        let before = self.vault_leverage_bps(&self.vaults[vault as usize].clone());
        let done = self.rebalance_internal(vault);
        if done {
            let v = self.vaults[vault as usize].clone();
            self.add_note(
                "rebalance",
                format!(
                    "Rebalanced Steady {}x from {}x back to {}x.",
                    v.target_bps / 10_000,
                    times(before),
                    times(self.vault_leverage_bps(&v))
                ),
            );
        }
        done
    }

    pub fn get_vaults(&self) -> Vec<VaultView> {
        self.vaults
            .iter()
            .map(|v| VaultView {
                id: v.id,
                name: format!("Steady {}x", v.target_bps / 10_000),
                target_bps: v.target_bps,
                t: U128(v.t),
                x: U128(v.x),
                value: U128(self.vault_value(v)),
                total_shares: U128(v.total_shares),
                leverage_bps: U128(self.vault_leverage_bps(v)),
                needs_rebalance: self.vault_needs_rebalance(v),
            })
            .collect()
    }

    pub fn get_vault_positions(&self, account_id: AccountId) -> Vec<VaultPosition> {
        self.vaults
            .iter()
            .map(|v| {
                let shares = self.vault_shares.get(&Self::vkey(v.id, &account_id)).copied().unwrap_or(0);
                let value = if v.total_shares == 0 { 0 } else { mul_div(self.vault_value(v), shares, v.total_shares) };
                VaultPosition { vault: v.id, shares: U128(shares), value: U128(value) }
            })
            .collect()
    }
}

// ===================== Exit orders =====================
//
// Park xNEAR with a stop price, a take price, or both. When NEAR's price
// reaches one, the order can be executed: the xNEAR is redeemed and the
// tNEAR goes straight to the owner. The contract checks the price itself,
// so whoever executes it (usually the Guardian) cannot cheat.

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderStatus {
    Open,
    Executed,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub owner: AccountId,
    pub x_amount: U128,
    /// Sell if NEAR falls to or below this (micro-dollars).
    pub stop_price: Option<U128>,
    /// Sell if NEAR rises to or above this (micro-dollars).
    pub take_price: Option<U128>,
    pub created_at: U64,
    pub status: OrderStatus,
    pub executed_price: Option<U128>,
    pub tnear_out: Option<U128>,
}

impl Contract {
    pub(crate) fn order_create_internal(
        &mut self,
        owner: &AccountId,
        x: u128,
        stop: Option<U128>,
        take: Option<U128>,
    ) {
        require!(stop.is_some() || take.is_some(), "Set a stop price, a take price, or both");
        if let (Some(s), Some(t)) = (stop, take) {
            require!(s.0 < t.0, "The stop price must be below the take price");
        }
        let id = self.next_order_id;
        self.next_order_id += 1;
        self.order_x += x;
        self.orders.insert(
            id,
            Order {
                id,
                owner: owner.clone(),
                x_amount: U128(x),
                stop_price: stop,
                take_price: take,
                created_at: U64(now()),
                status: OrderStatus::Open,
                executed_price: None,
                tnear_out: None,
            },
        );
    }

    fn order_triggered(&self, o: &Order, price: u128) -> Option<&'static str> {
        if o.status != OrderStatus::Open {
            return None;
        }
        if let Some(s) = o.stop_price {
            if price <= s.0 {
                return Some("stop-loss");
            }
        }
        if let Some(t) = o.take_price {
            if price >= t.0 {
                return Some("take-profit");
            }
        }
        None
    }
}

#[near]
impl Contract {
    /// Execute an order whose price has been reached. Anyone can call it.
    pub fn execute_order(&mut self, order_id: u64) -> U128 {
        let price = self.fresh_price();
        let mut o = self.orders.get(&order_id).expect("Order not found").clone();
        let kind = self
            .order_triggered(&o, price)
            .unwrap_or_else(|| env::panic_str("This order's price has not been reached"));
        self.order_x -= o.x_amount.0;
        let t = self.op_redeem_x(o.x_amount.0);
        o.status = OrderStatus::Executed;
        o.executed_price = Some(U128(price));
        o.tnear_out = Some(U128(t));
        let owner = o.owner.clone();
        self.orders.insert(order_id, o);
        self.stats.orders_executed += 1;
        self.give_t(&owner, t);
        self.add_note(
            "order",
            format!(
                "Executed a {kind} for {} at NEAR ${}: sold xNEAR for {} tNEAR.",
                owner,
                dollars(price),
                whole(t)
            ),
        );
        U128(t)
    }

    /// Cancel your open order and get your xNEAR back.
    #[payable]
    pub fn cancel_order(&mut self, order_id: u64) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mut o = self.orders.get(&order_id).expect("Order not found").clone();
        require!(o.owner == me, "This is not your order");
        require!(o.status == OrderStatus::Open, "This order is no longer open");
        o.status = OrderStatus::Cancelled;
        self.order_x -= o.x_amount.0;
        let x = o.x_amount.0;
        self.orders.insert(order_id, o);
        self.give_x(&me, x);
    }

    /// Open orders whose price is reached right now (what the Guardian reads).
    pub fn get_triggered_orders(&self, limit: Option<u32>) -> Vec<Order> {
        if self.price == 0 {
            return vec![];
        }
        self.orders
            .values()
            .filter(|o| self.order_triggered(o, self.price).is_some())
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    pub fn get_orders(&self, account_id: AccountId) -> Vec<Order> {
        self.orders.values().filter(|o| o.owner == account_id).cloned().collect()
    }
}

// ===================== AI Pool Guardian =====================
//
// The Guardian (an off-chain AI agent with a limited key) posts prices, sets
// the fee level within fixed limits, triggers protection, rebalancing and
// orders, and explains what it did in short public notes. It can never move
// anyone's funds: every action it can take is also checked by this contract.

pub const MAX_NOTES: usize = 40;
pub const MAX_NOTE_LEN: usize = 280;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Note {
    pub id: u64,
    pub at: U64,
    /// price, fees, protect, rebalance, order, watch
    pub kind: String,
    pub text: String,
}

impl Contract {
    pub(crate) fn add_note(&mut self, kind: &str, text: String) {
        let mut text = text;
        text.truncate(MAX_NOTE_LEN);
        let id = self.next_note_id;
        self.next_note_id += 1;
        self.notes.push(Note { id, at: U64(now()), kind: kind.to_string(), text });
        if self.notes.len() > MAX_NOTES {
            self.notes.remove(0);
        }
    }

    fn assert_guardian(&self) {
        require!(
            env::predecessor_account_id() == self.guardian,
            "Only the Pool Guardian can do this"
        );
    }
}

#[near]
impl Contract {
    /// Set the fee level: 0 calm (1x fees), 1 volatile (2x), 2 stormy (3x).
    pub fn set_fee_level(&mut self, level: u8, reason: String) {
        self.assert_guardian();
        require!(level <= 2, "Fee level must be 0, 1 or 2");
        if level != self.fee_level {
            self.fee_level = level;
            self.add_note("fees", reason);
        }
    }

    /// The Guardian explains something in plain English.
    pub fn post_note(&mut self, kind: String, text: String) {
        self.assert_guardian();
        require!(!text.is_empty(), "Empty note");
        self.add_note(&kind, text);
    }

    /// Newest first.
    pub fn get_notes(&self, limit: Option<u32>) -> Vec<Note> {
        self.notes.iter().rev().take(limit.unwrap_or(20) as usize).cloned().collect()
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        AccountView {
            bx: U128(self.bx.accounts.get(&account_id).unwrap_or(0)),
            stability_pool: self.get_sp_position(account_id.clone()),
            vaults: self.get_vault_positions(account_id.clone()),
            orders: self.get_orders(account_id.clone()),
            claim_tnear: U128(self.claim_t.get(&account_id).copied().unwrap_or(0)),
            claim_xnear: U128(self.claim_x.get(&account_id).copied().unwrap_or(0)),
        }
    }
}

#[near(serializers = [json])]
pub struct AccountView {
    pub bx: U128,
    pub stability_pool: SpPosition,
    pub vaults: Vec<VaultPosition>,
    pub orders: Vec<Order>,
    pub claim_tnear: U128,
    pub claim_xnear: U128,
}

/// Whole tokens with 2 decimals, for notes.
pub(crate) fn whole(units: u128) -> String {
    let cents = units / (ONE / 100);
    format!("{}.{:02}", cents / 100, cents % 100)
}

/// Basis points as "2.15".
pub(crate) fn times(bps: u128) -> String {
    let h = bps / 100;
    format!("{}.{:02}", h / 100, h % 100)
}

/// Micro-dollars as "3.905".
pub(crate) fn dollars(micro: u128) -> String {
    format!("{}.{:03}", micro / 1_000_000, (micro % 1_000_000) / 1_000)
}
