# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/tmrwbank51/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/tmrwbank51/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar ranks the DeFi protocols that record no token yet by what a launch would be worth, and shows a concrete farm plan for each one. The program reads the sealed DefiLlama snapshot (758 protocols, frozen 2026-11-14), derives an implied value for every pre-token protocol from the snapshot's own figures — TVL, seven-day growth, age since listing, and chain footprint — calibrated against the market-cap-to-TVL multiples of the protocols whose token already trades, and writes a dashboard: a sortable, filterable board with a detail view per protocol. The board covers all 40 protocols on the snapshot's watchlist plus every other pre-token protocol the snapshot carries. Implied values are this entry's own claim, never make.fun's, and a protocol is described as recording no token, never as having none.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1q76qhmm&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
