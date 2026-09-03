#!/usr/bin/env node
// Gate 2 end-to-end, LIVE on devnet: player pays a quarter with a committed
// seed → plays the deterministic game → POSTs the replay to the verifier
// service → the service re-executes it, checks the ON-CHAIN commitment, and
// submits the score → the score appears in the on-chain pot, the credit
// closes, and the rent comes back. Replay reuse dies at the closed credit.
const anchor = require("@coral-xyz/anchor");
const guardArcadeConfig = require("./config-guard.js");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PublicKey, Keypair, SystemProgram, Connection } = anchor.web3;
const RPC = "https://api.devnet.solana.com";
const PERIOD_FALLBACK = 120; let PERIOD = PERIOD_FALLBACK; // read from chain below
const PORT = 8792;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(pathName, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathName, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ code: res.statusCode, body: JSON.parse(b) }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

(async () => {
  // Boot the verifier service in devnet-submit mode.
  const svc = spawn("node", [path.join(__dirname, "../verifier/service.js")], {
    env: {
      ...process.env,
      DEVNET_SUBMIT: "1",
      PORT: String(PORT),
      RECEIPTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "qr-e2e-")),
      VERIFIER_KEY_FILE: path.join(os.tmpdir(), "qr-e2e-key.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  svc.stdout.on("data", (d) => process.stdout.write("  [svc] " + d));
  svc.stderr.on("data", (d) => process.stdout.write("  [svc!] " + d));
  await sleep(1500);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/quarters.json")));
  const payerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"))))
  );
  const conn = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payerKp), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  const PID = program.programId;

  // The verifier wallet pays submit_score fees — it needs a float.
  const verifierKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "../verifier/verifier-solana-devnet.json"))))
  );
  {
    const bal = await conn.getBalance(verifierKp.publicKey);
    if (bal < 0.02 * 1e9) {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: verifierKp.publicKey, lamports: 0.05 * 1e9 })
      );
      await provider.sendAndConfirm(tx);
      console.log("  (funded verifier fee float: 0.05 SOL)");
    }
  }

  const [arcadePda] = PublicKey.findProgramAddressSync([Buffer.from("arcade")], PID);
  const _guard = await guardArcadeConfig(program, arcadePda, payerKp.publicKey, { verifier: verifierKp.publicKey, fundFrom: payerKp });
  const cabinetPda = PublicKey.findProgramAddressSync([Buffer.from("cabinet"), Buffer.from([1])], PID)[0];
  const bountyPda = PublicKey.findProgramAddressSync([Buffer.from("bounty"), Buffer.from([1])], PID)[0];

  // Don't straddle a pot boundary mid-test.
  try { const _ai = await conn.getAccountInfo(arcadePda); if (_ai) PERIOD = _ai.data.readUInt32LE(116); } catch (e) {}
  const untilBoundary = PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
  if (untilBoundary < 40 && PERIOD <= 600) {
    console.log(`  (waiting ${untilBoundary + 2}s for a fresh pot period)`);
    await sleep((untilBoundary + 2) * 1000);
  }

  // --- the "browser": commit a seed and pay the quarter ---
  // v3: a 32-byte secret; its sha256 is the commitment AND the credit PDA seed;
  // the engine seed is the commitment's first four bytes.
  const secret = crypto.randomBytes(32);
  const seedCommit = crypto.createHash("sha256").update(secret).digest();
  let seed = 0, saltHex = "";   // v4: derived after the coin lands (needs the credit's salt)
  const stakesPk = PublicKey.findProgramAddressSync([Buffer.from("stakes"), Buffer.from([1])], PID)[0];

  const arcade = await program.account.arcade.fetch(arcadePda);
  const cab = await program.account.cabinet.fetch(cabinetPda);
  const creditPk = PublicKey.findProgramAddressSync(
    [Buffer.from("credit"), payerKp.publicKey.toBuffer(), seedCommit], PID)[0];
  const day = Math.floor(Date.now() / 1000 / PERIOD);
  const dayBuf = Buffer.alloc(4);
  dayBuf.writeUInt32LE(day);
  const potPk = PublicKey.findProgramAddressSync(
    [Buffer.from("pot"), Buffer.from([1]), dayBuf], PID)[0];

  await program.methods
    .insertCoin(Array.from(seedCommit))
    .accounts({
      arcade: arcadePda,
      cabinet: cabinetPda, stakes: stakesPk, slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
      pot: potPk,
      bounty: bountyPda,
      credit: creditPk,
      player: payerKp.publicKey,
      operator: cab.operator,
      treasury: arcade.treasury,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  { const cr = await program.account.credit.fetch(creditPk); saltHex = Buffer.from(cr.salt).toString("hex");
    seed = crypto.createHash("sha256").update(Buffer.concat([seedCommit, Buffer.from(cr.salt)])).digest().readInt32LE(0); }
  check("coin inserted with committed seed", true, `credit=${creditPk.toBase58().slice(0, 8)}…`);

  // --- play the game with that exact seed ---
  const VoidRocks = require(path.join(__dirname, "../engine/voidrocks.js"));
  const s = VoidRocks.createState(seed);
  const masks = [];
  let tr = seed | 0, cur = 0;
  while (!s.gameOver && s.tick < 20000) {
    tr = (tr + 0x9e3779b9) | 0;
    let t = Math.imul(tr ^ (tr >>> 16), 0x45d9f3b) >>> 0;
    if (t % 7 === 0) cur = (t >> 8) & 15;
    const m = cur | (t % 3 === 0 ? 8 : 0);
    masks.push(m);
    VoidRocks.tick(s, m);
  }
  const played = { score: s.score, hash: VoidRocks.stateHash(s) };
  console.log(`  (played: score ${played.score} over ${s.tick} ticks)`);

  // --- submit to the verifier service ---
  const submission = {
    creditId: creditPk.toBase58(),
    game: "voidrocks",
    seed,
    inputsRLE: VoidRocks.encodeRLE(masks),
    claimedScore: played.score,
    claimedHash: played.hash,
    secret: secret.toString("hex"), salt: saltHex,
  };
  const balBefore = await conn.getBalance(payerKp.publicKey);
  const resp = await post("/submit", submission);
  check("service verified and submitted on-chain",
    resp.code === 200 && resp.body.verified && resp.body.onchain && !!resp.body.onchain.txSig,
    resp.body.onchain ? `tx=${resp.body.onchain.txSig.slice(0, 12)}…` : JSON.stringify(resp.body).slice(0, 120));

  await sleep(2000);
  const pot = await program.account.dailyPot.fetch(potPk);
  const mine = pot.entries.slice(0, pot.count).find(
    (e) => e.player.equals(payerKp.publicKey) && e.score === played.score
  );
  check("score is on the on-chain leaderboard", !!mine, `count=${pot.count}`);

  let creditGone = false;
  try { await program.account.credit.fetch(creditPk); }
  catch (e) { creditGone = true; }
  check("credit closed (rent refunded)", creditGone);
  const balAfter = await conn.getBalance(payerKp.publicKey);
  check("player balance recovered rent", balAfter > balBefore, `net +${balAfter - balBefore} lamports`);

  // --- abuse: replay the same submission ---
  const reuse = await post("/submit", submission);
  check("replay reuse rejected (credit gone)", reuse.code === 410, reuse.body.reason);

  // --- abuse: pay a new coin but submit with a different seed ---
  {
    // the first credit was closed on submit, so its PDA (same commit) is free again
    const credit2 = creditPk;
    await program.methods
      .insertCoin(Array.from(seedCommit))    // committed to the OLD secret
      .accounts({
        arcade: arcadePda, cabinet: cabinetPda, stakes: stakesPk, slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY, pot: potPk, bounty: bountyPda,
        credit: credit2, player: payerKp.publicKey, operator: cab.operator,
        treasury: arcade.treasury, systemProgram: SystemProgram.programId,
      })
      .rpc();
    // An internally-consistent run for the WRONG seed: passes offline replay
    // verification, must die at the on-chain commitment check.
    const secret2 = crypto.randomBytes(32);
    const seed2 = crypto.createHash("sha256").update(Buffer.concat([crypto.createHash("sha256").update(secret2).digest(), Buffer.from(saltHex, "hex")])).digest().readInt32LE(0);
    const s2 = VoidRocks.createState(seed2);
    const masks2 = [];
    let tr2 = seed2 | 0, cur2 = 0;
    while (!s2.gameOver && s2.tick < 20000) {
      tr2 = (tr2 + 0x9e3779b9) | 0;
      let t2 = Math.imul(tr2 ^ (tr2 >>> 16), 0x45d9f3b) >>> 0;
      if (t2 % 7 === 0) cur2 = (t2 >> 8) & 15;
      const m2 = cur2 | (t2 % 3 === 0 ? 8 : 0);
      masks2.push(m2);
      VoidRocks.tick(s2, m2);
    }
    const cheat = await post("/submit", {
      creditId: credit2.toBase58(),
      game: "voidrocks",
      seed: seed2, secret: secret2.toString("hex"), salt: saltHex,
      inputsRLE: VoidRocks.encodeRLE(masks2),
      claimedScore: s2.score,
      claimedHash: VoidRocks.stateHash(s2),
    });
    check("wrong-seed submission rejected against chain commitment",
      cheat.code === 422 && String(cheat.body.reason).includes("commitment"), cheat.body.reason);
  }

  await _guard.restore();
  svc.kill();
  console.log(failures === 0 ? "\nGATE 2 CLOSED — full loop live on devnet" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
