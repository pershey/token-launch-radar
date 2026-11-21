# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/pershey/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/pershey/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A static radar of the DeFi protocols that record no token on DefiLlama: it ranks them by an implied launch value fitted on the snapshot's own traded tokens, keeps a term in that fit only if it lowers the miss on tokens the fit never saw, and gives every row a farm plan with its cost, its time and a verdict net of fees. One model file (`dashboard/model.js`) writes `board.json` under Node and redraws the same numbers in the browser, with no network and no list of names.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
# then open out/dashboard/index.html in a browser
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0xhfwpmz&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
