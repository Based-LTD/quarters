# QUARTERS — follow the money

**[quarters.fun](https://quarters.fun)** is a pay-to-play arcade on **Robinhood Chain**. A play costs a quarter (0.0002 ETH), every score is a replay anyone can re-run, and every pot pays out on-chain.

This repo is published so you don't have to trust us. It contains the contract, the verifier that decides scores, the deterministic game engines, and a one-command tool that re-executes any receipt on your own machine.

| | |
|---|---|
| Chain | Robinhood Chain mainnet (chain id 4663) |
| Contract | [`0x64d59b679728aa1d155a27c7f391c30c8e2d0b56`](https://robinhoodchain.blockscout.com/address/0x64d59b679728aa1d155a27c7f391c30c8e2d0b56) |
| Verifier (signer) | `0xAe9DC3F08f7593Bc0eD4be4709e2dC58b80f678C` · API `https://quarters-rh-mainnet.fly.dev` |
| Treasury | `0xBdB31Ab1F4070941e7573390f4c12054ed085335` |
| Source | [`contracts/src/Quarters.sol`](contracts/src/Quarters.sol) |

## Where every quarter goes

A quarter splits *inside the contract*, in the same transaction that pays it (`_credit` in `Quarters.sol`):

```
insertCoin / startRun
  quarter      = the cabinet's stake, or quarterWei (0.0002 ETH)
  pot share    = 70%   → that cabinet's pot for the day  (THE BOUNTY: its bounty pool)
  operator     = 15%   → the cabinet's operator
  gas leg      =  7%   → the verifier signer, which pays gas to write scores and settle pots
  house        = the remainder (8%) → the treasury
```

Pots are balances inside the contract. Wei leaves a pot only through `settlePot`, which:

1. can be called by **anyone** once the day is over (plus a grace window of min(period/4, 21 min)),
2. pays the top 10 unflagged scores by a fixed table: **30% / 18% / 12%** for ranks 1–3 and **40% split evenly** across ranks 4–10, renormalized over the ranks actually present,
3. sends rounding dust, or the whole pot if nobody played, to the treasury, and
4. can never run twice for the same pot.

A payout that a recipient contract refuses is not lost: it accrues to `owed[addr]` and `withdraw()` pays it out.

## THE BOUNTY

Cabinet 2 is the jackpot machine. It runs **one game per week**, rotating Monday 00:00 UTC, from the append-only schedule in [`verifier/jackpot-schedule.json`](verifier/jackpot-schedule.json): an entry is published before its week starts and never edited after. The contract keeps one record for cabinet 2 in *jackpot points*; each week converts raw scores at a rate fixed when the week opens (`points = floor(raw × bar_at_open / target)`, see [`verifier/jackpot.js`](verifier/jackpot.js)), and every receipt carries the raw score, the points and the rate. The contract never reads which game a cabinet runs; the verifier enforces the week's game.

Before rotation, cabinet 2 was VOID ROCKS with no daily reset. Its pot share accrues to a standing pool. The first unflagged score above **max(current record, floor)** takes the whole pool, paid inside the same `submitScores` call that records the score. The floor is 50,000 (`bountyFloor(2)`). A run is capped at 10 minutes of play.

## How a score becomes true

```
score = f(committed_seed, your_inputs)
```

1. **Commit.** Paying for a play stores your seed commitment on-chain *before* you play, salted with the previous block hash so seeds can't be shopped. No re-rolls.
2. **Play.** The engine is deterministic: integer-only state, fixed 60 Hz timestep, seeded PRNG. The client records your input bitmask every tick.
3. **Submit the recording, not the score.** The client POSTs `{creditId, game, seed, inputsRLE, claimedScore, claimedHash}` to the verifier.
4. **Re-execute.** The verifier checks the secret against the on-chain commitment, replays the inputs from scratch with the same engine, and only if the score and state hash reproduce exactly does it call `submitScores`. It publishes the receipt, and the on-chain `ScoreSubmitted` event carries the replay hash.
5. **Anyone can re-run it.** See below.

Bots are a risk in any skill contest. The verifier flags runs whose input timing is machine-regular (`analyzeInputs` in `verifier/service.js`). Flagged runs still go on the board with the flag on their receipt, but a flagged entry is skipped at settlement and cannot take THE BOUNTY.

## Re-run a receipt yourself

```bash
npm install
node tools/replay.js https://quarters-rh-mainnet.fly.dev/replays/<creditId>.json
```

It loads the engine, replays the recorded inputs against the committed seed, and prints `REPRODUCED` or `MISMATCH`.

Public verifier endpoints:

```
GET /leaderboards               every live cabinet's pot and top ten, the bounty, and the next payout time
GET /leaderboard/:cabinetId     one cabinet, straight from the chain (incl. bounty record, floor, pool)
GET /jackpot                    this week's Bounty game, raw score to beat, pool, and the schedule
GET /player/:wallet             a wallet's standings and receipts
GET /replays/:creditId.json     a receipt
GET /stats                      totals
GET /health                     solvency, signer identity, gas runway, settlement freshness
```

## Packs and the session key

A pack (`openTab(sessionKey, sessionFloat)`) escrows your deposit in the contract under your address and hands a small gas float to a throwaway **session key** held in your browser. The session key can only call `startRun` for *your* tab, which spends one quarter through the same split as `insertCoin`. It cannot move escrow anywhere else. `closeTab()` returns the unspent balance to your wallet at any time.

## Trust assumptions — what we can and can't do

- **The verifier key is trusted to be honest about scores.** It is the only key that can submit scores. Every score it writes carries a replay hash, and every receipt is public and re-runnable, so a fake score is detectable after the fact. It cannot be prevented by the contract.
- **The authority key** (`authority()`) can change config: the quarter price, the split, the period, the verifier and treasury addresses, cabinet stakes and operators, the bounty floor, and it can clear a verifier flag. It **cannot** withdraw a pot, the bounty pool, or anyone's escrow directly. Because it can replace the verifier, it is ultimately trusted too. It is being moved to a hardware wallet.
- Config changes emit events; watch the contract.

## What's in here

```
contracts/           Quarters.sol + BountyFeeder.sol, Foundry tests, forge-std, the ABI
verifier/            the verifier service, its EVM chain adapter, and its tests
engine/              24 deterministic game engines (plain JS, shared verbatim by client and verifier)
tools/replay.js      re-run any receipt
```

Not in here: the website and brand source, deploy keys, and infrastructure config.

```bash
npm test                          # engine determinism + verifier API tests
cd contracts && forge test        # contract tests
```

## Contact

hello@quarters.fun · [@quartersfun](https://x.com/quartersfun) · BASED LTD
