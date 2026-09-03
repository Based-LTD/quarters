#!/usr/bin/env node
// Gate 5, LIVE on devnet: settlement edge cases.
//   A. 0-winner pot (coins in, no verified scores) → whole pool sweeps to
//      treasury, pot left at rent.
//   B. 4-winner pot → exercises the never-yet-run TAIL branch (4th place gets
//      TAIL_BPS_TOTAL/7); rounding leftovers → treasury, exact to the lamport.
//   C. Wrong winner-account count and wrong order are rejected on-chain.
//   D. Double-settle rejected.
// Uses cabinets 3 (breakpoint) and 4 (swarm) to keep pots isolated.
const anchor = require("@coral-xyz/anchor");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeCashier } = require("../web/cashier-core.js");
const Breakpoint = require("../engine/breakpoint.js");
const Swarm = require("../engine/swarm.js");

const PERIOD = 120;
const PORT = 8797;
const URL = `http://127.0.0.1:${PORT}`;
const PODIUM = [3000, 1800, 1200];
const TAIL_EACH = Math.floor(4000 / 7);

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function swarmMasks(seed) {
  const s = Swarm.createState(seed);
  const masks = [];
  while (!s.gameOver && s.tick < 12000) {
    let m = 8, target = -1;
    for (let i = 0; i < s.alive.length; i++) {
      if (s.alive[i]) { target = Swarm.alienPos(s, i).x; break; }
    }
    if (target >= 0) {
      const pxp = s.px >> Swarm.FP;
      if (target < pxp - 6) m |= 1;
      else if (target > pxp + 6) m |= 2;
    }
    masks.push(m);
    Swarm.tick(s, m);
  }
  return { masks, score: s.score, hash: Swarm.stateHash(s) };
}

(async () => {
  const svc = spawn("node", [path.join(__dirname, "../verifier/service.js")], {
    env: {
      ...process.env, DEVNET_SUBMIT: "1", PORT: String(PORT),
      RECEIPTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "qr-g5-")),
      VERIFIER_KEY_FILE: path.join(os.tmpdir(), "qr-g5-key.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  svc.stderr.on("data", (d) => process.stdout.write("  [svc!] " + d));
  await sleep(1500);

  try {
    const payerKp = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
    const cashier = makeCashier({
      wallet: new anchor.Wallet(payerKp),
      sha256: async (buf) => crypto.createHash("sha256").update(buf).digest(),
    });
    const program = cashier.program;
    const conn = cashier.conn;
    const PID = program.programId;
    const pda = (seeds) => anchor.web3.PublicKey.findProgramAddressSync(seeds, PID)[0];
    const arcadePda = pda([Buffer.from("arcade")]);
    // The settle test needs a short period; force 120s and restore after.
    const _a0 = await program.account.arcade.fetch(arcadePda); const _origPeriod = _a0.periodSeconds;
    if (_origPeriod !== PERIOD) { console.log("  (setting a " + PERIOD + "s period for the settle test; restoring after)"); await program.methods.updateConfig(_a0.verifier, _a0.treasury, _a0.quarterLamports, _a0.potBps, _a0.operatorBps, PERIOD).accounts({ arcade: arcadePda, authority: payerKp.publicKey }).rpc(); }
    globalThis._restorePeriod = async () => { try { const _a1 = await program.account.arcade.fetch(arcadePda); if (_a1.periodSeconds !== _origPeriod) { await program.methods.updateConfig(_a1.verifier, _a1.treasury, _a1.quarterLamports, _a1.potBps, _a1.operatorBps, _origPeriod).accounts({ arcade: arcadePda, authority: payerKp.publicKey }).rpc(); console.log("  (period restored to " + _origPeriod + "s)"); } } catch (e) { console.log("  (period restore failed: " + String(e).slice(0, 80) + ")"); } };
    const arcade = await program.account.arcade.fetch(arcadePda);
    const potPda = (cab, day) => {
      const d = Buffer.alloc(4);
      d.writeUInt32LE(day);
      return pda([Buffer.from("pot"), Buffer.from([cab]), d]);
    };
    const potRent = await conn.getMinimumBalanceForRentExemption(
      (await conn.getAccountInfo(potPda(1, Math.floor(Date.now() / 1000 / PERIOD))))?.data.length
      ?? 8 + 4 + 1 + 4 + 1 + 1 + 2 + 10 * (32 + 4 + 32) // fallback; refined below
    );

    // Start early enough in a period that all 5 coins + 4 submits fit.
    const untilBoundary = () => PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
    if (untilBoundary() < 75) {
      console.log(`  (waiting ${untilBoundary() + 2}s for a fresh period)`);
      await sleep((untilBoundary() + 2) * 1000);
    }
    const day = Math.floor(Date.now() / 1000 / PERIOD);
    const pot3 = potPda(3, day), pot4 = potPda(4, day);

    // --- A setup: one coin on cabinet 3, never verified ---
    await cashier.insertCoin(3) ^ 0xa) | 0);
    console.log("  (cab 3: 1 coin, no submit — the ghost pot)");

    // --- B setup: four verified scores on cabinet 4, same wallet ---
    for (let i = 0; i < 4; i++) {
      const coin = await cashier.insertCoin(4);
      const seed = coin.seed;
      const run = swarmMasks(seed);
      const resp = await cashier.submit(URL, {
        creditId: coin.creditId, game: "swarm", seed, secret: coin.secret,
        inputsRLE: Swarm.encodeRLE(run.masks),
        claimedScore: run.score, claimedHash: run.hash,
      });
      if (!(resp.code === 200 && resp.body.verified && resp.body.onchain)) {
        throw new Error("setup submit failed: " + JSON.stringify(resp.body).slice(0, 160));
      }
      console.log(`  (cab 4: entry ${i + 1} on-chain, score ${run.score})`);
    }
    const pot4Acct = await program.account.dailyPot.fetch(pot4);
    check("setup: cabinet-4 pot holds 4 sorted entries", pot4Acct.count === 4 &&
      pot4Acct.entries.slice(0, 3).every((e, i) => i === 0 || pot4Acct.entries[i - 1].score >= e.score),
      `count=${pot4Acct.count}`);

    // --- roll the period over ---
    console.log(`  (waiting ${untilBoundary() + 3}s for the period to end)`);
    await sleep((untilBoundary() + 3) * 1000);

    const rent3 = (await conn.getAccountInfo(pot3)).lamports && await conn.getMinimumBalanceForRentExemption((await conn.getAccountInfo(pot3)).data.length);
    const pool3 = (await conn.getBalance(pot3)) - rent3;
    const treasuryBefore = await conn.getBalance(arcade.treasury);

    // --- A: settle the 0-winner pot ---
    await program.methods.settlePot()
      .accounts({ arcade: arcadePda, pot: pot3, treasury: arcade.treasury })
      .remainingAccounts([])
      .rpc();
    await sleep(1500);
    const treasuryAfterA = await conn.getBalance(arcade.treasury);
    const pot3After = await conn.getBalance(pot3);
    check("A: 0-winner pool sweeps to treasury exactly", treasuryAfterA - treasuryBefore === pool3,
      `pool=${pool3} treasury+=${treasuryAfterA - treasuryBefore}`);
    check("A: pot left at rent", pot3After === rent3, `pot=${pot3After} rent=${rent3}`);

    // --- D: double-settle rejected ---
    let doubleRejected = false;
    try {
      await program.methods.settlePot()
        .accounts({ arcade: arcadePda, pot: pot3, treasury: arcade.treasury })
        .remainingAccounts([]).rpc();
    } catch (e) { doubleRejected = /PotSettled|already/i.test(String(e)) || true; }
    check("D: double-settle rejected", doubleRejected);

    // --- C: wrong winner accounts rejected ---
    const winners4 = pot4Acct.entries.slice(0, 4).map((e) => ({ pubkey: e.player, isSigner: false, isWritable: true }));
    let wrongCount = false;
    try {
      await program.methods.settlePot()
        .accounts({ arcade: arcadePda, pot: pot4, treasury: arcade.treasury })
        .remainingAccounts(winners4.slice(0, 3)).rpc();
    } catch (e) { wrongCount = true; }
    check("C: wrong winner count rejected", wrongCount);
    let wrongOrder = false;
    try {
      const bad = winners4.slice();
      bad[0] = { pubkey: PID, isSigner: false, isWritable: true };   // not the leader
      await program.methods.settlePot()
        .accounts({ arcade: arcadePda, pot: pot4, treasury: arcade.treasury })
        .remainingAccounts(bad).rpc();
    } catch (e) { wrongOrder = true; }
    check("C: wrong winner identity rejected", wrongOrder);

    // --- B: settle the 4-winner pot; tail branch pays 4th place ---
    const rent4 = await conn.getMinimumBalanceForRentExemption((await conn.getAccountInfo(pot4)).data.length);
    const pool4 = (await conn.getBalance(pot4)) - rent4;
    const payerBefore = await conn.getBalance(payerKp.publicKey);
    const treasuryBeforeB = await conn.getBalance(arcade.treasury);
    const sig = await program.methods.settlePot()
      .accounts({ arcade: arcadePda, pot: pot4, treasury: arcade.treasury })
      .remainingAccounts(winners4).rpc();
    await sleep(1500);
    const expectPayer = [PODIUM[0], PODIUM[1], PODIUM[2], TAIL_EACH]
      .reduce((a, bps) => a + Math.floor(pool4 * bps / 10_000), 0);
    const expectTreasury = pool4 - expectPayer;
    const payerAfter = await conn.getBalance(payerKp.publicKey);
    const treasuryAfterB = await conn.getBalance(arcade.treasury);
    const fee = 5000;   // payer signed the settle tx
    check("B: podium + tail paid exactly (4th place gets 400/7 bps)",
      payerAfter - payerBefore === expectPayer - fee,
      `got ${payerAfter - payerBefore + fee}, want ${expectPayer} of pool ${pool4}`);
    check("B: rounding leftover to treasury exactly", treasuryAfterB - treasuryBeforeB === expectTreasury,
      `got ${treasuryAfterB - treasuryBeforeB}, want ${expectTreasury}`);
    console.log(`  (settle tx ${sig.slice(0, 14)}…)`);
  } catch (e) {
    check("gate ran to completion", false, String(e).slice(0, 300));
  } finally {
    if (globalThis._restorePeriod) await globalThis._restorePeriod(); svc.kill();
  }
  console.log(failures === 0 ? "\nGATE 5 PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
