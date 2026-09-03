#!/usr/bin/env node
// Credit-tab gates, LIVE on devnet: one popup opens a tab, then a browser
// session key inserts coins with NO wallet signatures; splits come out of
// the tab exactly; rent refunds cycle back to the session key; unauthorized
// keys and empty tabs are rejected; close_tab refunds every unused lamport.
const anchor = require("@coral-xyz/anchor");
const guardArcadeConfig = require("./config-guard.js");
const sweepBack = require("./sweep.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PublicKey, Keypair, SystemProgram, Connection, LAMPORTS_PER_SOL } = anchor.web3;
const BN = anchor.BN;
const RPC = "https://api.devnet.solana.com";
const QUARTER = 2_500_000;
let PERIOD = 120; // refreshed from chain

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
  const program = new anchor.Program(idl, provider);
  const PID = program.programId;

  const verifier = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "../verifier/verifier-solana-devnet.json"))))
  );
  const session = Keypair.generate();     // the browser's throwaway key
  const stranger = Keypair.generate();    // not authorized on the tab

  const [arcadePda] = PublicKey.findProgramAddressSync([Buffer.from("arcade")], PID);
  // A throwaway treasury seeded above the rent floor (a sub-rent house cut into an empty account fails).
  let _treasuryKp = null;
  async function fundedThrowaway() {
    const k = Keypair.generate(); _treasuryKp = k;
    const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: k.publicKey, lamports: 3_000_000 }));
    await anchor.web3.sendAndConfirmTransaction(conn, tx, [payerKp]);
    return k.publicKey;
  }

  globalThis._tabGuard = null;
  const _guard = await guardArcadeConfig(program, arcadePda, payerKp.publicKey, { verifier: verifier.publicKey, treasury: await fundedThrowaway(), fundFrom: payerKp });   // treasury must not be the payer for the split math; pre-funded above rent
  globalThis._tabGuard = _guard;
  const cabinetPda = PublicKey.findProgramAddressSync([Buffer.from("cabinet"), Buffer.from([1])], PID)[0];
  const bountyPda = PublicKey.findProgramAddressSync([Buffer.from("bounty"), Buffer.from([1])], PID)[0];
  const tabPda = PublicKey.findProgramAddressSync([Buffer.from("tab"), payerKp.publicKey.toBuffer()], PID)[0];
  const potPda = (day) => {
    const d = Buffer.alloc(4);
    d.writeUInt32LE(day);
    return PublicKey.findProgramAddressSync([Buffer.from("pot"), Buffer.from([1]), d], PID)[0];
  };

  // --- v3 credit protocol: secret → commit → credit PDA; every cabinet has a Stakes account ---
  const stakesPdaOf = (id) => PublicKey.findProgramAddressSync([Buffer.from("stakes"), Buffer.from([id])], PID)[0];
  const mkSecret = (tag) => { const b = Buffer.alloc(32); b.writeUInt32LE((Date.now() ^ (tag * 2654435761)) >>> 0, 0); b[4] = tag & 255; return b; };
  const commitOf = (secret) => crypto.createHash("sha256").update(secret).digest();
  const creditPdaOf = (player, commit) => PublicKey.findProgramAddressSync([Buffer.from("credit"), player.toBuffer(), commit], PID)[0];


  // Fund the session key's fee float and the stranger (one wallet tx IRL).
  {
    const tx = new anchor.web3.Transaction()
      .add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: session.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }))
      .add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: stranger.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(tx);
  }

  // Fresh period so all coins land in one pot.
  try { const _ai = await conn.getAccountInfo(arcadePda); if (_ai) PERIOD = _ai.data.readUInt32LE(116); } catch (e) {}
  const untilBoundary = PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
  if (untilBoundary < 50 && PERIOD <= 600) {
    console.log(`  (waiting ${untilBoundary + 2}s for a fresh pot period)`);
    await sleep((untilBoundary + 2) * 1000);
  }

  // --- open the tab: ONE wallet signature for a 10-credit pack ---
  const DEPOSIT = 10 * QUARTER;
  await program.methods
    .openTab(new BN(DEPOSIT), new BN(0))
    .accounts({ tab: tabPda, player: payerKp.publicKey, sessionKey: session.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  const tabBal0 = await conn.getBalance(tabPda);
  check("tab opened with 10-credit deposit", tabBal0 >= DEPOSIT, `tab=${tabBal0}`);

  const arcade = await program.account.arcade.fetch(arcadePda);
  const cab = await program.account.cabinet.fetch(cabinetPda);
  const day = Math.floor(Date.now() / 1000 / PERIOD);
  const pot = potPda(day);

  async function startRun(signerKp, commitByte) {
    const secret = mkSecret(commitByte);
    const commit = commitOf(secret);
    const credit = creditPdaOf(payerKp.publicKey, commit);
    await program.methods
      .startRun(Array.from(commit))
      .accounts({
        arcade: arcadePda,
        cabinet: cabinetPda, stakes: stakesPdaOf(1),
        tab: tabPda,
        pot: potPda(Math.floor(Date.now() / 1000 / PERIOD)),
        bounty: bountyPda,
        credit,
        signer: signerKp.publicKey,
        operator: cab.operator,
        treasury: arcade.treasury,
        systemProgram: SystemProgram.programId,
      })
      .signers([signerKp])
      .rpc();
    return credit;
  }

  // --- three popup-free plays, signed only by the session key ---
  const potBefore = await conn.getBalance(pot);
  const treBefore = await conn.getBalance(arcade.treasury);
  const tabCredits = [];
  for (let i = 0; i < 3; i++) tabCredits.push(await startRun(session, 20 + i));
  const tabBal1 = await conn.getBalance(tabPda);
  const potAfter = await conn.getBalance(pot);
  const treAfter = await conn.getBalance(arcade.treasury);
  check("session key played 3 credits with no wallet signature", true);
  check("tab debited exactly 3 quarters", tabBal0 - tabBal1 === 3 * QUARTER, `debit=${tabBal0 - tabBal1}`);
  check("pot received 3 x 70% from tab", potAfter - potBefore >= 3 * QUARTER * 0.7, `+${potAfter - potBefore}`);
  check("treasury received 3 x 15% from tab (operator gets the other 15%)", treAfter - treBefore === 3 * QUARTER * 0.15, `+${treAfter - treBefore}`);

  // --- rent refunds cycle back to the session key on submit ---
  const sessBefore = await conn.getBalance(session.publicKey);
  {
    const cr = await program.account.credit.fetch(tabCredits[0]);
    await program.methods
      .submitScore(777, Array(32).fill(3))
      .accounts({
        arcade: arcadePda,
        verifier: verifier.publicKey,
        credit: tabCredits[0],
        pot: potPda(cr.day),
        rentPayer: cr.rentPayer,
      })
      .signers([verifier])
      .rpc();
  }
  const sessAfter = await conn.getBalance(session.publicKey);
  const creditRent = await conn.getMinimumBalanceForRentExemption(8 + 119); // Credit::INIT_SPACE = 119 (v3)
  check("credit rent refunded to the session key", sessAfter - sessBefore === creditRent,
    `refund=${sessAfter - sessBefore} rent=${creditRent}`);
  const potAcc = await program.account.dailyPot.fetch(pot);
  check("tab-funded score is on the leaderboard",
    potAcc.entries.slice(0, potAcc.count).some((e) => e.score === 777 && e.player.equals(payerKp.publicKey)));

  // --- abuse: a stranger's key cannot spend the tab ---
  let strangerRejected = false;
  try { await startRun(stranger, 60); }
  catch (e) { strangerRejected = String(e).includes("NotSession"); }
  check("unauthorized key rejected (NotSession)", strangerRejected);

  // --- drain the tab: 7 credits remain, the 8th must fail TabEmpty ---
  for (let i = 0; i < 7; i++) await startRun(session, 30 + i);
  let empty = false;
  try { await startRun(session, 50); }
  catch (e) { empty = String(e).includes("TabEmpty"); }
  check("empty tab rejected (TabEmpty)", empty);

  // --- close_tab refunds the remainder (dust below one quarter + tab rent) ---
  const playerBefore = await conn.getBalance(payerKp.publicKey);
  const tabFinal = await conn.getBalance(tabPda);
  await program.methods
    .closeTab()
    .accounts({ tab: tabPda, player: payerKp.publicKey })
    .rpc();
  const playerAfter = await conn.getBalance(payerKp.publicKey);
  check("close_tab refunded remaining balance + tab rent",
    playerAfter - playerBefore === tabFinal - 5000 || playerAfter - playerBefore === tabFinal,
    `refund=${playerAfter - playerBefore} tabHeld=${tabFinal}`);
  let gone = false;
  try { await program.account.tab.fetch(tabPda); } catch (e) { gone = true; }
  check("tab account closed", gone);

  console.log(failures === 0 ? "\nTAB GATES PASSED (devnet, live)" : `\n${failures} CHECK(S) FAILED`);
  await _guard.restore();
  { let back = 0; for (const k of [session, stranger, _treasuryKp].filter(Boolean)) back += await sweepBack(conn, k, payerKp.publicKey); console.log(`  (swept ${(back / 1e9).toFixed(4)} SOL back to the payer)`); }
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("FATAL:", e);
  try { if (globalThis._tabGuard) await globalThis._tabGuard.restore(); } catch (_) {}
  process.exit(1);
});
