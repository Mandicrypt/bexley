// Number formatting for Bexley. Token amounts are bigint base units
// (tNEAR has 24 decimals); prices are micro-dollars (6 decimals).

export const DECIMALS = 24;
const ONE = 10n ** BigInt(DECIMALS);
const SECONDS_PER_YEAR = 31_536_000n;

/** "12.5" -> base units. Returns null for anything that is not a positive amount. */
export function parseAmount(text, decimals = DECIMALS) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  const v = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return v > 0n ? v : null;
}

/** Base units -> "12.34" (trimmed, up to `places` decimals). */
export function formatAmount(units, places = 2, decimals = DECIMALS) {
  const v = BigInt(units ?? 0);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  const w = whole.toLocaleString('en-US');
  return `${neg ? '-' : ''}${w}${frac ? '.' + frac : ''}`;
}

/** Micro-dollars -> "$3.91". */
export function formatUsd(micro, places = 2) {
  const v = Number(BigInt(micro ?? 0)) / 1e6;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })}`;
}

/** Dollar value of a token amount at a micro-dollar price. */
export function usdValue(units, micro) {
  return (BigInt(units) * BigInt(micro)) / ONE; // micro-dollars
}

/** Basis points -> "12.5%". */
export function formatRate(bps) {
  return `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** "12.5" (percent) -> 1250 bps, or null. */
export function parseRate(text) {
  const n = Number(String(text).trim());
  if (!Number.isFinite(n) || n < 0 || n > 500) return null;
  return Math.round(n * 100);
}

const LENGTHS = { 600: '10 minutes', 3600: '1 hour', 86400: '1 day', 604800: '7 days', 1209600: '14 days', 2592000: '30 days' };
const SHORT = { 600: '10m', 3600: '1h', 86400: '1d', 604800: '7d', 1209600: '14d', 2592000: '30d' };

export function lengthLabel(secs, short = false) {
  const map = short ? SHORT : LENGTHS;
  if (map[secs]) return map[secs];
  if (secs % 86400 === 0) return `${secs / 86400} days`;
  if (secs % 3600 === 0) return `${secs / 3600} hours`;
  return `${Math.round(secs / 60)} minutes`;
}

/** Tokens a saver gets back at the same price after the full term. */
export function grownAmount(units, rateBps, secs) {
  const den = 10_000n * SECONDS_PER_YEAR;
  return (BigInt(units) * (den + BigInt(rateBps) * BigInt(secs))) / den;
}

/** "2h 05m" / "3d 4h" / "ended" from nanosecond timestamps. */
export function timeLeft(endNs, nowMs = Date.now()) {
  const ms = Number(BigInt(endNs) / 1_000_000n) - nowMs;
  if (ms <= 0) return 'ended';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(mm).padStart(2, '0')}m`;
  if (m > 0) return `${mm}m`;
  return '< 1m';
}

export function shortAccount(id) {
  if (!id) return '';
  return id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}
