// The radar's value model, farm-plan generator, and board builder (v2).
//
// Every number on the board derives from the sealed snapshot's own fields.
// No protocol name is special-cased anywhere: one formula ranks every
// protocol, one calibration prices every category, and one set of templates
// writes every farm plan.
//
// Implied value, per protocol:
//
//   implied = TVL x category multiple x growth factor x maturity factor x footprint factor
//
// - category multiple: the median market-cap-to-TVL ratio of the protocols
//   in the same category whose token already trades, computed from this very
//   snapshot, with the interquartile range reported beside it so the reader
//   can see how wide the category's own evidence is. Categories with fewer
//   than three such protocols use the global median, and the board says so.
//   The live-token protocols are the calibration set, never the board.
// - growth factor: from the seven-day TVL change, in per cent, clamped so
//   one wild week cannot dominate the ranking.
// - maturity factor: from the days since DefiLlama began tracking the
//   protocol, saturating: a long record with no token counts, with
//   diminishing weight past the first year.
// - footprint factor: from the number of chains the protocol's TVL spans,
//   capped so a protocol on a hundred chains does not run away with it.
//
// A protocol records no token when both gecko_id and symbol are null in the
// snapshot. The board holds only protocols that record no token and are not
// a wrapped, staked or bridged product of a token that already trades, by
// the same exclusion the house's own watchlist rule applies. Nothing here
// predicts whether or when a protocol issues a token: the implied value is
// what a launch would be worth if the protocol's record stayed as it is.

const DAY_MS = 86400000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Linear-interpolation quantile of an already-sorted array. Null when empty. */
function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Compact dollars for the per-row reasoning text: $1.23B, $45.6M, $789K. */
function fmtUsd(value) {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
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
 * of the protocols whose token already trades, with the interquartile range
 * and the count, so the dashboard can show how much evidence each multiple
 * rests on. Categories with fewer than three live-token protocols fall back
 * to the global median, so no category is priced on one or two observations.
 */
export function calibrateCategoryMultiples(protocols) {
  const live = protocols.filter(
    (p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const allRatios = live.map((p) => p.mcap_usd / p.tvl_usd).sort((a, b) => a - b);
  const globalMultiple = clamp(median(allRatios), 0.05, 2.5);
  const globalQ1 = quantileSorted(allRatios, 0.25);
  const globalQ3 = quantileSorted(allRatios, 0.75);
  const ratiosByCategory = new Map();
  for (const p of live) {
    const category = p.category ?? 'Uncategorized';
    if (!ratiosByCategory.has(category)) ratiosByCategory.set(category, []);
    ratiosByCategory.get(category).push(p.mcap_usd / p.tvl_usd);
  }
  const multiples = new Map();
  const detail = new Map();
  const table = [];
  for (const category of [...ratiosByCategory.keys()].sort()) {
    const sorted = ratiosByCategory.get(category).sort((a, b) => a - b);
    const n = sorted.length;
    const fallback = n < 3;
    const ownMedian = median(sorted);
    const multiple = fallback ? globalMultiple : clamp(ownMedian, 0.05, 2.5);
    multiples.set(category, multiple);
    const entry = {
      category,
      multiple,
      own_median: fallback ? null : clamp(ownMedian, 0.05, 2.5),
      q1: fallback ? null : quantileSorted(sorted, 0.25),
      q3: fallback ? null : quantileSorted(sorted, 0.75),
      n,
      fallback,
    };
    detail.set(category, entry);
    table.push(entry);
  }
  return { multiples, detail, globalMultiple, globalQ1, globalQ3, liveCount: live.length, table };
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

// ------------------------------------------------------- signals and reasons

/** Human age for the reasoning text: 12d, 4mo, 2y 3mo. Unknown: null. */
function fmtAgeLong(ageDays) {
  if (ageDays === null || ageDays === undefined) return null;
  if (ageDays < 30) return `${ageDays} days`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)} months`;
  const years = Math.floor(ageDays / 365);
  const months = Math.floor((ageDays % 365) / 30);
  return months > 0 ? `${years} years ${months} months` : `${years} years`;
}

/**
 * Data-quality and context signals for one row, each derived from the
 * protocol's own snapshot fields. The detail view lists them beside the
 * breakdown, so a reader sees what the model knew and what it did not, and
 * where to be careful before farming.
 */
export function signalsFor(protocol, calibration, ageDays) {
  const signals = [];
  const change = protocol.change_7d;
  if (change === null || change === undefined || Number.isNaN(change)) {
    signals.push('7d change not reported: the growth factor stays neutral at 1.000x.');
  } else if (change >= 50) {
    signals.push(`TVL up ${change.toFixed(1)}% in 7 days: fast growth, so size cautiously and re-check weekly.`);
  } else if (change <= -30) {
    signals.push(`TVL down ${Math.abs(change).toFixed(1)}% in 7 days: find out why before farming.`);
  }
  if (ageDays === null) {
    signals.push('Listing date not reported: the maturity factor stays neutral at 1.000x.');
  } else if (ageDays < 90) {
    signals.push(`Listed ${fmtAgeLong(ageDays)} ago: a short record, so verify audits before sizing up.`);
  }
  const entry = calibration.detail.get(protocol.category ?? 'Uncategorized');
  if (!entry || entry.fallback) {
    signals.push('Category multiple falls back to the global median: fewer than 3 live-token protocols in this category.');
  }
  const chainCount = Array.isArray(protocol.chains) ? protocol.chains.length : 0;
  if (chainCount <= 1) {
    signals.push('TVL on a single chain: concentration risk if that chain stalls.');
  } else if (chainCount >= 8) {
    signals.push(`TVL spans ${chainCount} chains: a broad footprint, capped in the model at 8 extra chains.`);
  }
  return signals;
}

/**
 * Why this protocol ranks where it does, in plain sentences built only from
 * its own figures and its place on the board: the value's derivation, the
 * adjustment factor that moves it most, and how its TVL compares with the
 * rest of the board. The detail view shows it above the breakdown.
 */
export function whyNarrative(row, board) {
  const b = row.value_breakdown;
  const first =
    `Rank #${row.rank} of ${board.rows}: ${fmtUsd(row.implied_value_usd)} implied from ${fmtUsd(row.tvl_usd)} ` +
    `of TVL at a ${b.category_multiple.toFixed(3)}x ${row.category} multiple.`;
  const moves = [
    { key: 'growth', dev: Math.abs(Math.log(b.growth_factor)) },
    { key: 'maturity', dev: Math.abs(Math.log(b.maturity_factor)) },
    { key: 'footprint', dev: Math.abs(Math.log(b.footprint_factor)) },
  ].sort((a, c) => c.dev - a.dev);
  let second;
  if (moves[0].dev < 0.005) {
    second = 'All three adjustment factors sit near neutral, so the value follows TVL and the category multiple.';
  } else if (moves[0].key === 'growth') {
    const change = row.change_7d;
    second =
      change === null || change === undefined
        ? `Growth moves it most, and it is neutral: no 7d change was reported, so the factor is ${b.growth_factor.toFixed(3)}x.`
        : `Growth moves it most: ${change > 0 ? '+' : ''}${change.toFixed(1)}% in 7 days gives a ${b.growth_factor.toFixed(3)}x factor.`;
  } else if (moves[0].key === 'maturity') {
    const age = fmtAgeLong(row.age_days);
    second =
      age === null
        ? `Maturity moves it most, and it is neutral: no listing date was reported, so the factor is ${b.maturity_factor.toFixed(3)}x.`
        : `Maturity moves it most: ${age} since listing gives a ${b.maturity_factor.toFixed(3)}x factor.`;
  } else {
    second = `Footprint moves it most: ${row.chains.length} chain${row.chains.length === 1 ? '' : 's'} give a ${b.footprint_factor.toFixed(3)}x factor.`;
  }
  let third;
  if (board.tvlPercentile >= 90) {
    third = 'Its TVL sits in the top 10% of the board: size carries this rank.';
  } else if (board.tvlPercentile >= 50) {
    third = 'Its TVL sits in the top half of the board.';
  } else {
    third = 'Its TVL sits below the board median: the multiple and the factors carry this rank, not size.';
  }
  if (row.watchlist) third += ' It is on the snapshot watchlist.';
  return `${first} ${second} ${third}`;
}

// --------------------------------------------------------------- farm plans

// Approximate gas bands per chain, in US dollars, always stated as "about"
// in the steps. Chains are general knowledge, not protocol names; anything
// unlisted takes the default band.
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
  xDai: '$0.05–$0.50',
  Blast: '$0.05–$0.50',
  Mode: '$0.05–$0.50',
  'zkSync Era': '$0.10–$0.80',
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
  'World Chain': '$0.05–$0.50',
  Rayls: '$0.05–$0.50',
  Etherlink: '$0.05–$0.50',
  'XRPL EVM': '$0.01–$0.10',
  CORE: '$0.05–$0.50',
  'Babylon Genesis': '$0.05–$0.50',
  BSquared: '$0.05–$0.50',
  Fluent: '$0.05–$0.50',
  Noble: '$0.01–$0.10',
  Celo: '$0.05–$0.50',
  Cardano: '$0.10–$0.50',
  TON: '$0.05–$0.50',
  'X Layer': '$0.05–$0.50',
  Doge: '$0.05–$0.50',
  Litecoin: '$0.05–$0.50',
  Kava: '$0.05–$0.50',
  Cronos: '$0.05–$0.50',
  Moonbeam: '$0.05–$0.50',
  Metis: '$0.05–$0.50',
  'Polygon zkEVM': '$0.10–$0.80',
  RSK: '$0.05–$0.50',
  Klaytn: '$0.05–$0.50',
  Fraxtal: '$0.05–$0.50',
  Manta: '$0.05–$0.50',
  Moonriver: '$0.05–$0.50',
  Polkadot: '$0.05–$0.50',
  Aurora: '$0.05–$0.50',
  Hedera: '$0.01–$0.10',
  'Robinhood Chain': '$0.05–$0.50',
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
  xDai: 'xDAI and USDC',
  Celo: 'CELO and USDC',
  Cardano: 'ADA and USDC',
  TON: 'TON and USDT',
  Doge: 'DOGE and USDC',
  Litecoin: 'LTC and USDC',
  Kava: 'KAVA and USDT',
  Cronos: 'CRO and USDC',
  Moonbeam: 'GLMR and USDC',
  Hedera: 'HBAR and USDC',
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
  'Restaked BTC': 'restaking',
  'Liquid Restaking': 'restaking',
  'Liquid Staking': 'restaking',
  'Basis Trading': 'basis',
  Launchpad: 'launchpad',
  Indexes: 'indexes',
  Insurance: 'insurance',
  Privacy: 'privacy',
  'NFT Marketplace': 'nft',
  Payments: 'payments',
  'Crypto Card Issuer': 'payments',
  'Governance Incentives': 'governance',
  'Token Locker': 'locker',
  'AI Agents': 'ai',
  'Decentralized AI': 'ai',
  CeDeFi: 'cedefi',
  'Anchor BTC': 'btc',
  'Decentralized BTC': 'btc',
  Bridge: 'bridge',
  'Canonical Bridge': 'bridge',
  'Cross Chain Bridge': 'bridge',
  CEX: 'bridge',
};

function familyOf(category) {
  return FAMILY_OF[category] ?? 'generic';
}

// The two core steps per family. Each names the protocol, its primary chain,
// a concrete action, a cost and a duration.
const CORE_STEPS = {
  lending: (p, ctx) => [
    `Lend ${ctx.asset} into ${p.name} on ${ctx.chain}, then borrow up to half the deposit's value in a stablecoin and keep the health factor above 1.8. Budget about ${ctx.gas} in gas; the round trip takes 15–30 minutes.`,
    `After 7 days, either put the borrowed stablecoins into a second ${p.name} market or repay the loan in full, so the account shows real borrowing activity instead of one idle deposit.`,
  ],
  dexs: (p, ctx) => [
    `Add a two-sided ${ctx.deposit} liquidity position to ${p.name}'s deepest pool on ${ctx.chain}, in the pair the pool already prices. Budget about ${ctx.gas} in gas and 15 minutes; fee accrual starts the same day.`,
    `If ${p.name} runs a gauge or farm, stake the LP tokens, and route one swap a week through the pool, so the wallet reads as an active liquidity provider rather than a passive deposit.`,
  ],
  yield: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s largest vault on ${ctx.chain} and hold the receipt token. Budget about ${ctx.gas} in gas; the deposit itself takes under 10 minutes.`,
    `Leave the vault position untouched for at least 30 days so yield and any points accrue on a time-weighted balance, and claim or compound no more than once a week to keep gas low.`,
  ],
  rwa: (p, ctx) => [
    `Finish ${p.name}'s onboarding for its tokenized asset on ${ctx.chain}, then buy or mint a ${ctx.deposit} position. Budget about ${ctx.gas} in gas plus any onboarding fee; allow 1–3 days if identity checks apply.`,
    `Hold the position through at least one distribution cycle with the receipt token in the same wallet, so the holding history is unbroken when eligibility is read.`,
  ],
  derivatives: (p, ctx) => [
    `Open a small hedged position on ${p.name} on ${ctx.chain}: ${ctx.deposit} of collateral, 2x leverage at most, with a stop 10% away. Budget about ${ctx.gas} in gas and 20 minutes to set up.`,
    `Trade once a week for 6–8 weeks and keep total fees under 1% of the position, so the account shows repeated use rather than a single trade.`,
  ],
  cdp: (p, ctx) => [
    `Lock ${ctx.deposit} of ${ctx.asset} as collateral in ${p.name}'s vault on ${ctx.chain} and mint stablecoins against it at no more than half the limit. Budget about ${ctx.gas} in gas; allow 20 minutes.`,
    `Keep the vault open for at least 30 days, top up collateral if the ratio drifts toward the minimum, and repay in full before closing so the position ends clean.`,
  ],
  curator: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s largest curated vault on ${ctx.chain} and hold the vault token. Budget about ${ctx.gas} in gas; the deposit takes under 10 minutes.`,
    `Stay deposited through at least one curator rebalance cycle, usually 2–4 weeks, and read the vault's allocation notes weekly, so the position survives rebalances without an exit.`,
  ],
  chain: (p, ctx) => [
    `Bridge ${ctx.deposit} to ${ctx.chain} and stake or delegate at least half of it through ${p.name}'s native staking. Budget about ${ctx.gas} in gas; allow 20–40 minutes including confirmations.`,
    `Use two or three native apps on ${ctx.chain} with the remainder — a swap, a lend, a mint — once a week for a month, so the wallet shows chain-native activity beyond the stake.`,
  ],
  staking: (p, ctx) => [
    `Stake ${ctx.deposit} of ${ctx.asset} in ${p.name}'s pool on ${ctx.chain} and hold the liquid receipt token. Budget about ${ctx.gas} in gas; the stake takes under 10 minutes.`,
    `Keep the stake in place for at least 30 days and, where the receipt token is accepted elsewhere, deposit it once into a lending market to deepen the footprint without unstaking.`,
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
  indexes: (p, ctx) => [
    `Buy ${ctx.deposit} of ${p.name}'s index token on ${ctx.chain} and hold it in the farming wallet. Budget about ${ctx.gas} in gas; the purchase takes under 10 minutes.`,
    `Hold through at least one index rebalance, usually monthly, and top up after the rebalance if the new weights still suit you, so the holding spans a full cycle.`,
  ],
  insurance: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s underwriting pool on ${ctx.chain} and note the coverage period the deposit backs. Budget about ${ctx.gas} in gas; allow 15 minutes.`,
    `Keep the capital in the pool for the full coverage period, usually 30–90 days, and buy one small cover policy yourself, so the wallet shows both sides of the market.`,
  ],
  privacy: (p, ctx) => [
    `Deposit ${ctx.deposit} of ${ctx.asset} into ${p.name}'s shielded pool on ${ctx.chain} and keep the spending notes backed up offline. Budget about ${ctx.gas} in gas; allow 20 minutes.`,
    `Make one shielded transfer or withdrawal a week for 6 weeks with varied amounts, so the wallet shows steady private use rather than a single deposit and exit.`,
  ],
  nft: (p, ctx) => [
    `List one item and place two bids on ${p.name} on ${ctx.chain}, with ${ctx.deposit} ready to settle a winning bid. Budget about ${ctx.gas} in gas; allow 30 minutes.`,
    `Trade at least once a week for 6 weeks — a bid, a listing, a sale — and keep total fees under 2% of volume, so the account reads as a real marketplace user.`,
  ],
  payments: (p, ctx) => [
    `Route ${ctx.deposit} of real payments through ${p.name} on ${ctx.chain}: pay a bill, settle with a peer, or fund a card. Budget about ${ctx.gas} in gas; allow 15 minutes.`,
    `Repeat genuine payments weekly for 8 weeks at similar sizes, so the volume looks like use rather than one wash transfer.`,
  ],
  governance: (p, ctx) => [
    `Stake ${ctx.deposit} through ${p.name} on ${ctx.chain} to gain voting power, and delegate it if you will not vote yourself. Budget about ${ctx.gas} in gas; allow 15 minutes.`,
    `Vote on at least three proposals over the next 8 weeks and keep the stake through each vote's snapshot, so the record shows participation, not just a deposit.`,
  ],
  locker: (p, ctx) => [
    `Lock ${ctx.deposit} of tokens through ${p.name} on ${ctx.chain} for the longest schedule you can accept, and save the unlock dates. Budget about ${ctx.gas} in gas; allow 15 minutes.`,
    `Hold every lock to its unlock date without early exits, and add a second smaller lock mid-way, so the wallet shows repeated, disciplined locking.`,
  ],
  ai: (p, ctx) => [
    `Run ${p.name}'s core product on ${ctx.chain} with ${ctx.deposit} of spend: start the agent, job or inference run the product exists for. Budget about ${ctx.gas} in gas plus usage fees; allow 30 minutes.`,
    `Run the product weekly for 6–8 weeks with real inputs and varied prompts or jobs, so the history shows genuine use rather than one test call.`,
  ],
  cedefi: (p, ctx) => [
    `Deposit ${ctx.deposit} into ${p.name}'s CeFi-linked product on ${ctx.chain} and read its backing and custody notes first. Budget about ${ctx.gas} in gas; allow 20 minutes.`,
    `Hold the deposit for at least 30 days and verify the backing attestation each week, so the position is checked, not just parked.`,
  ],
  btc: (p, ctx) => [
    `Deposit ${ctx.deposit} of BTC into ${p.name}'s anchored product on ${ctx.chain} and hold the receipt token. Budget about ${ctx.gas} in gas; allow 20–40 minutes including confirmations.`,
    `Keep the position for at least 30 days and, where the receipt token is accepted, deposit it once into a lending market to deepen the footprint without unwrapping.`,
  ],
  bridge: (p, ctx) => [
    `Bridge ${ctx.deposit} through ${p.name} between two chains it serves, starting on ${ctx.chain}. Budget about ${ctx.gas} in gas plus the bridge fee; allow 10–30 minutes.`,
    `Bridge again in the other direction a week later with a different size, so the wallet shows repeated crossings rather than one transfer.`,
  ],
  generic: (p, ctx) => [
    `Use ${p.name}'s core product on ${ctx.chain} with ${ctx.deposit}: make the first real transaction the product exists for, not a test transfer. Budget about ${ctx.gas} in gas and 20 minutes.`,
    `Repeat the core action weekly for 6–8 weeks with similar sizes, so the wallet builds a history of genuine use before any snapshot.`,
  ],
};

// Trait steps: extra steps a protocol earns from its own snapshot fields.
// At most two are added, in the priority order below, so plans stay within
// the gate's 12 steps while the most relevant cautions always appear.
function traitSteps(protocol, ageDays, ctx) {
  const steps = [];
  const chains = Array.isArray(protocol.chains) ? protocol.chains : [];
  const change = protocol.change_7d;
  if (chains.length > 1) {
    steps.push(
      `Mirror a smaller position on a second chain ${protocol.name} runs on, ${chains[1]}: repeat the core action with about a quarter of the size, so the footprint spans more than one network.`,
    );
  }
  if (change !== null && change !== undefined && change >= 50) {
    steps.push(
      `Growth is running hot at +${change.toFixed(1)}% in 7 days: start at half the size above, wait a week, and add the rest only if TVL holds, so a spike does not become your entry price.`,
    );
  } else if (change !== null && change !== undefined && change <= -30) {
    steps.push(
      `TVL fell ${Math.abs(change).toFixed(1)}% in 7 days: read ${protocol.name}'s recent announcements before depositing, and start small until the outflow stops.`,
    );
  }
  if (ageDays !== null && ageDays < 90) {
    steps.push(
      `This protocol was listed ${ageDays} days ago: check its audits and team pages before sizing up, and keep the first position at the low end of the band.`,
    );
  } else if (ageDays === null) {
    steps.push(
      `No listing date is reported for this protocol: treat its record as unverified, confirm its launch history on its own pages, and start at the low end of the band.`,
    );
  }
  if (chains.length <= 1) {
    steps.push(
      `All of this protocol's TVL sits on ${ctx.chain}: keep an exit route ready, and do not add funds the week that chain has a scheduled upgrade.`,
    );
  }
  return steps.slice(0, 2);
}

/**
 * The farm plan for one protocol: 6 to 8 steps. Every step names a concrete
 * action, what it costs and how long it takes. The plan is a pure function
 * of the protocol's snapshot fields: funding, two core actions for its
 * category family, up to two trait steps, then points, monitoring and
 * record-keeping.
 */
export function farmPlan(protocol, ageDays) {
  const chain = primaryChain(protocol);
  const ctx = { chain, gas: gasBand(chain), asset: fundAsset(chain), deposit: depositBand(protocol.tvl_usd) };
  return [
    `Move ${ctx.deposit} of ${ctx.asset} to ${chain}. Bridge from your exchange account or wallet, keep ${ctx.gas} aside for gas, and allow 10–25 minutes for the transfer to land before you touch the protocol.`,
    ...CORE_STEPS[familyOf(protocol.category)](protocol, ctx),
    ...traitSteps(protocol, ageDays, ctx),
    `Opt into ${protocol.name}'s points or rewards program if it runs one, and keep the position open for at least 30 days. Most snapshots reward time-weighted balances, so one long position beats several short ones.`,
    `Check the position once a week for 8–12 weeks: top up if the balance falls by more than a third, watch for snapshot or season announcements, and never drain the wallet in a single move.`,
    `Record every deposit, fee, and reward with its date in a notebook. When a claim window opens, claim within the first week, and unstake only after the snapshot that rewards the position has passed.`,
  ];
}

// --------------------------------------------------------------- the board

/**
 * Per-category aggregates of the board itself, for the dashboard's category
 * breakdown: how many rows, how much TVL, the median implied value, and how
 * many of the rows are on the watchlist.
 */
function categoryAggregates(rows) {
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }
  return [...byCategory.entries()]
    .map(([category, members]) => ({
      category,
      rows: members.length,
      tvl_usd: members.reduce((sum, r) => sum + r.tvl_usd, 0),
      median_implied_value_usd: Math.round(median(members.map((r) => r.implied_value_usd))),
      watchlist: members.filter((r) => r.watchlist).length,
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.category < b.category ? -1 : 1));
}

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
    const ageDays = ageDaysOf(p.listed_at, asOf);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDays,
      watchlist: watchlist.has(p.slug),
      has_token: false,
      implied_value_usd: v.value,
      value_breakdown: {
        category_multiple: v.multiple,
        growth_factor: v.growth,
        maturity_factor: v.maturity,
        footprint_factor: v.footprint,
      },
      signals: signalsFor(p, calibration, ageDays),
      farm_steps: farmPlan(p, ageDays),
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
  const tvls = rows.map((r) => r.tvl_usd).sort((a, b) => a - b);
  rows.forEach((row) => {
    let below = 0;
    for (const tvl of tvls) if (tvl <= row.tvl_usd) below++;
    row.why = whyNarrative(row, { rows: rows.length, tvlPercentile: (below / rows.length) * 100 });
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
    categories: categoryAggregates(rows),
  };
  return { rows, calibration, stats };
}
