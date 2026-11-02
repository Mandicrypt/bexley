//! xNEAR: Bexley's leveraged NEAR token.
//!
//! A standard NEP-141 token that anyone can hold and send. Only the Bexley
//! pool contract (the "controller") can mint or burn it; the pool decides
//! how much xNEAR each deposit is worth.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
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
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    controller: AccountId,
    name: String,
    symbol: String,
    decimals: u8,
}

#[near]
impl Contract {
    #[init]
    pub fn new(controller: AccountId, name: String, symbol: String, decimals: u8) -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Accounts),
            controller,
            name,
            symbol,
            decimals,
        }
    }

    fn assert_controller(&self) {
        require!(
            env::predecessor_account_id() == self.controller,
            "Only the Bexley pool can do this"
        );
    }

    /// Mint to an account, registering it first if needed (this contract pays
    /// the small storage cost, so users never have to).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        self.assert_controller();
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount, memo: None }.emit();
    }

    /// Burn from an account's balance (the pool only burns its own).
    pub fn burn(&mut self, account_id: AccountId, amount: U128) {
        self.assert_controller();
        self.token.internal_withdraw(&account_id, amount.0);
        FtBurn { owner_id: &account_id, amount, memo: None }.emit();
    }

    pub fn register(&mut self, account_id: AccountId) {
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
    }

    pub fn controller(&self) -> AccountId {
        self.controller.clone()
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        if !self.token.accounts.contains_key(&receiver_id) {
            self.token.internal_register_account(&receiver_id);
        }
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
        if !self.token.accounts.contains_key(&receiver_id) {
            self.token.internal_register_account(&receiver_id);
        }
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
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
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
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn as_(who: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).build());
    }
    fn x() -> Contract {
        Contract::new(acc("pool.test"), "Bexley Leveraged NEAR".into(), "xNEAR".into(), 24)
    }

    #[test]
    fn controller_mints_and_burns() {
        as_("pool.test");
        let mut c = x();
        c.mint(acc("alice.test"), U128(100));
        assert_eq!(c.ft_balance_of(acc("alice.test")).0, 100);
        c.burn(acc("alice.test"), U128(40));
        assert_eq!(c.ft_balance_of(acc("alice.test")).0, 60);
        assert_eq!(c.ft_total_supply().0, 60);
    }

    #[test]
    #[should_panic(expected = "Only the Bexley pool")]
    fn others_cannot_mint() {
        as_("pool.test");
        let mut c = x();
        as_("alice.test");
        c.mint(acc("alice.test"), U128(100));
    }

    #[test]
    fn metadata() {
        as_("pool.test");
        assert_eq!(x().ft_metadata().symbol, "xNEAR");
    }
}
