// The radar's value model and farm-plan generator.
//
// Every number on the board derives from the sealed snapshot's own fields.
// No protocol name is special-cased anywhere: one formula ranks every
// protocol, and one set of templates writes every farm plan.
//
// Implied value, per protocol:
//
//   implied = TVL x category multiple x growth factor x maturity factor x footprint factor
//
// - category multiple: the median market-cap-to-TVL ratio of the protocols
//   in the same category whose token already trades, computed from this very
//   snapshot. Categories with fewer than three such protocols use the global
//   median. The live-token protocols are the calibration set, never the board.
// - growth factor: from the seven-day TVL change, clamped so one wild week
//   cannot dominate the ranking.
// - maturity factor: from the days since DefiLlama began tracking the
//   protocol, saturating: a long record with no token counts, with
//   diminishing weight past the first year.
// - footprint factor: from the number of chains the protocol's TVL spans.
//
// A protocol records no token when both gecko_id and symbol are null in the
// snapshot. The board holds only protocols that record no token and are not
// a wrapped, staked or bridged product of a token that already trades, by
// the same exclusion the house's own watchlist rule applies.

const DAY_MS = 86400000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** True when the snapshot records no token for the protocol. */
export function recordsNoToken(protocol) {
  return protocol.gecko_id === null && protocol.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * True when the protocol is a wrapped, staked or bridged product of a token
 * that already trades, mirroring the exclusion in the snapshot's own
 * watchlist rule (input/README.md). It reads the snapshot's fields only and
 * names no protocol: such a product is not a protocol still waiting on a
 * launch of its own.
 */
export function isWrappedOrStakedProduct(protocol) {
  if (EXCLUDED_CATEGORIES.has(protocol.category)) return true;
  if (VERSION_SUFFIX.test(protocol.name)) return true;
  if (WRAPPED_WORD.test(protocol.name)) return true;
  return EXCHANGE_PREFIXES.some((prefix) => protocol.name.startsWith(prefix));
}

/**
 * The calibration set: for each category, the median market-cap-to-TVL ratio
 * of the protocols whose token already trades. Categories with fewer than
 * three live-token protocols fall back to the global median, so no category
 * is priced on one or two observations.
 */
export function calibrateCategoryMultiples(protocols) {
  const live = protocols.filter(
    (p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const globalMultiple = clamp(median(live.map((p) => p.mcap_usd / p.tvl_usd)), 0.05, 2.5);
  const ratiosByCategory = new Map();
  for (const p of live) {
    const category = p.category ?? 'Uncategorized';
    if (!ratiosByCategory.has(category)) ratiosByCategory.set(category, []);
    ratiosByCategory.get(category).push(p.mcap_usd / p.tvl_usd);
  }
  const multiples = new Map();
  const counts = new Map();
  for (const [category, ratios] of ratiosByCategory) {
    counts.set(category, ratios.length);
    multiples.set(category, ratios.length >= 3 ? clamp(median(ratios), 0.05, 2.5) : globalMultiple);
  }
  const table = [...multiples.entries()]
    .map(([category, multiple]) => ({
      category,
      multiple,
      n: counts.get(category),
      fallback: counts.get(category) < 3,
    }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { multiples, globalMultiple, table };
}

/** Growth factor from the seven-day TVL change, in per cent. Unknown: neutral. */
export function growthFactor(change7d) {
  if (change7d === null || change7d === undefined || Number.isNaN(change7d)) return 1;
  return 1 + clamp(change7d, -50, 100) / 250;
}

/** Days between the snapshot date and the day tracking began. Unknown: null. */
export function ageDaysOf(listedAt, asOf) {
  if (!listedAt) return null;
  return Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(listedAt)) / DAY_MS));
}

/**
 * Maturity factor: a protocol that has run longer with no token has the
 * longer record, with diminishing weight past the first year. Unknown
 * listing date: neutral.
 */
export function maturityFactor(listedAt, asOf) {
  const ageDays = ageDaysOf(listedAt, asOf);
  if (ageDays === null) return 1;
  return 0.85 + 0.3 * (1 - Math.exp(-ageDays / 365));
}

/** Footprint factor: each further chain adds a little, up to eight extra. */
export function footprintFactor(chains) {
  const count = Array.isArray(chains) ? chains.length : 0;
  return 1 + 0.04 * clamp(count - 1, 0, 8);
}

/**
 * The implied value of a launch if the protocol's record stayed as it is,
 * with the factor breakdown the dashboard shows. The value is this entry's
 * own claim, never make.fun's.
 */
export function impliedValueUsd(protocol, calibration, asOf) {
  const multiple = calibration.multiples.get(protocol.category ?? 'Uncategorized') ?? calibration.globalMultiple;
  const growth = growthFactor(protocol.change_7d);
  const maturity = maturityFactor(protocol.listed_at, asOf);
  const footprint = footprintFactor(protocol.chains);
  const value = Math.round(protocol.tvl_usd * multiple * growth * maturity * footprint);
  return { value: clamp(value, 1, 100000000000000), multiple, growth, maturity, footprint };
}

// --------------------------------------------------------------- farm plans

// Approximate gas bands per chain, in US dollars, stated as "about" in the
// steps. Chains are general knowledge, not protocol names; anything unlisted
// takes the default band.
const GAS_BANDS = {
  Ethereum: '$6–$20',
  Arbitrum: '$0.30–$1.50',
  Base: '$0.10–$0.80',
  Optimism: '$0.20–$1',
  Binance: '$0.15–$0.80',
  Avalanche: '$0.20–$1',
  Polygon: '$0.05–$0.50',
  Solana: '$0.01–$0.10',
  Sui: '$0.01–$0.10',
  Tron: '$1–$3',
  Monad: '$0.05–$0.50',
  'Hyperliquid L1': '$0.05–$0.50',
  Linea: '$0.10–$0.80',
  Sonic: '$0.05–$0.50',
  Mantle: '$0.05–$0.50',
  Scroll: '$0.10–$0.80',
  Unichain: '$0.05–$0.50',
  Berachain: '$0.05–$0.50',
  Sei: '$0.01–$0.10',
  Aptos: '$0.01–$0.10',
  Near: '$0.01–$0.10',
  Fantom: '$0.05–$0.50',
  Gnosis: '$0.05–$0.50',
  Blast: '$0.05–$0.50',
  Mode: '$0.05–$0.50',
  ZkSync: '$0.10–$0.80',
  Starknet: '$0.20–$1',
  Bitcoin: '$2–$8',
  Bittensor: '$0.05–$0.50',
  Algorand: '$0.01–$0.05',
  Stellar: '$0.01–$0.05',
  Ripple: '$0.01–$0.05',
  Flare: '$0.05–$0.50',
  Plume: '$0.05–$0.50',
  'Plume Mainnet': '$0.05–$0.50',
  Katana: '$0.05–$0.50',
  Ink: '$0.05–$0.50',
  Arc: '$0.05–$0.50',
  Tempo: '$0.05–$0.50',
  Morph: '$0.05–$0.50',
  Stable: '$0.05–$0.50',
  Hemi: '$0.05–$0.50',
  BOB: '$0.05–$0.50',
  TAC: '$0.05–$0.50',
  Corn: '$0.05–$0.50',
  Mezo: '$0.05–$0.50',
  Citrea: '$0.05–$0.50',
  Pharos: '$0.05–$0.50',
  Plasma: '$0.05–$0.50',
  World: '$0.05–$0.50',
  'World Chain': '$0.05–$0.50',
  Rayls: '$0.05–$0.50',
  Etherlink: '$0.05–$0.50',
  'XRPL EVM': '$0.01–$0.10',
  CORE: '$0.05–$0.50',
  'Babylon Genesis': '$0.05–$0.50',
  BSquared: '$0.05–$0.50',
  Fluent: '$0.05–$0.50',
  Noble: '$0.01–$0.10',
};

// The asset a farmer starts from on each chain. Unlisted chains take USDC.
const CHAIN_ASSETS = {
  Ethereum: 'ETH and USDC',
  Arbitrum: 'ETH and USDC',
  Base: 'ETH and USDC',
  Optimism: 'ETH and USDC',
  Binance: 'BNB and USDT',
  Avalanche: 'AVAX and USDC',
  Polygon: 'POL and USDC',
  Solana: 'SOL and USDC',
  Sui: 'SUI and USDC',
  Tron: 'TRX and USDT',
  Bitcoin: 'BTC',
  Bittensor: 'TAO',
  Algorand: 'ALGO and USDC',
  Stellar: 'XLM and USDC',
  Ripple: 'XRP and USDC',
  Near: 'NEAR and USDC',
  Aptos: 'APT and USDC',
  Sei: 'SEI and USDC',
  Fantom: 'FTM and USDC',
  Gnosis: 'xDAI and USDC',
};

function primaryChain(protocol) {
  return protocol.chains && protocol.chains.length > 0 ? protocol.chains[0] : 'Ethereum';
}

function gasBand(chain) {
  return GAS_BANDS[chain] ?? '$0.50–$3';
}

function fundAsset(chain) {
  return CHAIN_ASSETS[chain] ?? 'USDC';
}

// The suggested position size follows the protocol's TVL band: larger,
// deeper protocols take larger positions without moving their own markets.
function depositBand(tvlUsd) {
  if (tvlUsd >= 500000000) return '$1,000–$5,000';
  if (tvlUsd >= 100000000) return '$500–$2,000';
  return '$250–$1,000';
}

// Category families, each with its own core actions. Categories the map does
// not name take the generic pair, so every protocol gets a plan.
const FAMILY_OF = {
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  'Collateral Markets': 'lending',
  'Collateral Management': 'lending',
  Dexs: 'dexs',
  'Liquidity Manager': 'dexs',
  'OTC Marketplace': 'dexs',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Farm: 'yield',
  'Leveraged Farming': 'yield',
  'Dual-Token Stablecoin': 'yield',
  RWA: 'rwa',
  'Reserve Currency': 'rwa',
  'Stablecoin Issuer': 'rwa',
  'Algo-Stables': 'rwa',
  'Stablecoin Wrapper': 'rwa',
  Derivatives: 'derivatives',
  Options: 'derivatives',
  'Options Vault': 'derivatives',
  'Interest Rate Derivatives': 'derivatives',
  Synthetics: 'derivatives',
  'Prediction Market': 'derivatives',
  DOR: 'derivatives',
  CDP: 'cdp',
  'CDP Manager': 'cdp',
  'Risk Curators': 'curator',
  'Onchain Capital Allocator': 'curator',
  Chain: 'chain',
  'Staking Pool': 'staking',
  Restaking: 'restaking',
  'Basis Trading': 'basis',
  Launchpad: 'launchpad',
};

function familyOf(category) {
  return FAMILY_OF[category] ?? 'generic';
}

// The two core steps per family. Each names the protocol, its primary chain,
// a concrete action, a cost and a duration.
const CORE_STEPS = {
  lending: (p, ctx) => [
    `Supply ${ctx.asset} into ${p.name}'s lending market on ${ctx.chain}, then borrow up to half its value in a stablecoin. Keep the health factor above 1.8. Budget about ${ctx.gas} in gas; the round trip takes 15–30 minutes.`,
    `Put the borrowed stablecoins to work in a second ${p.name} market, or repay the loan after 7 days, so the position shows real borrowing activity rather than one idle deposit sitting untouched.`,
  ],
  dexs: (p, ctx) => [
    `Add a two-sided ${ctx.deposit} liquidity position to ${p.name}'s highest-volume pool on ${ctx.chain}, in the pair the pool already prices. Budget about ${ctx.gas} in gas and 15 minutes; the position earns fees from the first day.`,
    `Stake the LP tokens if ${p.name} offers a gauge or farm, and route one swap a week through the pool, so the position reads as an active liquidity provider rather than a passive deposit.`,
  ],
  yield: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s highest-TVL vault on ${ctx.chain} and hold the receipt token. Budget about ${ctx.gas} in gas; the deposit itself takes under 10 minutes.`,
    `Leave the vault position untouched for at least 30 days so yield and any points accrue on a time-weighted balance, and claim or compound rewards no more than once a week to keep gas low.`,
  ],
  rwa: (p, ctx) => [
    `Complete ${p.name}'s onboarding for its tokenized asset on ${ctx.chain} and buy or mint a ${ctx.deposit} position. Budget about ${ctx.gas} in gas plus any onboarding fee; allow 1–3 days if identity checks apply.`,
    `Hold the position through at least one distribution cycle and keep the receipt token in the same wallet, so the holding history is unbroken when eligibility is read.`,
  ],
  derivatives: (p, ctx) => [
    `Open a small hedged position on ${p.name} on ${ctx.chain}: ${ctx.deposit} of collateral, 2x leverage at most, with a stop 10% away. Budget about ${ctx.gas} in gas and 20 minutes to set up.`,
    `Trade once a week for 6–8 weeks, keeping total fees under 1% of the position, so the account shows repeated use rather than a single trade.`,
  ],
  cdp: (p, ctx) => [
    `Lock ${ctx.deposit} of ${ctx.asset} as collateral in ${p.name}'s vault on ${ctx.chain} and mint stablecoins against it at no more than 50% of the limit. Budget about ${ctx.gas} in gas; allow 20 minutes.`,
    `Hold the vault open for at least 30 days, topping up collateral if the ratio drifts, and repay in full before closing so the position ends clean.`,
  ],
  curator: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s largest curated vault on ${ctx.chain} and hold the vault token. Budget about ${ctx.gas} in gas; the deposit takes under 10 minutes.`,
    `Stay deposited through at least one curator rebalance cycle, usually 2–4 weeks, and read the vault's allocation notes each week, so the position survives rebalances without exits.`,
  ],
  chain: (p, ctx) => [
    `Bridge ${ctx.deposit} to ${ctx.chain} and stake or delegate at least half of it through ${p.name}'s native staking. Budget about ${ctx.gas} in gas; allow 20–40 minutes including confirmations.`,
    `Use two or three native apps on ${ctx.chain} with the rest — a swap, a lend, a mint — once a week for a month, so the wallet shows chain-native activity beyond the stake.`,
  ],
  staking: (p, ctx) => [
    `Stake ${ctx.deposit} of ${ctx.asset} in ${p.name}'s pool on ${ctx.chain} and hold the liquid receipt token. Budget about ${ctx.gas} in gas; the stake takes under 10 minutes.`,
    `Keep the stake in place for at least 30 days and, if the receipt token is accepted elsewhere, deposit it once into a lending market to deepen the footprint without unstaking.`,
  ],
  restaking: (p, ctx) => [
    `Restake ${ctx.deposit} of ${ctx.asset} through ${p.name} on ${ctx.chain} and delegate to an operator with a long uptime record. Budget about ${ctx.gas} in gas; allow 20 minutes.`,
    `Hold the restaked position for at least 30 days and check the operator's status weekly; redelegate only if the operator misses attestations.`,
  ],
  basis: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s basis vault on ${ctx.chain} and hold the vault token through at least one funding cycle. Budget about ${ctx.gas} in gas; the deposit takes under 10 minutes.`,
    `Leave the position untouched for 30–60 days: basis strategies pay on time in the vault, and early exits usually forfeit the accrued edge.`,
  ],
  launchpad: (p, ctx) => [
    `Commit ${ctx.deposit} to ${p.name}'s allocation staking on ${ctx.chain} and complete any allowlist or identity step it requires. Budget about ${ctx.gas} in gas; allow 1–3 days for checks.`,
    `Join at least two sales or distributions over the next 8 weeks, even small ones, so the account shows repeated participation rather than one stake.`,
  ],
  generic: (p, ctx) => [
    `Use ${p.name}'s core product on ${ctx.chain} with ${ctx.deposit}: make the first real transaction the product exists for, not a test transfer. Budget about ${ctx.gas} in gas and 20 minutes.`,
    `Repeat the core action weekly for 6–8 weeks with similar sizes, so the wallet builds a history of genuine use before any snapshot.`,
  ],
};

/**
 * The farm plan for one protocol: 6 steps, 7 when it spans more than one
 * chain. Every step names a concrete action, what it costs and how long it
 * takes. The plan is a pure function of the protocol's snapshot fields.
 */
export function farmPlan(protocol) {
  const chain = primaryChain(protocol);
  const ctx = { chain, gas: gasBand(chain), asset: fundAsset(chain), deposit: depositBand(protocol.tvl_usd) };
  const steps = [
    `Move ${ctx.deposit} of ${ctx.asset} to ${chain}. Bridge from your exchange account or wallet, keep ${ctx.gas} aside for gas, and allow 10–25 minutes for the transfer to land before you touch the protocol.`,
    ...CORE_STEPS[familyOf(protocol.category)](protocol, ctx),
    `Opt into ${protocol.name}'s points or rewards program if it runs one, and keep the position open for at least 30 days. Most snapshots reward time-weighted balances, so one long position beats several short ones.`,
    `Check the position once a week for 8–12 weeks: top up if the balance falls by more than a third, watch for snapshot or season announcements, and never drain the wallet in a single move.`,
    `Record every deposit, fee, and reward with its date in a notebook. When a claim window opens, claim within the first week, and unstake only after the snapshot that rewards the position has passed.`,
  ];
  if (protocol.chains && protocol.chains.length > 1) {
    steps.splice(
      4,
      0,
      `Mirror a smaller position on a second chain ${protocol.name} runs on, ${protocol.chains[1]}: repeat the core action with about a quarter of the size, so the footprint spans more than one network.`,
    );
  }
  return steps;
}

// --------------------------------------------------------------- the board

/**
 * Build the board: every protocol that records no token and is not a
 * wrapped, staked or bridged product, ranked by implied value, rank 1 the
 * most valuable. Throws when the watchlist is not fully covered, rather
 * than writing a board the gate would refuse.
 */
export function buildBoard(snapshot) {
  const asOf = snapshot.as_of;
  const watchlist = new Set(snapshot.watchlist);
  const calibration = calibrateCategoryMultiples(snapshot.protocols);
  const candidates = snapshot.protocols.filter((p) => recordsNoToken(p) && !isWrappedOrStakedProduct(p));
  const rows = candidates.map((p) => {
    const v = impliedValueUsd(p, calibration, asOf);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDaysOf(p.listed_at, asOf),
      watchlist: watchlist.has(p.slug),
      has_token: false,
      implied_value_usd: v.value,
      value_breakdown: {
        category_multiple: v.multiple,
        growth_factor: v.growth,
        maturity_factor: v.maturity,
        footprint_factor: v.footprint,
      },
      farm_steps: farmPlan(p),
    };
  });
  rows.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  const covered = rows.filter((r) => r.watchlist).length;
  if (covered !== watchlist.size) {
    throw new Error(`watchlist coverage ${covered}/${watchlist.size}: every watchlist slug must appear on the board`);
  }
  const stats = {
    as_of: asOf,
    floor_usd: snapshot.floor_usd,
    protocols: snapshot.protocols.length,
    pre_token: snapshot.protocols.filter(recordsNoToken).length,
    board_rows: rows.length,
    watchlist: watchlist.size,
    watchlist_covered: covered,
    board_tvl_usd: rows.reduce((sum, r) => sum + r.tvl_usd, 0),
  };
  return { rows, calibration, stats };
}
