#!/usr/bin/env node
// QUARTERS verifier service v1 — the off-chain half of the money route.
//
//   POST /submit  {creditId, game, seed, seedCommit, inputsRLE,
//                  claimedScore, claimedHash}
//     → replays the inputs against the seed via the deterministic engines,
//       checks seed against its sha256 commitment, runs TAS heuristics,
//       stores the replay as a public receipt, and returns a signed verdict.
//   GET  /replays/:creditId.json   → the receipt (re-executable by anyone)
//   GET  /health
//
// v1 signs verdicts with an ed25519 key (VERIFIER_KEY_FILE, auto-generated
// on first run). On-chain submit_score wiring lands after devnet deploy —
// the same key becomes the arcade.verifier signer.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const GAMES = {
  voidrocks: require(path.join(__dirname, "..", "engine", "voidrocks.js")),
  coil: require(path.join(__dirname, "..", "engine", "coil.js")),
  breakpoint: require(path.join(__dirname, "..", "engine", "breakpoint.js")),
  swarm: require(path.join(__dirname, "..", "engine", "swarm.js")),
  moth: require(path.join(__dirname, "..", "engine", "moth.js")),
  lander: require(path.join(__dirname, "..", "engine", "lander.js")),
  hopper: require(path.join(__dirname, "..", "engine", "hopper.js")),
  airtime: require(path.join(__dirname, "..", "engine", "airtime.js")),
  chomp: require(path.join(__dirname, "..", "engine", "chomp.js")),
  girder: require(path.join(__dirname, "..", "engine", "girder.js")),
  stack: require(path.join(__dirname, "..", "engine", "stack.js")),
  vortex: require(path.join(__dirname, "..", "engine", "vortex.js")),
  miner: require(path.join(__dirname, "..", "engine", "miner.js")),
  gridlock: require(path.join(__dirname, "..", "engine", "gridlock.js")),
  apex: require(path.join(__dirname, "..", "engine", "apex.js")),
  myriapod: require(path.join(__dirname, "..", "engine", "myriapod.js")),
  overrun: require(path.join(__dirname, "..", "engine", "overrun.js")),
  skyfall: require(path.join(__dirname, "..", "engine", "skyfall.js")),
  claim: require(path.join(__dirname, "..", "engine", "claim.js")),
  cannonade: require(path.join(__dirname, "..", "engine", "cannonade.js")),
  exodus: require(path.join(__dirname, "..", "engine", "exodus.js")),
  conduit: require(path.join(__dirname, "..", "engine", "conduit.js")),
  lob: require(path.join(__dirname, "..", "engine", "lob.js")),
  summit: require(path.join(__dirname, "..", "engine", "summit.js")),
};

// Engine version stamps: sha256 of each engine file, so a receipt names the
// exact code that produced it. Tuning an engine never silently invalidates
// old receipts — the replay tool checks out the matching version instead.
const ENGINE_HASH = Object.fromEntries(Object.keys(GAMES).map((g) => [g,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "engine", g + ".js"))).digest("hex").slice(0, 16)]));

process.on("uncaughtException", (e) => { console.log("UNCAUGHT " + String(e && e.stack || e).slice(0, 300)); });
const STARTED_AT = Date.now();
const readCache = { lb: null };
const keyBal = { lamports: null, at: 0 };
const healthCache = { arcade: null };
async function refreshHealth() { if (!chain) return; try { keyBal.lamports = await chain.signerBalance(); keyBal.at = Date.now(); const c = await chain.config(); healthCache.arcade = { verifier: c.verifier, treasury: c.treasury, period: c.periodSeconds }; if (chain.kind === "evm") healthCache.gas = { gwei: await chain.gasPriceGwei(), quarter: c.quarter, gasBps: await chain.gasBps() }; } catch (e) {} }
setInterval(refreshHealth, 60_000).unref(); setTimeout(refreshHealth, 3000);
const submitHits = new Map();   // ip → [timestamps]
setInterval(() => { const now = Date.now(); for (const [k, v] of submitHits) { const keep = v.filter((t) => now - t < 60_000); if (keep.length) submitHits.set(k, keep); else submitHits.delete(k); } }, 60_000).unref();
const inFlight = new Set();     // creditIds being verified right now
const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(__dirname, "receipts");
const KEY_FILE = process.env.VERIFIER_KEY_FILE || path.join(__dirname, "verifier-key.json");
// Launch controls (Fly env): LIVE_CABS="1,3,4,9,15,16" limits the floor to a set of
// cabinets (empty = all 31); HOUSE_ADD_LAMPORTS seeds every live pot once per period
// from the signer key, recorded so it never double-seeds. Small JSON state lives
// next to the receipts: stats.json (paid-out counter), house-adds.json, names.json.
const LIVE_CABS = (process.env.LIVE_CABS || "").split(",").map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 31);
const isLive = (cab) => LIVE_CABS.length === 0 || LIVE_CABS.includes(cab);
const HOUSE_ADD = Math.max(0, parseInt(process.env.HOUSE_ADD_LAMPORTS || "0", 10) || 0);
function jsonFile(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, name), "utf8")); } catch (e) { return fallback; } }
function saveJson(name, obj) { fs.mkdirSync(RECEIPTS_DIR, { recursive: true }); const f = path.join(RECEIPTS_DIR, name); fs.writeFileSync(f + ".tmp", JSON.stringify(obj)); fs.renameSync(f + ".tmp", f); }
const stats = Object.assign({ paidOutLamports: 0, potsSettled: 0, potsPaid: 0, houseAddedLamports: 0, updatedAt: null }, jsonFile("stats.json", {}));
const houseAdds = jsonFile("house-adds.json", {});
const buybacks = jsonFile("buybacks.json", []);   // public receipts of the buyback lane
const names = jsonFile("names.json", {});            // wallet -> { name, at }
const nameOf = (w) => (names[w] && names[w].name) || null;
const GAME_NAMES = { 1: "VOID ROCKS", 2: "VR BOUNTY", 3: "BREAKPOINT", 4: "SWARM", 5: "MOTH", 6: "LANDER", 7: "HOPPER", 8: "AIRTIME", 9: "CHOMP", 10: "GIRDER", 11: "STACK", 12: "VORTEX", 13: "MINER", 14: "GRIDLOCK", 15: "APEX", 16: "MYRIAPOD", 17: "OVERRUN", 18: "SKYFALL", 19: "CLAIM", 20: "CANNONADE", 21: "EXODUS", 22: "CONDUIT", 23: "LOB", 24: "SUMMIT", 25: "COIL", 26: "VOID ROCKS BR", 27: "BREAKPOINT BR", 28: "SWARM BR", 29: "AIRTIME BR", 30: "APEX BR", 31: "MYRIAPOD BR" };
// Settle records (one file per period) feed the daily X post and the public results.
const SETTLES = path.join(RECEIPTS_DIR, "settles"); fs.mkdirSync(SETTLES, { recursive: true });
function recordSettle(day, period, cab, pool, houseAdd, entries) {
  const f = path.join(SETTLES, day + ".json"); let rec = { day, periodSeconds: period, cabs: {} };
  try { rec = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
  const bps = (i) => (i < 3 ? [3000, 1800, 1200][i] : 4000 / 7);
  const present = entries.reduce((a, e, i) => a + (e.flagged ? 0 : bps(i)), 0);
  rec.cabs[cab] = { pool, houseAdd, entries: entries.map((e, i) => ({ player: e.player, name: nameOf(e.player), score: e.score, flagged: e.flagged, payout: e.flagged || present === 0 ? 0 : Math.floor(pool * bps(i) / present) })) };
  fs.writeFileSync(f + ".tmp", JSON.stringify(rec)); fs.renameSync(f + ".tmp", f);
}
const poster = require("./poster.js")({ dir: RECEIPTS_DIR, network: process.env.QR_NETWORK || "devnet", log: console.log });
console.log(`poster: ${poster.dryRun ? "DRY RUN (drafts only)" : "LIVE"} · keys ${poster.configured ? "set" : "missing"} · cap ${poster.max}/day · time ${process.env.POST_TIME_UTC || "00:35"} UTC`);
let potRentCache = null;
const potRent = (c) => c.potRent();
const REVIEW_SCORE = 0x7fffffff; // v1: no auto-payout gate on-chain yet

fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

function loadOrCreateKey() {
  if (fs.existsSync(KEY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    return {
      privateKey: crypto.createPrivateKey({ key: Buffer.from(raw.priv, "base64"), format: "der", type: "pkcs8" }),
      publicKey: crypto.createPublicKey({ key: Buffer.from(raw.pub, "base64"), format: "der", type: "spki" }),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(KEY_FILE, JSON.stringify({
    priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }));
  return { privateKey, publicKey };
}
const KEYS = loadOrCreateKey();

// Devnet on-chain mode: fetch credits from chain (their stored seed_commit is
// authoritative) and push verified scores via submit_score.
let chain = null;
// One verifier, two rooms: CHAIN=evm talks to Quarters.sol (Robinhood Chain);
// otherwise DEVNET_SUBMIT=1 talks to the Anchor program. Same interface either way.
if (process.env.CHAIN === "evm") {
  chain = require("./chains/evm.js")({ rpcUrl: process.env.RPC_URL, chainId: parseInt(process.env.EVM_CHAIN_ID || "46630", 10), contract: process.env.EVM_CONTRACT, privateKey: process.env.EVM_PRIVATE_KEY, network: process.env.QR_NETWORK || "robinhood-testnet" });
} else if (process.env.DEVNET_SUBMIT === "1") {
  const keyJson = process.env.VERIFIER_SOLANA_KEY ? JSON.parse(process.env.VERIFIER_SOLANA_KEY) : JSON.parse(fs.readFileSync(path.join(__dirname, "verifier-solana-devnet.json")));
  chain = require("./chains/solana.js")({ rpcUrl: process.env.RPC_URL || "https://api.devnet.solana.com", keyJson, programId: process.env.PROGRAM_ID, network: process.env.QR_NETWORK || "devnet" });
}
// THE BOUNTY rotates (verifier/jackpot.js): cabinet 2 runs the game of the week
// from the public jackpot-schedule.json, scored in jackpot points on-chain.
const JACKPOT_SCHEDULE = process.env.JACKPOT_SCHEDULE || path.join(__dirname, "jackpot-schedule.json");
const jackpot = chain && chain.kind === "evm" && fs.existsSync(JACKPOT_SCHEDULE)
  ? require("./jackpot.js")({ chain, cab: 2, scheduleFile: JACKPOT_SCHEDULE, stateFile: path.join(RECEIPTS_DIR, "_jackpot.json") }) : null;
// THE BOUNTY's door (evm/src/JackpotDoor.sol). Coins inserted at/after
// JACKPOT_DOOR_FROM must come through the door; it is the player of record on
// Quarters and pays the real winner by $QTRS status. Pivot = a new door.
const JACKPOT_DOOR = process.env.JACKPOT_DOOR && /^0x[0-9a-fA-F]{40}$/.test(process.env.JACKPOT_DOOR) ? process.env.JACKPOT_DOOR : null;
const JACKPOT_DOOR_FROM = process.env.JACKPOT_DOOR_FROM ? Math.floor(Date.parse(process.env.JACKPOT_DOOR_FROM) / 1000) : Infinity;
let doorParamsCache = null;
async function doorParams() {
  if (!JACKPOT_DOOR) return null;
  if (doorParamsCache && Date.now() - doorParamsCache.at < 60000) return doorParamsCache.v;
  const v = await chain.doorParams(JACKPOT_DOOR); doorParamsCache = { at: Date.now(), v }; return v;
}
// what a door seat actually takes home from a pool of `pool` wei
function doorPayout(p, holder, pool) { const j = Math.min(pool, p.cap); return holder ? j : Math.floor(j * p.nonHolderBps / 10000); }
// door wins settle right after the submit; failures retry every minute until the seat says settled
const DOOR_SETTLES = path.join(RECEIPTS_DIR, "_door_settles.json");
let doorSettles = []; try { doorSettles = JSON.parse(fs.readFileSync(DOOR_SETTLES, "utf8")); } catch (e) {}
const saveDoorSettles = () => { try { fs.writeFileSync(DOOR_SETTLES, JSON.stringify(doorSettles, null, 1)); } catch (e) {} };
async function trySettle(job) {
  const seat = await chain.doorSeat(job.door, job.commit);
  if (seat.settled) return { done: true };
  const paid = await chain.bountyPaidIn(job.txSig);
  if (!paid) return { done: false, error: "no BountyClaimed in " + job.txSig };
  const tx = await chain.doorSettle(job.door, job.commit, paid.paidWei);
  return { done: true, tx, receivedWei: paid.paidWei.toString() };
}
async function settleDoorWin(job) {
  try { const r = await trySettle(job); if (r.done) { console.log(`door: settled ${job.commit.slice(0, 12)} ${r.tx || "(already)"}`); return r; } job.lastError = r.error; }
  catch (e) { job.lastError = String(e.message || e).slice(0, 200); }
  job.tries = (job.tries || 0) + 1; job.since = job.since || Date.now();
  doorSettles = doorSettles.filter((j) => j.commit !== job.commit).concat([job]); saveDoorSettles();
  console.log(`door: settle ${job.commit.slice(0, 12)} failed, will retry: ${job.lastError}`);
  return null;
}
if (JACKPOT_DOOR && chain) setInterval(async () => {
  for (const job of doorSettles.slice()) {
    try { const r = await trySettle(job); if (r.done) { doorSettles = doorSettles.filter((j) => j !== job); saveDoorSettles(); console.log(`door: settled on retry ${job.commit.slice(0, 12)}`); } else { job.lastError = r.error; job.tries++; } }
    catch (e) { job.lastError = String(e.message || e).slice(0, 200); job.tries++; }
  }
}, 60000);
const shownPlayer = (cab, e) => (jackpot && cab === 2 ? jackpot.playerFor(e.replayHash) || e.player : e.player);
let jackpotPublic = null;   // the health sensor reads this; it also opens each week's rate as soon as the week is ready
if (jackpot) { const tickJ = () => jackpot.publicState(Math.floor(Date.now() / 1000)).then((j) => { jackpotPublic = j; }).catch(() => {}); setTimeout(tickJ, 3000); setInterval(tickJ, 60000); }
const GAME_TITLES = { voidrocks: "VOID ROCKS", coil: "COIL", breakpoint: "BREAKPOINT", moth: "MOTH", lander: "LANDER", chomp: "CHOMP", girder: "GIRDER", stack: "STACK", apex: "APEX" };
const gameTitle = (g) => GAME_TITLES[g] || String(g || "").toUpperCase();
// Cabinet 2's on-chain scores are jackpot points; boards show the raw game score.
const shownScore = (cab, e) => { if (!jackpot || cab !== 2) return e.score; const r = jackpot.rawFor(e.replayHash); return r != null ? r : e.score; };
// THE BOUNTY's board is the week's, not the day's: it doesn't reset at midnight.
// Built from the chain: every day's pot for cabinet 2 since the week opened (a
// week's top ten is always inside some day's top ten, so nothing is missed).
async function weekEntries(cab) {
  if (!jackpot) return null;
  const nowS = await chain.now(), w = jackpot.weekAt(nowS); if (!w) return null;
  const hit = readCache["week" + cab]; if (hit && Date.now() - hit.at < 8000 && hit.from === w.from) return hit.v;
  const period = (await chain.config()).periodSeconds;
  const d0 = Math.floor(w.fromS / period), d1 = Math.floor(nowS / period), seen = new Set(), all = [];
  const days = []; for (let d = Math.max(d0, d1 - 13); d <= d1; d++) days.push(d);
  const pots = await Promise.all(days.map((d) => chain.pot(cab, d).catch(() => null)));
  pots.forEach((pot) => { if (pot) for (const e of pot.entries) { if (seen.has(e.replayHash)) continue; seen.add(e.replayHash);
    const pl = shownPlayer(cab, e); all.push({ player: pl, name: nameOf(pl), score: shownScore(cab, e), replayHash: e.replayHash, flagged: e.flagged }); } });
  all.sort((a, b) => b.score - a.score);
  readCache["week" + cab] = { at: Date.now(), from: w.from, v: all };
  return all;
}
async function bountyView(b) {
  const v = { record: b.record, floor: b.floor || 0, bar: b.bar != null ? b.bar : b.record, champion: b.champion, lamports: b.pool, championName: nameOf(b.champion) };
  if (jackpot) {
    try { const j = await jackpot.publicState(Math.floor(Date.now() / 1000));
      if (j) Object.assign(v, { game: j.game, target: j.target, barRaw: j.barRaw, weekRecordRaw: j.weekRecordRaw, rotatesAt: j.rotatesAt, next: j.next, paused: j.paused }); } catch (e) {}
  }
  if (JACKPOT_DOOR) {
    try { const p = await doorParams(); v.door = { address: JACKPOT_DOOR, cap: p.cap, nonHolderBps: p.nonHolderBps, refillTo: p.refillTo, reserve: p.reserve, holdMin: p.holdMin,
      token: /^0x0+$/.test(p.token) ? null : p.token, from: Number.isFinite(JACKPOT_DOOR_FROM) ? JACKPOT_DOOR_FROM : null, retired: p.retired }; } catch (e) {}
  }
  return v;
}
// Claude's first-pass review of held Bounty wins (verifier/reviewer.js). Off unless ANTHROPIC_API_KEY is set.
const reviewer = require("./reviewer.js");
const REVIEW_AUTO_MIN = parseFloat(process.env.REVIEW_AUTO_MIN || "0.85");   // "human" at or above this confidence pays without waking anyone
const REVIEW_NOTIFY_AFTER_MS = 150000;   // if the review hasn't answered by then, alert the owner anyway
// who is this wallet: plays today, earlier verified runs on record, on-chain activity
async function walletFacts(player) {
  const f = { playsToday: (walletVolume.get(player) || {}).count || 0, earlierRuns: 0, bestByGame: {}, firstSeen: null };
  try {
    const files = fs.readdirSync(RECEIPTS_DIR).filter((n) => n.endsWith(".json"));
    for (const n of files.slice(-3000)) {
      let rc; try { rc = JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, n), "utf8")); } catch (e) { continue; }
      const pl = rc.onchain && rc.onchain.player; if (!pl || !sameAddr(pl, player) || !rc.verdict) continue;
      f.earlierRuns++; f.bestByGame[rc.game] = Math.max(f.bestByGame[rc.game] || 0, rc.verdict.score);
      if (!f.firstSeen || rc.verdict.verifiedAt < f.firstSeen) f.firstSeen = rc.verdict.verifiedAt;
    }
    if (f.firstSeen) f.firstSeen = new Date(f.firstSeen).toISOString();
  } catch (e) {}
  try { if (chain.walletFacts) Object.assign(f, await chain.walletFacts(player)); } catch (e) {}
  return f;
}
const cabinetCache = new Map();   // cab → { game, operator, isBounty }
async function cabinetInfo(cab) { if (cabinetCache.has(cab)) return cabinetCache.get(cab); const c = await chain.cabinet(cab); if (c) cabinetCache.set(cab, c); return c; }
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---- settle daemon: pay every finished pot, permissionlessly, on a timer ----
// Scans cabinets 1..MAX_CAB for the last SETTLE_LOOKBACK periods; any pot that
// exists, is unsettled, and whose period is over gets settle_pot with the
// stored entries as remaining accounts. Idempotent: settled pots are skipped,
// and the program rejects double-settles anyway.
const settle = { enabled: process.env.SETTLE === "1", lastRun: null, lastOk: null, settled: 0, errors: 0, lastError: null, pending: 0, sweepErrors: 0, lastSweepErrors: 0, opened: 0, lastOpenError: null };
async function settleSweep() {
  if (!chain) return;
  const MAX_CAB = 31, LOOKBACK = parseInt(process.env.SETTLE_LOOKBACK || "7", 10);
  settle.lastRun = Date.now();
  settle.lastSweepErrors = settle.sweepErrors; settle.sweepErrors = 0;
  try {
    const cfg = await chain.config(); const period = cfg.periodSeconds;
    const nowDay = Math.floor((await chain.now()) / period);
    let pending = 0;
    for (let cab = 1; cab <= MAX_CAB; cab++) {
      for (let day = nowDay - LOOKBACK; day < nowDay; day++) {
        let pot; try { pot = await chain.pot(cab, day); } catch (e) { continue; }
        if (!pot || !pot.exists || pot.settled) continue;
        pending++;
        const pool = pot.pool, anyPaid = pot.entries.some((e) => !e.flagged);
        try {
          const { txSig } = await chain.settle(cab, day, pot);
          settle.settled++; pending--;
          stats.potsSettled++; if (anyPaid && pool > 0) { stats.paidOutLamports += pool; stats.potsPaid++; }
          stats.updatedAt = Date.now(); saveJson("stats.json", stats);
          try { recordSettle(day, period, cab, Math.max(0, pool), (houseAdds[chain.potId(cab, day)] || {}).lamports || 0, pot.entries); } catch (e) { console.log("settle: record failed " + e.message); }
          if (chain.kind === "evm") { try { await buybackLane(cab, day, pot); } catch (e) { console.log(`buyback: cab ${cab} day ${day} failed: ${String(e.message || e).slice(0, 160)}`); } }
          console.log(`settle: cabinet ${cab} day ${day} settled ${pot.entries.length} entr${pot.entries.length === 1 ? "y" : "ies"} ${String(txSig).slice(0, 12)}…`);
        } catch (e) {
          const msg = String(e);
          if (chain.isDayNotOver(msg)) { pending--; continue; }   // inside the settle grace: not stale
          settle.errors++; settle.sweepErrors++; settle.lastError = `cab ${cab} day ${day}: ${msg.slice(0, 140)}`;
          console.log("settle: FAILED " + settle.lastError);
        }
      }
    }
    settle.pending = pending;
    // Solana: house pays the pot rent by pre-opening this and next period's pots (never for short test periods).
    if (chain.canPreOpen && period >= 3600) {
      for (const day of [nowDay, nowDay + 1]) for (let cab = 1; cab <= MAX_CAB; cab++) {
        if (!isLive(cab) || !(await cabinetInfo(cab))) continue;
        try { if (await chain.preOpen(cab, day)) settle.opened = (settle.opened || 0) + 1; }
        catch (e) { settle.sweepErrors++; settle.lastOpenError = `open_pot cab ${cab} day ${day}: ${String(e).slice(0, 100)}`; }
      }
    }
    // House adds: seed each live pot once (this and next period) so no board is empty-handed.
    if (HOUSE_ADD > 0) {
      for (const day of [nowDay, nowDay + 1]) for (let cab = 1; cab <= MAX_CAB; cab++) {
        const ci = isLive(cab) ? await cabinetInfo(cab) : null;
        if (!ci) continue;   // only cabinets that exist on this arcade
        if (ci.isBounty) continue;   // THE BOUNTY pays by beating the score, not a daily pot: no daily seed
        const key = chain.potId(cab, day);
        if (houseAdds[key]) continue;
        try {
          const sig = await chain.houseAdd(cab, day, HOUSE_ADD);
          if (!sig) continue;   // pot not there yet
          houseAdds[key] = { cab, day, lamports: HOUSE_ADD, sig, at: Date.now() };
          stats.houseAddedLamports += HOUSE_ADD; saveJson("stats.json", stats);
          for (const k of Object.keys(houseAdds)) if (houseAdds[k].day < nowDay - 14) delete houseAdds[k];
          saveJson("house-adds.json", houseAdds);
          settle.houseAdded = (settle.houseAdded || 0) + 1;
        } catch (e) { settle.sweepErrors++; settle.lastOpenError = `house add cab ${cab} day ${day}: ${String(e).slice(0, 100)}`; }
      }
    }
    // EVM: the gas leg funds this key from revenue; sweep anything above the float cap to the treasury.
    if (chain.kind === "evm") {
      const cap = parseInt(process.env.EVM_FLOAT_CAP_WEI || "0", 10), floor = parseInt(process.env.EVM_FLOAT_FLOOR_WEI || "0", 10);
      if (cap > 0 && floor > 0 && floor < cap) {
        const bal = await chain.signerBalance();
        if (bal > cap) { try { const sig = await chain.sendEth(cfg.treasury, bal - floor); stats.sweptToTreasuryLamports = (stats.sweptToTreasuryLamports || 0) + (bal - floor); saveJson("stats.json", stats); console.log(`float: swept ${chain.fmt(bal - floor)} ETH to treasury ${String(sig).slice(0, 12)}…`); } catch (e) { settle.sweepErrors++; settle.lastError = "float sweep: " + String(e).slice(0, 100); } }
      }
    }
    settle.lastOk = Date.now();
  } catch (e) { settle.errors++; settle.lastError = String(e).slice(0, 140); console.log("settle: sweep error " + settle.lastError); }
}
// Buyback lane (EVM, sponsored cabinets): after a sponsored cabinet settles, the
// vault (this signer) pulls what accrued from quarters, market-buys the sponsor's
// token through its pool, and hands the whole bag to the day's #1 unflagged player.
// Every leg is a public receipt: accrued wei, swap tx, tokens out, bonus tx, winner.
async function buybackLane(cab, day, pot) {
  const sp = await chain.sponsor(cab); if (!sp) return;
  if (!sameAddr(sp.vault, chain.signer)) return;   // another vault runs this cabinet's lane
  const accrued = await chain.buybackAccrued(cab); if (accrued <= 0) return;
  const rec = { cab, day, token: sp.token, accruedWei: accrued, at: new Date().toISOString() };
  rec.withdrawTx = await chain.withdrawBuyback(cab);
  const before = await chain.tokenBalance(sp.token);
  const swap = await chain.buyToken(sp.token, accrued); rec.swapTx = swap.txSig; rec.poolFee = swap.fee;
  const bought = (await chain.tokenBalance(sp.token)) - before; rec.tokensOut = bought.toString();
  const winner = pot.entries.find((e) => !e.flagged);
  if (winner && bought > 0n) { rec.winner = winner.player; rec.winnerName = nameOf(winner.player); rec.bonusTx = await chain.sendToken(sp.token, winner.player, bought); }
  else rec.note = winner ? "swap returned nothing" : "no unflagged player — bag held in the vault";
  buybacks.push(rec); saveJson("buybacks.json", buybacks.slice(-500));
  console.log(`buyback: cab ${cab} day ${day} ${chain.fmt(accrued)} ETH → ${rec.tokensOut || 0} tokens → ${rec.winner || "held"}`);
}
// Daily results post: at POST_TIME_UTC, compose from the most recent settle record
// that isn't already posted. Devnet never posts unless X_POST_DEVNET=1 (drafts still form).
async function dailyPostTick() {
  const [hh, mm] = (process.env.POST_TIME_UTC || "00:35").split(":").map((x) => parseInt(x, 10));
  const now = new Date(); if (now.getUTCHours() !== hh || now.getUTCMinutes() !== mm) return;
  const files = fs.readdirSync(SETTLES).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) return;
  const rec = JSON.parse(fs.readFileSync(path.join(SETTLES, files[files.length - 1]), "utf8"));
  const label = rec.periodSeconds >= 86400 ? new Date(rec.day * rec.periodSeconds * 1000).toISOString().slice(0, 10) : "period " + rec.day;
  const composed = poster.composeDaily(rec, { games: GAME_NAMES, runs: (readCache.stats || {}).runs || 0, dayLabel: label });
  if (!composed) return;
  if ((process.env.QR_NETWORK || "devnet") !== "mainnet" && process.env.X_POST_DEVNET !== "1" && !poster.dryRun) return;
  await poster.queue("results", composed.key, composed.text, composed.png);
}
setInterval(() => dailyPostTick().catch((e) => console.log("poster: tick error " + e.message)), 60000);
if (settle.enabled && chain) {
  const every = Math.max(60, parseInt(process.env.SETTLE_INTERVAL_S || "300", 10)) * 1000;
  console.log(`settle daemon on: every ${every / 1000}s, lookback ${process.env.SETTLE_LOOKBACK || 7} periods`);
  setTimeout(settleSweep, 5000);
  setInterval(settleSweep, every);
}

async function chainSubmit(creditId, body, result) {
  const credit = await chain.credit(creditId, body);
  if (!credit) return { ok: false, code: 410, reason: "credit not found (unpaid, or already scored)" };
  if (credit.used) return { ok: false, code: 410, reason: "credit already scored" };
  // The credit's cabinet decides the game. A replay from a higher-scoring
  // engine must not be able to land in another cabinet's pot.
  const cab = await cabinetInfo(credit.cabinet);
  if (!cab) return { ok: false, code: 502, reason: "cabinet lookup failed" };
  // THE BOUNTY rotates: cabinet 2 plays the game of the week its coin went in.
  const jw = cab.isBounty && jackpot ? jackpot.weekAt(credit.insertedAt) : null;
  const wantGame = jw ? jw.game : cab.game;
  if (wantGame !== body.game) return { ok: false, code: 422, reason: `credit is for ${wantGame}, not ${body.game}` };
  let jst = null;
  if (jw) {
    jst = await jackpot.rate(jw);
    // 503 on purpose: the client keeps the run and retries until the owner opens the week
    if (!jst) return { ok: false, code: 503, reason: "THE BOUNTY is rotating to " + gameTitle(jw.game) + ". Your run is saved and lands as soon as the new week opens." };
  }
  // The chain's commitment is the truth: sha256(secret) must equal it.
  const commit = crypto.createHash("sha256").update(Buffer.from(body.secret, "hex")).digest();
  if (credit.commit && !commit.equals(credit.commit)) return { ok: false, code: 422, reason: "secret does not match on-chain commitment" };
  if (credit.salt !== String(body.salt).toLowerCase()) return { ok: false, code: 422, reason: "salt does not match the credit" };
  // THE BOUNTY's door: the door is the player of record; its seat says who really played and their status.
  let seat = null, doorP = null;
  if (cab.isBounty && JACKPOT_DOOR) {
    const viaDoor = sameAddr(credit.player, JACKPOT_DOOR);
    if (!viaDoor && credit.insertedAt >= JACKPOT_DOOR_FROM) return { ok: false, code: 422, reason: "Bounty coins go through the jackpot door; this one didn't" };
    if (viaDoor) {
      seat = await chain.doorSeat(JACKPOT_DOOR, commit.toString("hex"));
      if (!seat.player || /^0x0+$/.test(seat.player)) return { ok: false, code: 422, reason: "no jackpot door seat for this coin" };
      doorP = await doorParams();
    }
  }
  const realPlayer = seat ? seat.player : credit.player;
  // Per-wallet volume this period feeds the behavior analysis.
  { const w = realPlayer; const v = walletVolume.get(w); const dayNow = credit.day;
    const count = v && v.day === dayNow ? v.count + 1 : 1; walletVolume.set(w, { day: dayNow, count });
    let elapsedS = null; try { elapsedS = (await chain.now()) - credit.insertedAt; } catch (e) {}
    result.tas = analyzeInputs(result.masks || [], { volume: count, elapsedS }); }
  const replayHash = crypto.createHash("sha256").update(JSON.stringify({ game: body.game, seed: body.seed, inputsRLE: body.inputsRLE })).digest();
  const sub = { creditId, credit, player: credit.player, secret: body.secret, score: jst ? jackpot.toPoints(result.score, jst) : result.score, replayHash, flagged: !!result.tas.flagged };
  if (jst) jackpot.noteRaw(replayHash.toString("hex"), result.score);
  if (seat && jackpot) jackpot.notePlayer(replayHash.toString("hex"), realPlayer);
  const takeHome = (pool) => (seat ? doorPayout(doorP, seat.holder, pool) : pool);   // what this player gets from a pool
  const doorInfo = seat ? { door: { holder: seat.holder, cap: doorP.cap, nonHolderBps: doorP.nonHolderBps } } : {};
  const jInfo = jw ? { jackpot: { week: jw.from, game: jw.game, raw: result.score, points: sub.score, num: jst.num, den: jst.den } } : {};
  // Bounty cabinet: an unflagged record takes the whole pool. A flagged record
  // is held like any other flagged run — it goes on the board, nothing pays.
  let bountyNote;
  if (cab.isBounty) {
    const b = await chain.bounty(credit.cabinet);
    // bar = max(record, floor): the contract pays nothing below its floor, so
    // neither do we claim, announce, or tell the player they won.
    const bar = b.bar != null ? b.bar : b.record;
    const isRecord = sub.score > bar && !sub.flagged;   // points against the on-chain bar
    const prevRaw = jst ? jackpot.barRaw(jw, jst) : bar;   // the raw score the player sees they beat
    if (isRecord && !chain.bountyInSubmit) {
      const { txSig } = await chain.claimBounty(credit.cabinet, sub);
      announceBounty(realPlayer, result.score, prevRaw, b.pool, wantGame);
      return { ok: true, txSig, replayHash: replayHash.toString("hex"), player: realPlayer, bounty: { claimed: true, previousRecord: prevRaw, floor: 0, newRecord: result.score, paidLamports: b.pool } };
    }
    // JACKPOT HOLD: a record over a big pool waits for a human look at the
    // replay before it touches the chain. The contract only takes a score
    // within SUBMIT_WINDOW of the coin, so the hold has a hard deadline and a
    // default action (BOUNTY_HOLD_DEFAULT) if nobody decides in time.
    if (isRecord && chain.bountyInSubmit && b.pool >= HOLD_WEI && credit.insertedAt) {
      let evidence = null;
      if (reviewer.enabled()) {
        try { evidence = reviewer.buildEvidence({ Engine: GAMES[body.game], game: body.game, seed: body.seed, masks: result.masks || [], score: result.score, target: prevRaw, tas: result.tas, wallet: await walletFacts(realPlayer) }); }
        catch (e) { console.log("review: evidence failed " + e.message); }
      }
      const h = await openHold(credit, sub, result, b, { evidence, prevRaw, game: wantGame, weekFrom: jw ? jw.from : null, player: realPlayer,
        door: seat ? JACKPOT_DOOR : null, commit: commit.toString("hex"), holder: seat ? seat.holder : null, payout: takeHome(b.pool) });
      return { ok: true, held: true, holdId: h.id, deadline: h.deadline, replayHash: replayHash.toString("hex"), player: realPlayer, ...jInfo, ...doorInfo,
        bounty: { held: true, previousRecord: prevRaw, floor: 0, newRecord: result.score, poolLamports: b.pool, payoutLamports: takeHome(b.pool) } };
    }
    if (isRecord) announceBounty(realPlayer, result.score, prevRaw, takeHome(b.pool), wantGame);
    bountyNote = isRecord ? { claimed: true, previousRecord: prevRaw, floor: 0, newRecord: result.score, paidLamports: takeHome(b.pool), jackpotLamports: b.pool }
      : { claimed: false, record: prevRaw, floor: 0, bar: prevRaw, poolLamports: b.pool };
  }
  const { txSig, batched } = await chain.submit(credit.cabinet, sub);
  let doorSettle = null;
  if (seat && bountyNote && bountyNote.claimed) doorSettle = await settleDoorWin({ txSig, door: JACKPOT_DOOR, commit: commit.toString("hex") });
  if (jw && bountyNote && bountyNote.claimed) {   // the week's raw record moves only once the chain agrees
    try { const post = await chain.bounty(credit.cabinet); if (post.record === sub.score && sameAddr(post.champion, credit.player)) jackpot.noteWin(jw, result.score); } catch (e) {}
  }
  if (doorSettle && doorSettle.receivedWei && bountyNote) bountyNote.paidLamports = doorPayout(doorP, seat.holder, Number(doorSettle.receivedWei));   // exact, from the receipt
  return { ok: true, txSig, batched, replayHash: replayHash.toString("hex"), player: realPlayer, ...jInfo, ...doorInfo, ...(bountyNote ? { bounty: bountyNote } : {}) };
}
// ---------- jackpot hold ----------
const HOLD_WEI = Number(process.env.BOUNTY_HOLD_WEI || "100000000000000000");   // 0.1 ETH
const HOLD_DEFAULT = process.env.BOUNTY_HOLD_DEFAULT === "flag" ? "flag" : "pay";  // if nobody decides in time
const HOLD_SUBMIT_WINDOW_S = 1200;   // Quarters.SUBMIT_WINDOW
const HOLD_MARGIN_S = parseInt(process.env.BOUNTY_HOLD_MARGIN_S || "90", 10);   // decide this long before the window closes, so the tx lands
const HOLDS_DIR = process.env.HOLDS_DIR || path.join(RECEIPTS_DIR, "_holds");
const SITE_URL = process.env.SITE_URL || "https://quarters.fun";
const PUBLIC_URL = process.env.PUBLIC_URL || "https://quarters-rh-mainnet.fly.dev";
fs.mkdirSync(HOLDS_DIR, { recursive: true });
const holds = new Map(), holdTimers = new Map();
function saveHold(h) { holds.set(h.id, h); fs.writeFileSync(path.join(HOLDS_DIR, h.id + ".json"), JSON.stringify(h, null, 1)); }
function holdPublic(h) {
  return { id: h.id, status: h.status, score: h.score, deadline: h.deadline, previousRecord: h.prevRecord, floor: h.floor,
    poolWei: h.poolWei, paidWei: h.paidWei || 0, txSig: h.txSig || null, decidedBy: h.decidedBy || null,
    review: h.ai ? { verdict: h.ai.verdict, confidence: h.ai.confidence, reasons: h.ai.reasons, model: h.ai.model } : null };
}
async function openHold(credit, sub, result, b, extra = {}) {
  // The window is measured in CHAIN time; the timer runs on this server's
  // clock. Convert through the chain's current time so a skewed clock can't
  // push the default action past the window.
  let chainNow = Math.floor(Date.now() / 1000); try { chainNow = await chain.now(); } catch (e) {}
  const secsLeft = credit.insertedAt + HOLD_SUBMIT_WINDOW_S - HOLD_MARGIN_S - chainNow;
  const h = {
    id: crypto.randomBytes(8).toString("hex"), token: crypto.randomBytes(16).toString("hex"), status: "pending",
    createdAt: Date.now(), deadline: Math.floor(Date.now() / 1000) + secsLeft,   // unix seconds, server clock
    cab: credit.cabinet, creditId: sub.creditId, player: extra.player || credit.player, score: result.score,
    door: extra.door || null, commit: extra.commit || null, holder: extra.holder, payout: extra.payout,
    evidence: extra.evidence || null, ai: null, defaultAction: null, notified: false,
    prevRecord: extra.prevRaw != null ? extra.prevRaw : b.record, floor: extra.prevRaw != null ? 0 : (b.floor || 0), poolWei: b.pool, ticks: result.ticks,
    game: extra.game || "voidrocks", weekFrom: extra.weekFrom || null,
    tas: { flagged: !!result.tas.flagged, score: result.tas.score, signals: result.tas.signals },
    playsToday: (walletVolume.get(extra.player || credit.player) || {}).count || 0,
    sub: { player: sub.player, secret: sub.secret, score: sub.score, replayHash: sub.replayHash.toString("hex"), flagged: !!sub.flagged },
  };
  saveHold(h); scheduleHold(h);
  if (h.evidence && reviewer.enabled()) {   // Claude first; the owner hears about it only if needed (or if the review is slow)
    setTimeout(() => { const x = holds.get(h.id); if (x && x.status === "pending" && !x.notified) notifyHold(x); }, REVIEW_NOTIFY_AFTER_MS);
    runReview(h.id).catch((e) => { console.log(`hold ${h.id}: review crashed ${e.message}`); const x = holds.get(h.id); if (x && !x.notified) notifyHold(x); });
  } else notifyHold(h);
  console.log(`hold ${h.id}: bounty record ${h.score} by ${h.player} over ${h.poolWei} wei, decide by ${new Date(h.deadline * 1000).toISOString()} (default ${HOLD_DEFAULT})`);
  return h;
}
function scheduleHold(h) {
  clearTimeout(holdTimers.get(h.id));
  const ms = Math.max(0, h.deadline * 1000 - Date.now());
  // if nobody decides, the review's recommendation stands (bot → reject); without one, HOLD_DEFAULT
  holdTimers.set(h.id, setTimeout(() => { const x = holds.get(h.id) || h; decideHold(h.id, x.defaultAction || HOLD_DEFAULT, x.defaultAction ? "timeout (review's call)" : "timeout").catch((e) => console.log("hold timeout error " + e.message)); }, ms));
}
async function runReview(id) {
  const h0 = holds.get(id); if (!h0 || !h0.evidence) return;
  const v = await reviewer.review(h0.evidence);
  const h = holds.get(id); if (!h || h.status !== "pending") return;
  h.ai = v;
  if (v) {
    console.log(`hold ${id}: review says ${v.verdict} (${Math.round(v.confidence * 100)}%)`);
    if (v.verdict === "human" && v.confidence >= REVIEW_AUTO_MIN && !(h.tas && h.tas.flagged)) { saveHold(h); await decideHold(id, "pay", "review (human, " + Math.round(v.confidence * 100) + "%)"); return; }
    if (v.verdict === "bot") h.defaultAction = "flag";
  }
  saveHold(h); scheduleHold(h);
  if (!h.notified) notifyHold(h);
}
function notifyHold(h) {
  h.notified = true; try { saveHold(h); } catch (e) {}
  const topic = process.env.NTFY_TOPIC; if (!topic) { console.log(`hold ${h.id}: NTFY_TOPIC unset, no push`); return; }
  const mins = Math.max(0, Math.round((h.deadline * 1000 - Date.now()) / 60000));
  fetch("https://ntfy.sh/" + encodeURIComponent(topic), { method: "POST",
    headers: { Title: "JACKPOT REVIEW: " + h.score + " for " + chain.fmt(h.poolWei) + " ETH", Priority: "urgent", Tags: "rotating_light",
      Click: PUBLIC_URL + "/review/" + h.id + "?t=" + h.token },
    body: (h.ai ? "Claude: " + h.ai.verdict.toUpperCase() + " (" + Math.round(h.ai.confidence * 100) + "%). " + (h.ai.reasons[0] || "") + " " : h.evidence && reviewer.enabled() ? "Claude's review is still running. " : "") +
      "Beat " + Math.max(h.prevRecord, h.floor) + ". " + mins + " min to decide, then: " + (h.defaultAction || HOLD_DEFAULT).toUpperCase() + ". Tap to review." })
    .catch((e) => console.log(`hold ${h.id}: push failed ${e.message}`));
}
async function decideHold(id, action, by) {
  const h = holds.get(id); if (!h || h.status !== "pending") return h;
  clearTimeout(holdTimers.get(id)); holdTimers.delete(id);
  h.status = "submitting"; h.decidedBy = by; saveHold(h);
  const flagged = action === "flag" || h.sub.flagged;
  try {
    const pre = await chain.bounty(h.cab);
    const r = await chain.submit(h.cab, { player: h.sub.player, secret: h.sub.secret, score: h.sub.score, replayHash: Buffer.from(h.sub.replayHash, "hex"), flagged });
    h.txSig = r.txSig;
    if (!flagged) {
      const post = await chain.bounty(h.cab);
      const won = post.record === h.sub.score && String(post.champion).toLowerCase() === String(h.sub.player).toLowerCase();   // on-chain: points, and the door when it's a door seat
      h.paidWei = won ? pre.pool : 0;
      if (won && h.door) {   // the door pays the real winner by status; record what they actually took home
        const r = await settleDoorWin({ txSig: h.txSig, door: h.door, commit: h.commit });
        const p = await doorParams(); h.paidWei = doorPayout(p, h.holder, r && r.receivedWei ? Number(r.receivedWei) : pre.pool);
      }
      if (won && jackpot && h.weekFrom) jackpot.noteWin({ from: h.weekFrom }, h.score);
      if (won) announceBounty(h.player, h.score, h.prevRecord, pre.pool, h.game);
    }
    h.status = flagged ? "rejected" : "approved";
  } catch (e) { h.status = "failed"; h.error = String((e && e.message) || e).slice(0, 300); console.log(`hold ${id}: submit failed ${h.error}`); }
  h.decidedAt = Date.now(); saveHold(h);
  // the receipt's onchain block must say what actually happened, not "held"
  try { const rp = path.join(RECEIPTS_DIR, h.creditId + ".json"); const rc = JSON.parse(fs.readFileSync(rp, "utf8"));
    rc.onchain = { ...(rc.onchain || {}), hold: holdPublic(h), txSig: h.txSig || null }; fs.writeFileSync(rp, JSON.stringify(rc, null, 1)); } catch (e) {}
  console.log(`hold ${id}: ${h.status} by ${by}${h.txSig ? " tx " + h.txSig : ""}${h.paidWei ? " paid " + h.paidWei : ""}`);
  return h;
}
function restoreHolds() {
  for (const f of fs.readdirSync(HOLDS_DIR).filter((n) => n.endsWith(".json"))) {
    try { const h = JSON.parse(fs.readFileSync(path.join(HOLDS_DIR, f), "utf8")); holds.set(h.id, h);
      if (h.status === "pending") { scheduleHold(h); if (!h.notified) notifyHold(h); }   // a restart must not swallow an alert
      if (h.status === "submitting") console.log(`hold ${h.id}: was mid-submit at restart — check tx and credit ${h.creditId} by hand`);
    } catch (e) { console.log("hold restore: bad file " + f); }
  }
}
function tokenOk(h, t) { const a = Buffer.from(String(h.token)), b = Buffer.from(String(t || "")); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function reviewPage(h, t) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const watch = (sp) => SITE_URL + "/" + (h.game || "voidrocks") + ".html?watch=" + encodeURIComponent(h.creditId) + "&speed=" + sp;
  const open = h.status === "pending";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jackpot review</title>
<style>:root{color-scheme:dark}body{margin:0;background:#060708;color:#E9EDEF;font:15px/1.6 "IBM Plex Mono",Menlo,monospace;padding:20px 16px 40px}
.w{max-width:520px;margin:0 auto}h1{font:700 22px/1.2 system-ui,sans-serif;letter-spacing:.06em;color:#E3B54A;margin:0 0 4px}
.k{color:#8B949B;font-size:12px;letter-spacing:.14em}.big{font:800 44px/1 system-ui,sans-serif;color:#fff;margin:14px 0 2px;font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;border-bottom:1px solid #22262b;padding:9px 0;gap:12px}.row b{font-weight:500;text-align:right}
.clock{font:700 28px system-ui,sans-serif;color:#E3B54A;font-variant-numeric:tabular-nums}.flag{color:#E8402F}
a.w8,button{display:block;width:100%;box-sizing:border-box;text-align:center;padding:15px;border-radius:6px;font:600 15px system-ui,sans-serif;letter-spacing:.08em;margin-top:10px;cursor:pointer;text-decoration:none}
a.w8{border:1px solid #E3B54A;color:#E3B54A}.pay{background:#3DD8A8;color:#04110c;border:0}.no{background:transparent;color:#E8402F;border:1px solid #E8402F}
.st{margin-top:18px;padding:12px;border-radius:6px;background:#14171B}</style></head><body><div class="w">
<h1>JACKPOT REVIEW</h1><div class="k">THE BOUNTY · ${esc(gameTitle(h.game))} · HOLD ${esc(h.id)}</div>
<div class="big">${esc(h.score.toLocaleString("en-US"))}</div><div class="k">BEATS ${esc(Math.max(h.prevRecord, h.floor).toLocaleString("en-US"))} · POOL ${esc(chain.fmt(h.poolWei))} ETH</div>
${open ? `<div class="st"><div class="k">TIME TO DECIDE, THEN AUTO-${esc(HOLD_DEFAULT.toUpperCase())}</div><div class="clock" id="c">—</div></div>` : `<div class="st">Decided: <b>${esc(h.status.toUpperCase())}</b> by ${esc(h.decidedBy || "?")}${h.txSig ? `<br><span class="k">tx ${esc(h.txSig)}</span>` : ""}${h.error ? `<br><span class="flag">${esc(h.error)}</span>` : ""}</div>`}
<div class="row"><span>player</span><b>${esc(h.player.slice(0, 8))}…${esc(h.player.slice(-6))}</b></div>
<div class="row"><span>plays today (this wallet)</span><b>${esc(h.playsToday)}</b></div>
<div class="row"><span>run length</span><b>${esc(Math.round(h.ticks / 60))}s</b></div>
<div class="row"><span>bot-timing check</span><b class="${h.tas.flagged ? "flag" : ""}">${h.tas.flagged ? "FLAGGED" : "passed"} · score ${esc(h.tas.score)}</b></div>
${(h.tas.signals || []).length ? `<div class="row"><span>signals</span><b>${esc((h.tas.signals || []).join(", "))}</b></div>` : ""}
${h.ai ? `<div class="st"><div class="k">CLAUDE'S REVIEW · ${esc(h.ai.model || "")}</div><div class="clock" style="color:${h.ai.verdict === "human" ? "#3DD8A8" : h.ai.verdict === "bot" ? "#E8402F" : "#E3B54A"}">${esc(h.ai.verdict.toUpperCase())} · ${Math.round(h.ai.confidence * 100)}%</div><ul style="margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.5">${h.ai.reasons.map((r) => "<li>" + esc(r) + "</li>").join("")}</ul>${h.defaultAction ? `<div class="k" style="margin-top:8px">IF NOBODY DECIDES: ${esc(h.defaultAction === "flag" ? "REJECT" : "PAY")}</div>` : ""}</div>`
  : h.evidence && reviewer.enabled() && open ? `<div class="st"><div class="k">CLAUDE'S REVIEW</div>still running, refresh in a minute</div>` : ""}
${h.evidence && h.evidence.reactions && h.evidence.reactions.threats ? `<div class="row"><span>reaction to threats</span><b>median ${esc(h.evidence.reactions.median)} ticks · ${esc(Math.round(h.evidence.reactions.under6ticksShare * 100))}% under 100 ms · n=${esc(h.evidence.reactions.threats)}</b></div>` : ""}
<a class="w8" href="${esc(watch(8))}" target="_blank" rel="noopener">WATCH REPLAY · 8×</a>
<a class="w8" href="${esc(watch(16))}" target="_blank" rel="noopener">WATCH REPLAY · 16×</a>
${open ? `<form method="post" action="/review/${esc(h.id)}/approve?t=${esc(t)}"><button class="pay">APPROVE · PAY THE POOL</button></form>
<form method="post" action="/review/${esc(h.id)}/reject?t=${esc(t)}" onsubmit="return confirm('Reject? The run goes on the board flagged and the pool stays.')"><button class="no">REJECT · KEEP THE POOL</button></form>
<script>const d=${Number(h.deadline) * 1000},c=document.getElementById("c");(function t(){const s=Math.max(0,Math.round((d-Date.now())/1000));c.textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");if(s>0)setTimeout(t,1000);else setTimeout(()=>location.reload(),4000)})();</script>` : ""}
</div></body></html>`;
}

if (chain) restoreHolds();   // after the declarations above: pending holds get their deadline timers back

function announceBounty(player, score, prevRecord, pool, game) {
  if (!(pool > 0)) return;   // a record over an empty pool is not "took the whole pool: 0"
  try {
    const who = nameOf(player) || (player.slice(0, 4) + "…" + player.slice(-4));
    poster.queue("bounty", "bounty:" + score + ":" + Date.now(), "THE BOUNTY just fell.\n\n" + who + " scored " + score + " on " + gameTitle(game || "voidrocks") + ", beat the record of " + prevRecord + " and took the whole pool: " + chain.fmt(pool) + " " + chain.unit.symbol + ".\n\nNew record to beat: " + score + ". quarters.fun", null).catch(() => {});
  } catch (e) {}
}

// TAS heuristic v1: humans have messy inter-press timing. A long run whose
// input-edge gaps are overwhelmingly identical gets flagged for review —
// flagged runs still verify, but the flag rides the receipt and the on-chain
// path can hold payouts above a threshold on it.
// Behavior analysis v2. Every replay carries the player's input mask for every
// tick, so we can ask questions a bot answers differently from a person:
//   • regularity: are inter-press gaps machine-even? (modal share, CV of gaps)
//   • speed: how often are distinct decisions faster than a human can make them?
//   • warm-up: does play start at tick 0 (a bot) or after a human beat?
//   • hold shape: are key-hold durations quantized to a few exact values?
//   • volume: how many paid runs has this wallet submitted this period?
// Each signal is a soft score; a run is FLAGGED when enough of them agree.
// A flag never blocks a score — it holds the payout for review (clear_flag).
const walletVolume = new Map();   // wallet → { day, count }
// Bot-detection thresholds. The mechanism is public; the numbers production
// uses are not: TAS_* settings (Fly secrets) override these defaults, so the
// published values aren't the ones a bot would have to beat.
const TAS = {
  modal: parseFloat(process.env.TAS_MODAL || "0.9"), cv: parseFloat(process.env.TAS_CV || "0.12"), fast: parseFloat(process.env.TAS_FAST || "0.35"),
  quant: parseFloat(process.env.TAS_QUANT || "0.9"), warmup: parseInt(process.env.TAS_WARMUP || "3", 10), volume: parseInt(process.env.TAS_VOLUME || "60", 10),
  realtimeSlackS: parseInt(process.env.TAS_REALTIME_SLACK_S || "20", 10),
};
function analyzeInputs(masks, ctx = {}) {
  const gaps = [], holds = [];
  let prev = 0, lastEdge = -1, firstInput = -1, holdLen = 0, holdMask = 0;
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i] & 0xff;   // low byte: buttons (pointer games pack coords above)
    if (m && firstInput < 0) firstInput = i;
    const edges = m & ~prev;
    if (edges) { if (lastEdge >= 0) gaps.push(i - lastEdge); lastEdge = i; }
    if (m === holdMask) holdLen++; else { if (holdMask && holdLen > 0) holds.push(holdLen); holdMask = m; holdLen = 1; }
    prev = m;
  }
  const n = gaps.length;
  const f = { edges: n, firstInput, modalShare: 0, gapCv: 0, fastShare: 0, holdQuant: 0, volume: ctx.volume || 0 };
  const signals = [];
  if (n >= 30) {
    const counts = new Map(); for (const g of gaps) counts.set(g, (counts.get(g) || 0) + 1);
    f.modalShare = Math.max(...counts.values()) / n;
    const mean = gaps.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) * (g - mean), 0) / n);
    f.gapCv = mean > 0 ? sd / mean : 0;
    f.fastShare = gaps.filter((g) => g <= 2).length / n;          // ≤ 33 ms between distinct presses
    if (f.modalShare > TAS.modal) signals.push("metronome");            // one exact gap almost always
    else if (f.gapCv < TAS.cv) signals.push("too-regular");         // humans: CV ≈ 0.3–0.8
    if (f.fastShare > TAS.fast) signals.push("superhuman-speed");
    if (holds.length >= 30) {
      const hc = new Map(); for (const h of holds) hc.set(h, (hc.get(h) || 0) + 1);
      f.holdQuant = Math.max(...hc.values()) / holds.length;
      if (f.holdQuant > TAS.quant) signals.push("quantized-holds");
    }
    if (firstInput >= 0 && firstInput < TAS.warmup && masks.length > 600) signals.push("no-warmup");
  }
  if ((ctx.volume || 0) > TAS.volume) signals.push("volume");
  // a human plays in real time: a run can't arrive before its own length after the coin went in
  if (ctx.elapsedS != null && masks.length > 600 && ctx.elapsedS + TAS.realtimeSlackS < masks.length / 60) signals.push("faster-than-real-time");           // > 60 paid runs this period from one wallet
  // Score: strong signals count double. Flag at 2+ points, so one soft trait
  // alone (a fast player, a warm-up skip) never flags a person.
  const weight = { metronome: 2, "too-regular": 1, "superhuman-speed": 1, "quantized-holds": 1, "no-warmup": 1, volume: 2, "faster-than-real-time": 2 };
  const score = signals.reduce((a, s) => a + (weight[s] || 1), 0);
  return { flagged: score >= 2, score, signals, features: f, edgeGaps: n, modalShare: Math.round(f.modalShare * 100) / 100 };
}
function tasFlags(masks) { return analyzeInputs(masks); }

function verifyRun(body) {
  const { creditId, game, seed, seedCommit, inputsRLE, claimedScore, claimedHash } = body;
  if (typeof creditId !== "string" || !/^[A-Za-z0-9_-]{1,66}$/.test(creditId)) {
    return { ok: false, reason: "bad creditId" };
  }
  const Engine = GAMES[game];
  if (!Engine) return { ok: false, reason: "unknown game" };
  if (!Array.isArray(inputsRLE) || inputsRLE.length > 400_000 || inputsRLE.length % 2 !== 0) {
    return { ok: false, reason: "bad input log" };
  }
  // Validate the RLE before expanding it: a two-element body could otherwise
  // ask for a 500 MB array. Masks are non-negative ints (pointer games pack
  // mouse coords in), run lengths are 1..MAX_TICKS, total ticks bounded.
  const MAXT = Engine.MAX_TICKS + 1000;
  let total = 0;
  for (let i = 0; i < inputsRLE.length; i += 2) {
    const m = inputsRLE[i], n = inputsRLE[i + 1];
    if (!Number.isInteger(m) || m < 0 || m > 0x3fffffff) return { ok: false, reason: "bad input mask" };
    if (!Number.isInteger(n) || n < 1 || n > MAXT) return { ok: false, reason: "bad run length" };
    total += n;
    if (total > MAXT) return { ok: false, reason: "log too long" };
  }

  // The run's secret (32 bytes, hex) proves ownership of the credit: its
  // sha256 is the on-chain commitment, and the engine seed is the first four
  // bytes of that commitment. Nobody else can submit a run for this credit.
  const secret = body.secret;
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/i.test(secret)) return { ok: false, reason: "bad secret" };
  const commitBuf = crypto.createHash("sha256").update(Buffer.from(secret, "hex")).digest();
  // v4: the seed also mixes the credit's on-chain salt (verified against the
  // chain in chainSubmit); the client sends it so the replay is self-contained.
  const salt = body.salt;
  if (typeof salt !== "string" || !/^[0-9a-f]{16}$/i.test(salt)) return { ok: false, reason: "bad salt" };
  const derivedSeed = crypto.createHash("sha256").update(Buffer.concat([commitBuf, Buffer.from(salt, "hex")])).digest().readInt32LE(0);
  if ((seed | 0) !== derivedSeed) return { ok: false, reason: "seed does not derive from secret+salt" };
  const commit = commitBuf.toString("hex");

  const masks = Engine.decodeRLE(inputsRLE);
  var _masksForAnalysis = masks;
  if (masks.length > Engine.MAX_TICKS + 1000) return { ok: false, reason: "log too long" };
  const t0 = process.hrtime.bigint();
  const result = Engine.runHeadless(seed | 0, masks);
  const verifyMs = Number(process.hrtime.bigint() - t0) / 1e6;

  if (result.gameOver !== 1) return { ok: false, reason: "run did not end" };
  if (result.score !== claimedScore) {
    return { ok: false, reason: `score mismatch: computed ${result.score}` };
  }
  if (result.hash !== (claimedHash >>> 0)) {
    return { ok: false, reason: `hash mismatch: computed ${result.hash}` };
  }

  const tas = tasFlags(masks);
  return { ok: true, masks, score: result.score, hash: result.hash, ticks: result.ticks, verifyMs, tas, seedCommitHex: commit };
}

function signVerdict(v) {
  const payload = Buffer.from(JSON.stringify(v));
  const sig = crypto.sign(null, payload, KEYS.privateKey);
  return { payload: payload.toString("base64"), signature: sig.toString("base64") };
}

const server = http.createServer((req, res) => {
  let send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    });
    return res.end();
  }

  // Post drafts/log (public, no secrets): what the bot composed and whether it went out.
  if (req.method === "GET" && req.url === "/posts") return send(200, { dryRun: poster.dryRun, configured: poster.configured, maxPerDay: poster.max, posts: poster.list().slice(0, 30) });
  if (req.method === "GET" && /^\/posts\/[a-f0-9]{12}\.png$/.test(req.url)) {
    const f = path.join(poster.dir, req.url.slice(7)); if (!fs.existsSync(f)) return send(404, { error: "no card" });
    res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }); return res.end(fs.readFileSync(f));
  }
  // Admin: send a draft now, or compose a test post. ADMIN_TOKEN must match.
  if (req.method === "POST" && /^\/posts\/(test|[a-f0-9]{12})\/send$/.test(req.url)) {
    const at = Buffer.from(String(req.headers["x-admin-token"] || "")), want = Buffer.from(String(process.env.ADMIN_TOKEN || ""));
    if (!want.length || at.length !== want.length || !crypto.timingSafeEqual(at, want)) return send(401, { error: "admin token" });   // constant-time
    const id = req.url.split("/")[2];
    (async () => {
      if (id === "test") { const rec = await poster.queue("test", "test:" + Date.now(), "QUARTERS results bot online · " + new Date().toISOString().slice(0, 16) + "Z", null); return send(200, rec); }
      return send(200, (await poster.send(id)) || { error: "no such draft" });
    })().catch((e) => send(500, { error: String(e).slice(0, 200) }));
    return;
  }
  // Buyback receipts (public): every sponsored-cabinet buyback with its transactions.
  if (req.method === "POST" && /^\/review-selftest\/[A-Za-z0-9_-]{1,66}$/.test(req.url)) {
    const at = Buffer.from(String(req.headers["x-admin-token"] || "")), want = Buffer.from(String(process.env.ADMIN_TOKEN || ""));
    if (!want.length || at.length !== want.length || !crypto.timingSafeEqual(at, want)) return send(401, { error: "admin token" });
    (async () => {
      const id = req.url.split("/")[2], rp = path.join(RECEIPTS_DIR, id + ".json");
      if (!fs.existsSync(rp)) return send(404, { error: "no such receipt" });
      const rc = JSON.parse(fs.readFileSync(rp, "utf8")), Engine = GAMES[rc.game];
      if (!Engine) return send(422, { error: "unknown game" });
      const player = (rc.onchain && rc.onchain.player) || "0x0000000000000000000000000000000000000000";
      const evidence = reviewer.buildEvidence({ Engine, game: rc.game, seed: rc.seed, masks: Engine.decodeRLE(rc.inputsRLE), score: rc.verdict.score, target: null,
        tas: { flagged: rc.verdict.tasFlagged, signals: (rc.verdict.analysis || {}).signals || [], features: (rc.verdict.analysis || {}).features || {} }, wallet: await walletFacts(player) });
      const t0 = Date.now(), verdict = await reviewer.review(evidence);
      send(200, { enabled: reviewer.enabled(), model: reviewer.MODEL, ms: Date.now() - t0, verdict, evidence });
    })().catch((e) => send(500, { error: String(e.message || e).slice(0, 200) }));
    return;
  }
  if (req.method === "GET" && req.url === "/buybacks") return send(200, { buybacks: buybacks.slice(-100).reverse() });
  // Launch config the site reads at runtime (one source of truth: Fly env).
  if (req.method === "GET" && req.url === "/config") {
    return send(200, { liveCabinets: LIVE_CABS, houseAddLamports: HOUSE_ADD, network: process.env.QR_NETWORK || "devnet", chain: chain ? { kind: chain.kind, unit: chain.unit, contract: chain.contract } : null });
  }
  // The number on the wall: lamports paid to players by settled pots, plus run count.
  if (req.method === "GET" && req.url === "/stats") {
    if (!readCache.stats || Date.now() - readCache.stats.at > 60000) {
      let runs = 0; try { runs = fs.readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith(".json") && f.length > 40).length; } catch (e) {}
      readCache.stats = { at: Date.now(), runs };
    }
    return send(200, Object.assign({}, stats, { runs: readCache.stats.runs, liveCabinets: LIVE_CABS.length || 31 }));
  }
  if (req.method === "GET" && req.url.startsWith("/names?")) {
    const ws = (new URL(req.url, "http://x").searchParams.get("w") || "").split(",").slice(0, 50);
    const out = {}; for (const w of ws) if (names[w]) out[w] = names[w].name;
    return send(200, out);
  }
  // Claim a display name: the wallet signs "QUARTERS name: <name>" (Phantom signMessage).
  // 3–16 chars [A-Za-z0-9_], unique case-insensitively, one change per wallet per hour.
  if (req.method === "POST" && req.url === "/name") {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
    req.on("end", () => {
      try {
        const b = JSON.parse(raw || "{}"); const name = String(b.name || "").trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return send(422, { error: "name must be 3–16 letters, digits or _" });
        // no names that could pass for staff or the project
        if (/quarter|qtrs|official|admin|support|staff|verif|based|proof|mod$|^mod|team|dev$|^dev|jackpot|bounty/i.test(name)) return send(422, { error: "that name is reserved" });
        const msg = "QUARTERS name: " + name;
        if (b.message !== msg) return send(422, { error: "bad message" });
        let w = String(b.wallet || "");
        (async () => {
          let ok = false;
          if (/^0x[0-9a-fA-F]{40}$/.test(w)) {
            // EVM: EIP-191 personal_sign, signature as 0x hex
            const { verifyMessage, getAddress } = require("viem");
            try { ok = await verifyMessage({ address: getAddress(w), message: msg, signature: String(b.signature || "") }); w = getAddress(w); } catch (e) { ok = false; }
          } else {
            const { PublicKey } = require("@coral-xyz/anchor").web3;
            let pk; try { pk = new PublicKey(w); } catch (e) { return send(422, { error: "bad wallet" }); }
            const sig = Buffer.from(String(b.signature || ""), "base64");
            const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk.toBytes())]);
            ok = sig.length === 64 && crypto.verify(null, Buffer.from(msg, "utf8"), { key: spki, format: "der", type: "spki" }, sig);
            w = pk.toBase58();
          }
          if (!ok) return send(401, { error: "signature does not match wallet" });
          const lower = name.toLowerCase();
        for (const [ow, v] of Object.entries(names)) if (ow !== w && v.name.toLowerCase() === lower) return send(409, { error: "that name is taken" });
        if (names[w] && Date.now() - names[w].at < 3600000 && names[w].name !== name) return send(429, { error: "one name change per hour" });
          names[w] = { name, at: Date.now() }; saveJson("names.json", names);
          return send(200, { ok: true, wallet: w, name });
        })().catch((e) => send(400, { error: String(e).slice(0, 120) }));
      } catch (e) { return send(400, { error: String(e).slice(0, 120) }); }
    });
    return;
  }
  // Current pot standings + bounty for a cabinet, straight off the chain.
  // THE BOUNTY this week: game, raw score to beat, pool, rotation time, the next week if published.
  if (req.method === "GET" && req.url === "/jackpot") {
    if (!jackpot) return send(404, { error: "no rotation on this arcade" });
    (async () => {
      const j = await jackpot.publicState(Math.floor(Date.now() / 1000)); if (!j) return send(404, { error: "no week scheduled" });
      const b = await chain.bounty(2);
      const view = await bountyView(b);
      send(200, { ...j, title: gameTitle(j.game), poolLamports: b.pool, recordPoints: b.record, unit: chain.unit, door: view.door || null, schedule: jackpot.schedule().map((w) => ({ from: w.from, game: w.game, target: w.target })) });
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }
  if (req.method === "GET" && req.url === "/leaderboards") {
    if (!chain) return send(503, { error: "chain mode off" });
    if (readCache.lb && Date.now() - readCache.lb.at < 8000) return send(200, readCache.lb.body);
    (async () => {
      const cfg = await chain.config(); const period = cfg.periodSeconds;
      const day = Math.floor((await chain.now()) / period);
      const CABS = Array.from({ length: 31 }, (_, i) => i + 1).filter(isLive);
      const boards = [];
      // Every live cabinet that exists on this arcade gets a board, played today
      // or not: an empty table is an open seat, not a missing machine.
      await Promise.all(CABS.map(async (cab) => {
        let info = null; try { info = await cabinetInfo(cab); } catch (e) {}
        if (!info) return;
        let pot = null; try { pot = await chain.pot(cab, day); } catch (e) { /* no pot yet */ }
        const entries = pot ? pot.entries.map((e) => { const pl = shownPlayer(cab, e); return { player: pl, name: nameOf(pl), score: shownScore(cab, e), flagged: e.flagged }; }).sort((a, b) => b.score - a.score) : [];
        const ha = houseAdds[chain.potId(cab, day)];
        const board = { cabinetId: cab, game: info.game, priceLamports: info.price || cfg.quarter || 0, potLamports: pot ? pot.balance : 0, poolLamports: pot ? pot.pool : 0,
          houseAdd: ha ? ha.lamports : 0, count: entries.length, top: entries.slice(0, 10) };
        if (info.isBounty) {
          try { board.bounty = await bountyView(await chain.bounty(cab)); if (board.bounty.game) board.game = board.bounty.game; } catch (e) {}
          try { const wk = await weekEntries(cab); if (wk) { board.top = wk.slice(0, 10); board.count = wk.length; board.scope = "week"; } } catch (e) {}
        }
        boards.push(board);
      }));
      boards.sort((a, b) => b.poolLamports - a.poolLamports || b.count - a.count || a.cabinetId - b.cabinetId);
      // pots settle once the period is over (plus the contract's grace window)
      readCache.lb = { at: Date.now(), body: { day, periodSeconds: period, unit: chain.unit, payoutAt: (day + 1) * period, boards } };
      send(200, readCache.lb.body);
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }

  if (req.method === "GET" && /^\/leaderboard\/\d{1,3}$/.test(req.url)) {
    if (!chain) return send(503, { error: "chain mode off" });
    const cabId = parseInt(req.url.split("/")[2], 10);
    (async () => {
      const cfg = await chain.config(); const period = cfg.periodSeconds;
      const day = Math.floor((await chain.now()) / period);
      let entries = [], potLamports = 0, poolLamports = 0, houseAdd = 0;
      try {
        const pot = await chain.pot(cabId, day);
        if (pot) {
          entries = pot.entries.map((e) => { const pl = shownPlayer(cabId, e); return { player: pl, name: nameOf(pl), score: shownScore(cabId, e), replayHash: e.replayHash, flagged: e.flagged }; });
          potLamports = pot.balance; poolLamports = pot.pool;
          const ha = houseAdds[chain.potId(cabId, day)]; houseAdd = ha ? ha.lamports : 0;
        }
      } catch (e) { /* no pot yet this period */ }
      let bounty = null;
      try {
        const cab = await cabinetInfo(cabId);
        if (cab && cab.isBounty) {
          bounty = await bountyView(await chain.bounty(cabId));
          const wk = await weekEntries(cabId); if (wk) { entries = wk.slice(0, 10); bounty.scope = "week"; }
        }
      } catch (e) { /* no bounty */ }
      if (bounty && bounty.champion) bounty.championName = nameOf(bounty.champion);
      let sponsor = null; if (chain.kind === "evm") { try { const sp = await chain.sponsor(cabId); if (sp) sponsor = { token: sp.token, buybackBps: sp.buybackBps, accruedWei: await chain.buybackAccrued(cabId), lastBuyback: buybacks.filter((b) => b.cab === cabId).slice(-1)[0] || null }; } catch (e) {} }
      send(200, { cabinetId: cabId, day, periodSeconds: period, live: isLive(cabId), unit: chain.unit, entries, potLamports, poolLamports, houseAdd, bounty, sponsor });
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }

  // Player profile: current-period standings across every cabinet, plus
  // their public receipts. The wallet IS the account.
  if (req.method === "GET" && /^\/player\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(req.url)) {
    if (!chain) return send(503, { error: "chain mode off" });
    const pubkey = req.url.split("/")[2];
    (async () => {
      const cfg = await chain.config(); const period = cfg.periodSeconds;
      const day = Math.floor((await chain.now()) / period);
      const CABS = Array.from({ length: 31 }, (_, i) => i + 1);
      const standings = [];
      const pots = await Promise.all(CABS.map(async (cab) => { try { const p = await chain.pot(cab, day); return p ? [cab, p] : null; } catch (e) { return null; } }));
      for (const entry of pots) {
        if (!entry) continue;
        const [cab, pot] = entry;
        const sorted = pot.entries.map((e) => ({ player: shownPlayer(cab, e), score: shownScore(cab, e) })).sort((a, b) => b.score - a.score);
        sorted.forEach((e, rank) => { if (sameAddr(e.player, pubkey)) standings.push({ cabinetId: cab, rank: rank + 1, score: e.score, of: sorted.length }); });
      }
      // Receipts: newest 200 files, matched by player.
      const receipts = [];
      try {
        const files = fs.readdirSync(RECEIPTS_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => ({ f, t: fs.statSync(path.join(RECEIPTS_DIR, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
          .slice(0, 200);
        for (const { f } of files) {
          try {
            const r = JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, f)));
            if (r.onchain && sameAddr(r.onchain.player, pubkey)) {
              receipts.push({
                creditId: r.creditId, game: r.game, score: r.verdict.score,
                ticks: r.verdict.ticks, tasFlagged: r.verdict.tasFlagged,
                verifiedAt: r.verdict.verifiedAt, replay: `/replays/${r.creditId}.json`,
              });
            }
          } catch (e) { /* skip bad file */ }
        }
      } catch (e) { /* no receipts dir yet */ }
      send(200, { player: pubkey, name: nameOf(pubkey), day, periodSeconds: period, standings, receipts });
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }

  // Liveness for the platform's router: 200 whenever the process can answer.
  // /health carries the money sensors and may return 503 (red) — never point
  // a router's health check at it, or a red sensor takes the service offline.
  if (req.method === "GET" && req.url === "/live") return send(200, { ok: true, uptimeS: Math.round((Date.now() - STARTED_AT) / 1000) });

  if (req.method === "GET" && req.url === "/health") {
    // Sensors: each green/yellow/red; overall = worst; 503 on red so any dumb
    // monitor can page on status code alone.
    const sensors = {};
    const POT_RENT = 4399280, CABS = LIVE_CABS.length || 31;   // v5 DailyPot rent; live cabinets only
    if (chain) {
      const ident = healthCache.arcade ? (sameAddr(healthCache.arcade.verifier, chain.signer) ? "green" : "red") : "yellow";
      sensors.verifierIdentity = { status: ident, detail: healthCache.arcade ? `arcade.verifier ${healthCache.arcade.verifier.slice(0, 8)} vs signer ${chain.signer.slice(0, 8)}` : "not read yet" };
      // per-period signer burn: Solana = pot rent per live cabinet; EVM = a gas allowance per live cabinet (settles + batched submits)
      // What one cabinet actually costs the house per period: its fixed legs (one settle
      // + one house-add ≈ 300k gas) priced at the LIVE gas price, plus the house add itself.
      // A flat wei constant was pessimistic by ~100x whenever gas was cheap.
      const perCab = chain.kind === "evm"
        ? (process.env.EVM_GAS_BUDGET_WEI_PER_CAB
            ? parseInt(process.env.EVM_GAS_BUDGET_WEI_PER_CAB, 10)
            : Math.round(300000 * ((healthCache.gas && healthCache.gas.gwei) || 0.05) * 1e9))
        : POT_RENT;
      const periods = keyBal.lamports === null ? null : keyBal.lamports / ((perCab + HOUSE_ADD) * CABS);
      sensors.signerRunway = { status: periods === null ? "yellow" : periods < 1 ? "red" : periods < 2 ? "yellow" : "green", detail: periods === null ? "unknown" : `${periods.toFixed(2)} periods of ${chain.kind === "evm" ? "gas budget" : "pot rent"} (${chain.fmt(keyBal.lamports)} ${chain.unit.symbol}${HOUSE_ADD ? ", incl. house adds" : ""})` };
      if (chain.kind === "evm" && healthCache.gas) {
        // does the gas leg on one quarter cover the house's gas for that play? (batched submit ≈ 70k + settle/house-add amortised ≈ 30k)
        const g = healthCache.gas; const spendPerPlay = 100000 * g.gwei * 1e9, incomePerPlay = g.quarter * g.gasBps / 10000;
        const cov = spendPerPlay > 0 ? incomePerPlay / spendPerPlay : Infinity;
        sensors.gasCoverage = { status: cov >= 2 ? "green" : cov >= 1 ? "yellow" : "red", detail: `gas leg ${g.gasBps} bps = ${chain.fmt(incomePerPlay)} per play vs ≈${chain.fmt(spendPerPlay)} gas at ${g.gwei.toFixed(3)} gwei (${cov === Infinity ? "∞" : cov.toFixed(1)}×)` };
      }
      if (settle.enabled) {
        const up = Date.now() - STARTED_AT, age = settle.lastOk ? Date.now() - settle.lastOk : up;
        const every = Math.max(60, parseInt(process.env.SETTLE_INTERVAL_S || "300", 10)) * 1000;
        sensors.sweepFreshness = { status: up < 2 * every ? "green" : age < 2 * every ? "green" : age < 6 * every ? "yellow" : "red", detail: `last ok ${Math.round(age / 1000)}s ago` };
        sensors.sweepErrors = { status: settle.lastSweepErrors > 0 ? "yellow" : "green", detail: settle.lastSweepErrors > 0 ? (settle.lastError || settle.lastOpenError || "") : "clean" };
        sensors.stalePots = { status: settle.pending > 3 ? "red" : settle.pending > 0 ? "yellow" : "green", detail: `${settle.pending} unsettled past grace` };
      }
        if (JACKPOT_DOOR) {   // a door win that hasn't reached its winner is money owed right now
          const stuck = doorSettles.filter((j) => Date.now() - (j.since || Date.now()) > 10 * 60000);
          sensors.doorSettles = { status: stuck.length ? "red" : doorSettles.length ? "yellow" : "green",
            detail: doorSettles.length ? `${doorSettles.length} door win(s) waiting to settle: ${doorSettles.map((j) => j.lastError || "").join("; ").slice(0, 120)}` : "every door win settled" };
        }
        if (jackpot) {
          try {
            const nowS = Math.floor(Date.now() / 1000), j = jackpotPublic;   // refreshed every minute below
            if (j) {
              const age = nowS - Math.floor(Date.parse(j.from) / 1000);
              // paused = the owner hasn't raised bountyFloor(2) to the new week's target yet; paid Bounty runs wait
              sensors.jackpot = j.paused ? { status: age < 1800 ? "yellow" : "red", detail: `rotation to ${gameTitle(j.game)} pending: raise bountyFloor(2) to ${j.target}` }
                : !j.next && age > 6 * 86400 ? { status: "yellow", detail: `${gameTitle(j.game)} week, day ${Math.floor(age / 86400) + 1}: publish next week's game` }
                : { status: "green", detail: `${gameTitle(j.game)} · beat ${j.barRaw}${j.next ? " · then " + gameTitle(j.next.game) + " from " + j.next.from.slice(0, 10) : ""}` };
            }
          } catch (e) { sensors.jackpot = { status: "yellow", detail: "rotation state unreadable: " + String(e.message || e).slice(0, 80) }; }
        }
    }
    const rank = { green: 0, yellow: 1, red: 2 };
    const overall = Object.values(sensors).reduce((w, x) => (rank[x.status] > rank[w] ? x.status : w), "green");
    return send(overall === "red" ? 503 : 200, {
      ok: overall !== "red",
      status: overall,
      sensors,
      uptimeS: Math.round((Date.now() - STARTED_AT) / 1000),
      settle: settle.enabled ? { lastRun: settle.lastRun, lastOk: settle.lastOk, settled: settle.settled, opened: settle.opened || 0, pending: settle.pending, errors: settle.errors, lastSweepErrors: settle.lastSweepErrors, lastError: settle.lastError, lastOpenError: settle.lastOpenError } : "off",
      signer: chain ? { pubkey: chain.signer, lamports: keyBal.lamports, at: keyBal.at } : null,
      games: Object.keys(GAMES).length,
      engines: ENGINE_HASH,
      verifierPubkey: KEYS.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    });
  }

  if (req.method === "GET" && req.url.startsWith("/replays/")) {
    const name = req.url.slice("/replays/".length);
    if (!/^[A-Za-z0-9_-]{1,66}\.json$/.test(name)) return send(400, { error: "bad name" });   // EVM credit ids are 0x + 64 hex = 66
    const p = path.join(RECEIPTS_DIR, name);
    if (!fs.existsSync(p)) return send(404, { error: "no such receipt" });
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(fs.readFileSync(p));
  }

  // Jackpot hold: public status for the waiting player; review + decide behind the per-hold token.
  { const m = req.url.match(/^\/hold\/([0-9a-f]{16})$/);
    if (req.method === "GET" && m) { const h = holds.get(m[1]); return h ? send(200, holdPublic(h)) : send(404, { error: "no such hold" }); } }
  { const m = req.url.match(/^\/review\/([0-9a-f]{16})(\/(approve|reject))?\?t=([0-9a-f]{1,64})$/);
    if (m) {
      const h = holds.get(m[1]);
      if (!h || !tokenOk(h, m[4])) return send(404, { error: "no such review" });
      if (req.method === "GET" && !m[3]) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(reviewPage(h, m[4])); }
      if (req.method === "POST" && m[3]) {
        decideHold(h.id, m[3] === "approve" ? "pay" : "flag", "human")
          .then(() => { res.writeHead(303, { location: "/review/" + h.id + "?t=" + m[4] }); res.end(); })
          .catch((e) => send(500, { error: String(e.message || e) }));
        return;
      }
    } }
  if (req.method === "POST" && req.url === "/submit") {
    // Abuse limits: a full 10-minute run RLE-encodes to a few KB, so 1 MB is
    // generous; 30 submits/minute/IP is far above any human; one in-flight
    // verification per credit so two racing submits can't double-hit the chain.
    // Fly sets fly-client-ip; never trust a client-supplied x-forwarded-for.
    // Behind Fly, fly-client-ip is authoritative. Anywhere else, only the
    // socket address counts — x-forwarded-for is attacker-controlled text.
    const ip = (req.headers["fly-client-ip"] || req.socket.remoteAddress || "?").toString();
    const now = Date.now();
    const hits = (submitHits.get(ip) || []).filter((t) => now - t < 60_000);
    if (hits.length >= 30) return send(429, { verified: false, reason: "too many submits; slow down" });
    hits.push(now); submitHits.set(ip, hits);
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) { send(413, { verified: false, reason: "body too large" }); req.destroy(); }
    });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return send(400, { error: "bad json" }); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return send(400, { error: "bad body" });
      if (typeof parsed.creditId !== "string" || !/^[A-Za-z0-9_-]{1,66}$/.test(parsed.creditId)) return send(422, { verified: false, reason: "bad creditId" });
      if (inFlight.has(parsed.creditId)) return send(409, { verified: false, reason: "that credit is already being verified" });
      inFlight.add(parsed.creditId);
      const _send = send; send = (code, obj) => { inFlight.delete(parsed.creditId); return _send(code, obj); };
      try {
      const result = verifyRun(parsed);
      if (!result.ok) return send(422, { verified: false, reason: result.reason });

      const finish = (onchain) => {
      const verdict = {
        creditId: parsed.creditId,
        game: parsed.game,
        score: result.score,
        replayHash: result.hash,
        ticks: result.ticks,
        tasFlagged: result.tas.flagged,
        analysis: { score: result.tas.score, signals: result.tas.signals, features: result.tas.features },
        verifiedAt: Date.now(),
        engineHash: ENGINE_HASH[parsed.game],
      };
      // The receipt: everything anyone needs to re-run the verification.
      fs.writeFileSync(
        path.join(RECEIPTS_DIR, `${parsed.creditId}.json`),
        JSON.stringify({ creditId: parsed.creditId, game: parsed.game, seed: parsed.seed, secret: parsed.secret, salt: parsed.salt, inputsRLE: parsed.inputsRLE,
          claimedScore: parsed.claimedScore, claimedHash: parsed.claimedHash, engineHash: ENGINE_HASH[parsed.game], verdict, onchain }, null, 1)
      );
      return send(200, { verified: true, verdict, onchain, signed: signVerdict(verdict), tas: result.tas });
      };

      if (chain) {
        chainSubmit(parsed.creditId, parsed, result)
          .then((oc) => {
            if (!oc.ok) return send(oc.code, { verified: false, reason: oc.reason });
            finish(oc);
          })
          .catch((e) => {
            const m = String(e);
            const definitive = /SubmitWindow|PotSettled|CreditConsumed|WrongDay|RecordStands/.test(m);
            send(definitive ? 422 : 502, { verified: false, reason: (definitive ? "run cannot be scored: " : "chain submit failed: ") + m.slice(0, 200) });
          });
      } else {
        finish(null);
      }
      } catch (e) {
        console.log("submit handler error: " + String(e).slice(0, 200));
        return send(500, { verified: false, reason: "verifier error" });
      }
    });
    return;
  }

  send(404, { error: "not found" });
});

const PORT = process.env.PORT || 8791;
if (require.main === module) {
  server.on("error", (e) => { console.error("listen failed: " + e.message + " — exiting so no port-less daemon keeps running"); process.exit(1); });
server.listen(PORT, () => console.log(`quarters verifier on :${PORT}, receipts in ${RECEIPTS_DIR}`));
}
module.exports = { server, verifyRun, tasFlags };
