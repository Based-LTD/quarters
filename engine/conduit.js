// CONDUIT — deterministic pipe-laying puzzle core for QUARTERS. Same
// contract: integer-only state, fixed 60Hz timestep, seeded RNG,
// score = f(seed, inputs).
// Input bitmask: 1/2/4/8 move cursor cell, 16=place tile (edge), 32=pump
// (flux flows 3x while held).
// The flux starts running when the countdown hits zero and never stops. You
// lay pipe ahead of it from a forced queue — every tile it crosses pays, and
// each level demands a longer run before the flux finds a dead end.
const Conduit = (() => {
  const W = 960, H = 720;
  const COLS = 11, ROWS = 7, TILE = 72;
  const OX = (W - COLS * TILE) >> 1, OY = 150;
  // Tiles: 0 empty, 1 H, 2 V, 3 NE, 4 NW, 5 SE, 6 SW, 7 cross, 8 source.
  // Sides: 0=N 1=E 2=S 3=W. exit = EXITS[tile][entrySide], -1 = no connection.
  const EXITS = [
    null,
    [-1, 3, -1, 1],      // H: enter E→exit W? no — enter FROM side, leave other
    [2, -1, 0, -1],      // V
    [1, 0, -1, -1],      // NE: N<->E
    [3, -1, -1, 0],      // NW: N<->W
    [-1, 2, 1, -1],      // SE: S<->E
    [-1, -1, 3, 2],      // SW: S<->W
    [2, 3, 0, 1],        // cross: straight through
  ];
  const DC = [0, 1, 0, -1], DR = [-1, 0, 1, 0];   // move toward side
  const QUEUE_N = 5;
  const MOVE_CD = 7;
  const COUNTDOWN = 540;
  const TILE_PTS = 10, GOAL_BONUS = 250;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }
  function gi(c, r) { return r * COLS + c; }
  function opp(side) { return side ^ 2; }

  function drawTileFromQueue(s) {
    // Straights and elbows evenly, the occasional cross.
    const roll = rnd(s, 15);
    if (roll < 2) return 7;
    return 1 + (roll % 6);
  }

  function genLevel(s) {
    s.grid = new Uint8Array(COLS * ROWS);
    s.locked = new Uint8Array(COLS * ROWS);
    s.src = {
      c: 2 + rnd(s, COLS - 4),
      r: 1 + rnd(s, ROWS - 2),
      dir: rnd(s, 4),
    };
    // Aim the source away from the nearest wall.
    if (s.src.c <= 2 && s.src.dir === 3) s.src.dir = 1;
    if (s.src.c >= COLS - 3 && s.src.dir === 1) s.src.dir = 3;
    if (s.src.r <= 1 && s.src.dir === 0) s.src.dir = 2;
    if (s.src.r >= ROWS - 2 && s.src.dir === 2) s.src.dir = 0;
    s.grid[gi(s.src.c, s.src.r)] = 8;
    s.locked[gi(s.src.c, s.src.r)] = 1;
    s.passes = new Uint8Array(COLS * ROWS);
    s.queue = [];
    for (let i = 0; i < QUEUE_N; i++) s.queue.push(drawTileFromQueue(s));
    s.cc = s.src.c;
    s.cr = Math.max(0, s.src.r - 1);
    s.flux = null;
    s.countdown = COUNTDOWN;
    s.goal = 6 + s.level * 2;
    s.dist = 0;
    s.flowT = Math.max(26, 80 - s.level * 6);
    s.events.push({ t: "level", level: s.level, goal: s.goal });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, level: 1,
      grid: null, locked: null, src: null, queue: [],
      cc: 0, cr: 0, moveCd: 0, prevIn: 0,
      flux: null, countdown: 0, goal: 0, dist: 0, flowT: 60,
      gameOver: 0,
      events: [],
    };
    genLevel(s);
    return s;
  }

  function endFlow(s) {
    if (s.dist >= s.goal) {
      const bonus = GOAL_BONUS * s.level + (s.dist - s.goal) * TILE_PTS * 2;
      s.score += bonus;
      s.events.push({ t: "goal", dist: s.dist, bonus });
      s.level++;
      genLevel(s);
    } else {
      s.events.push({ t: "spill", dist: s.dist, goal: s.goal });
      s.gameOver = 1;
    }
  }

  function advanceFlux(s) {
    const f = s.flux;
    f.p++;
    if (f.p < s.flowT) return;
    // Leave the current tile through its exit; enter the next.
    const tile = s.grid[gi(f.c, f.r)];
    const exitSide = tile === 8 ? s.src.dir : EXITS[tile][f.from];
    const nc = f.c + DC[exitSide], nr = f.r + DR[exitSide];
    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) { endFlow(s); return; }
    const ntile = s.grid[gi(nc, nr)];
    const nfrom = opp(exitSide);
    if (ntile === 0 || ntile === 8 || EXITS[ntile][nfrom] < 0) { endFlow(s); return; }
    f.c = nc; f.r = nr; f.from = nfrom; f.p = 0;
    const ni = gi(nc, nr);
    s.locked[ni] = 1;
    s.passes[ni]++;
    // A cross pays on both axes; a third visit anywhere is a closed loop —
    // the pipe bursts (no infinite point farm).
    if (s.passes[ni] > (ntile === 7 ? 2 : 1)) { endFlow(s); return; }
    s.dist++;
    s.score += TILE_PTS * s.level * (ntile === 7 && s.passes[ni] === 2 ? 2 : 1);
    s.events.push({ t: "flow", c: nc, r: nr, dist: s.dist });
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.moveCd > 0) s.moveCd--;
    if (s.moveCd === 0) {
      let moved = false;
      if (input & 1) { s.cc = Math.max(0, s.cc - 1); moved = true; }
      else if (input & 2) { s.cc = Math.min(COLS - 1, s.cc + 1); moved = true; }
      else if (input & 4) { s.cr = Math.max(0, s.cr - 1); moved = true; }
      else if (input & 8) { s.cr = Math.min(ROWS - 1, s.cr + 1); moved = true; }
      if (moved) s.moveCd = MOVE_CD;
    }

    const placeEdge = (input & 16) && !(s.prevIn & 16);
    s.prevIn = input;
    if (placeEdge) {
      const i = gi(s.cc, s.cr);
      if (s.locked[i]) {
        s.events.push({ t: "deny", c: s.cc, r: s.cr });
      } else {
        s.grid[i] = s.queue.shift();
        s.queue.push(drawTileFromQueue(s));
        s.events.push({ t: "place", c: s.cc, r: s.cr, tile: s.grid[i] });
      }
    }

    if (s.countdown > 0) {
      s.countdown--;
      if (s.countdown === 0) {
        s.flux = { c: s.src.c, r: s.src.r, from: opp(s.src.dir), p: 0 };
        s.events.push({ t: "start" });
      }
      return;
    }

    if (s.flux) {
      advanceFlux(s);
      if (!s.gameOver && s.flux && (input & 32)) { advanceFlux(s); if (!s.gameOver && s.flux) advanceFlux(s); }
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.level);
    mix(s.cc); mix(s.cr); mix(s.moveCd); mix(s.prevIn);
    mix(s.countdown); mix(s.goal); mix(s.dist); mix(s.flowT);
    mix(s.src.c); mix(s.src.r); mix(s.src.dir);
    mix(s.rs); mix(s.gameOver);
    if (s.flux) { mix(s.flux.c); mix(s.flux.r); mix(s.flux.from); mix(s.flux.p); }
    for (const q of s.queue) mix(q);
    for (let i = 0; i < s.grid.length; i++) mix(s.grid[i] * 9 + s.locked[i] * 3 + s.passes[i]);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, dist: s.dist, hash: stateHash(s), gameOver: s.gameOver };
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

  return {
    createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE,
    EXITS, DC, DR, opp,
    W, H, COLS, ROWS, TILE, OX, OY, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Conduit;
