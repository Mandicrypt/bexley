//! Test USDC (tUSDC) for Bexley on NEAR testnet.
//!
//! A standard NEP-141 fungible token with 6 decimals, like real USDC.
//! It has NO real value. Anyone can claim a fixed amount from the
//! built-in faucet once per cooldown period, so testers can try Bexley
//! without real money.

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
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// 1 tUSDC in base units (6 decimals).
pub const ONE_TUSDC: u128 = 1_000_000;
/// How much one faucet claim gives: 1,000 tUSDC.
pub const FAUCET_AMOUNT: u128 = 1_000 * ONE_TUSDC;
/// Wait time between claims for the same account: 1 hour.
pub const FAUCET_COOLDOWN_NS: u64 = 60 * 60 * 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    LastClaim,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    /// Last faucet claim time (nanoseconds) per account.
    last_claim: LookupMap<AccountId, u64>,
}

#[near]
impl Contract {
    /// Set up the token. Nothing is minted up front; all supply comes
    /// from faucet claims.
    #[init]
    pub fn new() -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Accounts),
            last_claim: LookupMap::new(StorageKey::LastClaim),
        }
    }

    /// Faucet: give the caller 1,000 tUSDC. Registers the caller's
    /// account first if needed (the contract pays that small storage
    /// cost itself, so testers don't need to). One claim per hour.
    pub fn claim(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let now = env::block_timestamp();
        if let Some(last) = self.last_claim.get(&account) {
            require!(
                now >= last + FAUCET_COOLDOWN_NS,
                "You can claim test USDC once per hour. Please try again later."
            );
        }
        if !self.token.accounts.contains_key(&account) {
            self.token.internal_register_account(&account);
        }
        self.token.internal_deposit(&account, FAUCET_AMOUNT);
        self.last_claim.insert(account.clone(), now);
        FtMint {
            owner_id: &account,
            amount: U128(FAUCET_AMOUNT),
            memo: Some("faucet"),
        }
        .emit();
        U128(FAUCET_AMOUNT)
    }

    /// When the caller can next claim from the faucet (nanoseconds),
    /// or 0 if they can claim now.
    pub fn next_claim_at(&self, account_id: AccountId) -> u64 {
        match self.last_claim.get(&account_id) {
            Some(last) => {
                let next = last + FAUCET_COOLDOWN_NS;
                if env::block_timestamp() >= next {
                    0
                } else {
                    next
                }
            }
            None => 0,
        }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, _burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Bexley Test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(caller: AccountId, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(caller).block_timestamp(ts);
        b
    }

    #[test]
    fn claim_gives_1000_tusdc() {
        testing_env!(ctx(accounts(1), 1).build());
        let mut c = Contract::new();
        c.claim();
        assert_eq!(c.ft_balance_of(accounts(1)).0, FAUCET_AMOUNT);
        assert_eq!(c.ft_total_supply().0, FAUCET_AMOUNT);
    }

    #[test]
    #[should_panic(expected = "once per hour")]
    fn second_claim_too_soon_fails() {
        testing_env!(ctx(accounts(1), 1).build());
        let mut c = Contract::new();
        c.claim();
        testing_env!(ctx(accounts(1), 1 + FAUCET_COOLDOWN_NS - 1).build());
        c.claim();
    }

    #[test]
    fn claim_again_after_an_hour() {
        testing_env!(ctx(accounts(1), 1).build());
        let mut c = Contract::new();
        c.claim();
        testing_env!(ctx(accounts(1), 1 + FAUCET_COOLDOWN_NS).build());
        c.claim();
        assert_eq!(c.ft_balance_of(accounts(1)).0, 2 * FAUCET_AMOUNT);
    }

    #[test]
    fn next_claim_time_is_reported() {
        testing_env!(ctx(accounts(1), 100).build());
        let mut c = Contract::new();
        assert_eq!(c.next_claim_at(accounts(1)), 0);
        c.claim();
        assert_eq!(c.next_claim_at(accounts(1)), 100 + FAUCET_COOLDOWN_NS);
    }

    #[test]
    fn metadata_looks_like_usdc() {
        testing_env!(ctx(accounts(1), 1).build());
        let c = Contract::new();
        let m = c.ft_metadata();
        assert_eq!(m.symbol, "tUSDC");
        assert_eq!(m.decimals, 6);
    }
}
