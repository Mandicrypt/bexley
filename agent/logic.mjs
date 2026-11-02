// Bexley agent: the decision logic. Pure functions, no network, so they can
// be tested on their own. The contract re-checks every rule, so a mistake
// here can only cause a refused call, never an unfair match.

/** Margin an offer must lock for a deposit: deposit / cover, rounded up. */
export function requiredMargin(amount, maxCover) {
  const a = BigInt(amount);
  const c = BigInt(maxCover);
  return (a + c - 1n) / c;
}

/** Can this offer take this saving right now? */
export function eligible(save, offer, freeMargin) {
  return (
    save.owner !== offer.owner &&
    offer.durations.includes(save.duration_secs) &&
    offer.rate_bps >= save.min_rate_bps &&
    freeMargin >= requiredMargin(save.amount, offer.max_cover)
  );
}

/**
 * Rank the eligible offers for one saving, best first.
 * 1. Highest rate: the saver earns the most.
 * 2. Lowest cover: more margin per token deposited, so the saver is safer.
 * 3. Oldest offer: first come, first served.
 */
export function rankOffers(save, offers, freeMargins) {
  return offers
    .filter((o) => eligible(save, o, freeMargins.get(o.id)))
    .sort(
      (a, b) =>
        b.rate_bps - a.rate_bps ||
        a.max_cover - b.max_cover ||
        Number(BigInt(a.created_at) - BigInt(b.created_at)) ||
        a.id - b.id,
    );
}

/**
 * Plan matches for all open savings, oldest saving first. Offers' free margin
 * is used up as matches are planned, so one offer is never over-committed.
 * Returns [{saveId, offerId, rateBps, reason, alternatives}] and the savings
 * left unmatched with why.
 */
export function planMatches(saves, offers) {
  const freeMargins = new Map(offers.map((o) => [o.id, BigInt(o.margin_available)]));
  const ordered = [...saves].sort(
    (a, b) => Number(BigInt(a.created_at) - BigInt(b.created_at)) || a.id - b.id,
  );
  const matches = [];
  const unmatched = [];
  for (const save of ordered) {
    const ranked = rankOffers(save, offers, freeMargins);
    if (ranked.length === 0) {
      unmatched.push({ saveId: save.id, reason: whyNoMatch(save, offers, freeMargins) });
      continue;
    }
    const best = ranked[0];
    freeMargins.set(best.id, freeMargins.get(best.id) - requiredMargin(save.amount, best.max_cover));
    matches.push({
      saveId: save.id,
      offerId: best.id,
      rateBps: best.rate_bps,
      reason: `best of ${ranked.length} eligible offer(s): ${(best.rate_bps / 100).toFixed(2)}% a year, cover ${best.max_cover}`,
      alternatives: ranked.length - 1,
    });
  }
  return { matches, unmatched };
}

function whyNoMatch(save, offers, freeMargins) {
  const others = offers.filter((o) => o.owner !== save.owner);
  if (others.length === 0) return 'no offers from other people';
  const length = others.filter((o) => o.durations.includes(save.duration_secs));
  if (length.length === 0) return 'no offer accepts this deal length';
  const rate = length.filter((o) => o.rate_bps >= save.min_rate_bps);
  if (rate.length === 0) return 'no offer meets the minimum rate';
  return 'offers do not have enough free margin';
}

/**
 * Post a new price when there is none, it has moved by at least `moveBps`,
 * or the last post is older than `maxAgeMs` (the contract refuses prices
 * older than an hour, so this keeps it fresh).
 */
export function shouldPostPrice(onchain, newPrice, nowMs, { moveBps = 10, maxAgeMs = 20 * 60_000 } = {}) {
  const current = BigInt(onchain.price);
  if (current === 0n) return true;
  const ageMs = nowMs - Number(BigInt(onchain.updated_at) / 1_000_000n);
  if (ageMs >= maxAgeMs) return true;
  const diff = newPrice > current ? newPrice - current : current - newPrice;
  return diff * 10_000n >= current * BigInt(moveBps);
}

/** Dollars (number) to the contract's micro-dollars (bigint). */
export function toMicroUsd(usd) {
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error(`Bad price: ${usd}`);
  return BigInt(Math.round(usd * 1_000_000));
}
