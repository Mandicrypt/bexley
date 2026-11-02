//! A configurable faucet test token for Bexley on NEAR testnet.
//!
//! Standard NEP-141. Name, symbol, decimals and the faucet amount are set
//! once at init. Used for Test NEAR (tNEAR), the asset Bexley deals are
//! held in. It has NO real value: anyone can claim a fixed amount once
//! per hour so testers can use Bexley freely.

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
    last_claim: LookupMap<AccountId, u64>,
    name: String,
    symbol: String,
    decimals: u8,
    faucet_amount: u128,
}

#[near]
impl Contract {
    /// `faucet_amount` is in base units (e.g. 100 tNEAR with 24 decimals
    /// is "100000000000000000000000000").
    #[init]
    pub fn new(name: String, symbol: String, decimals: u8, faucet_amount: U128) -> Self {
        require!(faucet_amount.0 > 0, "Faucet amount must be above zero");
        Self {
            token: FungibleToken::new(StorageKey::Accounts),
            last_claim: LookupMap::new(StorageKey::LastClaim),
            name,
            symbol,
            decimals,
            faucet_amount: faucet_amount.0,
        }
    }

    /// Faucet: give the caller the faucet amount, once per hour. Registers
    /// the caller first if needed (the contract pays that storage).
    pub fn claim(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let now = env::block_timestamp();
        if let Some(last) = self.last_claim.get(&account) {
            require!(
                now >= last + FAUCET_COOLDOWN_NS,
                "You can claim test tokens once per hour. Please try again later."
            );
        }
        if !self.token.accounts.contains_key(&account) {
            self.token.internal_register_account(&account);
        }
        self.token.internal_deposit(&account, self.faucet_amount);
        self.last_claim.insert(account.clone(), now);
        FtMint {
            owner_id: &account,
            amount: U128(self.faucet_amount),
            memo: Some("faucet"),
        }
        .emit();
        U128(self.faucet_amount)
    }

    /// Register another account (for example a contract) so it can hold
    /// the token. The contract pays the small storage cost.
    pub fn register(&mut self, account_id: AccountId) {
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
    }

    /// When the account can next claim (nanoseconds), or 0 if now.
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

    pub fn faucet_amount(&self) -> U128 {
        U128(self.faucet_amount)
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
        let (used_amount, _burned) =
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
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: self.decimals,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const HUNDRED: u128 = 100 * 10u128.pow(24);

    fn ctx(caller: AccountId, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(caller).block_timestamp(ts);
        b
    }

    fn tnear() -> Contract {
        Contract::new("Bexley Test NEAR".into(), "tNEAR".into(), 24, U128(HUNDRED))
    }

    #[test]
    fn claim_gives_faucet_amount() {
        testing_env!(ctx(accounts(1), 1).build());
        let mut c = tnear();
        c.claim();
        assert_eq!(c.ft_balance_of(accounts(1)).0, HUNDRED);
    }

    #[test]
    #[should_panic(expected = "once per hour")]
    fn claim_cooldown() {
        testing_env!(ctx(accounts(1), 1).build());
        let mut c = tnear();
        c.claim();
        c.claim();
    }

    #[test]
    fn register_lets_contract_hold_tokens() {
        testing_env!(ctx(accounts(1), 1).build());
        let mut c = tnear();
        c.register(accounts(2));
        assert!(c.storage_balance_of(accounts(2)).is_some());
        assert_eq!(c.ft_balance_of(accounts(2)).0, 0);
    }

    #[test]
    fn metadata_from_init() {
        testing_env!(ctx(accounts(1), 1).build());
        let c = tnear();
        let m = c.ft_metadata();
        assert_eq!(m.symbol, "tNEAR");
        assert_eq!(m.decimals, 24);
    }
}
