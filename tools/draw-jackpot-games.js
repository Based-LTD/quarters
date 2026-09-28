#!/usr/bin/env node
// THE BOUNTY's game order, drawn at random from a Robinhood Chain block hash
// that didn't exist when the draw was announced. Shuffle-bag: every floor
// game gets a week before any game repeats. Anyone can re-run this script
// with the announced block and get the same order.
//
//   node scripts/draw-jackpot-games.js --block <N> [--exclude voidrocks] [--cycle 1]
//
// seed  = keccak256("QUARTERS jackpot draw" | cycle | blockhash(N))
// order = Fisher-Yates over the games (sorted A-Z), each swap index taken
//         from keccak256(seed | i) mod (i + 1)
const { createPublicClient, http, keccak256, encodePacked, toHex } = require("viem");
const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const FLOOR = ["apex", "breakpoint", "chomp", "coil", "girder", "lander", "moth", "stack", "voidrocks"];   // the nine machines on the floor

function arg(name, dflt) { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; }

function draw(blockHash, cycle, games) {
  const seed = keccak256(encodePacked(["string", "uint256", "bytes32"], ["QUARTERS jackpot draw", BigInt(cycle), blockHash]));
  const bag = games.slice().sort();
  for (let i = bag.length - 1; i > 0; i--) {
    const r = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [seed, BigInt(i)])));
    const j = Number(r % BigInt(i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return { seed, order: bag };
}

(async () => {
  const block = arg("block"); if (!block) { console.error("--block <N> is required (announce it before it is mined)"); process.exit(1); }
  const cycle = Number(arg("cycle", "1"));
  const exclude = (arg("exclude", "") || "").split(",").filter(Boolean);
  const games = FLOOR.filter((g) => !exclude.includes(g));
  const pub = createPublicClient({ transport: http(RPC) });
  const b = await pub.getBlock({ blockNumber: BigInt(block) }).catch(() => null);
  if (!b) { const head = await pub.getBlockNumber(); console.error(`block ${block} isn't mined yet (head ${head}); run this after it is`); process.exit(2); }
  const { seed, order } = draw(b.hash, cycle, games);
  console.log(`cycle ${cycle} · block ${block} · hash ${b.hash} · mined ${new Date(Number(b.timestamp) * 1000).toISOString()}`);
  console.log(`seed ${seed}`);
  console.log(`order: ${order.join(" → ")}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { draw, FLOOR };
