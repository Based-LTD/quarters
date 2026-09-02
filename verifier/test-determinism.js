#!/usr/bin/env node
// Determinism + gameplay sanity checks for all QUARTERS game cores.
const path = require("path");
const VoidRocks = require(path.join(__dirname, "..", "engine", "voidrocks.js"));
const Coil = require(path.join(__dirname, "..", "engine", "coil.js"));
const Breakpoint = require(path.join(__dirname, "..", "engine", "breakpoint.js"));
const Swarm = require(path.join(__dirname, "..", "engine", "swarm.js"));
const Moth = require(path.join(__dirname, "..", "engine", "moth.js"));
const Lander = require(path.join(__dirname, "..", "engine", "lander.js"));
const Hopper = require(path.join(__dirname, "..", "engine", "hopper.js"));
const Airtime = require(path.join(__dirname, "..", "engine", "airtime.js"));
const Chomp = require(path.join(__dirname, "..", "engine", "chomp.js"));
const Girder = require(path.join(__dirname, "..", "engine", "girder.js"));
const Stack = require(path.join(__dirname, "..", "engine", "stack.js"));
const Vortex = require(path.join(__dirname, "..", "engine", "vortex.js"));
const Miner = require(path.join(__dirname, "..", "engine", "miner.js"));
const Gridlock = require(path.join(__dirname, "..", "engine", "gridlock.js"));
const Apex = require(path.join(__dirname, "..", "engine", "apex.js"));
const Myriapod = require(path.join(__dirname, "..", "engine", "myriapod.js"));
const Overrun = require(path.join(__dirname, "..", "engine", "overrun.js"));
const Skyfall = require(path.join(__dirname, "..", "engine", "skyfall.js"));
const Claim = require(path.join(__dirname, "..", "engine", "claim.js"));
const Cannonade = require(path.join(__dirname, "..", "engine", "cannonade.js"));
const Exodus = require(path.join(__dirname, "..", "engine", "exodus.js"));
const Conduit = require(path.join(__dirname, "..", "engine", "conduit.js"));
const Lob = require(path.join(__dirname, "..", "engine", "lob.js"));
const Summit = require(path.join(__dirname, "..", "engine", "summit.js"));

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// Independent RNG for test input streams.
function testRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x9E3779B9) | 0;
    let t = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    t = Math.imul(t ^ (t >>> 16), 0x45d9f3b) ^ (t >>> 16);
    return t >>> 0;
  };
}

// Shared battery: identical-run, divergence, RLE, replay speed.
function battery(name, Engine, masks, seed, aliveWindow) {
  const a = Engine.runHeadless(seed, masks);
  const b = Engine.runHeadless(seed, masks);
  check(`${name}: same seed+inputs → identical hash`, a.hash === b.hash && a.score === b.score,
    `score=${a.score} ticks=${a.ticks} hash=${a.hash.toString(16)}`);
  const c = Engine.runHeadless(seed + 1, masks);
  check(`${name}: different seed → different run`, c.hash !== a.hash);
  const flip = aliveWindow[2] || 1;   // must be a bit the engine actually reads
  const mutated = masks.slice();
  for (let i = aliveWindow[0]; i < aliveWindow[1]; i++) mutated[i] ^= flip;
  const d = Engine.runHeadless(seed, mutated);
  check(`${name}: mutated inputs → different run`, d.hash !== a.hash);
  const rle = Engine.encodeRLE(masks);
  const rt = Engine.decodeRLE(rle);
  check(`${name}: RLE roundtrip exact`, rt.length === masks.length && rt.every((v, i) => v === masks[i]),
    `${masks.length} → ${rle.length} ints`);
  const t0 = process.hrtime.bigint();
  Engine.runHeadless(seed, masks);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`${name}: replay ≥50x realtime`, ms < (a.ticks / 60) * 1000 / 50, `${a.ticks} ticks in ${ms.toFixed(1)}ms`);
  return a;
}

// ---------- VOID ROCKS: monkey pilot ----------
{
  const r = testRng(42);
  const masks = [];
  let cur = 0;
  for (let i = 0; i < 20000; i++) {
    if (r() % 7 === 0) cur = (r() >> 8) & 15;
    masks.push(cur | 8);
  }
  const a = battery("voidrocks", VoidRocks, masks, 123456789, [60, 120]);
  check("voidrocks: scores points", a.score > 0, `score=${a.score}`);
  check("voidrocks: reaches game over", a.gameOver === 1, `ticks=${a.ticks}`);
  check("voidrocks: saucers spawn", a.saucers >= 1, `saucers=${a.saucers}`);
  const idle = VoidRocks.runHeadless(99, new Array(18000).fill(0), 0);
  check("voidrocks: idle camper dies", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- COIL: greedy bot chases the apple ----------
{
  function coilBot(seed, maxTicks) {
    const s = Coil.createState(seed);
    const masks = [];
    const DIRMASK = [1, 2, 4, 8]; // left right up down
    while (!s.gameOver && s.tick < maxTicks) {
      const head = s.snake[0];
      const dx = s.apple.x - head.x, dy = s.apple.y - head.y;
      let want;
      if (Math.abs(dx) >= Math.abs(dy)) want = dx < 0 ? 0 : 1;
      else want = dy < 0 ? 2 : 3;
      const m = DIRMASK[want];
      masks.push(m);
      Coil.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = coilBot(555, 30000);
  check("coil: greedy bot eats apples", final.apples >= 3, `apples=${final.apples} score=${final.score}`);
  const a = battery("coil", Coil, masks, 555, [30, 90]);
  check("coil: bot run replays to same score", a.score === final.score, `score=${a.score}`);
  const idle = Coil.runHeadless(7, new Array(3000).fill(0), 0);
  check("coil: idle snake hits the wall", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- BREAKPOINT: paddle tracks the ball ----------
{
  function bpBot(seed, maxTicks) {
    const s = Breakpoint.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 8; // always willing to serve
      if (s.bx < s.px - (4 << Breakpoint.FP)) m |= 1;
      else if (s.bx > s.px + (4 << Breakpoint.FP)) m |= 2;
      masks.push(m);
      Breakpoint.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = bpBot(777, 30000);
  check("breakpoint: tracker bot breaks bricks", final.score >= 30, `score=${final.score} wall=${final.wallNo}`);
  // Mutation window must straddle a paddle contact — a tracking bot's paddle
  // reconverges after mid-flight-only perturbations.
  const a = battery("breakpoint", Breakpoint, masks, 777, [300, 500]);
  // grace 0: the bot's run was cut off mid-game, so extra grace ticks would
  // legitimately keep scoring.
  const exact = Breakpoint.runHeadless(777, masks, 0);
  check("breakpoint: bot run replays to same score", exact.score === final.score, `score=${exact.score}`);
  const idle = Breakpoint.runHeadless(11, new Array(36000).fill(0), 0);
  check("breakpoint: idle paddle loses all balls", idle.gameOver === 1, `ticks=${idle.ticks} score=${idle.score}`);
}

// ---------- SWARM: chase-and-fire bot ----------
{
  function swarmBot(seed, maxTicks) {
    const s = Swarm.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 8;
      let target = -1;
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
    return { masks, final: s };
  }
  const { masks, final } = swarmBot(4242, 30000);
  check("swarm: bot kills aliens", final.score >= 100, `score=${final.score} wave=${final.wave}`);
  battery("swarm", Swarm, masks, 4242, [100, 300]);
  const idle = Swarm.runHeadless(13, new Array(36000).fill(0), 0);
  check("swarm: idle player loses", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- MOTH: gap-seeking flapper ----------
{
  function mothBot(seed, maxTicks) {
    const s = Moth.createState(seed);
    const masks = [];
    let prev = 0;
    while (!s.gameOver && s.tick < maxTicks) {
      let want = 0;
      let target = 360;
      for (const g of s.gates) {
        if ((g.x >> Moth.FP) + Moth.GATE_W / 2 >= Moth.MOTH_X - Moth.MOTH_R) { target = g.gapY; break; }
      }
      const my = s.y >> Moth.FP;
      const pred = my + (s.vy * 12) / 256;   // where the moth will be soon
      if (!s.started || (pred > target && s.vy > -350 && my > 50)) want = 8;
      const m = want && !prev ? 8 : 0;   // flap is edge-triggered
      prev = m;
      masks.push(m);
      Moth.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = mothBot(777, 30000);
  check("moth: bot clears gates", final.gatesPassed >= 5, `gates=${final.gatesPassed} score=${final.score}`);
  battery("moth", Moth, masks, 777, [50, 200, 8]);
  const idle = Moth.runHeadless(3, new Array(1200).fill(0), 0);
  check("moth: idle credit times out", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- LANDER: upright hover bot ----------
{
  function landerBot(seed, maxTicks) {
    const s = Lander.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      const m = s.vy > 260 ? 4 : 0;   // brake hard falls, never rotate
      masks.push(m);
      Lander.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = landerBot(99, 30000);
  check("lander: bot run ends (fuel/landers are finite)", final.gameOver === 1,
    `score=${final.score} landings=${final.landings} ticks=${final.tick}`);
  battery("lander", Lander, masks, 99, [30, 120]);
  const idle = Lander.runHeadless(5, new Array(8000).fill(0), 0);
  check("lander: idle ship crashes out", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- HOPPER: hop-forward bot ----------
{
  function hopperBot(seed, maxTicks) {
    const s = Hopper.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      const m = s.tick % 45 === 0 ? 4 : 0;   // hop up every 0.75s, damn the traffic
      masks.push(m);
      Hopper.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = hopperBot(31337, 30000);
  check("hopper: bot scores forward progress", final.score >= 10, `score=${final.score}`);
  check("hopper: reckless bot dies out", final.gameOver === 1, `ticks=${final.tick}`);
  battery("hopper", Hopper, masks, 31337, [10, 90, 4]);
  const idle = Hopper.runHeadless(2, new Array(8000).fill(0), 0);
  check("hopper: idle frog times out of all lives", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- AIRTIME: throttle bot with air correction ----------
{
  function airtimeBot(seed, maxTicks) {
    const s = Airtime.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 4;
      if (!s.grounded) {
        // Level out: positive signed angle = nose down = tilt back (bit 1).
        const signedA = ((s.angle + 128) & 255) - 128;
        if (signedA > 4) m |= 1;
        else if (signedA < -4) m |= 2;
      }
      masks.push(m);
      Airtime.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = airtimeBot(808, 30000);
  check("airtime: bot covers distance", final.score >= 30, `score=${final.score} dist=${final.wx >> Airtime.FP}px`);
  check("airtime: bot actually catches air", final.launches >= 1, `launches=${final.launches} flips=${final.flips}`);
  // Flip achievability: holding tilt-back in the air must land at least one
  // flip — this stalled once (world-axis tilt impulses) and must not again.
  {
    const s2 = Airtime.createState(808);
    for (let i = 0; i < 4000 && !s2.gameOver; i++) {
      Airtime.tick(s2, s2.grounded ? 4 : 5);
    }
    check("airtime: flips are achievable", s2.flips >= 1, `flips=${s2.flips} launches=${s2.launches}`);
  }
  battery("airtime", Airtime, masks, 808, [100, 400, 4]);
  // Renderer-parity: probing terrain ahead (as the renderer does every frame)
  // must not perturb the simulation — the engine pre-generates its lookahead.
  {
    const clean = Airtime.runHeadless(808, masks.slice(0, 3000), 0);
    const s = Airtime.createState(808);
    for (let i = 0; i < 3000 && !s.gameOver; i++) {
      Airtime.tick(s, masks[i]);
      Airtime.groundAt(s, (s.wx >> Airtime.FP) + 680);   // render probe
    }
    check("airtime: render probes don't change the run", Airtime.stateHash(s) === clean.hash,
      `probed=${Airtime.stateHash(s).toString(16)} clean=${clean.hash.toString(16)}`);
  }
  const idle = Airtime.runHeadless(6, new Array(36000).fill(0), 0);
  check("airtime: idle rider eventually stops scoring or run ends", idle.gameOver === 1, `ticks=${idle.ticks} score=${idle.score}`);
}

// ---------- CHOMP: maze validity + wandering bot ----------
{
  // Every row is exactly COLS wide.
  check("chomp: maze rows are uniform width", Chomp.MAZE.every((r) => r.length === Chomp.COLS),
    Chomp.MAZE.map((r) => r.length).join(","));
  // Flood-fill from the player start over player-walkable tiles: every pellet
  // must be reachable, or the level is unclearable by construction.
  const seen = new Set();
  const stack = [[Chomp.PLAYER_START.c, Chomp.PLAYER_START.r]];
  while (stack.length) {
    const [c, r] = stack.pop();
    const key = `${((c % Chomp.COLS) + Chomp.COLS) % Chomp.COLS},${r}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nc = ((c + dc) % Chomp.COLS + Chomp.COLS) % Chomp.COLS;
      const nr = r + dr;
      if (Chomp.walkable(nc, nr, false)) stack.push([nc, nr]);
    }
  }
  let unreachable = 0, totalPellets = 0;
  for (let r = 0; r < Chomp.ROWS; r++) {
    for (let c = 0; c < Chomp.COLS; c++) {
      const ch = Chomp.MAZE[r][c];
      if (ch === "." || ch === "o") {
        totalPellets++;
        if (!seen.has(`${c},${r}`)) unreachable++;
      }
    }
  }
  check("chomp: every pellet reachable from start", unreachable === 0,
    `${totalPellets} pellets, ${unreachable} unreachable`);
  // A wall start makes the player untouchable (wisps can't path into walls).
  check("chomp: player starts on a walkable tile",
    Chomp.walkable(Chomp.PLAYER_START.c, Chomp.PLAYER_START.r, false),
    `start=(${Chomp.PLAYER_START.c},${Chomp.PLAYER_START.r})`);

  function chompBot(seed, maxTicks) {
    const s = Chomp.createState(seed);
    const masks = [];
    let tr = seed | 0, cur = 2;
    while (!s.gameOver && s.tick < maxTicks) {
      tr = (tr + 0x9E3779B9) | 0;
      let t = Math.imul(tr ^ (tr >>> 16), 0x45d9f3b) >>> 0;
      if (s.tick % 25 === 0) cur = [1, 2, 4, 8][t % 4];
      masks.push(cur);
      Chomp.tick(s, cur);
    }
    return { masks, final: s };
  }
  const { masks, final } = chompBot(2600, 30000);
  check("chomp: wandering bot eats pellets", final.score >= 50, `score=${final.score}`);
  check("chomp: wisps finish the bot off", final.gameOver === 1, `ticks=${final.tick}`);
  battery("chomp", Chomp, masks, 2600, [100, 300]);
  const idle = Chomp.runHeadless(4, new Array(20000).fill(0), 0);
  check("chomp: idle coin gets hunted down", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- GIRDER: blind climber bot ----------
{
  function girderBot(seed, maxTicks) {
    const s = Girder.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      if (s.ladder >= 0) m = 4;                       // keep climbing
      else if (s.pg >= 0 && s.pg < 6) {
        // Walk to the nearest up-ladder on this girder, then climb.
        let best = -1, bestD = 1e9;
        for (const [lx, lg] of Girder.LADDERS) {
          if (lg !== s.pg) continue;
          const d = Math.abs(lx - (s.px >> Girder.FP));
          if (d < bestD) { bestD = d; best = lx; }
        }
        if (best < 0) m = 2;
        else if (bestD < 5) m = 4;
        else m = best > (s.px >> Girder.FP) ? 2 : 1;
      }
      masks.push(m);
      Girder.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = girderBot(1981, 30000);
  check("girder: bot climbs the scaffolding", final.bestG >= 2, `bestG=${final.bestG} score=${final.score}`);
  check("girder: kegs finish the blind climber", final.gameOver === 1, `ticks=${final.tick} lives=${final.lives}`);
  battery("girder", Girder, masks, 1981, [40, 160]);
  const idle = Girder.runHeadless(8, new Array(20000).fill(0), 0);
  check("girder: idle player is run down by kegs", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- STACK: perfect-align and sloppy droppers ----------
{
  function stackBot(seed, maxTicks, sloppy) {
    const s = Stack.createState(seed);
    const masks = [];
    let prev = 0;
    while (!s.gameOver && s.tick < maxTicks) {
      const below = s.rows[s.rows.length - 1];
      let want = 0;
      if (sloppy) want = s.tick % 37 === 0 ? 8 : 0;
      else if (s.pos === below.x0) want = 8;
      const m = want && !(prev & 8) ? 8 : 0;
      prev = m;
      masks.push(m);
      Stack.tick(s, m);
    }
    return { masks, final: s };
  }
  const good = stackBot(4001, 30000, false);
  check("stack: aligned dropper reaches a jackpot", good.final.level >= 2, `level=${good.final.level} score=${good.final.score}`);
  const bad = stackBot(4001, 30000, true);
  check("stack: sloppy dropper misses out", bad.final.gameOver === 1, `ticks=${bad.final.tick} row=${bad.final.row}`);
  battery("stack", Stack, bad.masks, 4001, [30, 120, 8]);
  const idle = Stack.runHeadless(9, new Array(36000).fill(0), 0);
  check("stack: idle credit auto-drops into a miss eventually", idle.gameOver === 1, `ticks=${idle.ticks} row=${idle.row}`);
}

// ---------- VORTEX: aim-and-fire bot ----------
{
  function vortexBot(seed, maxTicks) {
    const s = Vortex.createState(seed);
    const masks = [];
    let prev = 0;
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 8;
      let target = -1, bd = 99;
      let rimCount = 0;
      for (const f of s.foes) {
        if (f.onRim) rimCount++;
        const d = Math.min(Math.abs(f.lane - s.lane), Vortex.LANES - Math.abs(f.lane - s.lane));
        if (d < bd) { bd = d; target = f.lane; }
      }
      if (target >= 0 && target !== s.lane) {
        const cwd = (target - s.lane + Vortex.LANES) % Vortex.LANES;
        m |= cwd <= Vortex.LANES / 2 ? 2 : 1;
      }
      if (rimCount >= 3 && s.pulse && !(prev & 4)) m |= 4;
      prev = m;
      masks.push(m);
      Vortex.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = vortexBot(5150, 30000);
  check("vortex: bot clears foes and waves", final.score >= 500 && final.wave >= 2, `score=${final.score} wave=${final.wave}`);
  battery("vortex", Vortex, masks, 5150, [100, 300]);
  const idle = Vortex.runHeadless(12, new Array(20000).fill(0), 0);
  check("vortex: idle player is hunted on the rim", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- MINER: greedy digger ----------
{
  function minerBot(seed, maxTicks) {
    const s = Miner.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      // Nearest nugget, walk toward it through the dirt.
      const pc = Math.trunc(s.px / Miner.TILE), pr = Math.trunc(s.py / Miner.TILE);
      let best = null, bd = 1e9;
      for (let r = 0; r < Miner.ROWS; r++) {
        for (let c = 0; c < Miner.COLS; c++) {
          if (s.grid[r * Miner.COLS + c] !== Miner.NUGGET) continue;
          const d = Math.abs(c - pc) + Math.abs(r - pr);
          if (d < bd) { bd = d; best = { c, r }; }
        }
      }
      if (s.exitOpen) best = { c: Miner.COLS - 3, r: Miner.ROWS - 3 };
      if (best) {
        const dc = best.c - pc, dr = best.r - pr;
        // Alternate preferred axis every ~2s so walls don't wedge it forever.
        const preferX = ((s.tick >> 7) & 1) === 0;
        if (preferX && dc !== 0) m = dc < 0 ? 1 : 2;
        else if (dr !== 0) m = dr < 0 ? 4 : 8;
        else if (dc !== 0) m = dc < 0 ? 1 : 2;
      }
      masks.push(m);
      Miner.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = minerBot(7777, 30000);
  check("miner: digger collects nuggets", final.got >= 3 || final.level >= 2, `got=${final.got} level=${final.level} score=${final.score}`);
  // Mutate near the end — the greedy bot RE-CONVERGES after early
  // perturbations (same cave, same targets), which is honest determinism,
  // not a bug; late mutations leave no time to re-sync.
  battery("miner", Miner, masks, 7777, [masks.length - 500, masks.length - 100]);
  const idle = Miner.runHeadless(3, new Array(20000).fill(0), 0);
  check("miner: idle miner times out of lives", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- GRIDLOCK: whisker bot ----------
{
  function glClear(s, x, y, dir, cap) {
    const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];
    for (let d = 4; d <= cap; d += 4) {
      const nx = x + DX[dir] * d, ny = y + DY[dir] * d;
      if (nx < 2 || nx >= 958 || ny < 2 || ny >= 718) return d;
      if (s.trail[Math.trunc(ny / 4) * Gridlock.GC + Math.trunc(nx / 4)]) return d;
    }
    return cap;
  }
  function gridlockBot(seed, maxTicks) {
    const s = Gridlock.createState(seed);
    const masks = [];
    const MASKS_FOR = [1, 2, 4, 8];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      const p = s.riders[0];
      if (p.alive && glClear(s, p.x, p.y, p.dir, 60) <= 28) {
        const OPP = [1, 0, 3, 2];
        let best = p.dir, bd = -1;
        for (let d = 0; d < 4; d++) {
          if (d === OPP[p.dir]) continue;
          const c = glClear(s, p.x, p.y, d, 160);
          if (c > bd) { bd = c; best = d; }
        }
        m = MASKS_FOR[best];
      }
      masks.push(m);
      Gridlock.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = gridlockBot(2049, 30000);
  check("gridlock: whisker bot survives and scores", final.score >= 50, `score=${final.score} round=${final.round}`);
  battery("gridlock", Gridlock, masks, 2049, [30, 90, 4]);
  const idle = Gridlock.runHeadless(5, new Array(9000).fill(0), 0);
  check("gridlock: straight rider hits a wall", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- APEX: racing-line bot ----------
{
  function apexBot(seed, maxTicks) {
    const s = Apex.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 4;
      // Aim two centerline points ahead.
      let ni = 0, bd = 1e18;
      for (let i = 0; i < Apex.TRACK.length; i++) {
        const dx = (s.x >> Apex.FP) - Apex.TRACK[i][0], dy = (s.y >> Apex.FP) - Apex.TRACK[i][1];
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; ni = i; }
      }
      const tgt = Apex.TRACK[(ni + 2) % Apex.TRACK.length];
      const want = Apex.aimAngle(tgt[0] - (s.x >> Apex.FP), tgt[1] - (s.y >> Apex.FP));
      const d = ((want - s.heading + 128) & 255) - 128;
      if (d > 3) m |= 2;
      else if (d < -3) m |= 1;
      if (Math.abs(d) > 30 && s.v > 1200) m = (m & ~4) | 8;   // brake for corners
      masks.push(m);
      Apex.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = apexBot(3131, 12000);
  check("apex: racing-line bot completes laps", final.lap >= 2, `laps=${final.lap} bestLap=${final.bestLap} score=${final.score}`);
  battery("apex", Apex, masks, 3131, [200, 500]);
  const idle = Apex.runHeadless(1, new Array(11000).fill(0), 0);
  check("apex: idle car runs out the clock", idle.gameOver === 1 && idle.laps === 0, `ticks=${idle.ticks}`);
  // Off-track containment: a never-steering driver leaves the circuit at the
  // first corner and must be towed back, never stranded (GRASS_DRAG > ACC
  // once bricked cars at v=0 forever; LOST_R rescue caps how far you stray).
  {
    const s = Apex.createState(7);
    let rescues = 0, maxD = 0;
    for (let i = 0; i < 8000; i++) {
      Apex.tick(s, 4);
      for (const e of s.events) if (e.t === "rescue") rescues++;
      const d2 = Apex.trackDist2(s.x >> Apex.FP, s.y >> Apex.FP);
      if (d2 > maxD) maxD = d2;
    }
    check("apex: straight driver is rescued, never lost", rescues >= 1 && maxD <= (Apex.LOST_R + 10) * (Apex.LOST_R + 10),
      `rescues=${rescues} maxDist=${Math.round(Math.sqrt(maxD))}px`);
    const g = Apex.createState(7);
    for (let i = 0; i < 200; i++) Apex.tick(g, 4);
    for (let i = 0; i < 300; i++) Apex.tick(g, 0);
    for (let i = 0; i < 120; i++) Apex.tick(g, 4);
    check("apex: grass is escapable under throttle", g.v > 300, `v=${g.v}`);
  }
}

// ---------- MYRIAPOD: strafe-and-fire gardener ----------
{
  function myriBot(seed, maxTicks) {
    const s = Myriapod.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 16;
      // Line up under the lowest segment on the board.
      let tgt = null, br = -1;
      for (const ch of s.chains) {
        for (const cell of ch.cells) {
          if (cell.r > br) { br = cell.r; tgt = cell; }
        }
      }
      const pxp = s.px >> Myriapod.FP;
      if (tgt) {
        const tx = tgt.c * Myriapod.CELL + 12;
        if (Math.abs(tx - pxp) > 6) m |= tx < pxp ? 1 : 2;
      }
      // Spider outranks everything: sidestep it.
      if (s.spider) {
        const dx = (s.spider.x - s.px) >> Myriapod.FP;
        const dy = (s.spider.y - s.py) >> Myriapod.FP;
        if (Math.abs(dx) < 80 && Math.abs(dy) < 80) {
          m = (m & ~3) | (dx > 0 ? 1 : 2) | 16;
        }
      }
      masks.push(m);
      Myriapod.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = myriBot(6502, 30000);
  check("myriapod: bot shreds the chain", final.score >= 500, `score=${final.score} wave=${final.wave}`);
  battery("myriapod", Myriapod, masks, 6502, [100, 300, 16]);
  const idle = Myriapod.runHeadless(14, new Array(36000).fill(0), 0);
  check("myriapod: idle player gets overrun", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- OVERRUN: kite-and-shoot bot ----------
{
  function overrunBot(seed, maxTicks) {
    const s = Overrun.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      let ne = null, bd = 1e18;
      for (const e of s.enemies) {
        const dx = (e.x - s.px) >> Overrun.FP, dy = (e.y - s.py) >> Overrun.FP;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; ne = e; }
      }
      if (ne) {
        const dx = (ne.x - s.px) >> Overrun.FP, dy = (ne.y - s.py) >> Overrun.FP;
        // Fire at it...
        if (Math.abs(dx) * 2 > Math.abs(dy)) m |= dx < 0 ? 16 : 32;
        if (Math.abs(dy) * 2 > Math.abs(dx)) m |= dy < 0 ? 64 : 128;
        // ...while backing off when it closes.
        if (bd < 240 * 240) {
          m |= dx > 0 ? 1 : 2;
          m |= dy > 0 ? 4 : 8;
        }
      }
      masks.push(m);
      Overrun.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = overrunBot(2084, 30000);
  check("overrun: kiting bot racks up kills", final.score >= 500, `score=${final.score} wave=${final.wave}`);
  battery("overrun", Overrun, masks, 2084, [100, 300, 16]);
  const idle = Overrun.runHeadless(16, new Array(20000).fill(0), 0);
  check("overrun: idle player is swarmed", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- SKYFALL: intercept bot ----------
{
  function skyfallBot(seed, maxTicks) {
    const s = Skyfall.createState(seed);
    const masks = [];
    let prev = 0;
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      // Chase the lowest (most urgent) warhead, leading its fall.
      let tgt = null, by = -1;
      for (const wh of s.warheads) {
        const wy = wh.y >> Skyfall.FP;
        if (wy > by) { by = wy; tgt = wh; }
      }
      if (tgt) {
        const ax = (tgt.x + tgt.vx * 22) >> Skyfall.FP;
        const ay = (tgt.y + tgt.vy * 22) >> Skyfall.FP;
        const cx = s.cx >> Skyfall.FP, cy = s.cy >> Skyfall.FP;
        if (Math.abs(ax - cx) > 8) m |= ax < cx ? 1 : 2;
        if (Math.abs(ay - cy) > 8) m |= ay < cy ? 4 : 8;
        if (Math.abs(ax - cx) <= 30 && Math.abs(ay - cy) <= 30 && !(prev & 16) && s.tick % 6 === 0) m |= 16;
      }
      prev = m;
      masks.push(m);
      Skyfall.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = skyfallBot(1983, 30000);
  check("skyfall: intercept bot defends the cities", final.score >= 300, `score=${final.score} wave=${final.wave} cities=${final.cities.filter((c) => c).length}`);
  // Mutate crosshair movement at run END — a mid-run extra fire can vanish
  // into a destroyed silo + wave-refill and re-converge (the MINER lesson).
  battery("skyfall", Skyfall, masks, 1983, [masks.length - 500, masks.length - 100, 1]);
  const idle = Skyfall.runHeadless(17, new Array(36000).fill(0), 0);
  check("skyfall: idle cities all burn", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- CLAIM: strip-claiming bot ----------
{
  function claimScript() {
    const R = 2, U = 4, D = 8;
    const script = [];
    for (let k = 0; k < 40; k++) {
      for (let i = 0; i < 12; i++) script.push(U);
      for (let i = 0; i < 16; i++) script.push(R);
      for (let i = 0; i < 14; i++) script.push(D);
      for (let i = 0; i < 8; i++) script.push(R);
    }
    return script;
  }
  const masks = claimScript();
  const a = battery("claim", Claim, masks, 4096, [50, 250, 2]);
  check("claim: strip bot claims territory", a.score > 0, `score=${a.score} pct=${a.pct}%`);
  check("claim: bot run reaches game over", a.gameOver === 1, `ticks=${a.ticks}`);
  const idle = Claim.runHeadless(18, new Array(20000).fill(0), 0);
  check("claim: idle player is hunted by sparx", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- CANNONADE: previewShot gunnery bot ----------
{
  function cannonadeBot(seed, maxTicks) {
    const s = Cannonade.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let input = 0;
      if (s.phase === 0) {
        // Same flight sim the AI uses: sweep power at the current angle.
        const targetX = Cannonade.tankX(s, s.aiCol);
        let bestP = s.power, bd = 1e9;
        for (let p = 20; p <= 100; p++) {
          const land = Cannonade.previewShot(s, s.playerCol, s.angle, p, s.wind);
          const d = Math.abs(land - targetX);
          if (d < bd) { bd = d; bestP = p; }
        }
        if (s.power < bestP) input = 4;
        else if (s.power > bestP) input = 8;
        else input = (s.prevIn & 16) ? 0 : 16;
      }
      masks.push(input);
      Cannonade.tick(s, input);
    }
    return { masks, final: s };
  }
  const { masks, final } = cannonadeBot(1942, 30000);
  check("cannonade: gunnery bot lands hits", final.score >= 100, `score=${final.score} round=${final.round}`);
  // Goal-seeking bot: mutate power-adjust inputs early — a changed power at
  // fire time changes the shell, the craters, and every volley after.
  battery("cannonade", Cannonade, masks, 1942, [10, 200, 4]);
  const idle = Cannonade.runHeadless(19, new Array(36000).fill(0), 0);
  check("cannonade: idle gunner is out-shot", idle.gameOver === 1, `ticks=${idle.ticks}`);
  // Boomerang bound: wind is drag toward a capped drift velocity, so even a
  // near-vertical max-power lob into the strongest headwind lands within a
  // bounded distance behind the firer — raw accumulating wind flew shells
  // backwards over the firer's head.
  {
    let worst = 0;
    const s = Cannonade.createState(1);
    const tx = Cannonade.tankX(s, s.playerCol);
    for (const angle of [196, 205, 214, 220, 230]) {
      for (const power of [60, 80, 100]) {
        const behind = tx - Cannonade.previewShot(s, s.playerCol, angle, power, -80);
        if (behind > worst) worst = behind;
      }
    }
    check("cannonade: no boomerang against max wind", worst < 150, `worst landing ${worst}px behind firer`);
    const spread = [-80, 0, 80].map((w) => Cannonade.previewShot(s, s.playerCol, 214, 80, w));
    check("cannonade: wind still spreads landings", spread[2] - spread[0] > 200 && spread[0] < spread[1] && spread[1] < spread[2],
      `landings ${spread.join(" / ")}`);
  }
}

// ---------- EXODUS: shepherd bot ----------
{
  // World 1 is featureless by construction — marchers walk home unaided.
  // The bot idles through it, then cursor-chases the lead walker and spends
  // jobs from world 2 on (a blocker dropped at the hatch on world 1 strands
  // everyone — the bot learned that the hard way).
  function exodusBot(seed, maxTicks) {
    const s = Exodus.createState(seed);
    const masks = [];
    let prev = 0;
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 64;                                    // fast-forward always
      if (s.level >= 2) {
        let tgt = null, bx = -1;
        for (const mm of s.marchers) {
          if (mm.st === Exodus.WALK && (mm.x >> Exodus.FP) > bx) { bx = mm.x >> Exodus.FP; tgt = mm; }
        }
        if (tgt) {
          const cx = s.cx >> Exodus.FP, cy = s.cy >> Exodus.FP, ty = (tgt.y >> Exodus.FP) - 8;
          if (Math.abs(bx - cx) > 5) m |= bx < cx ? 1 : 2;
          if (Math.abs(ty - cy) > 5) m |= ty < cy ? 4 : 8;
          if (s.tick % 500 === 0 && !(prev & 32)) m |= 32;
          if (s.tick % 350 === 0 && !(prev & 16)) m |= 16;
        }
      }
      prev = m;
      masks.push(m);
      Exodus.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = exodusBot(2091, 30000);
  check("exodus: world 1 is walkable unaided (always winnable)", final.score >= 1000, `score=${final.score}`);
  check("exodus: bot reaches world 2 and the credit ends", final.level >= 2 && final.gameOver === 1, `level=${final.level} ticks=${final.tick}`);
  // Cursor position is hashed directly — end-window movement flips diverge
  // even when no assignment lands (assigns need a walker in cursor range).
  battery("exodus", Exodus, masks, 2091, [masks.length - 500, masks.length - 100, 1]);
  const idle = Exodus.runHeadless(21, new Array(30000).fill(0), 0);
  check("exodus: idle clears world 1, fails world 2", idle.gameOver === 1 && idle.level === 2 && idle.score > 0,
    `score=${idle.score} level=${idle.level}`);
  // Pointer mode: cursor coords packed into the input int (bit 128) must
  // teleport the cursor, land assignments, and replay identically.
  {
    const s = Exodus.createState(5);
    for (let i = 0; i < 400; i++) Exodus.tick(s, 0);
    const m = s.marchers.find((mm) => mm.st === Exodus.WALK);
    const packed = 128 | ((m.x >> Exodus.FP) << 8) | (((m.y >> Exodus.FP) - 8) << 18);
    const pmasks = [];
    for (let i = 0; i < 3000; i++) pmasks.push(i < 400 ? 0 : (i === 401 ? packed | 16 : packed));
    const a = Exodus.runHeadless(5, pmasks, 0);
    const b = Exodus.runHeadless(5, Exodus.decodeRLE(Exodus.encodeRLE(pmasks)), 0);
    const plainIdle = Exodus.runHeadless(5, new Array(3000).fill(0), 0);
    check("exodus: pointer-packed input replays and diverges", a.hash === b.hash && a.hash !== plainIdle.hash,
      `hash=${a.hash.toString(16)}`);
  }
}

// ---------- CONDUIT: path-extender bot ----------
{
  function conduitBot(seed, maxTicks) {
    const s = Conduit.createState(seed);
    const masks = [];
    let cur = { c: s.src.c, r: s.src.r }, exitDir = s.src.dir;
    let target = null, targetEntry = 0, dump = false;
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      if (!target) {
        const nc = cur.c + Conduit.DC[exitDir], nr = cur.r + Conduit.DR[exitDir];
        if (nc >= 0 && nc < Conduit.COLS && nr >= 0 && nr < Conduit.ROWS && !s.grid[nr * Conduit.COLS + nc]) {
          const entry = Conduit.opp(exitDir);
          if (Conduit.EXITS[s.queue[0]][entry] >= 0) {
            target = { c: nc, r: nr }; targetEntry = entry; dump = false;
          } else {
            let dc = s.cc < Conduit.COLS / 2 ? Conduit.COLS - 1 : 0, dr = Conduit.ROWS - 1;
            if ((dc === nc && dr === nr) || s.locked[dr * Conduit.COLS + dc]) dr = 0;
            target = { c: dc, r: dr }; dump = true;
          }
        }
      }
      if (target) {
        if (s.cc !== target.c) m |= s.cc < target.c ? 2 : 1;
        else if (s.cr !== target.r) m |= s.cr < target.r ? 8 : 4;
        else if (!(s.prevIn & 16)) m |= 16;
      }
      masks.push(m);
      Conduit.tick(s, m);
      for (const e of s.events) {
        if (e.t === "place") {
          if (!dump) { cur = { c: e.c, r: e.r }; exitDir = Conduit.EXITS[e.tile][targetEntry]; }
          target = null;
        }
        if (e.t === "level") { cur = { c: s.src.c, r: s.src.r }; exitDir = s.src.dir; target = null; }
      }
    }
    return { masks, final: s };
  }
  const { masks, final } = conduitBot(11, 30000);
  check("conduit: path bot completes a section", final.score >= 300 && final.level >= 2, `score=${final.score} level=${final.level}`);
  battery("conduit", Conduit, masks, 11, [100, 400]);
  const idle = Conduit.runHeadless(9, new Array(20000).fill(0), 0);
  check("conduit: idle flux spills immediately", idle.gameOver === 1 && idle.score === 0, `ticks=${idle.ticks}`);
}

// ---------- LOB: aim-scan bot via previewShot ----------
{
  function lobBot(seed, maxTicks) {
    const s = Lob.createState(seed);
    const masks = [];
    let phase = 0, targetAngle = 192, prev = 0;
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      if (!s.shot) {
        if (phase === 0) {
          let bestScore = -1;
          for (let a = Lob.AIM_MIN; a <= Lob.AIM_MAX; a += 2) {
            const cell = Lob.previewShot(s, a);
            if (!cell) continue;
            let same = 0;
            for (const [nc, nr] of Lob.neighbors(cell.c, cell.r)) {
              if (nc >= 0 && nr >= 0 && nr < Lob.ROWS && nc < Lob.rowCols(nr) && s.grid[nr * Lob.COLS + nc] === s.cur) same++;
            }
            if (same > bestScore) { bestScore = same; targetAngle = a; }
          }
          phase = 1;
        }
        if (s.angle !== targetAngle) m |= s.angle < targetAngle ? 2 : 1;
        else if (!(prev & 4)) { m |= 4; phase = 0; }
      }
      prev = m;
      masks.push(m);
      Lob.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = lobBot(13, 20000);
  check("lob: aim-scan bot pops and clears", final.score >= 2000 && final.level >= 2, `score=${final.score} level=${final.level}`);
  battery("lob", Lob, masks, 13, [200, 500]);
  const idle = Lob.runHeadless(4, new Array(30000).fill(0), 0);
  check("lob: idle player is ground into the line", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

// ---------- SUMMIT: greedy climber bot ----------
{
  function summitBot(seed, maxTicks) {
    const s = Summit.createState(seed);
    const masks = [];
    while (!s.gameOver && s.tick < maxTicks) {
      let m = 0;
      if (!s.hop && s.deadT === 0 && s.tick % 3 === 0) {
        let tgt = null, bd = 1e9;
        for (let r = 0; r < Summit.N; r++) {
          for (let i = 0; i <= r; i++) {
            if (s.cubes[Summit.ci(r, i)] >= Summit.target(s)) continue;
            const d = Math.abs(r - s.pr) * 2 + Math.abs(i - s.pi);
            if (d < bd) { bd = d; tgt = { r, i }; }
          }
        }
        if (tgt) {
          let best = -1, bestD = 1e9;
          for (let d = 0; d < 4; d++) {
            const nr = s.pr + Summit.HOPS[d][0], ni = s.pi + Summit.HOPS[d][1];
            if (nr < 0 || nr >= Summit.N || ni < 0 || ni > nr) continue;
            let danger = false;
            for (const b of s.balls) {
              const br = b.hop ? b.hop.r : b.r, bi2 = b.hop ? b.hop.i : b.i;
              if (br === nr && bi2 === ni) danger = true;
            }
            if (danger) continue;
            const dd = Math.abs(nr - tgt.r) * 2 + Math.abs(ni - tgt.i);
            if (dd < bestD) { bestD = dd; best = d; }
          }
          if (best >= 0) m = [1, 2, 4, 8][best];
        }
      }
      masks.push(m);
      Summit.tick(s, m);
    }
    return { masks, final: s };
  }
  const { masks, final } = summitBot(21, 30000);
  check("summit: climber bot claims summits", final.score >= 2000 && final.level >= 2, `score=${final.score} level=${final.level}`);
  battery("summit", Summit, masks, 21, [100, 400]);
  const idle = Summit.runHeadless(6, new Array(20000).fill(0), 0);
  check("summit: idle camper is crushed at the peak", idle.gameOver === 1, `ticks=${idle.ticks}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
