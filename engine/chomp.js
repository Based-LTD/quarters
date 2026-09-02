// CHOMP — deterministic maze-chase core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask (buffered direction): 1=left 2=right 4=up 8=down.
// You are a gold coin; four wisps hunt you with distinct temperaments. Power
// pellets flip the hunt for a while. Clear the maze, it refills faster.
// Mechanics are genre-classic; character and art are our own.
const Chomp = (() => {
  const FP = 8;
  const TILE = 32;
  // 21 x 17. '#'=wall '.'=pellet 'o'=power ' '=open-no-pellet 'H'=wisp den
  // (den is wall to the player, open to wisps). Row 8 is the wrap tunnel.
  const MAZE = [
    "#####################",
    "#.........#.........#",
    "#o###.###.#.###.###o#",
    "#.....#...#...#.....#",
    "###.#.#.#####.#.#.###",
    "#...#.....H.....#...#",
    "#.#####.##H##.#####.#",
    "#.#.....#HHH#.....#.#",
    "  ..#.#.#HHH#.#.#..  ",
    "#.#.....#####.....#.#",
    "#.#####.......#####.#",
    "#...#....###....#...#",
    "###.#.#.#####.#.#.###",
    "#.....#...#...#.....#",
    "#o###.###.#.###.###o#",
    "#.........#.........#",
    "#####################",
  ];
  const COLS = 21, ROWS = 17;
  const TUNNEL_ROW = 8;
  const PLAYER_START = { c: 10, r: 10 };
  const WISP_STARTS = [{ c: 10, r: 7 }, { c: 9, r: 8 }, { c: 11, r: 8 }, { c: 10, r: 8 }];
  const WISP_RELEASE = [0, 240, 480, 720];
  const DEN_EXIT = { c: 10, r: 5 };

  const SPEED = 2, FRIGHT_SPEED = 1;   // px per tick; TILE % SPEED == 0
  const PELLET_PTS = 10, POWER_PTS = 50;
  const FRIGHT_TICKS = 480, FRIGHT_MIN = 180;
  const START_LIVES = 3;
  const RESPAWN = 90;
  const MAX_TICKS = 36000;

  const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];
  const OPP = [1, 0, 3, 2];
  const DIR_PRIORITY = [2, 0, 3, 1]; // up, left, down, right — classic tiebreak

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function cellAt(c, r) {
    if (r < 0 || r >= ROWS) return "#";
    if (c < 0) c += COLS;
    if (c >= COLS) c -= COLS;
    return MAZE[r][c];
  }
  function walkable(c, r, isWisp) {
    const ch = cellAt(c, r);
    if (ch === "#") return false;
    if (ch === "H") return !!isWisp;
    return true;
  }

  function freshPellets() {
    const p = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = MAZE[r][c];
        p.push(ch === "." ? 1 : ch === "o" ? 2 : 0);
      }
    }
    return p;
  }

  function countPellets(p) {
    let n = 0;
    for (const v of p) if (v) n++;
    return n;
  }

  function resetPositions(s) {
    s.px = PLAYER_START.c * TILE;
    s.py = PLAYER_START.r * TILE;
    s.pdir = 1; s.pnext = 1;
    s.wisps = WISP_STARTS.map((w, i) => ({
      x: w.c * TILE, y: w.r * TILE,
      dir: 2, release: WISP_RELEASE[i], eaten: 0, inDen: 1,
    }));
    s.fright = 0;
    s.chain = 0;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, level: 1,
      pellets: freshPellets(), left: 0,
      px: 0, py: 0, pdir: 1, pnext: 1,
      wisps: [], fright: 0, chain: 0,
      dead: 0,
      gameOver: 0,
      events: [],
    };
    s.left = countPellets(s.pellets);
    resetPositions(s);
    return s;
  }

  function aligned(e) { return e.x % TILE === 0 && e.y % TILE === 0; }
  function tileOf(e) { return { c: Math.trunc(e.x / TILE), r: Math.trunc(e.y / TILE) }; }

  function moveEntity(e, speed) {
    e.x += DX[e.dir] * speed;
    e.y += DY[e.dir] * speed;
    const max = COLS * TILE;
    if (e.x < -TILE + 1) e.x += max;
    if (e.x >= max) e.x -= max;
  }

  function wispTarget(s, i, w) {
    const pt = tileOf({ x: s.px, y: s.py });
    if (w.inDen || w.eaten) return DEN_EXIT;
    if (i === 0) return pt;                                       // chaser
    if (i === 1) {                                                // ambusher
      return { c: pt.c + DX[s.pdir] * 4, r: pt.r + DY[s.pdir] * 4 };
    }
    if (i === 2) {                                                // flanker
      const w0 = tileOf(s.wisps[0]);
      return { c: pt.c * 2 - w0.c, r: pt.r * 2 - w0.r };
    }
    const wt = tileOf(w);                                         // shy
    const d2 = (wt.c - pt.c) * (wt.c - pt.c) + (wt.r - pt.r) * (wt.r - pt.r);
    return d2 > 64 ? pt : { c: 1, r: 15 };
  }

  function chooseWispDir(s, i, w) {
    const t = tileOf(w);
    // Den cells are one-way: passable while leaving (or returning eaten),
    // walls once a wisp is loose — so the door only swings outward.
    const allowDen = !!(w.inDen || w.eaten);
    const options = [];
    for (const d of DIR_PRIORITY) {
      if (d === OPP[w.dir]) continue;
      if (walkable(t.c + DX[d], t.r + DY[d], allowDen)) options.push(d);
    }
    if (options.length === 0) return OPP[w.dir];
    if (s.fright > 0 && !w.eaten && !w.inDen) return options[rnd(s, options.length)];
    const target = wispTarget(s, i, w);
    let best = options[0], bestD = 0x7FFFFFFF;
    for (const d of options) {
      const dc = t.c + DX[d] - target.c, dr = t.r + DY[d] - target.r;
      const dist = dc * dc + dr * dr;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  function killPlayer(s) {
    s.lives--;
    s.events.push({ t: "die", x: s.px, y: s.py });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) resetPositions(s);
      return;
    }

    if (input & 1) s.pnext = 0;
    else if (input & 2) s.pnext = 1;
    else if (input & 4) s.pnext = 2;
    else if (input & 8) s.pnext = 3;

    if (s.fright > 0) {
      s.fright--;
      if (s.fright === 0) { s.chain = 0; s.events.push({ t: "fright-end" }); }
    }

    // Player: moves only while a direction is held — release to stop.
    const holding = (input & 15) !== 0;
    const pe = { x: s.px, y: s.py, dir: s.pdir };
    if (aligned(pe)) {
      const t = tileOf(pe);
      if (walkable(t.c + DX[s.pnext], t.r + DY[s.pnext], false)) s.pdir = s.pnext;
      pe.dir = s.pdir;
      if (!walkable(t.c + DX[s.pdir], t.r + DY[s.pdir], false)) pe.dir = -1;
    }
    if (holding && pe.dir >= 0) {
      moveEntity(pe, SPEED);
      s.px = pe.x; s.py = pe.y;
    }
    if (aligned({ x: s.px, y: s.py })) {
      const t = tileOf({ x: s.px, y: s.py });
      const idx = t.r * COLS + t.c;
      const v = s.pellets[idx];
      if (v === 1) {
        s.pellets[idx] = 0; s.left--; s.score += PELLET_PTS;
        s.events.push({ t: "pellet" });
      } else if (v === 2) {
        s.pellets[idx] = 0; s.left--; s.score += POWER_PTS;
        s.fright = Math.max(FRIGHT_MIN, FRIGHT_TICKS - (s.level - 1) * 60);
        s.chain = 0;
        for (const w of s.wisps) if (!w.inDen && !w.eaten) w.dir = OPP[w.dir];
        s.events.push({ t: "power" });
      }
      if (s.left === 0) {
        s.level++;
        s.pellets = freshPellets();
        s.left = countPellets(s.pellets);
        resetPositions(s);
        s.events.push({ t: "level", level: s.level });
        return;
      }
    }

    // Wisps
    for (let i = 0; i < s.wisps.length; i++) {
      const w = s.wisps[i];
      if (w.release > 0) { w.release--; continue; }
      if (w.inDen || w.eaten) {
        // Head for the den exit; on arrival, rejoin the hunt.
        if (aligned(w)) {
          const t = tileOf(w);
          if (t.c === DEN_EXIT.c && t.r === DEN_EXIT.r) { w.inDen = 0; w.eaten = 0; }
          else w.dir = chooseWispDir(s, i, w);
        }
        moveEntity(w, SPEED);
      } else {
        if (aligned(w)) w.dir = chooseWispDir(s, i, w);
        moveEntity(w, s.fright > 0 ? FRIGHT_SPEED : SPEED);
      }

      const dx = Math.abs(w.x - s.px), dy = Math.abs(w.y - s.py);
      if (dx < 20 && dy < 20 && !w.eaten && !w.inDen) {
        if (s.fright > 0) {
          s.chain++;
          const pts = 100 * (1 << s.chain);      // 200/400/800/1600
          s.score += pts;
          w.eaten = 1;
          w.release = 60;
          w.x = WISP_STARTS[i].c * TILE; w.y = WISP_STARTS[i].r * TILE;
          w.inDen = 1; w.dir = 2;
          s.events.push({ t: "wisp", pts });
        } else {
          killPlayer(s);
          return;
        }
      }
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.level); mix(s.left);
    mix(s.px); mix(s.py); mix(s.pdir); mix(s.pnext);
    mix(s.fright); mix(s.chain); mix(s.dead); mix(s.rs); mix(s.gameOver);
    for (const w of s.wisps) { mix(w.x); mix(w.y); mix(w.dir); mix(w.release); mix(w.eaten); mix(w.inDen); }
    for (let i = 0; i < s.pellets.length; i += 16) {
      let bits = 0;
      for (let j = i; j < Math.min(i + 16, s.pellets.length); j++) bits = (bits << 2) | s.pellets[j];
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
    return { score: s.score, ticks: s.tick, level: s.level, left: s.left, hash: stateHash(s), gameOver: s.gameOver };
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
    MAZE, COLS, ROWS, TILE, TUNNEL_ROW, PLAYER_START, WISP_STARTS, walkable, cellAt, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Chomp;
