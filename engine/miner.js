// MINER — deterministic dig-and-dodge core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask (hold to move): 1=left 2=right 4=up 8=down.
// Dig through the dirt, collect gold nuggets, don't stand where a boulder is
// about to be. Meet the quota and the exit opens; nuggets past quota pay
// extra — greed is the risk lever. Classic falling-object rules: things fall
// into empty space and roll off round things. Three lives, level restarts.
const Miner = (() => {
  const COLS = 30, ROWS = 20, TILE = 32;
  // Cell codes
  const EMPTY = 0, DIRT = 1, WALL = 2, BOULDER = 3, NUGGET = 4, EXIT = 5;
  const SPEED = 4;                 // px/tick; TILE % SPEED == 0
  const QUOTA = 10;
  const NUGGET_PTS = 25, EXTRA_PTS = 50, CLEAR_PTS = 200;
  const LEVEL_TIME = 3600;         // 60s
  const START_LIVES = 3;
  const RESPAWN = 80;
  const MAX_TICKS = 36000;

  const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function idx(c, r) { return r * COLS + c; }

  // Level layout comes from its own RNG stream so a restart rebuilds the
  // exact same cave.
  function genLevel(s) {
    const g = { rs: s.levelSeed | 0 };
    const grid = new Array(COLS * ROWS).fill(DIRT);
    for (let c = 0; c < COLS; c++) { grid[idx(c, 0)] = WALL; grid[idx(c, ROWS - 1)] = WALL; }
    for (let r = 0; r < ROWS; r++) { grid[idx(0, r)] = WALL; grid[idx(COLS - 1, r)] = WALL; }
    // Interior walls for structure.
    for (let i = 0; i < 26; i++) {
      grid[idx(1 + rnd(g, COLS - 2), 1 + rnd(g, ROWS - 2))] = WALL;
    }
    // Boulders and nuggets scattered in the dirt.
    for (let i = 0; i < 42; i++) {
      const c = 1 + rnd(g, COLS - 2), r = 1 + rnd(g, ROWS - 3);
      if (grid[idx(c, r)] === DIRT) grid[idx(c, r)] = BOULDER;
    }
    let nuggets = 0;
    for (let guard = 0; guard < 400 && nuggets < 16; guard++) {
      const c = 1 + rnd(g, COLS - 2), r = 1 + rnd(g, ROWS - 2);
      if (grid[idx(c, r)] === DIRT) { grid[idx(c, r)] = NUGGET; nuggets++; }
    }
    // Player start pocket top-left; exit bottom-right.
    grid[idx(2, 2)] = EMPTY;
    grid[idx(3, 2)] = EMPTY;
    grid[idx(2, 3)] = EMPTY;
    grid[idx(COLS - 3, ROWS - 3)] = EXIT;
    s.grid = grid;
    s.falling = new Array(COLS * ROWS).fill(0);
    s.px = 2 * TILE; s.py = 2 * TILE;
    s.pdir = 1;
    s.got = 0;
    s.exitOpen = 0;
    s.timer = LEVEL_TIME;
    s.invuln = INVULN_START;
  }
  const INVULN_START = 60;

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, level: 1,
      levelSeed: (seed ^ 0x9A7B) | 0,
      grid: [], falling: [],
      px: 0, py: 0, pdir: 1, got: 0, exitOpen: 0, timer: LEVEL_TIME,
      invuln: 0, dead: 0,
      gameOver: 0,
      events: [],
    };
    genLevel(s);
    return s;
  }

  function aligned(s) { return s.px % TILE === 0 && s.py % TILE === 0; }
  function ptile(s) { return { c: Math.trunc(s.px / TILE), r: Math.trunc(s.py / TILE) }; }

  function kill(s) {
    s.lives--;
    s.events.push({ t: "die", x: s.px, y: s.py });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  // Falling-object physics: bottom-up scan; a round thing falls into empty
  // space below, or rolls sideways off another round thing. Runs at 8Hz so
  // falls are readable.
  function physics(s) {
    const pt = ptile(s);
    for (let r = ROWS - 2; r >= 1; r--) {
      for (let c = 1; c < COLS - 1; c++) {
        const i = idx(c, r);
        const v = s.grid[i];
        if (v !== BOULDER && v !== NUGGET) continue;
        const below = idx(c, r + 1);
        const isRoundBelow = s.grid[below] === BOULDER || s.grid[below] === NUGGET;
        if (s.grid[below] === EMPTY && !(pt.c === c && pt.r === r + 1)) {
          s.grid[below] = v;
          s.grid[i] = EMPTY;
          s.falling[below] = 1;
          s.falling[i] = 0;
        } else if (s.falling[i] && pt.c === c && pt.r === r + 1) {
          // A falling thing entering the player's cell: crushed.
          if (s.dead === 0 && s.invuln === 0) { kill(s); return; }
        } else if (isRoundBelow) {
          // Roll left or right off a round pile.
          const L = idx(c - 1, r), LB = idx(c - 1, r + 1);
          const R = idx(c + 1, r), RB = idx(c + 1, r + 1);
          if (s.grid[L] === EMPTY && s.grid[LB] === EMPTY && !(pt.c === c - 1 && pt.r === r)) {
            s.grid[L] = v; s.grid[i] = EMPTY; s.falling[L] = 1; s.falling[i] = 0;
          } else if (s.grid[R] === EMPTY && s.grid[RB] === EMPTY && !(pt.c === c + 1 && pt.r === r)) {
            s.grid[R] = v; s.grid[i] = EMPTY; s.falling[R] = 1; s.falling[i] = 0;
          } else {
            s.falling[i] = 0;
          }
        } else {
          s.falling[i] = 0;
        }
      }
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) genLevel(s);   // level restarts, same cave
      return;
    }
    if (s.invuln > 0) s.invuln--;

    if (--s.timer <= 0) { kill(s); return; }

    // Movement: hold-to-move, tile-aligned; digging is just walking into dirt.
    let want = -1;
    if (input & 1) want = 0;
    else if (input & 2) want = 1;
    else if (input & 4) want = 2;
    else if (input & 8) want = 3;

    if (aligned(s)) {
      if (want >= 0) {
        const pt = ptile(s);
        const nc = pt.c + DX[want], nr = pt.r + DY[want];
        const nv = s.grid[idx(nc, nr)];
        if (nv === DIRT || nv === EMPTY || nv === NUGGET || (nv === EXIT && s.exitOpen)) {
          s.pdir = want;
          if (nv === DIRT) { s.grid[idx(nc, nr)] = EMPTY; s.events.push({ t: "dig" }); }
          if (nv === NUGGET) {
            s.grid[idx(nc, nr)] = EMPTY;
            s.got++;
            s.score += s.got > QUOTA ? EXTRA_PTS : NUGGET_PTS;
            s.events.push({ t: "nugget", extra: s.got > QUOTA, n: s.got });
            if (s.got === QUOTA) { s.exitOpen = 1; s.events.push({ t: "exit-open" }); }
          }
          if (nv === EXIT && s.exitOpen) {
            s.score += CLEAR_PTS + Math.trunc(s.timer / 20);
            s.level++;
            s.levelSeed = (s.levelSeed + 0x5DEECE) | 0;
            s.events.push({ t: "clear", level: s.level });
            genLevel(s);
            return;
          }
          s.px += DX[want] * SPEED;
          s.py += DY[want] * SPEED;
        } else {
          s.pdir = want;
        }
      }
    } else {
      s.px += DX[s.pdir] * SPEED;
      s.py += DY[s.pdir] * SPEED;
    }

    if (s.tick % 8 === 0) physics(s);
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.level); mix(s.levelSeed);
    mix(s.px); mix(s.py); mix(s.pdir); mix(s.got); mix(s.exitOpen);
    mix(s.timer); mix(s.invuln); mix(s.dead); mix(s.rs); mix(s.gameOver);
    for (let i = 0; i < s.grid.length; i += 10) {
      let bits = 0;
      for (let j = i; j < Math.min(i + 10, s.grid.length); j++) bits = bits * 7 + s.grid[j];
      mix(bits);
    }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, got: s.got, hash: stateHash(s), gameOver: s.gameOver };
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
    COLS, ROWS, TILE, QUOTA, EMPTY, DIRT, WALL, BOULDER, NUGGET, EXIT, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Miner;
