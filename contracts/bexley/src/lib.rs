//! Bexley pool: one pool of NEAR, split into two tokens.
//!
//! - **bxUSD** (this contract is the token): a stablecoin worth $1. Its value
//!   is backed by the pool and protected by xNEAR.
//! - **xNEAR** (a separate token the pool controls): leveraged NEAR. It owns
//!   whatever the pool is worth above the bxUSD it owes, so it moves more than
//!   NEAR in both directions.
//!
//!   pool value (TVL) = tNEAR in the pool x NEAR price
//!   xNEAR price      = (TVL - bxUSD supply) / xNEAR supply
//!   collateral ratio = TVL / bxUSD supply
//!   xNEAR leverage   = TVL / (TVL - bxUSD supply)
//!
//! Every mint and redeem happens at fair value, so it never changes anyone
//! else's xNEAR price. Fees go to the Stability Pool (bxUSD holders who agree
//! to absorb risk) and the treasury.
//!
//! Safety modes follow the collateral ratio (CR):
//!   Healthy   CR >= 150%  normal fees
//!   Caution   CR <  150%  fees steer people toward safety
//!   Stabilize CR <  130%  no new bxUSD, no xNEAR exits; the Stability Pool
//!                         converts its bxUSD into xNEAR to lift the CR
//!
//! Stability Pool savers also earn a savings rate paid by xNEAR holders,
//! set by the Guardian from how much leverage people want.
//!
//! On top: Steady 2x/3x vaults that hold a fixed leverage, stop-loss and
//! take-profit orders for xNEAR, and an AI Pool Guardian that posts prices,
//! tunes fees within set limits, triggers protection and explains each move
//! in on-chain notes.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, PromiseOrValue,
};

mod features;
mod savings;
mod math;
mod pool;
#[cfg(test)]
mod tests;

pub use features::*;
pub use savings::*;
pub use pool::*;

/// 1 whole token in base units (tNEAR, bxUSD and xNEAR all use 24 decimals).
pub const ONE: u128 = 1_000_000_000_000_000_000_000_000;
/// Prices are micro-dollars per whole token.
pub const MICRO: u128 = 1_000_000;
pub const BPS: u128 = 10_000;
pub const MAX_PRICE_AGE_NS: u64 = 60 * 60 * 1_000_000_000;

const GAS_FT: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
pub(crate) enum StorageKey {
    Bx,
    SpShares,
    VaultShares,
    Orders,
    ClaimT,
    ClaimX,
    Users,
}

#[ext_contract(ext_xtoken)]
pub trait XToken {
    fn mint(&mut self, account_id: AccountId, amount: U128);
    fn burn(&mut self, account_id: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner: AccountId,
    pub(crate) guardian: AccountId,
    pub(crate) price_feeder: AccountId,
    /// The collateral token (tNEAR on testnet).
    pub(crate) asset: AccountId,
    /// The xNEAR token this pool controls.
    pub(crate) xtoken: AccountId,

    /// bxUSD itself.
    pub(crate) bx: FungibleToken,

    pub(crate) price: u128,
    pub(crate) price_at: u64,
    /// 0 calm, 1 volatile, 2 stormy: multiplies fees, set by the Guardian.
    pub(crate) fee_level: u8,

    /// tNEAR backing bxUSD and xNEAR.
    pub(crate) collateral: u128,
    /// xNEAR held by people as real tokens.
    pub(crate) x_external: u128,

    // Stability Pool
    pub(crate) sp_bx: u128,
    pub(crate) sp_x: u128,
    pub(crate) sp_total_shares: u128,
    pub(crate) sp_shares: LookupMap<AccountId, u128>,

    // Steady vaults (index 0 = 2x, 1 = 3x)
    pub(crate) vaults: Vec<Vault>,
    pub(crate) vault_shares: LookupMap<String, u128>,

    // Exit orders
    pub(crate) orders: IterableMap<u64, Order>,
    pub(crate) next_order_id: u64,
    pub(crate) order_x: u128,

    /// tNEAR or xNEAR owed to people whose transfer failed; they can claim it.
    pub(crate) claim_t: LookupMap<AccountId, u128>,
    pub(crate) claim_x: LookupMap<AccountId, u128>,

    pub(crate) notes: Vec<Note>,
    pub(crate) next_note_id: u64,

    pub(crate) users: LookupSet<AccountId>,
    pub(crate) stats: Stats,

    // Savings rate (added in v2.1): Stability Pool bxUSD earns this yearly
    // rate, paid by xNEAR holders. Set by the Guardian.
    pub(crate) savings_rate_bps: u32,
    pub(crate) last_accrual: u64,
    pub(crate) interest_paid: u128,
}

/// The layout before the savings rate was added, for `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV2_0 {
    pub(crate) owner: AccountId,
    pub(crate) guardian: AccountId,
    pub(crate) price_feeder: AccountId,
    /// The collateral token (tNEAR on testnet).
    pub(crate) asset: AccountId,
    /// The xNEAR token this pool controls.
    pub(crate) xtoken: AccountId,

    /// bxUSD itself.
    pub(crate) bx: FungibleToken,

    pub(crate) price: u128,
    pub(crate) price_at: u64,
    /// 0 calm, 1 volatile, 2 stormy: multiplies fees, set by the Guardian.
    pub(crate) fee_level: u8,

    /// tNEAR backing bxUSD and xNEAR.
    pub(crate) collateral: u128,
    /// xNEAR held by people as real tokens.
    pub(crate) x_external: u128,

    // Stability Pool
    pub(crate) sp_bx: u128,
    pub(crate) sp_x: u128,
    pub(crate) sp_total_shares: u128,
    pub(crate) sp_shares: LookupMap<AccountId, u128>,

    // Steady vaults (index 0 = 2x, 1 = 3x)
    pub(crate) vaults: Vec<Vault>,
    pub(crate) vault_shares: LookupMap<String, u128>,

    // Exit orders
    pub(crate) orders: IterableMap<u64, Order>,
    pub(crate) next_order_id: u64,
    pub(crate) order_x: u128,

    /// tNEAR or xNEAR owed to people whose transfer failed; they can claim it.
    pub(crate) claim_t: LookupMap<AccountId, u128>,
    pub(crate) claim_x: LookupMap<AccountId, u128>,

    pub(crate) notes: Vec<Note>,
    pub(crate) next_note_id: u64,

    pub(crate) users: LookupSet<AccountId>,
    pub(crate) stats: Stats,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Stats {
    pub users: u64,
    pub mints: u64,
    pub redeems: u64,
    /// Dollar value of all mints and redeems (bxUSD units).
    pub volume_usd: U128,
    pub fees_usd: U128,
    pub stabilizations: u64,
    pub rebalances: u64,
    pub orders_executed: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(asset: AccountId, xtoken: AccountId, guardian: AccountId, price_feeder: AccountId) -> Self {
        let owner = env::predecessor_account_id();
        let mut bx = FungibleToken::new(StorageKey::Bx);
        bx.internal_register_account(&owner);
        Self {
            owner,
            guardian,
            price_feeder,
            asset,
            xtoken,
            bx,
            price: 0,
            price_at: 0,
            fee_level: 0,
            collateral: 0,
            x_external: 0,
            sp_bx: 0,
            sp_x: 0,
            sp_total_shares: 0,
            sp_shares: LookupMap::new(StorageKey::SpShares),
            vaults: vec![Vault::new(0, 20_000), Vault::new(1, 30_000)],
            vault_shares: LookupMap::new(StorageKey::VaultShares),
            orders: IterableMap::new(StorageKey::Orders),
            next_order_id: 0,
            order_x: 0,
            claim_t: LookupMap::new(StorageKey::ClaimT),
            claim_x: LookupMap::new(StorageKey::ClaimX),
            notes: Vec::new(),
            next_note_id: 0,
            users: LookupSet::new(StorageKey::Users),
            stats: Stats::default(),
            savings_rate_bps: DEFAULT_SAVINGS_BPS,
            last_accrual: 0,
            interest_paid: 0,
        }
    }

    /// One-time upgrade from the layout without a savings rate. Keeps every
    /// balance and position. Only the contract account itself can call it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let o: ContractV2_0 = env::state_read().expect("Nothing to migrate");
        Self {
            owner: o.owner,
            guardian: o.guardian,
            price_feeder: o.price_feeder,
            asset: o.asset,
            xtoken: o.xtoken,
            bx: o.bx,
            price: o.price,
            price_at: o.price_at,
            fee_level: o.fee_level,
            collateral: o.collateral,
            x_external: o.x_external,
            sp_bx: o.sp_bx,
            sp_x: o.sp_x,
            sp_total_shares: o.sp_total_shares,
            sp_shares: o.sp_shares,
            vaults: o.vaults,
            vault_shares: o.vault_shares,
            orders: o.orders,
            next_order_id: o.next_order_id,
            order_x: o.order_x,
            claim_t: o.claim_t,
            claim_x: o.claim_x,
            notes: o.notes,
            next_note_id: o.next_note_id,
            users: o.users,
            stats: o.stats,
            savings_rate_bps: DEFAULT_SAVINGS_BPS,
            last_accrual: env::block_timestamp(),
            interest_paid: 0,
        }
    }

    // ---------- Owner ----------

    pub fn set_guardian(&mut self, guardian: AccountId) {
        self.assert_owner();
        self.guardian = guardian;
    }

    pub fn set_price_feeder(&mut self, price_feeder: AccountId) {
        self.assert_owner();
        self.price_feeder = price_feeder;
    }

    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    // ---------- Shared helpers ----------

    pub(crate) fn track_user(&mut self, a: &AccountId) {
        if self.users.insert(a.clone()) {
            self.stats.users += 1;
        }
    }

    /// Give bxUSD to an account (registering it for free if needed).
    pub(crate) fn give_bx(&mut self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        if !self.bx.accounts.contains_key(to) {
            self.bx.internal_register_account(to);
        }
        self.bx.internal_deposit(to, amount);
        FtMint { owner_id: to, amount: U128(amount), memo: None }.emit();
    }

    /// Mint real xNEAR tokens to someone.
    pub(crate) fn give_x(&mut self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        self.x_external += amount;
        let _ = ext_xtoken::ext(self.xtoken.clone())
            .with_static_gas(GAS_FT)
            .mint(to.clone(), U128(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_give_x(to.clone(), U128(amount)),
            );
    }

    /// Send tNEAR out of the pool to someone.
    pub(crate) fn give_t(&mut self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let _ = ext_ft_core::ext(self.asset.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT)
            .ft_transfer(to.clone(), U128(amount), Some("Bexley".into()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_give_t(to.clone(), U128(amount)),
            );
    }

    /// xNEAR that came back to the pool is destroyed.
    pub(crate) fn burn_returned_x(&mut self, amount: u128) {
        if amount == 0 {
            return;
        }
        let _ = ext_xtoken::ext(self.xtoken.clone())
            .with_static_gas(GAS_FT)
            .burn(env::current_account_id(), U128(amount));
    }

    #[private]
    pub fn on_give_t(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            let cur = self.claim_t.get(&account_id).copied().unwrap_or(0);
            self.claim_t.insert(account_id, cur + amount.0);
        }
        ok
    }

    #[private]
    pub fn on_give_x(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            self.x_external -= amount.0;
            let cur = self.claim_x.get(&account_id).copied().unwrap_or(0);
            self.claim_x.insert(account_id, cur + amount.0);
        }
        ok
    }

    /// Retry sending anything a failed transfer left behind.
    pub fn claim(&mut self) {
        let me = env::predecessor_account_id();
        let t = self.claim_t.get(&me).copied().unwrap_or(0);
        let x = self.claim_x.get(&me).copied().unwrap_or(0);
        require!(t > 0 || x > 0, "Nothing to claim");
        self.claim_t.insert(me.clone(), 0);
        self.claim_x.insert(me.clone(), 0);
        self.give_t(&me, t);
        self.give_x(&me, x);
    }
}

// ---------- bxUSD token (NEP-141) ----------

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        if !self.bx.accounts.contains_key(&receiver_id) {
            self.bx.internal_register_account(&receiver_id);
        }
        self.bx.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if !self.bx.accounts.contains_key(&receiver_id) {
            self.bx.internal_register_account(&receiver_id);
        }
        self.bx.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.bx.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.bx.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.bx.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.bx.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.bx.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.bx.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.bx.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.bx.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Bexley USD".to_string(),
            symbol: "bxUSD".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 24,
        }
    }
}

pub(crate) fn now() -> u64 {
    env::block_timestamp()
}
