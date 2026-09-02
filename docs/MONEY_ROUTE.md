# QUARTERS Money Route — Design v1 (2026-08-31)

Goal: a bulletproof quarter-in → verified-score → payout-out loop. Devnet until
proven; nothing touches mainnet until the full loop has survived live abuse
testing (house rule: revenue plumbing is verified live, never believed done).

## The loop

```
ECONOMICS (2026-08-31): quarter = 0.0025 SOL (~$0.25 — "a quarter costs a
quarter"); back room 0.05 SOL. Credit account rent (~0.0014 SOL) is fronted
by the player and refunded automatically when the score submits (credit
closes). update_config retunes price/splits/period/verifier/treasury without
redeploy. Verifier wallet requires a fee float (pays submit_score fees).

player wallet
  │ insert_coin(cabinet, seed_commit)          [on-chain]
  ▼
70% → DailyPot PDA / Bounty PDA
15% → cabinet operator          (house until deeds sell)
15% → treasury
  │  seed committed on-chain BEFORE play — no re-rolls
  ▼
player plays in browser (deterministic engine, input log recorded)
  │ POST {creditId, replay JSON}               [off-chain]
  ▼
verifier service: replays inputs vs committed seed (~400x realtime),
publishes the replay JSON (the receipt), signs the result
  │ submit_score(credit, score, replay_hash)   [on-chain, verifier-signed]
  ▼
DailyPot leaderboard updated (top 10) — or Bounty claimed outright
  │ settle_pot(cabinet, day)                   [on-chain, permissionless]
  ▼
top-10 split 30/18/12/40-evenly, paid to wallets
```

## On-chain program (Anchor) — the cashier and the trophy case

Accounts:
- **Arcade** (PDA "arcade"): authority, verifier pubkey, treasury, quarter
  lamports, split bps. One per deployment.
- **Cabinet** (PDA "cabinet"+id): game id, operator wallet, bounty flag.
  Operator is reassignable = the deed transfer hook for the NFT phase.
- **DailyPot** (PDA "pot"+cabinet+day): holds the day's 70%; top-10
  leaderboard of (player, score, replay_hash); settled flag. Day =
  unix_time / 86400 — one pot per cabinet per UTC day.
- **Bounty** (PDA "bounty"+cabinet): standing record, champion, pot that only
  grows until beaten.
- **Credit** (PDA "credit"+player+counter): one per quarter — cabinet, day,
  seed_commit, consumed flag. The on-chain proof a specific seed was paid
  for before the run happened.

Instructions: initialize, create_cabinet, set_operator (deed hook),
insert_coin, submit_score (verifier-only signer), claim_bounty (verifier-only),
settle_pot (permissionless after day rollover).

Trust model v1: the verifier is a house-held key. What keeps it honest is the
receipts: every scoring replay is published and re-executable by anyone, and
seeds are committed on-chain pre-play. Cheating by the house is detectable by
any player with a laptop. Verifier decentralization is a later phase, not a
launch blocker — detectability beats trustlessness for v1.

## Verifier service (node)

- HTTP: POST /submit {creditId, game, seed, inputsRLE, claimedScore, claimedHash}
- Loads the credit from chain, checks seed matches the commitment, replays via
  the existing engines (verifier/verify.js registry — already built and tested),
  checks score+hash, runs TAS heuristics (input-timing entropy; flag > threshold
  for manual review per spec §06), stores replay JSON at a public URL, signs and
  sends submit_score.
- Publishes: /replays/{creditId}.json — the receipt.

## Web integration

- Wallet adapter (Phantom/Solflare) on cabinet pages.
- INSERT COIN → builds seed client-side, commits hash on-chain via insert_coin,
  reveals seed to the game after confirmation (seed_commit = sha256(seed)).
- Game over → auto-POST replay to verifier; UI shows pot position.
- FREE PLAY mode stays — wallet-less play, no pot entry (the demo path).

## NFT deeds (phase after payouts work)

Per spec: release first, sell after. Deed = NFT whose holder can call
set_operator on their cabinet; sale = standard Metaplex auction later. The
program only needs operator reassignment to be deed-ready, which v1 includes.

## Sequencing gates (each verified live on devnet before the next)

1. ✅ 2026-08-31 — deployed to devnet (GixGVpDZpCxVcnpfWcSPwXF8rtjYrBGmmpkSdZq7kb7a);
   insert_coin splits verified by live balances: pot +3×70%, treasury +3×30%
   exactly (tests/gates.js).
2. ✅ CLOSED 2026-08-31 (tests/gate2-e2e.js, live devnet): coin with
   committed seed → deterministic play → verifier service re-executes and
   checks the ON-CHAIN commitment → submit_score lands → score on the
   on-chain top-10 → credit closes with exact rent refund → replay reuse
   rejected (410) → internally-consistent wrong-seed run rejected against
   the chain commitment (422). REMAINING: the browser UI itself (Phantom
   INSERT COIN button) — a UX layer over these exact calls.
3. ✅ settlement live: pre-rollover rejected (DayNotOver), post-rollover paid
   exactly 30/18/12% with the 40% tail to treasury on a 3-winner board,
   double-settle rejected. (Pot period is configurable: 120s devnet / 86400
   mainnet.)
4. ✅ bounty live: pool paid whole to the record-breaker, weaker claim held
   (RecordStands), champion + record replay hash on-chain.
5. ✅ abuse + settlement edges live (tests/gate5-settle-edges.js, 8/8):
   forged verifier sig, double-submit, replay reuse, wrong-seed all rejected;
   0-winner pot sweeps whole pool to treasury exactly; 4-winner board pays
   the tail branch (4th place = 400/7 bps) with rounding dust to treasury,
   exact to the lamport; wrong winner count/identity and double-settle
   rejected on-chain. Dust griefing note: pot lamports only enter via
   insert_coin splits or donations to the PDA — donations just enlarge the
   pool and settle normally (saturating rent math holds).
6. → mainnet with tiny caps: see docs/MAINNET.md.
