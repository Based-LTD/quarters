#!/usr/bin/env node
// Re-run any QUARTERS receipt locally and check the score, bit for bit.
//
//   node tools/replay.js https://quarters-verifier.fly.dev/replays/<creditId>.json
//   node tools/replay.js path/to/receipt.json
//
// A receipt is {game, seed, inputsRLE, verdict:{score, ticks, stateHash}, ...}.
// This script loads the same deterministic engine the verifier uses, replays
// the recorded inputs against the committed seed, and prints whether the
// score reproduces. No network trust required.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

async function load(arg) {
  if (/^https?:\/\//.test(arg)) { const r = await fetch(arg); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
  return JSON.parse(fs.readFileSync(arg, "utf8"));
}

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: node tools/replay.js <receipt url or file>"); process.exit(2); }
  const rc = await load(arg);
  const game = rc.game;
  const enginePath = path.join(__dirname, "..", "engine", game + ".js");
  const Engine = require(enginePath);
  const localHash = crypto.createHash("sha256").update(fs.readFileSync(enginePath)).digest("hex").slice(0, 16);
  if (rc.engineHash && rc.engineHash !== localHash) {
    console.log(`engine     LOCAL ${localHash} ≠ RECEIPT ${rc.engineHash}`);
    console.log("           this receipt was produced by a different engine version; check out the matching commit to reproduce it.\n");
  } else if (rc.engineHash) console.log(`engine     ${localHash} (matches receipt)`);
  const masks = Engine.decodeRLE(rc.inputsRLE);
  const s = Engine.createState(rc.seed | 0);
  for (const m of masks) { if (s.gameOver) break; Engine.tick(s, m); }
  const score = s.score, hash = Engine.stateHash(s);
  const want = rc.verdict || {};
  const ok = (want.score === undefined || want.score === score) && (want.stateHash === undefined || want.stateHash === hash);
  console.log(`game       ${game}`);
  console.log(`seed       ${rc.seed}`);
  console.log(`inputs     ${masks.length} ticks`);
  console.log(`score      ${score}${want.score !== undefined ? "  (receipt says " + want.score + ")" : ""}`);
  console.log(`stateHash  ${hash}${want.stateHash !== undefined ? "  (receipt says " + want.stateHash + ")" : ""}`);
  console.log(ok ? "\nREPRODUCED — the receipt is honest." : "\nMISMATCH — this receipt does not reproduce. That is a bug or a lie; keep the file.");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("replay failed:", e.message); process.exit(1); });
