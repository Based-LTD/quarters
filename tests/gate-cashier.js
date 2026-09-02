#!/usr/bin/env node
// Gate: the browser cashier core, LIVE on devnet. Drives the exact module the
// website bundles (web/cashier-core.js) with a node keypair standing in for
// Phantom: insert coin → play → submit via HTTP → verify the score landed on
// the on-chain leaderboard through the service's /leaderboard endpoint, and
// that the CORS preflight a browser would send is answered.
const anchor = require("@coral-xyz/anchor");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeCashier } = require("../web/cashier-core.js");
const VoidRocks = require("../engine/voidrocks.js");

const PERIOD_FALLBACK = 120; let PERIOD = PERIOD_FALLBACK; // read from chain below
const PORT = 8795;
const URL = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const svc = spawn("node", [path.join(__dirname, "../verifier/service.js")], {
    env: {
      ...process.env,
      DEVNET_SUBMIT: "1",
      PORT: String(PORT),
      RECEIPTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "qr-cash-")),
      VERIFIER_KEY_FILE: path.join(os.tmpdir(), "qr-cash-key.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  svc.stderr.on("data", (d) => process.stdout.write("  [svc!] " + d));
  await sleep(1500);

  try {
    // Browser preflight must be answered or no fetch ever leaves the page.
    const preflight = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/submit", method: "OPTIONS" },
        (res) => resolve({ code: res.statusCode, allow: res.headers["access-control-allow-methods"] })
      );
      req.on("error", reject);
      req.end();
    });
    check("CORS preflight answered", preflight.code === 204 && /POST/.test(preflight.allow), JSON.stringify(preflight));

    const payerKp = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"))))
    );
    const cashier = makeCashier({
      wallet: new anchor.Wallet(payerKp),
      sha256: async (buf) => crypto.createHash("sha256").update(buf).digest(),
    });

    // Don't straddle a pot boundary mid-test.
    try { const _ap = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("arcade")], new anchor.web3.PublicKey("GixGVpDZpCxVcnpfWcSPwXF8rtjYrBGmmpkSdZq7kb7a"))[0]; const _ai = await new anchor.web3.Connection("https://api.devnet.solana.com").getAccountInfo(_ap); if (_ai) PERIOD = _ai.data.readUInt32LE(8 + 32 + 32 + 32 + 8 + 2 + 2); } catch (e) {}
    try { const _ap = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("arcade")], new anchor.web3.PublicKey("GixGVpDZpCxVcnpfWcSPwXF8rtjYrBGmmpkSdZq7kb7a"))[0]; const _ai = await new anchor.web3.Connection("https://api.devnet.solana.com").getAccountInfo(_ap); if (_ai) PERIOD = _ai.data.readUInt32LE(116); } catch (e) {}
    const untilBoundary = PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
    if (untilBoundary < 40 && PERIOD <= 600) {
      console.log(`  (waiting ${untilBoundary + 2}s for a fresh pot period)`);
      await sleep((untilBoundary + 2) * 1000);
    }

    const seed = (Date.now() ^ 0xca5e) | 0;
    const coin = await cashier.insertCoin(1, seed);
    check("cashier core inserted a coin", !!coin.creditId && !!coin.txSig,
      `credit=${coin.creditId.slice(0, 8)}… quarter=${coin.quarterLamports} lamports`);

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
    console.log(`  (played: score ${s.score} over ${s.tick} ticks)`);

    const resp = await cashier.submit(URL, {
      creditId: coin.creditId,
      game: "voidrocks",
      seed,
      inputsRLE: VoidRocks.encodeRLE(masks),
      claimedScore: s.score,
      claimedHash: VoidRocks.stateHash(s),
    });
    check("cashier core submit verified + on-chain",
      resp.code === 200 && resp.body.verified && resp.body.onchain && !!resp.body.onchain.txSig,
      resp.body.onchain ? `tx=${resp.body.onchain.txSig.slice(0, 12)}…` : JSON.stringify(resp.body).slice(0, 140));

    await sleep(2000);
    const lb = await cashier.leaderboard(URL, 1);
    const mine = (lb.entries || []).find((e) => e.player === payerKp.publicKey.toBase58() && e.score === s.score);
    check("score visible via /leaderboard endpoint", !!mine,
      `entries=${(lb.entries || []).length} pot=${lb.potLamports} bounty=${lb.bounty ? lb.bounty.record : "n/a"}`);

    // --- tab flow through the core, on a different cabinet (coil = 25) ---
    if (await cashier.getTab()) {
      await cashier.closeTab();          // stale tab from an earlier gate run
      console.log("  (closed a stale tab)");
    }
    const session = anchor.web3.Keypair.generate();
    const sessionWallet = new anchor.Wallet(session);
    const tabOpen = await cashier.openTab(session.publicKey, 3 * 2_500_000, 15_000_000);
    const tabInfo0 = await cashier.getTab();
    check("core opened a 3-credit tab + session float", !!tabOpen.txSig && tabInfo0 && tabInfo0.creditsLeft === 3,
      `credits=${tabInfo0 && tabInfo0.creditsLeft}`);

    const seed2 = (Date.now() ^ 0x7ab) | 0;
    const run = await cashier.startRun(sessionWallet, 25, seed2);
    check("session-signed start_run (no popup path)", !!run.creditId && !!run.txSig,
      `credit=${run.creditId.slice(0, 8)}…`);

    const Coil = require("../engine/coil.js");
    const cs = Coil.createState(seed2);
    const cmasks = [];
    const DIRMASK = [1, 2, 4, 8];
    while (!cs.gameOver && cs.tick < 15000) {
      const head = cs.snake[0];
      const dx = cs.apple.x - head.x, dy = cs.apple.y - head.y;
      const m = DIRMASK[Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 0 : 1) : (dy < 0 ? 2 : 3)];
      cmasks.push(m);
      Coil.tick(cs, m);
    }
    const resp2 = await cashier.submit(URL, {
      creditId: run.creditId,
      game: "coil",
      seed: seed2,
      inputsRLE: Coil.encodeRLE(cmasks),
      claimedScore: cs.score,
      claimedHash: Coil.stateHash(cs),
    });
    check("tab-paid coil run verified + on-chain (new cabinet 25)",
      resp2.code === 200 && resp2.body.verified && resp2.body.onchain && !!resp2.body.onchain.txSig,
      resp2.body.onchain ? `score=${cs.score} tx=${resp2.body.onchain.txSig.slice(0, 12)}…` : JSON.stringify(resp2.body).slice(0, 140));

    const tabInfo1 = await cashier.getTab();
    check("tab debited one credit", tabInfo1 && tabInfo1.creditsLeft === 2, `credits=${tabInfo1 && tabInfo1.creditsLeft}`);
    await cashier.closeTab();
    check("tab closed and refunded", (await cashier.getTab()) === null);
  } catch (e) {
    check("gate ran to completion", false, String(e).slice(0, 300));
  } finally {
    svc.kill();
  }
  console.log(failures === 0 ? "\nCASHIER GATE PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
