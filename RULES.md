# QUARTERS rules log

Every rule change, posted here before it takes effect. Newest first. Nothing on this list changes a day that already has scores in it. Mirrors https://quarters.fun/rules.html.

## Upcoming, at $QTRS launch (date posted here first): the jackpot door, $QTRS status
Jackpot coins go in through `JackpotDoor.sol`. Holding the minimum $QTRS when your coin goes in: you take the whole jackpot, up to 1 ETH. Not holding: 25% of it. The rest stays in a reserve that tops the next jackpot back up to 1 ETH. No owner withdraw: the door only pays a verified winner or sends money back into the jackpot. Same games, targets, and scores for everyone. Minimum holding and start date: posted here before they take effect.

## 2026-09-28: Claude reviews every Bounty win first
Each winning Bounty run is measured from its replay (threat reaction times, score curve, input patterns, bot checks, wallet history) and reviewed by Claude (`verifier/reviewer.js`) before it pays. Confident "human" with no bot flags pays right away; "unsure" or "bot" goes to a person with the reasoning; on timeout Claude's recommendation stands. The verdict and reasons are in the run's public record.

## 2026-09-28: every Bounty win is reviewed
Every winning Bounty run, whatever the pool, gets a human replay review before it pays (was: pools over 0.1 ETH). Inside the contract's 20-minute window; if nobody reviews it in time, it pays. Runs submitted faster than real time are flagged.

## 2026-09-27: the Bounty board runs all week
The Bounty's board is the week's best runs; it no longer resets at midnight. Daily machines still reset and pay daily. No daily house seed on the Bounty machine.

## 2026-09-27: the Bounty rotates weekly
One game per week, Monday 00:00 UTC, from `verifier/jackpot-schedule.json` (append-only). The pool carries over. A run counts under the week its coin went in. Void Rocks through 2026-10-05.

## 2026-09-27: jackpot review
A winning Bounty run on a pool over 0.1 ETH gets a human replay review inside the contract's 20-minute window; if nobody reviews it in time, it pays.

## 2026-09-26: the Bounty, score to beat 50,000
`bountyFloor(2) = 50000`. 20% of $QTRS trading fees feed the pool through `0xDcD7FB55784009cB717265F0A6AFE9CEEaA64791` (ownerless, pays only the pool).

## 2026-09-26: live on Robinhood Chain
Contract `0x64d59b679728aa1d155a27c7f391c30c8e2d0b56`. A play is 0.0002 ETH: 70% pot, 15% operator, 7% verifier gas, 8% house. Daily pots pay the top ten at midnight UTC: 30 / 18 / 12%, 40% split across 4th–10th.
