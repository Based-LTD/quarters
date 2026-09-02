// HOPPER — deterministic lane-crossing core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask (edge-triggered hops): 1=left 2=right 4=up 8=down.
// Cross five road lanes, a median, five river lanes; ride the logs, fill all
// five home slots. Timer per attempt. 3 lives. Speeds scale per level.
const Hopper = (() => {
  const W = 960, H = 720, FP = 8;
  const WF = W << FP;
  const TILE = 60;
  const COLS = 16, ROWS = 12;
  const FROG_HALF = 22;               // px collision half-width
  const TIMER = 1800;                 // 30s per attempt
  const START_LIVES = 3;
  const MAX_TICKS = 36000;

  // Row map (y tile): 0 homes, 1-5 river, 6 median, 7-11 road, 12 start... but
  // ROWS=12 gives rows 0..11 — start row is 11, roads 6..10, median 5? Keep it
  // explicit instead:
  const ROW_HOME = 0;
  const RIVER_ROWS = [1, 2, 3, 4, 5];
  const ROW_MEDIAN = 6;
  const ROAD_ROWS = [7, 8, 9, 10];
  const ROW_START = 11;
  const HOME_COLS = [1, 4, 8, 11, 14];

  // Per-lane config: [row, dir, speed fp px/tick, entity width px, count]
  const LANES = [
    [1, 1, 210, 180, 3],   // long logs
    [2, -1, 300, 120, 3],  // turtles (ride)
    [3, 1, 160, 240, 2],   // longest logs
    [4, -1, 240, 120, 3],
    [5, 1, 340, 150, 3],
    [7, -1, 260, 70, 3],   // cars
    [8, 1, 200, 70, 3],
    [9, -1, 380, 100, 2],  // trucks
    [10, 1, 300, 70, 3],
  ];

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function laneSpeed(base, level) {
    return base + Math.trunc(base * 12 * (level - 1) / 100);
  }

  function buildLanes(s) {
    s.lanes = LANES.map(([row, dir, speed, w, count]) => {
      const ents = [];
      const spacing = Math.trunc(W / count);
      const jitter = rnd(s, spacing >> 1);
      for (let i = 0; i < count; i++) ents.push(((i * spacing + jitter) % W) << FP);
      return { row, dir, speed: laneSpeed(speed, s.level), w, ents, river: row <= 5 };
    });
  }

  function resetFrog(s) {
    s.fx = (W >> 1) << FP;
    s.frow = ROW_START;
    s.timer = TIMER;
    s.bestRow = ROW_START;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, level: 1,
      fx: 0, frow: ROW_START, bestRow: ROW_START,
      timer: TIMER, dead: 0, prevIn: 0,
      homes: [0, 0, 0, 0, 0],
      lanes: [],
      gameOver: 0,
      events: [],
    };
    buildLanes(s);
    resetFrog(s);
    return s;
  }

  function laneAt(s, row) {
    for (const l of s.lanes) if (l.row === row) return l;
    return null;
  }

  function onEntity(s, lane) {
    const fx = s.fx >> FP;
    for (const e of lane.ents) {
      const ex = e >> FP;
      // Entities can straddle the wrap seam.
      for (const off of [0, -W, W]) {
        if (fx >= ex + off - FROG_HALF && fx <= ex + off + lane.w + FROG_HALF) return true;
      }
    }
    return false;
  }

  function hitEntity(s, lane) {
    const fx = s.fx >> FP;
    for (const e of lane.ents) {
      const ex = e >> FP;
      for (const off of [0, -W, W]) {
        if (fx + FROG_HALF > ex + off && fx - FROG_HALF < ex + off + lane.w) return true;
      }
    }
    return false;
  }

  function kill(s, why) {
    s.lives--;
    s.events.push({ t: "die", why, x: s.fx >> FP, row: s.frow });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = 70;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    for (const l of s.lanes) {
      for (let i = 0; i < l.ents.length; i++) {
        l.ents[i] = ((l.ents[i] + l.dir * l.speed) % WF + WF) % WF;
      }
    }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) resetFrog(s);
      s.prevIn = input;
      return;
    }

    if (--s.timer <= 0) { kill(s, "time"); s.prevIn = input; return; }

    // Edge-triggered hops.
    const edge = input & ~s.prevIn;
    s.prevIn = input;
    if (edge & 1) s.fx -= TILE << FP;
    else if (edge & 2) s.fx += TILE << FP;
    else if (edge & 4) s.frow--;
    else if (edge & 8) s.frow = Math.min(ROW_START, s.frow + 1);
    if (edge & 15) s.events.push({ t: "hop" });

    // Ride the log after the hop resolves.
    const lane = laneAt(s, s.frow);
    if (lane && lane.river && onEntity(s, lane)) {
      s.fx += lane.dir * lane.speed;
    }

    if (s.fx < FROG_HALF << FP || s.fx > WF - (FROG_HALF << FP)) {
      if (lane && lane.river) { kill(s, "swept"); return; }
      s.fx = Math.max(FROG_HALF << FP, Math.min(WF - (FROG_HALF << FP), s.fx));
    }

    if (s.frow === ROW_HOME) {
      const fx = s.fx >> FP;
      let slot = -1;
      for (let i = 0; i < HOME_COLS.length; i++) {
        const cx = HOME_COLS[i] * TILE + (TILE >> 1);
        if (fx >= cx - 26 && fx <= cx + 26 && !s.homes[i]) slot = i;
      }
      if (slot >= 0) {
        s.homes[slot] = 1;
        s.score += 50 + Math.trunc(s.timer / 30);
        s.events.push({ t: "home", slot });
        if (s.homes.every((h) => h)) {
          s.score += 500;
          s.level++;
          s.homes = [0, 0, 0, 0, 0];
          buildLanes(s);
          s.events.push({ t: "level", level: s.level });
        }
        resetFrog(s);
      } else {
        kill(s, "wall");
      }
      return;
    }

    if (s.frow < s.bestRow) {
      s.score += 10 * (s.bestRow - s.frow);
      s.bestRow = s.frow;
      s.events.push({ t: "advance" });
    }

    if (lane) {
      if (lane.river) {
        if (!onEntity(s, lane)) { kill(s, "water"); return; }
      } else if (hitEntity(s, lane)) {
        kill(s, "car");
        return;
      }
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.level);
    mix(s.fx); mix(s.frow); mix(s.bestRow); mix(s.timer);
    mix(s.dead); mix(s.prevIn); mix(s.rs); mix(s.gameOver);
    for (const hm of s.homes) mix(hm);
    for (const l of s.lanes) for (const e of l.ents) mix(e);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, hash: stateHash(s), gameOver: s.gameOver };
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
    W, H, FP, TILE, ROW_HOME, ROW_MEDIAN, ROW_START, RIVER_ROWS, ROAD_ROWS, HOME_COLS, TIMER, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Hopper;
