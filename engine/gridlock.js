// GRIDLOCK — deterministic light-cycle core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask (buffered turn): 1=left 2=right 4=up 8=down.
// You and three AI riders leave solid light walls. Cross any wall — theirs
// or your own — and you're out. Outlast them: 100 per rider down, 300 for
// the round, +1 every half second alive. Rounds speed up. Three lives.
const Gridlock = (() => {
  const W = 960, H = 720;
  const CELL = 4;                     // trail-grid resolution
  const GC = W / CELL, GR = H / CELL; // 240 x 180
  const BASE_SPEED = 3;               // px per tick (integer, divides CELL later via accumulation)
  const RIDERS = [
    { x: 160, y: 360, dir: 1 },       // player start, heading right
    { x: 800, y: 360, dir: 0 },
    { x: 480, y: 140, dir: 3 },
    { x: 480, y: 580, dir: 2 },
  ];
  const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];
  const OPP = [1, 0, 3, 2];
  const SURVIVE_PTS = 1;              // per 30 ticks
  const KILL_PTS = 100, ROUND_PTS = 300;
  const START_LIVES = 3;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function speed(s) { return BASE_SPEED + Math.min(2, s.round >> 1); }

  function roundStart(s) {
    s.trail = new Uint8Array(GC * GR);
    s.riders = RIDERS.map((r, i) => ({
      x: r.x, y: r.y, dir: r.dir, alive: 1, id: i,
    }));
    s.pnext = RIDERS[0].dir;
    s.roundTick = 0;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, round: 1,
      trail: null, riders: [], pnext: 1, roundTick: 0,
      dead: 0,
      gameOver: 0,
      events: [],
    };
    roundStart(s);
    return s;
  }

  function cellOf(x, y) { return Math.trunc(y / CELL) * GC + Math.trunc(x / CELL); }
  function blockedAt(s, x, y) {
    if (x < 2 || x >= W - 2 || y < 2 || y >= H - 2) return 1;
    return s.trail[cellOf(x, y)];
  }

  // How far ahead is clear in a direction, capped — the AI's whisker.
  function clearance(s, x, y, dir, cap) {
    for (let d = CELL; d <= cap; d += CELL) {
      if (blockedAt(s, x + DX[dir] * d, y + DY[dir] * d)) return d;
    }
    return cap;
  }

  function aiSteer(s, r) {
    const ahead = clearance(s, r.x, r.y, r.dir, 120);
    if (ahead > 48 && rnd(s, 60) !== 0) return;   // occasional whimsy turn
    const options = [];
    for (let d = 0; d < 4; d++) {
      if (d === OPP[r.dir]) continue;
      options.push([d, clearance(s, r.x, r.y, d, 200)]);
    }
    options.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (options[0][1] > ahead || ahead <= 24) r.dir = options[0][0];
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) roundStart(s);
      return;
    }

    s.roundTick++;
    if (s.roundTick % 30 === 0) s.score += SURVIVE_PTS;

    if (input & 1) s.pnext = 0;
    else if (input & 2) s.pnext = 1;
    else if (input & 4) s.pnext = 2;
    else if (input & 8) s.pnext = 3;

    const spd = speed(s);
    const player = s.riders[0];
    if (player.alive && s.pnext !== OPP[player.dir]) player.dir = s.pnext;

    for (const r of s.riders) {
      if (!r.alive) continue;
      if (r.id !== 0) aiSteer(s, r);
      for (let step = 0; step < spd; step++) {
        // Trail is laid on the cell being LEFT — never on the head's own
        // cell, or every rider self-collides within its first pixel.
        const oldC = cellOf(r.x, r.y);
        const nx = r.x + DX[r.dir], ny = r.y + DY[r.dir];
        const hitWall = nx < 2 || nx >= W - 2 || ny < 2 || ny >= H - 2;
        const newC = hitWall ? -1 : cellOf(nx, ny);
        if (hitWall || (newC !== oldC && s.trail[newC])) {
          r.alive = 0;
          s.events.push({ t: "crash", id: r.id, x: r.x, y: r.y });
          if (r.id === 0) {
            s.lives--;
            if (s.lives <= 0) { s.gameOver = 1; return; }
            s.dead = 90;
            return;
          }
          s.score += KILL_PTS;
          break;
        }
        r.x = nx;
        r.y = ny;
        if (newC !== oldC) s.trail[oldC] = 1 + r.id;
      }
    }

    // Round won?
    if (s.riders[0].alive && s.riders.every((r) => r.id === 0 || !r.alive)) {
      s.score += ROUND_PTS;
      s.round++;
      s.events.push({ t: "round", round: s.round });
      roundStart(s);
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.round);
    mix(s.pnext); mix(s.roundTick); mix(s.dead); mix(s.rs); mix(s.gameOver);
    for (const r of s.riders) { mix(r.x); mix(r.y); mix(r.dir); mix(r.alive); }
    // Trail hashed sparsely — rider states pin the rest.
    for (let i = 0; i < s.trail.length; i += 97) mix(s.trail[i]);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, round: s.round, hash: stateHash(s), gameOver: s.gameOver };
  }

  function encodeRLE(masks) {
    const out = [];
    let i = 0;
    while (i < masks.length) {
      let j = i;
      while (j < masks.length && masks[j] === masks[i]) j++;
      out.push(masks[i], j - i);
      i = j;
    }
    return out;
  }
  function decodeRLE(rle) {
    const out = [];
    for (let i = 0; i < rle.length; i += 2) {
      for (let k = 0; k < rle[i + 1]; k++) out.push(rle[i]);
    }
    return out;
  }

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, W, H, CELL, GC, GR, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Gridlock;
