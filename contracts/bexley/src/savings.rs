//! Savings rate: bxUSD in the Stability Pool earns a yearly rate, paid by
//! xNEAR holders.
//!
//! xNEAR's leverage comes from bxUSD: in effect, xNEAR borrows from bxUSD
//! holders. So xNEAR pays savers a small rate, a little at a time. The pool
//! mints new bxUSD into the Stability Pool; the pool's value is unchanged,
//! so that bxUSD comes out of xNEAR's share.
//!
//! The rate only runs while the pool is Healthy, and never pushes backing
//! below 150%. The Guardian sets it (0% to 20%) from how much leverage
//! people want.

use crate::math::mul_div;
use crate::*;

pub const DEFAULT_SAVINGS_BPS: u32 = 800;
pub const MAX_SAVINGS_BPS: u32 = 2_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

impl Contract {
    /// Pay savers the interest built up since the last call.
    pub(crate) fn accrue(&mut self) {
        let now = now();
        if self.last_accrual == 0 || now <= self.last_accrual {
            self.last_accrual = now.max(self.last_accrual);
            return;
        }
        let dt = ((now - self.last_accrual) / 1_000_000_000) as u128;
        if dt == 0 {
            return;
        }
        self.last_accrual = now;
        if self.price == 0 || self.savings_rate_bps == 0 || self.sp_bx == 0 || self.mode() != Mode::Healthy {
            return;
        }
        let mut interest = mul_div(self.sp_bx, self.savings_rate_bps as u128 * dt, BPS * SECONDS_PER_YEAR);
        // Never let interest push backing under 150%.
        let room = mul_div(self.tvl(), BPS, CAUTION_CR_BPS).saturating_sub(self.bx_supply());
        interest = interest.min(room);
        if interest == 0 {
            return;
        }
        self.sp_bx += interest;
        self.interest_paid += interest;
    }
}

#[near]
impl Contract {
    /// Guardian: set the fee level (0 calm, 1 volatile, 2 stormy) and,
    /// optionally, the savings rate in basis points (0 to 2000 = 20% a year).
    /// `reason` is posted as a public note when anything changes.
    pub fn set_fee_level(&mut self, level: u8, reason: String, savings_rate_bps: Option<u32>) {
        require!(env::predecessor_account_id() == self.guardian, "Only the Pool Guardian can do this");
        require!(level <= 2, "Fee level must be 0, 1 or 2");
        self.accrue();
        let fee_changed = level != self.fee_level;
        self.fee_level = level;
        let mut rate_changed = false;
        if let Some(r) = savings_rate_bps {
            require!(r <= MAX_SAVINGS_BPS, "The savings rate can be at most 20% a year");
            rate_changed = r != self.savings_rate_bps;
            self.savings_rate_bps = r;
        }
        if (fee_changed || rate_changed) && !reason.is_empty() {
            self.add_note(if rate_changed { "rate" } else { "fees" }, reason);
        }
    }

    /// Anyone can bring the savings interest up to date.
    pub fn accrue_interest(&mut self) {
        self.accrue();
    }

    /// The yearly rate the Stability Pool earns right now, in basis points
    /// (0 outside Healthy mode).
    pub fn get_savings_rate(&self) -> u32 {
        if self.price == 0 || self.mode() != Mode::Healthy {
            0
        } else {
            self.savings_rate_bps
        }
    }

    /// Total bxUSD paid to savers so far.
    pub fn get_interest_paid(&self) -> U128 {
        U128(self.interest_paid)
    }
}
