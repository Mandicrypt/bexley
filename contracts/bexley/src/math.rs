//! 256-bit helpers so large token amounts never overflow.

use near_sdk::env;

uint::construct_uint! {
    pub struct U256(4);
}

/// a * b / c, rounded down, computed in 256 bits. Panics if c is zero or the
/// result does not fit in u128.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if c == 0 {
        env::panic_str("Division by zero");
    }
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    if r > U256::from(u128::MAX) {
        env::panic_str("Number too large");
    }
    r.as_u128()
}
