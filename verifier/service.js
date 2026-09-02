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
  chain = { anchor, program, kp, conn, potPda, arcadePda };
  console.log("devnet submit mode: verifier", kp.publicKey.toBase58(), "program", PID.toBase58());
}

async function chainSubmit(creditIdB58, body, result) {
  const { anchor, program, kp, potPda, arcadePda } = chain;
  const creditPk = new anchor.web3.PublicKey(creditIdB58);
  let credit;
  try { credit = await program.account.credit.fetch(creditPk); }
  catch (e) { return { ok: false, code: 410, reason: "credit not found (unpaid, or already scored)" }; }

  // The chain's commitment is the truth; the client's copy is ignored.
  const seedBuf = Buffer.alloc(4);
  seedBuf.writeInt32LE(body.seed | 0);
  const commit = crypto.createHash("sha256").update(seedBuf).digest();
  if (!commit.equals(Buffer.from(credit.seedCommit))) {
    return { ok: false, code: 422, reason: "seed does not match on-chain commitment" };
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
  if (!Array.isArray(inputsRLE) || inputsRLE.length > 400_000) {
    return { ok: false, reason: "bad input log" };
  }

  // Seed must match its pre-play commitment: sha256(le32(seed)).
  const seedBuf = Buffer.alloc(4);
  seedBuf.writeInt32LE(seed | 0);
  const commit = crypto.createHash("sha256").update(seedBuf).digest("hex");
  if (seedCommit && commit !== seedCommit) {
    return { ok: false, reason: "seed does not match commitment" };
  }

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
  const send = (code, obj) => {
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
      send(200, { day, periodSeconds: period, boards });
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
      games: Object.keys(GAMES).length,
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
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return send(400, { error: "bad json" }); }
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
      };
      // The receipt: everything anyone needs to re-run the verification.
      fs.writeFileSync(
        path.join(RECEIPTS_DIR, `${parsed.creditId}.json`),
        JSON.stringify({ ...parsed, verdict, onchain }, null, 1)
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
