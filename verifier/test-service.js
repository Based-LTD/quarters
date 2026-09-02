#!/usr/bin/env node
// End-to-end + abuse tests for the verifier service: honest run verifies,
// tampered score/hash/seed rejected, TAS-perfect input flagged, receipt served.
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");

process.env.RECEIPTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qr-receipts-"));
process.env.VERIFIER_KEY_FILE = path.join(process.env.RECEIPTS_DIR, "key.json");
const { server } = require("./service.js");
const VoidRocks = require(path.join(__dirname, "..", "engine", "voidrocks.js"));

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

function post(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: pathName, method: "POST", headers: { "content-type": "application/json" } },
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
function get(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathName }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ code: res.statusCode, body: b }));
    }).on("error", reject);
  });
}

// A legit messy-timed run: monkey pilot (human-ish irregular inputs).
function honestRun(seed) {
  const s = VoidRocks.createState(seed);
  const masks = [];
  let tr = seed | 0, cur = 0;
  while (!s.gameOver && s.tick < 20000) {
    tr = (tr + 0x9E3779B9) | 0;
    let t = Math.imul(tr ^ (tr >>> 16), 0x45d9f3b) >>> 0;
    if (t % 7 === 0) cur = (t >> 8) & 15;
    const m = cur | (t % 3 === 0 ? 8 : 0);
    masks.push(m);
    VoidRocks.tick(s, m);
  }
  return { masks, score: s.score, hash: VoidRocks.stateHash(s) };
}

function commitOf(seed) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(seed | 0);
  return crypto.createHash("sha256").update(b).digest("hex");
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const seed = 424242;
  const run = honestRun(seed);
  const base = {
    creditId: "credit-test-1",
    game: "voidrocks",
    seed,
    seedCommit: commitOf(seed),
    inputsRLE: VoidRocks.encodeRLE(run.masks),
    claimedScore: run.score,
    claimedHash: run.hash,
  };

  const ok = await post(port, "/submit", base);
  check("honest run verifies", ok.code === 200 && ok.body.verified === true,
    `score=${ok.body.verdict && ok.body.verdict.score} tasFlagged=${ok.body.verdict && ok.body.verdict.tasFlagged}`);
  check("honest run not TAS-flagged", ok.body.verdict && ok.body.verdict.tasFlagged === false);
  check("verdict is signed", !!(ok.body.signed && ok.body.signed.signature));

  const inflated = await post(port, "/submit", { ...base, creditId: "credit-test-2", claimedScore: run.score + 1000 });
  check("inflated score rejected", inflated.code === 422, inflated.body.reason);

  const badHash = await post(port, "/submit", { ...base, creditId: "credit-test-3", claimedHash: (run.hash ^ 1) >>> 0 });
  check("tampered hash rejected", badHash.code === 422, badHash.body.reason);

  const wrongSeed = await post(port, "/submit", { ...base, creditId: "credit-test-4", seed: seed + 1 });
  check("seed not matching commitment rejected", wrongSeed.code === 422, wrongSeed.body.reason);

  // TAS run: metronome-perfect fire every 9 ticks, nothing else.
  {
    const s = VoidRocks.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < 20000) {
      const m = s.tick % 9 === 0 ? 8 : 0;
      masks.push(m);
      VoidRocks.tick(s, m);
    }
    const bot = await post(port, "/submit", {
      creditId: "credit-test-5",
      game: "voidrocks",
      seed,
      seedCommit: commitOf(seed),
      inputsRLE: VoidRocks.encodeRLE(masks),
      claimedScore: s.score,
      claimedHash: VoidRocks.stateHash(s),
    });
    check("metronome TAS run verifies but is flagged", bot.code === 200 && bot.body.verdict.tasFlagged === true,
      `modalShare=${bot.body.tas && bot.body.tas.modalShare}`);
  }

  const receipt = await get(port, "/replays/credit-test-1.json");
  check("receipt is served publicly", receipt.code === 200 && receipt.body.includes("inputsRLE"));
  const health = await get(port, "/health");
  check("health reports 24 games", JSON.parse(health.body).games === 24);

  server.close();
  console.log(failures === 0 ? "\nALL SERVICE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
