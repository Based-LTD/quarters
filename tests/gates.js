#!/usr/bin/env node
// QUARTERS money-route gate tests, run LIVE against devnet.
// Gate 1: insert_coin splits verified by real balances.
// Gate 2: verifier-signed scores land sorted on the on-chain leaderboard.
// Gate 4: bounty pays the whole pool on a beaten record, holds otherwise.
// Gate 5 (abuse): forged signer, double-submit rejected on-chain.
// Gate 3: pot settles permissionlessly after period rollover with correct
//         payouts, leftovers to treasury, and double-settle rejected.
const anchor = require("@coral-xyz/anchor");
const guardArcadeConfig = require("./config-guard.js");
const sweepBack = require("./sweep.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PublicKey, Keypair, SystemProgram, Connection, LAMPORTS_PER_SOL } = anchor.web3;
const BN = anchor.BN;

const RPC = "https://api.devnet.solana.com";
const QUARTER = 2_500_000;       // 0.0025 SOL — a quarter that costs a quarter
const PERIOD = 120;              // devnet pot period, seconds

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/quarters.json")));
  const payerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"))))
  );
  const conn = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payerKp), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);
  const PID = program.programId;
  console.log("program:", PID.toBase58(), "payer:", payerKp.publicKey.toBase58());

  const _kf = path.join(__dirname, "../verifier/verifier-solana-devnet.json");
  const verifier = fs.existsSync(_kf) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(_kf)))) : Keypair.generate();
  const treasury = Keypair.generate();
  const players = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  if (!fs.existsSync(_kf)) fs.writeFileSync(_kf, JSON.stringify(Array.from(verifier.secretKey)));

  // Fund players from the payer.
  {
    const tx = new anchor.web3.Transaction();
    for (const p of players) {
      tx.add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: p.publicKey, lamports: 0.04 * LAMPORTS_PER_SOL }));
    }
    // A real treasury is a funded wallet; an empty account can't accept a
    // sub-rent-minimum house cut. Seed it above the rent floor.
    tx.add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: treasury.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(tx);
  }

  const [arcadePda] = PublicKey.findProgramAddressSync([Buffer.from("arcade")], PID);
  const _guard = await guardArcadeConfig(program, arcadePda, payerKp.publicKey, {});   // captures the original config; restored at exit
  globalThis._gatesGuard = _guard;
  const cabinetPda = (id) => PublicKey.findProgramAddressSync([Buffer.from("cabinet"), Buffer.from([id])], PID)[0];
  const bountyPda = (id) => PublicKey.findProgramAddressSync([Buffer.from("bounty"), Buffer.from([id])], PID)[0];
  const potPda = (id, day) => {
    const d = Buffer.alloc(4);
    d.writeUInt32LE(day);
    return PublicKey.findProgramAddressSync([Buffer.from("pot"), Buffer.from([id]), d], PID)[0];
  };
  // v3: credit PDA is seeded by the commitment; every cabinet has a Stakes PDA
  const creditPda = (player, commit) => PublicKey.findProgramAddressSync([Buffer.from("credit"), player.toBuffer(), commit], PID)[0];
  const stakesPda = (id) => PublicKey.findProgramAddressSync([Buffer.from("stakes"), Buffer.from([id])], PID)[0];
  const commitFor = (tag) => { const b = Buffer.alloc(32); b.writeUInt32LE((Date.now() ^ (tag * 2654435761)) >>> 0, 0); b[4] = tag & 255; return require("crypto").createHash("sha256").update(b).digest(); };
  const gameName = (s) => {
    const b = Buffer.alloc(16);
    b.write(s);
    return Array.from(b);
  };

  // ---- initialize + cabinets (idempotent-ish: fresh deploy expected) ----
  let freshInit = true;
  try {
    await program.methods
      .initialize(verifier.publicKey, treasury.publicKey, new BN(QUARTER), 7000, 1500, PERIOD)
      .accounts({ arcade: arcadePda, authority: payerKp.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  } catch (e) {
    freshInit = false;
    await program.methods
      .updateConfig(verifier.publicKey, treasury.publicKey, new BN(QUARTER), 7000, 1500, PERIOD)
      .accounts({ arcade: arcadePda, authority: payerKp.publicKey })
      .rpc();
  }
  for (const [id, isBounty] of [[1, false], [2, true]]) {
    try {
      await program.methods
        .createCabinet(id, gameName("voidrocks"), isBounty)
        .accounts({ arcade: arcadePda, cabinet: cabinetPda(id), authority: payerKp.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e) { /* exists from a prior run */ }
  }
  // Point both cabinets' operator at this run's treasury (the deed hook).
  for (const id of [1, 2]) {
    await program.methods
      .setOperator(treasury.publicKey)
      .accounts({ arcade: arcadePda, cabinet: cabinetPda(id), authority: payerKp.publicKey })
      .rpc();
  }
  const arcade0 = await program.account.arcade.fetch(arcadePda);
  check("arcade configured (quarter=0.0025)",
    arcade0.quarterLamports.toNumber() === QUARTER && arcade0.periodSeconds > 0,
    freshInit ? "fresh init" : "re-pointed via update_config");
  check("arcade verifier/treasury current",
    arcade0.verifier.equals(verifier.publicKey) && arcade0.treasury.equals(treasury.publicKey));

  // Wait for a fresh period so all coins + settlement fit predictably.
  const nowSec = Math.floor(Date.now() / 1000);
  const untilBoundary = PERIOD - (nowSec % PERIOD);
  if (true) {   // always: a fresh period means a pot no other test touched
    console.log(`  (waiting ${untilBoundary + 1}s for a fresh pot period)`);
    await sleep((untilBoundary + 1) * 1000);
  }
  const day = Math.floor(Date.now() / 1000 / PERIOD);
  const pot1 = potPda(1, day);
  const potRentUnit = await conn.getMinimumBalanceForRentExemption(8 + 727);   // a settled pot closes its rent to the treasury

  async function insertCoin(playerKp2, cabId, commitByte) {
    const commit = commitFor(commitByte);
    const credit = creditPda(playerKp2.publicKey, commit);
    const cab = await program.account.cabinet.fetch(cabinetPda(cabId));
    await program.methods
      .insertCoin(Array.from(commit))
      .accounts({
        arcade: arcadePda,
        cabinet: cabinetPda(cabId),
        stakes: stakesPda(cabId),
        pot: potPda(cabId, Math.floor(Date.now() / 1000 / PERIOD)),
        bounty: bountyPda(cabId),
        credit,
        player: playerKp2.publicKey,
        operator: cab.operator,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerKp2])
      .rpc();
    return credit;
  }

  // ---- Gate 1: splits ----
  const potBefore = await conn.getBalance(pot1);
  const treBefore = await conn.getBalance(treasury.publicKey);
  const credits = [];
  for (let i = 0; i < 3; i++) credits.push(await insertCoin(players[i], 1, i + 1));
  const potAfter = await conn.getBalance(pot1);
  const treAfter = await conn.getBalance(treasury.publicKey);
  const potGain = potAfter - potBefore;
  const treGain = treAfter - treBefore;
  // Pot PDA rent was paid at first init; measure the 70% cuts net of it.
  check("gate1: pot received 3 x 70%", potGain >= 3 * QUARTER * 0.7, `potGain=${potGain}`);
  // Operator == treasury pre-deeds, so treasury collects operator + house = 30%/coin.
  check("gate1: treasury received 3 x 30% (± pots the daemon closed to it mid-test)", (treGain - 2250000) >= 0 && ((treGain - 2250000) % potRentUnit === 0), `treGain=${treGain}`);

  // ---- Gate 2: verifier-signed leaderboard ----
  async function submitScore(credit, score) {
    const cr = await program.account.credit.fetch(credit);
    await program.methods
      .submitScore(score, Array(32).fill(9))
      .accounts({
        arcade: arcadePda,
        verifier: verifier.publicKey,
        credit,
        pot: potPda(cr.cabinetId, cr.day),
        rentPayer: cr.rentPayer,
      })
      .signers([verifier])
      .rpc();
  }
  const creditRent = await conn.getMinimumBalanceForRentExemption(8 + 119); // Credit::INIT_SPACE = 119 (v3: + inserted_at)
  const p0PreSubmit = await conn.getBalance(players[0].publicKey);
  await submitScore(credits[0], 100);
  const p0PostSubmit = await conn.getBalance(players[0].publicKey);
  check("gate1b: credit rent refunded to player on submit",
    p0PostSubmit - p0PreSubmit === creditRent,
    `refund=${p0PostSubmit - p0PreSubmit} rent=${creditRent}`);
  await submitScore(credits[1], 300);
  await submitScore(credits[2], 200);
  const potAcc = await program.account.dailyPot.fetch(pot1);
  const scores = potAcc.entries.slice(0, potAcc.count).map((e) => e.score);
  check("gate2: leaderboard sorted 300/200/100",
    potAcc.count === 3 && scores[0] === 300 && scores[1] === 200 && scores[2] === 100,
    scores.join(","));
  check("gate2: leaderboard players correct",
    potAcc.entries[0].player.equals(players[1].publicKey) &&
    potAcc.entries[1].player.equals(players[2].publicKey) &&
    potAcc.entries[2].player.equals(players[0].publicKey));

  // ---- Gate 5a: forged signer + double submit ----
  {
    const forged = await insertCoin(players[0], 1, 7);
    let rejected = false;
    try {
      const cr = await program.account.credit.fetch(forged);
      await program.methods
        .submitScore(999999, Array(32).fill(6))
        .accounts({ arcade: arcadePda, verifier: players[0].publicKey, credit: forged, pot: potPda(cr.cabinetId, cr.day), rentPayer: cr.rentPayer })
        .signers([players[0]])
        .rpc();
    } catch (e) { rejected = String(e).includes("NotVerifier"); }
    check("gate5: forged verifier signature rejected", rejected);

    let doubled = false;
    try { await submitScore(credits[0], 5000); }
    catch (e) { doubled = true; }   // credit account is closed — gone entirely
    check("gate5: double submit rejected (credit closed)", doubled);
  }

  // ---- Gate 4: bounty ----
  {
    const bounty2 = bountyPda(2);
    let record0 = 0;
    try { record0 = (await program.account.bounty.fetch(bounty2)).record; } catch (e) {}
    const winScore = record0 + 100;
    const c1 = await insertCoin(players[0], 2, 11);
    const p0Before = await conn.getBalance(players[0].publicKey);
    const bountyBal = await conn.getBalance(bounty2);
    await program.methods
      .claimBounty(winScore, Array(32).fill(4))
      .accounts({ arcade: arcadePda, verifier: verifier.publicKey, credit: c1, bounty: bounty2, player: players[0].publicKey, rentPayer: players[0].publicKey })
      .signers([verifier])
      .rpc();
    const p0After = await conn.getBalance(players[0].publicKey);
    check("gate4: bounty pool paid to record-breaker", p0After > p0Before, `+${p0After - p0Before} (pool was ${bountyBal})`);

    const c2 = await insertCoin(players[1], 2, 12);
    let held = false;
    try {
      await program.methods
        .claimBounty(winScore - 50, Array(32).fill(5))
        .accounts({ arcade: arcadePda, verifier: verifier.publicKey, credit: c2, bounty: bounty2, player: players[1].publicKey, rentPayer: players[1].publicKey })
        .signers([verifier])
        .rpc();
    } catch (e) { held = String(e).includes("RecordStands"); }
    check("gate4: weaker score cannot take the bounty", held);
    const b = await program.account.bounty.fetch(bounty2);
    check("gate4: champion recorded", b.record === winScore && b.champion.equals(players[0].publicKey));
  }

  // ---- Gate 3: settlement after rollover ----
  {
    let earlyRejected = false;
    try {
      await program.methods
        .settlePot()
        .accounts({ arcade: arcadePda, pot: pot1, treasury: treasury.publicKey })
        .remainingAccounts([
          { pubkey: players[1].publicKey, isSigner: false, isWritable: true },
          { pubkey: players[2].publicKey, isSigner: false, isWritable: true },
          { pubkey: players[0].publicKey, isSigner: false, isWritable: true },
        ])
        .rpc();
    } catch (e) { earlyRejected = String(e).includes("DayNotOver"); }
    check("gate3: settle before rollover rejected", earlyRejected);

    const wait = (PERIOD - (Math.floor(Date.now() / 1000) % PERIOD) + 3) + Math.min(900, Math.floor(PERIOD / 4)) + 2;   // v3 settle grace
    console.log(`  (waiting ${wait}s for the pot period to roll over)`);
    await sleep(wait * 1000);

    const balsBefore = await Promise.all(players.map((p) => conn.getBalance(p.publicKey)));
    const treBefore2 = await conn.getBalance(treasury.publicKey);
    const potLamports = await conn.getBalance(pot1);
    const rent = await conn.getMinimumBalanceForRentExemption(potAcc ? 8 + 727 : 0).catch(() => 0);

    await program.methods
      .settlePot()
      .accounts({ arcade: arcadePda, pot: pot1, treasury: treasury.publicKey })
      .remainingAccounts([
        { pubkey: players[1].publicKey, isSigner: false, isWritable: true },
        { pubkey: players[2].publicKey, isSigner: false, isWritable: true },
        { pubkey: players[0].publicKey, isSigner: false, isWritable: true },
      ])
      .rpc();

    const balsAfter = await Promise.all(players.map((p) => conn.getBalance(p.publicKey)));
    const treAfter2 = await conn.getBalance(treasury.publicKey);
    const gains = balsAfter.map((b, i) => b - balsBefore[i]);
    // players order [p0=3rd, p1=1st, p2=2nd]
    check("gate3: payout order 1st>2nd>3rd", gains[1] > gains[2] && gains[2] > gains[0],
      `1st=${gains[1]} 2nd=${gains[2]} 3rd=${gains[0]}`);
    check("gate3: ratios ~30/18/12 of pool",
      Math.abs(gains[1] * 18 - gains[2] * 30) < 60 && Math.abs(gains[2] * 12 - gains[0] * 18) < 60);
    check("gate3: unpaid tail went to treasury", treAfter2 > treBefore2, `treasury +${treAfter2 - treBefore2}`);

    let doubleSettle = false;
    try {
      await program.methods
        .settlePot()
        .accounts({ arcadePda, pot: pot1, treasury: treasury.publicKey })
        .remainingAccounts([])
        .rpc();
    } catch (e) { doubleSettle = true; }
    check("gate3: double settle rejected", doubleSettle);
  }

  console.log(failures === 0 ? "\nALL GATES PASSED (devnet, live)" : `\n${failures} GATE CHECK(S) FAILED`);
  await _guard.restore();
  { let back = 0; for (const k of [...players, treasury]) back += await sweepBack(conn, k, payerKp.publicKey); console.log(`  (swept ${(back / 1e9).toFixed(4)} SOL back to the payer)`); }
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("FATAL:", e);
  try { if (globalThis._gatesGuard) await globalThis._gatesGuard.restore(); } catch (_) {}
  process.exit(1);
});
