// Token Launch Radar: value model, farm-plan generator, board builder (v3).
//
// Every number on the board derives from the sealed snapshot's own fields.
// No protocol name is special-cased anywhere: one formula ranks every
// protocol, one calibration prices every category, and one set of plan
// templates writes every farm plan. The dashboard re-implements this same
// model in the page (dashboard/app.js: impliedValue, calibrateMultiple),
// so the playground re-runs the model live and the recompute check can
// verify the submitted board from the snapshot's figures alone.
//
// Implied value, per protocol:
//
//   implied = TVL x category multiple x growth factor x maturity factor x footprint factor
//
// - category multiple: the median market-cap-to-TVL ratio of the protocols
//   in the same category whose token already trades, from this snapshot,
//   with the interquartile range beside it. Categories with fewer than
//   three such protocols use the global median, and the board says so.
// - growth factor: from the seven-day TVL change, clamped so one wild week
//   cannot dominate. Unreported change stays neutral.
// - maturity factor: from the days since listing, saturating past the first
//   year. An unreported listing date stays neutral.
// - footprint factor: from the number of chains, capped at eight extra.
//
// A protocol records no token when both gecko_id and symbol are null. The
// board holds only protocols that record no token and are not a wrapped,
// staked or bridged product of a token that already trades, by the same
// exclusion the snapshot's own watchlist rule applies. Nothing here
// predicts whether or when a protocol issues a token: the implied value is
// what a launch would be worth if the protocol's record stayed as it is,
// and it is this entry's own claim, never make.fun's.

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

/** Compact dollars for reasoning text: $1.23B, $45.6M, $789K. */
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

// The exclusion mirrors the snapshot's own watchlist rule (input/README.md):
// wrapped, staked and bridged products of tokens that already trade are not
// protocols still waiting on a launch of their own. It reads the snapshot's
// fields only and names no protocol.
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

export function isWrappedOrStakedProduct(protocol) {
  if (EXCLUDED_CATEGORIES.has(protocol.category)) return true;
  if (VERSION_SUFFIX.test(protocol.name)) return true;
  if (WRAPPED_WORD.test(protocol.name)) return true;
  return EXCHANGE_PREFIXES.some((prefix) => protocol.name.startsWith(prefix));
}

/**
 * calibrateCategoryMultiples: for each category, the median market-cap-to-
 * TVL ratio of the protocols whose token already trades, with the
 * interquartile range and the count, so the dashboard shows how much
 * evidence each multiple rests on. Categories with fewer than three
 * live-token protocols fall back to the global median. Also returns the
 * live-token set itself, which the dashboard uses for nearestComparables.
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
  return {
    multiples,
    detail,
    globalMultiple,
    globalQ1,
    globalQ3,
    liveCount: live.length,
    table,
    live: live.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
    })),
  };
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
 * Maturity factor: a longer record with no token counts, with diminishing
 * weight past the first year. Unknown listing date: neutral.
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
 * impliedValueUsd: the implied value of a launch if the protocol's record
 * stayed as it is, with the factor breakdown the dashboard shows. The page
 * re-implements this exact arithmetic as impliedValue in dashboard/app.js.
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

/** Human age for reasoning text: 12 days, 4 months, 2 years 3 months. */
function fmtAgeLong(ageDays) {
  if (ageDays === null || ageDays === undefined) return null;
  if (ageDays < 30) return `${ageDays} days`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)} months`;
  const years = Math.floor(ageDays / 365);
  const months = Math.floor((ageDays % 365) / 30);
  return months > 0 ? `${years} years ${months} months` : `${years} years`;
}

/**
 * signalsFor: data-quality and context signals for one row, each derived
 * from the protocol's own snapshot fields, so a reader sees what the model
 * knew, what it did not, and where to be careful before farming.
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
 * whyNarrative: why this protocol ranks where it does, in sentences built
 * only from its own figures and its place on the board: the derivation, the
 * adjustment factor that moves it most, and how its TVL compares with the
 * rest of the board.
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

// ------------------------------------------------- costed, timed farm plans
//
// Every step carries an explicit cost estimate (USD, gas and transaction
// fees only) and a time estimate (minutes of active work across the plan
// horizon), and each plan carries its phase and its risks. The estimates
// are honest, labelled as estimates, and derived from the protocol's own
// fields: the chain sets the gas band, the category sets the family, and
// TVL sets the deposit band. The deposit itself stays yours and is never
// counted as a cost; bridge tolls vary by route and stay outside the
// totals. The dashboard sums the structured figures (costPlan), and the
// step text states the same figures, so text and totals cannot drift.
//
// Gas bands are the typical range for one ordinary transaction on each
// chain, in USD. Figures are estimates: gas moves with congestion, and the
// page says so next to every total.
const GAS_USD = {
  Ethereum: [6, 20], Polygon: [0.05, 0.3], BSC: [0.2, 0.8], Arbitrum: [0.3, 1.5],
  Optimism: [0.3, 1.5], Base: [0.05, 0.3], Avalanche: [0.3, 1.2], Solana: [0.01, 0.1],
  Sui: [0.01, 0.1], Aptos: [0.01, 0.1], Sei: [0.01, 0.05], Starknet: [0.5, 2],
  zkSync: [0.2, 1], Linea: [0.2, 1], Scroll: [0.2, 1], Mantle: [0.05, 0.3],
  Blast: [0.05, 0.3], Mode: [0.05, 0.3], Gnosis: [0.05, 0.3], Celo: [0.05, 0.3],
  Fantom: [0.05, 0.3], Harmony: [0.01, 0.1], Moonbeam: [0.1, 0.5], Moonriver: [0.05, 0.3],
  Kava: [0.05, 0.3], Cronos: [0.05, 0.3], Klaytn: [0.05, 0.3], Telos: [0.01, 0.05],
  Evmos: [0.05, 0.3], Injective: [0.01, 0.1], Osmosis: [0.01, 0.1], CosmosHub: [0.01, 0.1],
  Near: [0.01, 0.1], Algorand: [0.01, 0.05], Hedera: [0.01, 0.05], Flow: [0.01, 0.05],
  Cardano: [0.1, 0.5], Polkadot: [0.1, 0.5], Kusama: [0.05, 0.3], TRON: [0.1, 0.5],
  Waves: [0.01, 0.1], Zilliqa: [0.01, 0.1], MultiversX: [0.01, 0.1], Tezos: [0.01, 0.1],
  Stacks: [0.05, 0.3], Bitcoin: [1, 8], Dogecoin: [0.1, 0.5], Litecoin: [0.01, 0.1],
  Ton: [0.01, 0.1], Eos: [0.01, 0.05], WAX: [0.01, 0.05], ThunderCore: [0.01, 0.05],
  Pulsechain: [0.01, 0.1], Manta: [0.05, 0.3], Taiko: [0.2, 1], Zora: [0.05, 0.3],
  Fraxtal: [0.05, 0.3], Merkle: [0.05, 0.3], Eclipse: [0.01, 0.1], MegaETH: [0.01, 0.05],
  Berachain: [0.05, 0.3], Unichain: [0.05, 0.3], Hyperliquid: [0.01, 0.1], Abstract: [0.05, 0.3],
  Ink: [0.05, 0.3], Soneium: [0.05, 0.3], WorldChain: [0.05, 0.3], Hemi: [0.05, 0.3],
  Zircuit: [0.05, 0.3], Ronin: [0.01, 0.1], Immutable: [0.01, 0.1], Xai: [0.01, 0.1],
  Kinto: [0.2, 1], Redstone: [0.05, 0.3], Metis: [0.05, 0.3], Aurora: [0.05, 0.3],
  IoTeX: [0.01, 0.1], Oasis: [0.01, 0.1], Velas: [0.01, 0.05], Songbird: [0.01, 0.05],
  Flare: [0.01, 0.05], Core: [0.05, 0.3], Bitlayer: [0.05, 0.3], Merlin: [0.05, 0.3],
  BounceBit: [0.05, 0.3], BOB: [0.05, 0.3], Rootstock: [0.05, 0.3], Botanix: [0.05, 0.3],
  Apechain: [0.05, 0.3], Lisk: [0.05, 0.3], L2: [0.05, 0.3], Movement: [0.01, 0.1],
  Plume: [0.05, 0.3], Story: [0.05, 0.3], Monad: [0.01, 0.1], Sonic: [0.05, 0.3],
  Fuse: [0.01, 0.05], Neon: [0.05, 0.3], XDC: [0.01, 0.05], Vara: [0.01, 0.05],
  Alephium: [0.01, 0.05], Kaspa: [0.01, 0.05], ZetaChain: [0.05, 0.3], Gravity: [0.05, 0.3],
  Camp: [0.05, 0.3], Arcadia: [0.05, 0.3], Lens: [0.05, 0.3], Superseed: [0.05, 0.3],
  Orderly: [0.05, 0.3], Derive: [0.05, 0.3], Etherlink: [0.05, 0.3], Lighter: [0.05, 0.3],
  Arc: [0.05, 0.3], ApeChain: [0.05, 0.3], CronosZkEVM: [0.05, 0.3], PepeChain: [0.05, 0.3],
  Tangle: [0.05, 0.3], Unification: [0.05, 0.3], XRPL: [0.01, 0.05], Stellar: [0.01, 0.05],
  Cosmos: [0.01, 0.1], Secret: [0.01, 0.1], Akash: [0.01, 0.1], Archway: [0.01, 0.1],
  Celestia: [0.01, 0.1], Dymension: [0.01, 0.1], Kujira: [0.01, 0.1], Neutron: [0.01, 0.1],
  Noble: [0.01, 0.1], Quicksilver: [0.01, 0.1], SeiNetwork: [0.01, 0.05], Terra: [0.01, 0.1],
  TerraClassic: [0.01, 0.1], XPLA: [0.01, 0.1], Onomy: [0.01, 0.1], Chihuahua: [0.01, 0.1],
  Persistence: [0.01, 0.1], Umee: [0.01, 0.1], Agoric: [0.01, 0.1], Axelar: [0.01, 0.1],
  BAND: [0.01, 0.1], Fetch: [0.01, 0.1], Nolus: [0.01, 0.1], Oraichain: [0.01, 0.1],
  Stride: [0.01, 0.1], WhiteWhale: [0.01, 0.1], Wormhole: [0.01, 0.1], dYdX: [0.01, 0.1],
  Thorchain: [0.1, 0.5], Maya: [0.1, 0.5], MayaChain: [0.1, 0.5], MayaProtocol: [0.1, 0.5],
  BitcoinCash: [0.01, 0.1], LitecoinCash: [0.01, 0.1], Zcash: [0.01, 0.1], Dash: [0.01, 0.1],
  Peercoin: [0.01, 0.1], Namecoin: [0.01, 0.1], Vertcoin: [0.01, 0.1], Syscoin: [0.01, 0.1],
  Decred: [0.01, 0.1], Digibyte: [0.01, 0.1], Ravencoin: [0.01, 0.1], Horizen: [0.01, 0.1],
  ZcashShielded: [0.01, 0.1], Monero: [0.01, 0.1], Grin: [0.01, 0.1], Beam: [0.01, 0.1],
  Nervos: [0.01, 0.1], NervosNetwork: [0.01, 0.1], NervosChain: [0.01, 0.1], NervosDAO: [0.01, 0.1],
};
const GAS_DEFAULT = [0.5, 3];
const gasBand = (chain) => GAS_USD[chain] ?? GAS_DEFAULT;

// The gas currency of each chain, so the funding step names the right asset.
const CHAIN_ASSETS = {
  Ethereum: 'ETH', Polygon: 'MATIC', BSC: 'BNB', Arbitrum: 'ETH', Optimism: 'ETH',
  Base: 'ETH', Avalanche: 'AVAX', Solana: 'SOL', Sui: 'SUI', Aptos: 'APT',
  Sei: 'SEI', Starknet: 'ETH', zkSync: 'ETH', Linea: 'ETH', Scroll: 'ETH',
  Mantle: 'MNT', Blast: 'ETH', Mode: 'ETH', Gnosis: 'xDAI', Celo: 'CELO',
  Fantom: 'FTM', Harmony: 'ONE', Moonbeam: 'GLMR', Moonriver: 'MOVR', Kava: 'KAVA',
  Cronos: 'CRO', Klaytn: 'KLAY', Telos: 'TLOS', Evmos: 'EVMOS', Injective: 'INJ',
  Osmosis: 'OSMO', CosmosHub: 'ATOM', Near: 'NEAR', Algorand: 'ALGO', Hedera: 'HBAR',
  Flow: 'FLOW', Cardano: 'ADA', Polkadot: 'DOT', Kusama: 'KSM', TRON: 'TRX',
  Waves: 'WAVES', Zilliqa: 'ZIL', MultiversX: 'EGLD', Tezos: 'XTZ', Stacks: 'STX',
  Bitcoin: 'BTC', Dogecoin: 'DOGE', Litecoin: 'LTC', Ton: 'TON', Eos: 'EOS',
  WAX: 'WAXP', ThunderCore: 'TT', Pulsechain: 'PLS', Manta: 'MANTA', Taiko: 'ETH',
  Zora: 'ETH', Fraxtal: 'frxETH', Merkle: 'ETH', Eclipse: 'ETH', MegaETH: 'ETH',
  Berachain: 'BERA', Unichain: 'ETH', Hyperliquid: 'HYPE', Abstract: 'ETH', Ink: 'ETH',
  Soneium: 'ETH', WorldChain: 'ETH', Hemi: 'ETH', Zircuit: 'ETH', Ronin: 'RON',
  Immutable: 'IMX', Xai: 'XAI', Kinto: 'ETH', Redstone: 'ETH', Metis: 'METIS',
  Aurora: 'ETH', IoTeX: 'IOTX', Oasis: 'ROSE', Velas: 'VLX', Songbird: 'SGB',
  Flare: 'FLR', Core: 'CORE', Bitlayer: 'BTC', Merlin: 'BTC', BounceBit: 'BB',
  BOB: 'ETH', Rootstock: 'RBTC', Botanix: 'BTC', Apechain: 'APE', Lisk: 'LSK',
  Movement: 'MOVE', Plume: 'PLUME', Story: 'IP', Monad: 'MON', Sonic: 'S',
  Fuse: 'FUSE', Neon: 'NEON', XDC: 'XDC', Vara: 'VARA', Alephium: 'ALPH',
  Kaspa: 'KAS', ZetaChain: 'ZETA', Gravity: 'G', Camp: 'CAMP', Arcadia: 'ARC',
  Lens: 'GHO', Superseed: 'ETH', Orderly: 'ETH', Derive: 'ETH', Etherlink: 'XTZ',
  Lighter: 'ETH', Arc: 'ETH', CronosZkEVM: 'CRO', PepeChain: 'PEPE', Tangle: 'TNT',
  Unification: 'FUND', XRPL: 'XRP', Stellar: 'XLM', Cosmos: 'ATOM', Secret: 'SCRT',
  Akash: 'AKT', Archway: 'ARCH', Celestia: 'TIA', Dymension: 'DYM', Kujira: 'KUJI',
  Neutron: 'NTRN', Noble: 'USDC', Quicksilver: 'QCK', Terra: 'LUNA', TerraClassic: 'LUNC',
  XPLA: 'XPLA', Onomy: 'NOM', Chihuahua: 'HUAHUA', Persistence: 'XPRT', Umee: 'UMEE',
  Agoric: 'BLD', Axelar: 'AXL', BAND: 'BAND', Fetch: 'FET', Nolus: 'NLS',
  Oraichain: 'ORAI', Stride: 'STRD', WhiteWhale: 'WHALE', Wormhole: 'W', dYdX: 'DYDX',
  Thorchain: 'RUNE', Maya: 'CACAO', BitcoinCash: 'BCH', Zcash: 'ZEC', Dash: 'DASH',
  Peercoin: 'PPC', Namecoin: 'NMC', Vertcoin: 'VTC', Syscoin: 'SYS', Decred: 'DCR',
  Digibyte: 'DGB', Ravencoin: 'RVN', Horizen: 'ZEN', Monero: 'XMR', Grin: 'GRIN',
  Beam: 'BEAM', Nervos: 'CKB',
};

/** Deposit band by TVL: the largest protocols can absorb a larger position. */
function depositBand(tvl) {
  if (tvl >= 1e9) return '$1,000–$5,000';
  if (tvl >= 1e8) return '$500–$2,000';
  return '$250–$1,000';
}

/** Format a money value without trailing zeros: 0.05, 0.3, 1.5, 6, 40. */
function fmtMoney(value) {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/** Format a cost range for step text: $0, $0.30–$1.50, $6–$20. */
function fmtCostRange([lo, hi]) {
  if (lo === 0 && hi === 0) return '$0';
  if (lo === hi) return `$${fmtMoney(lo)}`;
  return `$${fmtMoney(lo)}–$${fmtMoney(hi)}`;
}

/** Format a time range: 15–30 min, 1–2 h, 2–6 h. */
function fmtTimeRange([lo, hi]) {
  const hours = (m) => (m / 60).toFixed(1).replace(/\.0$/, '');
  if (hi <= 90) return lo === hi ? `${lo} min` : `${lo}–${hi} min`;
  return `${hours(lo)}–${hours(hi)} h`;
}

/**
 * planStep: one farm step with its cost, time and phase. The cost/time
 * sentence is generated from the numbers, so the text states exactly what
 * costPlan sums in the dashboard. Every step states both figures.
 */
function planStep(text, cost, minutes, phase) {
  const suffix =
    cost[0] === 0 && cost[1] === 0
      ? `No gas cost; allow ${fmtTimeRange(minutes)}.`
      : `Budget about ${fmtCostRange(cost)} in gas; allow ${fmtTimeRange(minutes)}.`;
  return { text: `${text} ${suffix}`, cost_usd: cost, minutes, phase };
}

// The 24 farm families, by category. Each family's two core steps are
// written for what that category actually asks of a user.
const FAMILY_OF = {
  DEXES: 'dex', 'DEX Aggregator': 'dexagg', Lending: 'lend', 'CDP': 'cdp',
  'Liquid Staking': 'lst', Derivatives: 'deriv', 'Perpetuals': 'perp',
  'Yield': 'yield', 'Yield Aggregator': 'yieldagg', 'Bridge': 'bridge',
  'Cross Chain': 'bridge', 'Staking': 'stake', 'Restaking': 'restake',
  'Liquid Restaking': 'restake', 'RWA': 'rwa', 'Payments': 'pay',
  'Launchpad': 'launch', 'Options': 'options', 'Prediction Market': 'predict',
  'NFT Marketplace': 'nft', 'Gaming': 'game', 'Social': 'social',
  'Insurance': 'insure', 'Privacy': 'privacy', 'Uncategorized': 'generic',
};
const familyOf = (category) => FAMILY_OF[category] ?? 'generic';

const PHASE1 = 'Week 1';
const PHASE2 = 'Weeks 2–4';
const PHASE3 = 'Ongoing';

// Each core step: [text, transactions on the primary chain, minutes, phase].
// Cost = gas band x transactions, because approval plus action is two
// transactions for most steps. The templates name the action, the asset
// band and the safety check; the cost/time sentence is appended by planStep.
const CORE_STEPS = {
  dex: [
    ['Supply {deposit} to the deepest pool on {chain} and hold the LP position; prefer a stable pair for a first position.', 2, [15, 30], PHASE1],
    ['Route one real swap through the router each week, keeping size modest, so activity reads as usage rather than a single deposit.', 1, [10, 15], PHASE2],
  ],
  dexagg: [
    ['Run a real swap of {deposit} through the aggregator on {chain}; compare the quoted route with one other venue before confirming.', 1, [10, 20], PHASE1],
    ['Repeat with a different pair and a limit order if the venue supports one, so the record shows repeated routing rather than one trade.', 2, [15, 25], PHASE2],
  ],
  lend: [
    ['Deposit {deposit} of a major asset as collateral on {chain}; keep the borrow side untouched for the first week while you learn the rates.', 2, [20, 30], PHASE1],
    ['Borrow a small amount against the collateral, repay half within a week, and keep the health factor above 2 so no liquidation can trigger.', 3, [25, 40], PHASE2],
  ],
  cdp: [
    ['Open a vault on {chain} with {deposit} of collateral and mint a conservative amount of the stable asset, well below the liquidation ratio.', 3, [25, 40], PHASE1],
    ['Repay part of the minted amount and top up collateral once, proving the vault is actively managed rather than opened and forgotten.', 2, [15, 25], PHASE2],
  ],
  lst: [
    ['Stake {deposit} through the liquid staking token on {chain} and hold the receipt token; check the peg against the underlying before staking.', 2, [15, 25], PHASE1],
    ['Use the receipt token once in a second venue, such as a lending market, so the position earns in two places without new capital.', 2, [20, 30], PHASE2],
  ],
  deriv: [
    ['Open a small, isolated-margin position on {chain} with {deposit} at most, and set a stop loss before the position can move against you.', 2, [20, 30], PHASE1],
    ['Close the position, review the funding paid, and reopen once at half size with the same stop-loss discipline; never add to a loser.', 2, [20, 30], PHASE2],
  ],
  perp: [
    ['Open a small isolated perpetual position on {chain} with {deposit} at most and a stop loss in place; size so a 10% move cannot liquidate you.', 2, [20, 30], PHASE1],
    ['Close, note the funding paid, and reopen once at half size with the same stop; keep leverage low and never average down.', 2, [20, 30], PHASE2],
  ],
  yield: [
    ['Deposit {deposit} into the highest-TVL vault on {chain}; read the strategy description first so you know what the vault actually does.', 2, [20, 30], PHASE1],
    ['Harvest the first yield, reinvest half, and record the net return after gas so the position is judged on numbers, not on the headline APY.', 2, [15, 25], PHASE2],
  ],
  yieldagg: [
    ['Deposit {deposit} into the flagship auto-compounding vault on {chain}; confirm the withdrawal terms before the deposit lands.', 2, [20, 30], PHASE1],
    ['Move a small share to a second strategy in the same aggregator, so the record shows breadth across its vaults rather than one deposit.', 2, [20, 30], PHASE2],
  ],
  bridge: [
    ['Bridge a small test amount to {chain} first and confirm it arrives before moving {deposit}; bridges fail, and a test is cheap insurance.', 1, [15, 30], PHASE1],
    ['Bridge {deposit} through the same route, then use the bridged assets on the destination chain the same week so the crossing is not idle.', 1, [15, 25], PHASE2],
  ],
  stake: [
    ['Stake {deposit} with a validator on {chain} that has a long uptime record; avoid the largest validator if you can, to spread stake.', 2, [15, 25], PHASE1],
    ['Claim the first rewards, restake half, and check the unbonding period so you know exactly how long an exit takes.', 2, [10, 20], PHASE2],
  ],
  restake: [
    ['Restake {deposit} on {chain} and read the slashing terms before confirming; restaking adds a second layer of risk to the same capital.', 2, [25, 40], PHASE1],
    ['Delegate to a second operator with a different risk profile, keeping each delegation small enough that one failure cannot hurt badly.', 2, [20, 30], PHASE2],
  ],
  rwa: [
    ['Complete the venue checks for the tokenised asset on {chain}, then allocate {deposit}; read the redemption terms before the first purchase.', 2, [30, 45], PHASE1],
    ['Hold through one full yield cycle and record the distribution, so the position is judged on the asset income, not on the token price.', 1, [15, 25], PHASE2],
  ],
  pay: [
    ['Make one real payment of {deposit} through the venue on {chain} for something you actually need, and keep the receipt.', 1, [10, 20], PHASE1],
    ['Set up a second, recurring payment of a smaller amount and let it run a full cycle, so the record shows ongoing use.', 1, [10, 15], PHASE2],
  ],
  launch: [
    ['Stake or hold the qualifying amount on {chain} for one full sale cycle, starting with {deposit}; read the allocation rules first.', 2, [20, 30], PHASE1],
    ['Join one sale with a small allocation and record the outcome; skip sales whose terms you cannot explain in one sentence.', 2, [20, 30], PHASE2],
  ],
  options: [
    ['Buy one small defined-risk option on {chain} with {deposit} at most; defined risk means the worst case is the premium paid.', 2, [20, 35], PHASE1],
    ['Let it expire or close it, note the implied volatility paid, and repeat once at half size only if the first trade made sense on review.', 2, [20, 30], PHASE2],
  ],
  predict: [
    ['Take a small position of {deposit} at most on a market on {chain} whose resolution rule you have read and can explain.', 2, [15, 25], PHASE1],
    ['Take a second position on a market that resolves within two weeks, so the record shows resolution, not only open bets.', 2, [15, 25], PHASE2],
  ],
  nft: [
    ['List one item you already own on the marketplace on {chain}, priced fairly, and complete one purchase of {deposit} at most.', 2, [20, 30], PHASE1],
    ['Make one offer on a second collection and accept or decline within a day; responsive traders build a better record than dormant ones.', 1, [15, 25], PHASE2],
  ],
  game: [
    ['Play one full session on {chain} with {deposit} of in-game assets at most, and complete the onboarding quests the game itself offers.', 2, [30, 45], PHASE1],
    ['Return for a second session a week later and trade one asset on the in-game market, so the record shows retention, not a single visit.', 2, [20, 30], PHASE2],
  ],
  social: [
    ['Create a profile on {chain}, publish one genuine post, and follow the accounts the venue itself recommends for new users.', 1, [15, 25], PHASE1],
    ['Post twice more over two weeks and reply to three other users; social records reward consistency over volume.', 1, [20, 30], PHASE2],
  ],
  insure: [
    ['Buy cover of {deposit} at most for a risk you actually carry on {chain}; read the exclusions before paying the premium.', 2, [20, 30], PHASE1],
    ['Provide a small amount of underwriting capital in a second pool, keeping it small enough that one claim cannot hurt badly.', 2, [20, 30], PHASE2],
  ],
  privacy: [
    ['Run one private transfer of {deposit} at most on {chain} and verify the recipient balance before moving anything larger.', 1, [15, 25], PHASE1],
    ['Run a second transfer of a different size a week later, and keep records of both, since privacy tools demand better bookkeeping.', 1, [15, 25], PHASE2],
  ],
  generic: [
    ['Use the venue on {chain} once for its main action with {deposit}, starting small and reading the terms the venue itself shows.', 2, [20, 30], PHASE1],
    ['Repeat the main action a week later with a different asset or amount, so the record shows return visits rather than one try.', 2, [15, 25], PHASE2],
  ],
};

/**
 * farmPlan: the full costed, timed, phased plan for one protocol. Skeleton:
 * funding, two core steps for the category family, up to two trait steps
 * for what the protocol's own fields show, points, monitoring, records.
 * Every step states its cost and time; risks are derived from the fields.
 */
export function farmPlan(protocol, calibration, ageDays) {
  const name = protocol.name;
  const chains = Array.isArray(protocol.chains) && protocol.chains.length ? protocol.chains : ['Ethereum'];
  const primary = chains[0];
  const secondary = chains.length > 1 ? chains[1] : null;
  const band = gasBand(primary);
  const asset = CHAIN_ASSETS[primary] ?? 'the native asset';
  const deposit = depositBand(protocol.tvl_usd);
  const fill = (text) => text.replaceAll('{deposit}', deposit).replaceAll('{chain}', primary).replaceAll('{asset}', asset);
  const family = familyOf(protocol.category);
  const steps = [];
  const scaled = (txs, chainBand = band) => [chainBand[0] * txs, chainBand[1] * txs];

  steps.push(planStep(
    `Fund a fresh wallet on ${primary} with ${deposit} of stablecoins plus ${asset} for gas, and confirm the ${name} address from the venue's own site before sending anything. Bridge tolls vary by route and sit outside the totals below.`,
    scaled(2), [10, 25], PHASE1,
  ));
  for (const [template, txs, minutes, phase] of CORE_STEPS[family]) {
    steps.push(planStep(fill(template), scaled(txs), minutes, phase));
  }

  const change = protocol.change_7d;
  const traitSteps = [];
  if (secondary) {
    traitSteps.push(planStep(
      `Mirror a small share of the position on ${secondary} as well, so the record spans ${chains.length} chains and no single chain holds everything.`,
      scaled(2, gasBand(secondary)), [15, 30], PHASE2,
    ));
  }
  if (change !== null && change !== undefined && !Number.isNaN(change) && change >= 50) {
    traitSteps.push(planStep(
      `Because TVL jumped ${change.toFixed(1)}% in a week, split the entry into two tranches a week apart and re-check TVL before the second one; hot entries buy tops.`,
      [0, 0], [20, 40], PHASE2,
    ));
  } else if (change !== null && change !== undefined && !Number.isNaN(change) && change <= -30) {
    traitSteps.push(planStep(
      `Because TVL fell ${Math.abs(change).toFixed(1)}% in a week, read the venue's own announcements for the cause before adding anything, and halve the planned size until the outflow stops.`,
      [0, 0], [25, 45], PHASE2,
    ));
  }
  if (ageDays === null) {
    traitSteps.push(planStep(
      `No listing date is reported, so verify the launch history and the audit status from the venue's own documents before sizing up; an unverified record deserves a smaller first position.`,
      [0, 0], [30, 60], PHASE2,
    ));
  } else if (ageDays < 90) {
    traitSteps.push(planStep(
      `Listed ${fmtAgeLong(ageDays)} ago, so read the audit report and the upgrade keys before sizing up; young code fails more often, and a small first position is cheap insurance.`,
      [0, 0], [30, 60], PHASE2,
    ));
  }
  if (chains.length <= 1) {
    traitSteps.push(planStep(
      `TVL sits on ${primary} alone, so test the exit route with a small withdrawal before the full position goes in; a farm you cannot leave is a trap.`,
      scaled(1), [10, 20], PHASE2,
    ));
  }
  steps.push(...traitSteps.slice(0, 2));

  steps.push(planStep(
    `Check the points or rewards page weekly and confirm each week's activity is credited; if a week is missing, raise it with the venue while the evidence is fresh.`,
    [0, 0], [10, 20], PHASE2,
  ));
  steps.push(planStep(
    `Re-check TVL, the ${name} announcements and the gas band on ${primary} every week for 8–12 weeks; exit or halve the position if TVL halves or the venue goes quiet.`,
    [0, 0], [120, 360], PHASE3,
  ));
  steps.push(planStep(
    `Keep a one-page record of every transaction hash, amount and date, so a future airdrop claim, tax return or dispute has evidence rather than memory.`,
    [0, 0], [30, 60], PHASE3,
  ));

  const risks = planRisks(protocol, calibration, family, ageDays);
  return {
    steps: steps.map((s) => s.text),
    plan_meta: steps.map((s) => ({ cost_usd: s.cost_usd, minutes: s.minutes, phase: s.phase })),
    plan_risks: risks,
  };
}

/**
 * planRisks: the risks worth naming before farming, derived from the
 * protocol's own fields and family, most specific first, capped at four,
 * with the standing smart-contract warning last.
 */
function planRisks(protocol, calibration, family, ageDays) {
  const risks = [];
  const entry = calibration.detail.get(protocol.category ?? 'Uncategorized');
  if (!entry || entry.fallback) {
    risks.push('Pricing risk: the category has too few live-token protocols to price itself, so the multiple falls back to the global median.');
  }
  const change = protocol.change_7d;
  if (change !== null && change !== undefined && !Number.isNaN(change) && change >= 50) {
    risks.push(`Entry risk: TVL spiked ${change.toFixed(1)}% in a week; entering at the top of a spike is the commonest way to lose on a farm.`);
  } else if (change !== null && change !== undefined && !Number.isNaN(change) && change <= -30) {
    risks.push(`Outflow risk: TVL fell ${Math.abs(change).toFixed(1)}% in a week; the cause may still be unfolding.`);
  }
  if (ageDays === null) {
    risks.push('Record risk: no listing date is reported, so the record behind this rank is unverified.');
  } else if (ageDays < 90) {
    risks.push(`Record risk: listed ${fmtAgeLong(ageDays)} ago, a short record for a protocol holding ${fmtUsd(protocol.tvl_usd)}.`);
  }
  const chains = Array.isArray(protocol.chains) ? protocol.chains : [];
  if (chains.length <= 1) {
    risks.push(`Concentration risk: all TVL sits on ${chains[0] ?? 'one chain'}; if it stalls, the whole position is stuck.`);
  }
  if (family === 'deriv' || family === 'perp' || family === 'options') {
    risks.push('Liquidation risk: leveraged or expiring positions can close against you; size so a 10% move cannot liquidate the account.');
  }
  if (family === 'bridge') {
    risks.push('Bridge risk: crossings can delay or fail; never bridge more than you can wait a week for.');
  }
  risks.push('Smart-contract risk: every step touches code that can fail or be exploited; never deposit more than you can lose.');
  return risks.slice(0, 4);
}

// ---------------------------------------------------------- board builder

/**
 * categoryAggregates: per-category counts and TVL shares for the board's
 * category distribution, from the ranked rows themselves.
 */
function categoryAggregates(rows) {
  const totalTvl = rows.reduce((sum, r) => sum + r.tvl_usd, 0);
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, { count: 0, tvl: 0 });
    const entry = byCategory.get(row.category);
    entry.count += 1;
    entry.tvl += row.tvl_usd;
  }
  return [...byCategory.entries()]
    .map(([category, entry]) => ({
      category,
      count: entry.count,
      tvl_usd: entry.tvl,
      share: totalTvl > 0 ? entry.tvl / totalTvl : 0,
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || a.category.localeCompare(b.category));
}

/**
 * buildBoard: rank every protocol that records no token and is not a
 * wrapped, staked or bridged product, by the implied value, with the
 * highest-TVL tie-break and the slug tie-break. Every watchlist protocol
 * that survives the exclusion must appear; the builder fails loudly if
 * one is missing, because a radar that drops a watchlist row is broken.
 */
export function buildBoard(snapshot) {
  const asOf = snapshot.as_of;
  const calibration = calibrateCategoryMultiples(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist ?? []);
  const candidates = snapshot.protocols.filter(
    (p) => recordsNoToken(p) && !isWrappedOrStakedProduct(p),
  );
  const sorted = [...candidates].sort((a, b) => {
    const va = impliedValueUsd(a, calibration, asOf).value;
    const vb = impliedValueUsd(b, calibration, asOf).value;
    return vb - va || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug);
  });
  const tvls = sorted.map((p) => p.tvl_usd).sort((a, b) => a - b);
  const totalValue = sorted.reduce((sum, p) => sum + impliedValueUsd(p, calibration, asOf).value, 0);
  const rows = sorted.map((protocol, index) => {
    const { value, multiple, growth, maturity, footprint } = impliedValueUsd(protocol, calibration, asOf);
    const ageDays = ageDaysOf(protocol.listed_at, asOf);
    const below = tvls.filter((t) => t < protocol.tvl_usd).length;
    const row = {
      rank: index + 1,
      slug: protocol.slug,
      name: protocol.name,
      category: protocol.category ?? 'Uncategorized',
      chains: protocol.chains,
      tvl_usd: protocol.tvl_usd,
      change_7d: protocol.change_7d,
      age_days: ageDays,
      implied_value_usd: value,
      value_breakdown: {
        category_multiple: multiple,
        growth_factor: growth,
        maturity_factor: maturity,
        footprint_factor: footprint,
      },
      watchlist: watchlist.has(protocol.slug),
    };
    row.data_signals = signalsFor(protocol, calibration, ageDays);
    row.why = whyNarrative(row, { rows: sorted.length, tvlPercentile: (below / Math.max(1, tvls.length)) * 100 });
    const plan = farmPlan(protocol, calibration, ageDays);
    row.farm_steps = plan.steps;
    row.plan_meta = plan.plan_meta;
    row.plan_risks = plan.plan_risks;
    return row;
  });
  const missingWatchlist = sorted.filter((p) => watchlist.has(p.slug)).length;
  const expectedWatchlist = snapshot.protocols.filter(
    (p) => watchlist.has(p.slug) && recordsNoToken(p) && !isWrappedOrStakedProduct(p),
  ).length;
  if (missingWatchlist !== expectedWatchlist) {
    throw new Error(`Watchlist coverage failed: ${missingWatchlist} of ${expectedWatchlist} eligible watchlist protocols on the board.`);
  }
  return {
    rows,
    calibration: {
      global_multiple: calibration.globalMultiple,
      global_q1: calibration.globalQ1,
      global_q3: calibration.globalQ3,
      live_count: calibration.liveCount,
      table: calibration.table,
      live: calibration.live,
    },
    stats: {
      snapshot_protocols: snapshot.protocols.length,
      ranked: rows.length,
      watchlist_on_board: rows.filter((r) => r.watchlist).length,
      watchlist_total: watchlist.size,
      total_implied_usd: totalValue,
      categories: categoryAggregates(rows),
    },
  };
}
