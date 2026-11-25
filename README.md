# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dottiekuthe-tech/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dottiekuthe-tech/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's `token-radar-01` bounty. It reads a sealed DefiLlama snapshot of 758 protocols and ranks the ones that record no token by what a launch would be worth, each with a concrete farm plan, in an offline web dashboard.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22 or later, standard library only, no network. Two runs write byte-identical output. `main.ts` writes `board.json`, the dashboard (with `data.js`), the screenshots, and `dossier.json` (via `vendor/makefun-board.ts`).

## Model (`lib/model.ts`, `radar-2-category-fit`)

The starter priced every protocol at TVL × 0.25. The snapshot itself says that is a bad guess: on the 128 protocols that already have a token, TVL alone explains only ~19% of log market-cap variance (R² = 0.19). What the snapshot does say is that the market-cap/TVL ratio depends on the category: the median ratio runs from 0.041 for Liquid Staking to 0.746 for Canonical Bridge, an ~18× spread.

So the model fits one multiple per category from the snapshot's own already-tokenized protocols, shrinks thin categories toward the global median in log space (k = 3), caps the multiple to [0.01, 3], and applies it to every pre-token protocol in the same category. A 7-day growth factor (weight 0.5, clamped −60%…+120%) adjusts for momentum. Age is not weighted: its correlation with log(mcap/TVL) is −0.004, no pricing signal at all. Nothing is hard-coded by name; the fit is recomputed from the sealed snapshot on every run.

Holdout validation (deterministic 50/50 split by slug hash): median absolute log error ~1.56 (about 4.8×) against ~1.75 (5.7×) for the starter's flat 0.25×. Implied values are order-of-magnitude prices, not point estimates, and the dashboard says so next to every number.

## Board

200 rows: the 40 watchlist protocols plus the 160 pre-token protocols below the $50M floor with the most TVL. Each row carries a 6-step farm plan with cost and time, in capital tiers by TVL ($50 / $100 / $150 / $250). A separate Live view lists the 24 largest already-tokenized protocols, so the board keeps pre-token and live clearly apart.

## Layout

- `main.ts` — entrypoint
- `lib/model.ts` — the fitted model, board builder, farm plans
- `vendor/makefun-board.ts` — make.fun's dossier library (the kit's copy, byte for byte)
- `dashboard/` — `index.html`, `app.css`, `app.js` (renders `data.js`, no network)
- `screenshots/` — board, detail, and filtered views (1440×900)

---

<sub>Entered on [make.fun](https://make.fun/?ref=mza7v7h3&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
