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
setInterval(async () => { if (!chain) return; try { keyBal.lamports = await chain.conn.getBalance(chain.kp.publicKey); keyBal.at = Date.now(); } catch (e) {} }, 60_000).unref();
setTimeout(async () => { if (!chain) return; try { keyBal.lamports = await chain.conn.getBalance(chain.kp.publicKey); keyBal.at = Date.now(); } catch (e) {} }, 3000);
const submitHits = new Map();   // ip → [timestamps]
setInterval(() => { const now = Date.now(); for (const [k, v] of submitHits) { const keep = v.filter((t) => now - t < 60_000); if (keep.length) submitHits.set(k, keep); else submitHits.delete(k); } }, 60_000).unref();
const inFlight = new Set();     // creditIds being verified right now

const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(__dirname, "receipts");
const KEY_FILE = process.env.VERIFIER_KEY_FILE || path.join(__dirname, "verifier-key.json");
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
if (process.env.DEVNET_SUBMIT === "1") {
  const anchor = require("@coral-xyz/anchor");
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../idl/quarters.json")));
  // Hosted deploys pass the keypair via env; local runs use the file.
  const kp = anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(
      process.env.VERIFIER_SOLANA_KEY
        ? JSON.parse(process.env.VERIFIER_SOLANA_KEY)
        : JSON.parse(fs.readFileSync(path.join(__dirname, "verifier-solana-devnet.json")))
    )
  );
  const conn = new anchor.web3.Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  const PID = program.programId;
  const potPda = (cabId, day) => {
    const d = Buffer.alloc(4);
    d.writeUInt32LE(day);
    return anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("pot"), Buffer.from([cabId]), d], PID)[0];
  };
  const arcadePda = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("arcade")], PID)[0];
  const cabinetPda = (id) => anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("cabinet"), Buffer.from([id])], PID)[0];
  chain = { anchor, program, kp, conn, potPda, arcadePda, cabinetPda, cabinetGame: new Map() };
  console.log("devnet submit mode: verifier", kp.publicKey.toBase58(), "program", PID.toBase58());
}

// ---- settle daemon: pay every finished pot, permissionlessly, on a timer ----
// Scans cabinets 1..MAX_CAB for the last SETTLE_LOOKBACK periods; any pot that
// exists, is unsettled, and whose period is over gets settle_pot with the
// stored entries as remaining accounts. Idempotent: settled pots are skipped,
// and the program rejects double-settles anyway.
const settle = { enabled: process.env.SETTLE === "1", lastRun: null, lastOk: null, settled: 0, errors: 0, lastError: null, pending: 0 };
async function settleSweep() {
  if (!chain) return;
  const { anchor, program, kp, conn, potPda, arcadePda } = chain;
  const MAX_CAB = 31, LOOKBACK = parseInt(process.env.SETTLE_LOOKBACK || "7", 10);
  settle.lastRun = Date.now();
  try {
    const arcade = await program.account.arcade.fetch(arcadePda);
    const period = arcade.periodSeconds.toNumber ? arcade.periodSeconds.toNumber() : Number(arcade.periodSeconds);
    const nowDay = Math.floor(Date.now() / 1000 / period);
    let pending = 0;
    for (let cab = 1; cab <= MAX_CAB; cab++) {
      for (let day = nowDay - LOOKBACK; day < nowDay; day++) {
        const pk = potPda(cab, day);
        let pot;
        try { pot = await program.account.dailyPot.fetch(pk); } catch (e) { continue; }
        if (!pot.initialized || pot.settled) continue;
        pending++;
        const winners = pot.entries.slice(0, pot.count).map((e) => ({ pubkey: e.player, isWritable: true, isSigner: false }));
        try {
          const sig = await program.methods.settlePot()
            .accounts({ arcade: arcadePda, pot: pk, treasury: arcade.treasury })
            .remainingAccounts(winners)
            .rpc();
          settle.settled++; pending--;
          console.log(`settle: cabinet ${cab} day ${day} paid ${winners.length} winner(s) ${sig.slice(0, 12)}…`);
        } catch (e) {
          const msg = String(e);
          if (/DayNotOver/.test(msg)) continue;   // inside the settle grace; try next sweep
          settle.errors++; settle.lastError = `cab ${cab} day ${day}: ${msg.slice(0, 140)}`;
          console.log("settle: FAILED " + settle.lastError);
        }
      }
    }
    settle.pending = pending;
    // House pays the pot rent: pre-open this and next period's pots.
    if (program.methods.openPot && period >= 3600) {   // never for short test periods
      for (const day of [nowDay, nowDay + 1]) {
        for (let cab = 1; cab <= MAX_CAB; cab++) {
          const pk = potPda(cab, day);
          try { const info = await conn.getAccountInfo(pk); if (info) continue; } catch (e) { continue; }
          try {
            await program.methods.openPot(day).accounts({ arcade: arcadePda, cabinet: chain.cabinetPda(cab), pot: pk, payer: kp.publicKey, systemProgram: anchor.web3.SystemProgram.programId }).rpc();
            settle.opened = (settle.opened || 0) + 1;
          } catch (e) { settle.lastError = `open_pot cab ${cab} day ${day}: ${String(e).slice(0, 100)}`; }
        }
      }
    }
    settle.lastOk = Date.now();
  } catch (e) { settle.errors++; settle.lastError = String(e).slice(0, 140); console.log("settle: sweep error " + settle.lastError); }
}
if (settle.enabled && chain) {
  const every = Math.max(60, parseInt(process.env.SETTLE_INTERVAL_S || "300", 10)) * 1000;
  console.log(`settle daemon on: every ${every / 1000}s, lookback ${process.env.SETTLE_LOOKBACK || 7} periods`);
  setTimeout(settleSweep, 5000);
  setInterval(settleSweep, every);
}

async function chainSubmit(creditIdB58, body, result) {
  const { anchor, program, kp, potPda, arcadePda } = chain;
  const creditPk = new anchor.web3.PublicKey(creditIdB58);
  let credit;
  try { credit = await program.account.credit.fetch(creditPk); }
  catch (e) { return { ok: false, code: 410, reason: "credit not found (unpaid, or already scored)" }; }

  // The credit's cabinet decides the game. A replay from a higher-scoring
  // engine must not be able to land in another cabinet's pot.
  let cabGame = chain.cabinetGame.get(credit.cabinetId);
  if (!cabGame) {
    try {
      const cab = await program.account.cabinet.fetch(chain.cabinetPda(credit.cabinetId));
      cabGame = Buffer.from(cab.game).toString("utf8").replace(/\0+$/, "");
      chain.cabinetGame.set(credit.cabinetId, cabGame);
    } catch (e) { return { ok: false, code: 502, reason: "cabinet lookup failed" }; }
  }
  if (cabGame !== body.game) return { ok: false, code: 422, reason: `credit is for ${cabGame}, not ${body.game}` };

  // The chain's commitment is the truth: sha256(secret) must equal it.
  const commit = crypto.createHash("sha256").update(Buffer.from(body.secret, "hex")).digest();
  if (!commit.equals(Buffer.from(credit.seedCommit))) {
    return { ok: false, code: 422, reason: "secret does not match on-chain commitment" };
  }

  // The published replay hash: sha256 over the canonical replay record.
  const replayHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ game: body.game, seed: body.seed, inputsRLE: body.inputsRLE }))
    .digest();

  const sig = await program.methods
    .submitScore(result.score, Array.from(replayHash))
    .accounts({
      arcade: arcadePda,
      verifier: kp.publicKey,
      credit: creditPk,
      pot: potPda(credit.cabinetId, credit.day),
      rentPayer: credit.rentPayer,
    })
    .rpc();
  return { ok: true, txSig: sig, replayHash: replayHash.toString("hex"), player: credit.player.toBase58() };
}

// TAS heuristic v1: humans have messy inter-press timing. A long run whose
// input-edge gaps are overwhelmingly identical gets flagged for review —
// flagged runs still verify, but the flag rides the receipt and the on-chain
// path can hold payouts above a threshold on it.
function tasFlags(masks) {
  const gaps = [];
  let prev = 0, lastEdge = -1;
  for (let i = 0; i < masks.length; i++) {
    const edges = masks[i] & ~prev;
    if (edges) {
      if (lastEdge >= 0) gaps.push(i - lastEdge);
      lastEdge = i;
    }
    prev = masks[i];
  }
  if (gaps.length < 30) return { flagged: false, edgeGaps: gaps.length };
  const counts = new Map();
  for (const g of gaps) counts.set(g, (counts.get(g) || 0) + 1);
  let modal = 0;
  for (const c of counts.values()) modal = Math.max(modal, c);
  const modalShare = modal / gaps.length;
  return {
    flagged: modalShare > 0.9,
    edgeGaps: gaps.length,
    modalShare: Math.round(modalShare * 100) / 100,
  };
}

function verifyRun(body) {
  const { creditId, game, seed, seedCommit, inputsRLE, claimedScore, claimedHash } = body;
  if (typeof creditId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(creditId)) {
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
  const derivedSeed = commitBuf.readInt32LE(0);
  if ((seed | 0) !== derivedSeed) return { ok: false, reason: "seed does not derive from secret" };
  const commit = commitBuf.toString("hex");

  const masks = Engine.decodeRLE(inputsRLE);
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
  return { ok: true, score: result.score, hash: result.hash, ticks: result.ticks, verifyMs, tas, seedCommitHex: commit };
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

  // Current pot standings + bounty for a cabinet, straight off the chain.
  if (req.method === "GET" && req.url === "/leaderboards") {
    if (!chain) return send(503, { error: "chain mode off" });
    if (readCache.lb && Date.now() - readCache.lb.at < 8000) return send(200, readCache.lb.body);
    (async () => {
      const { program, potPda } = chain;
      const arcade = await program.account.arcade.fetch(chain.arcadePda);
      const period = arcade.periodSeconds.toNumber ? arcade.periodSeconds.toNumber() : Number(arcade.periodSeconds);
      const day = Math.floor(Date.now() / 1000 / period);
      const CABS = Array.from({ length: 31 }, (_, i) => i + 1);
      const boards = [];
      await Promise.all(CABS.map(async (cab) => {
        try {
          const pot = await program.account.dailyPot.fetch(potPda(cab, day));
          const lamports = await chain.conn.getBalance(potPda(cab, day));
          const entries = pot.entries.slice(0, pot.count)
            .map((e) => ({ player: e.player.toBase58(), score: e.score }))
            .sort((a, b) => b.score - a.score);
          boards.push({ cabinetId: cab, potLamports: lamports, count: entries.length, top: entries.slice(0, 3) });
        } catch (e) { /* no pot */ }
      }));
      boards.sort((a, b) => b.potLamports - a.potLamports);
      readCache.lb = { at: Date.now(), body: { day, periodSeconds: period, boards } };
      send(200, readCache.lb.body);
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }

  if (req.method === "GET" && /^\/leaderboard\/\d{1,3}$/.test(req.url)) {
    if (!chain) return send(503, { error: "chain mode off" });
    const cabId = parseInt(req.url.split("/")[2], 10);
    (async () => {
      const { anchor, program, potPda } = chain;
      const arcade = await program.account.arcade.fetch(chain.arcadePda);
      const period = arcade.periodSeconds.toNumber ? arcade.periodSeconds.toNumber() : Number(arcade.periodSeconds);
      const day = Math.floor(Date.now() / 1000 / period);
      let entries = [], potLamports = 0;
      try {
        const pot = await program.account.dailyPot.fetch(potPda(cabId, day));
        entries = pot.entries.slice(0, pot.count).map((e) => ({
          player: e.player.toBase58(),
          score: e.score,
          replayHash: Buffer.from(e.replayHash).toString("hex"),
        }));
        potLamports = await chain.conn.getBalance(potPda(cabId, day));
      } catch (e) { /* no pot yet this period */ }
      let bounty = null;
      try {
        const bPda = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("bounty"), Buffer.from([cabId])], program.programId)[0];
        const b = await program.account.bounty.fetch(bPda);
        bounty = {
          record: b.record,
          champion: b.champion.toBase58(),
          lamports: await chain.conn.getBalance(bPda),
        };
      } catch (e) { /* cabinet has no bounty */ }
      send(200, { cabinetId: cabId, day, periodSeconds: period, entries, potLamports, bounty });
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }

  // Player profile: current-period standings across every cabinet, plus
  // their public receipts. The wallet IS the account.
  if (req.method === "GET" && /^\/player\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.url)) {
    if (!chain) return send(503, { error: "chain mode off" });
    const pubkey = req.url.split("/")[2];
    (async () => {
      const { program, potPda } = chain;
      const arcade = await program.account.arcade.fetch(chain.arcadePda);
      const period = arcade.periodSeconds.toNumber ? arcade.periodSeconds.toNumber() : Number(arcade.periodSeconds);
      const day = Math.floor(Date.now() / 1000 / period);
      const CABS = Array.from({ length: 31 }, (_, i) => i + 1);
      const standings = [];
      const pots = await Promise.all(CABS.map(async (cab) => {
        try { return [cab, await program.account.dailyPot.fetch(potPda(cab, day))]; }
        catch (e) { return null; }
      }));
      for (const entry of pots) {
        if (!entry) continue;
        const [cab, pot] = entry;
        const sorted = pot.entries.slice(0, pot.count)
          .map((e, i) => ({ player: e.player.toBase58(), score: e.score }))
          .sort((a, b) => b.score - a.score);
        sorted.forEach((e, rank) => {
          if (e.player === pubkey) standings.push({ cabinetId: cab, rank: rank + 1, score: e.score, of: sorted.length });
        });
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
            if (r.onchain && r.onchain.player === pubkey) {
              receipts.push({
                creditId: r.creditId, game: r.game, score: r.verdict.score,
                ticks: r.verdict.ticks, tasFlagged: r.verdict.tasFlagged,
                verifiedAt: r.verdict.verifiedAt, replay: `/replays/${r.creditId}.json`,
              });
            }
          } catch (e) { /* skip bad file */ }
        }
      } catch (e) { /* no receipts dir yet */ }
      send(200, { player: pubkey, day, periodSeconds: period, standings, receipts });
    })().catch((e) => send(502, { error: String(e).slice(0, 200) }));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    return send(200, {
      ok: true,
      uptimeS: Math.round((Date.now() - STARTED_AT) / 1000),
      settle: settle.enabled ? { lastRun: settle.lastRun, lastOk: settle.lastOk, settled: settle.settled, opened: settle.opened || 0, pending: settle.pending, errors: settle.errors, lastError: settle.lastError } : "off",
      signer: chain ? { pubkey: chain.kp.publicKey.toBase58(), lamports: keyBal.lamports, at: keyBal.at } : null,
      games: Object.keys(GAMES).length,
      engines: ENGINE_HASH,
      verifierPubkey: KEYS.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    });
  }

  if (req.method === "GET" && req.url.startsWith("/replays/")) {
    const name = req.url.slice("/replays/".length);
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) return send(400, { error: "bad name" });
    const p = path.join(RECEIPTS_DIR, name);
    if (!fs.existsSync(p)) return send(404, { error: "no such receipt" });
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(fs.readFileSync(p));
  }

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
      if (typeof parsed.creditId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.creditId)) return send(422, { verified: false, reason: "bad creditId" });
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
        verifiedAt: Date.now(),
        engineHash: ENGINE_HASH[parsed.game],
      };
      // The receipt: everything anyone needs to re-run the verification.
      fs.writeFileSync(
        path.join(RECEIPTS_DIR, `${parsed.creditId}.json`),
        JSON.stringify({ creditId: parsed.creditId, game: parsed.game, seed: parsed.seed, secret: parsed.secret, inputsRLE: parsed.inputsRLE,
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
          .catch((e) => send(502, { verified: false, reason: "chain submit failed: " + String(e).slice(0, 200) }));
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
  server.listen(PORT, () => console.log(`quarters verifier on :${PORT}, receipts in ${RECEIPTS_DIR}`));
}
module.exports = { server, verifyRun, tasFlags };
