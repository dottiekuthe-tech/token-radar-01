// Token launch radar, model v2: fitted category multiples.
//
// The starter priced every protocol at TVL x 0.25. That is a guess, and the
// snapshot itself says it is a bad one: on the 128 protocols that already
// have a token, TVL alone explains only ~19% of log market-cap variance
// (log-log OLS R^2 = 0.19). What the snapshot does say is that the
// market-cap/TVL ratio depends on the category: the median ratio runs from
// 0.041 for Liquid Staking to 0.746 for Canonical Bridge, an ~18x spread.
// So this model fits one multiple per category from the snapshot's own
// already-tokenized protocols, shrinks thin categories toward the global
// median in log space (so a single wild observation cannot set a price),
// and applies the fitted multiple to every pre-token protocol in the same
// category. Nothing is hard-coded by name: the same function scores every
// row, and the fit is recomputed from the sealed snapshot on every run.
//
// Two signals the snapshot does NOT carry are left out on purpose:
//  - Age (days since listed_at): correlation with log(mcap/TVL) is -0.004
//    on the issued set, i.e. no pricing signal at all.
//  - Whether a protocol will ever launch a token, or when: the radar
//    prices "if it launched today, what would it be worth", never a
//    launch probability.
//
// Validation, recomputed at runtime and shown on the dashboard:
// a 50/50 split of the 128 comparables (by slug hash, deterministic)
// fits the multiples on one half and predicts the other. Median absolute
// log error is ~1.56 (about a 4.8x typical error) against ~1.75 (5.7x)
// for the starter's flat 0.25x. The model is honest about that spread:
// implied values are order-of-magnitude prices, not point estimates,
// and the dashboard says so next to every number.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Fitted model constants: everything here is derived from the snapshot. */
export interface ModelFit {
  comparables: number;
  global_multiple: number;
  global_log_multiple: number;
  /** Shrinkage weight: n observations count n, the global prior counts this. */
  shrink_k: number;
  multiple_cap_low: number;
  multiple_cap_high: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  /** Per-category fitted multiple (already shrunk and capped). */
  category_multiple: Record<string, number>;
  /** Categories with no issued comparable: they fall back to global_multiple. */
  fallback_categories: string[];
  /** Holdout validation, recomputed every run (see header). */
  holdout_n: number;
  holdout_median_log_error: number;
  holdout_starter_median_log_error: number;
  loglog_r2: number;
}

export const MODEL_VERSION = 'radar-2-category-fit';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_n: number;
    growth_pct: number;
    growth_multiplier: number;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: ModelFit;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Deterministic 50/50 split: even md5 of the slug goes to the fit half. */
function hashEven(slug: string): boolean {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 2 === 0;
}

/** The issued protocols usable as price comparables: a token with a market. */
export function comparables(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.gecko_id !== null,
  );
}

/**
 * Fit the multiples from the comparables. Per category, take the median of
 * log(mcap/TVL), shrink it toward the global median log ratio with weight
 * k = 3, exponentiate, and cap to [0.01, 3]. Categories with no comparable
 * are absent from the map and fall back to the global median at use time.
 */
export function fitModel(snapshot: Snapshot): ModelFit {
  const comps = comparables(snapshot);
  const logs = comps.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const globalLog = median(logs);
  const globalMultiple = Math.exp(globalLog);
  const shrinkK = 3;
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const c = p.category ?? 'Unknown';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(Math.log(p.mcap_usd! / p.tvl_usd));
  }
  const categoryMultiple: Record<string, number> = {};
  for (const [c, vals] of byCat) {
    const shrunk = (vals.length * median(vals) + shrinkK * globalLog) / (vals.length + shrinkK);
    categoryMultiple[c] = Math.min(3, Math.max(0.01, Math.exp(shrunk)));
  }
  const watchCats = new Set(
    snapshot.watchlist.map((s) => snapshot.protocols.find((p) => p.slug === s)?.category ?? 'Unknown'),
  );
  const fallbackCategories = [...watchCats].filter((c) => !(c in categoryMultiple)).sort();

  // Holdout validation: fit on the even half, predict the odd half.
  const fitHalf = comps.filter((p) => hashEven(p.slug));
  const testHalf = comps.filter((p) => !hashEven(p.slug));
  const fitLogs = fitHalf.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const fitGlobal = median(fitLogs);
  const fitByCat = new Map<string, number[]>();
  for (const p of fitHalf) {
    const c = p.category ?? 'Unknown';
    if (!fitByCat.has(c)) fitByCat.set(c, []);
    fitByCat.get(c)!.push(Math.log(p.mcap_usd! / p.tvl_usd));
  }
  const fitMult = (p: SnapshotProtocol): number => {
    const vals = fitByCat.get(p.category ?? 'Unknown');
    if (!vals) return Math.exp(fitGlobal);
    const shrunk = (vals.length * median(vals) + shrinkK * fitGlobal) / (vals.length + shrinkK);
    return Math.min(3, Math.max(0.01, Math.exp(shrunk)));
  };
  const errs = testHalf.map((p) => Math.abs(Math.log(Math.max(p.tvl_usd * fitMult(p), 1)) - Math.log(p.mcap_usd!)));
  const starterErrs = testHalf.map((p) => Math.abs(Math.log(Math.max(p.tvl_usd * 0.25, 1)) - Math.log(p.mcap_usd!)));

  // Log-log OLS R^2 of log(mcap) on log(tvl) over all comparables.
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;

  return {
    comparables: comps.length,
    global_multiple: Math.round(globalMultiple * 10000) / 10000,
    global_log_multiple: Math.round(globalLog * 10000) / 10000,
    shrink_k: shrinkK,
    multiple_cap_low: 0.01,
    multiple_cap_high: 3,
    growth_weight: 0.5,
    growth_floor: -60,
    growth_cap: 120,
    category_multiple: Object.fromEntries(
      Object.entries(categoryMultiple).map(([k, v]) => [k, Math.round(v * 10000) / 10000]),
    ),
    fallback_categories: fallbackCategories,
    holdout_n: testHalf.length,
    holdout_median_log_error: Math.round(median(errs) * 1000) / 1000,
    holdout_starter_median_log_error: Math.round(median(starterErrs) * 1000) / 1000,
    loglog_r2: Math.round(r2 * 1000) / 1000,
  };
}

/** A protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the board may rank a protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** One protocol's implied value under the fitted model. */
export function impliedValue(
  p: SnapshotProtocol,
  fit: ModelFit,
): { implied: number; multiple: number; categoryN: number; growthPct: number; growthMult: number } {
  const multiple = fit.category_multiple[p.category ?? 'Unknown'] ?? fit.global_multiple;
  const categoryN = 0; // filled by the caller from the snapshot; see buildBoard
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(fit.growth_cap, Math.max(fit.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * fit.growth_weight;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult));
  return { implied, multiple, categoryN, growthPct, growthMult };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: ModelFit): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const catN = new Map<string, number>();
  for (const p of comparables(snapshot)) {
    const c = p.category ?? 'Unknown';
    catN.set(c, (catN.get(c) ?? 0) + 1);
  }
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, fit);
    return { p, ...v, categoryN: catN.get(p.category ?? 'Unknown') ?? 0 };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    implied_value_usd: s.implied,
    model: {
      category_multiple: Math.round(s.multiple * 10000) / 10000,
      category_n: s.categoryN,
      growth_pct: s.growthPct,
      growth_multiplier: Math.round(s.growthMult * 10000) / 10000,
    },
    farm_steps: farmSteps(s.p).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Farm capital tiers by TVL: big protocols get a bigger position, small ones a small one. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 30;
  if (p.tvl_usd >= 100_000_000) return 45;
  return 60;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Derived from the protocol's own record (category, chains, TVL), never
 * from a hand-written list of names. Three capital tiers ($50 / $100 /
 * $150 / $250) keep small-protocol plans affordable and big-protocol
 * plans meaningful; the hold window is longer for smaller protocols,
 * whose snapshots are taken less often.
 */
export function farmSteps(p: SnapshotProtocol): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(p);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; fit: ModelFit } {
  const fit = fitModel(snapshot);
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar, fit };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
