// EXODUS — deterministic guide-them-home puzzle core for QUARTERS. Same
// contract: integer-only state, fixed 60Hz timestep, seeded RNG,
// score = f(seed, inputs).
// Input bitmask: 1/2/4/8 cursor, 16=assign job (edge), 32=cycle job (edge),
// 64=fast-forward (sim runs double while held). Bit 128 = pointer mode: the
// cursor position rides IN the input int (bits 8-17 = x, 18-27 = y), so a
// mouse-driven run replays from the same log as a keyboard one.
// Marchers pour from the hatch and walk until something stops them. You
// spend a fixed budget of jobs — BLOCK, BUILD, BASH, DIG — to route them to
// the exit. Levels are generated backwards from a walkable spine, so every
// level is solvable with exactly the budget you're given. Save 60% or the
// credit ends.
const Exodus = (() => {
  const W = 960, H = 720, FP = 8;
  const CELL = 4, GC = 240, GR = 180;
  const WALK_V = 96;                  // fp px/tick
  const FALL_V = 520;
  const CROSS_SPEED = 7 << FP;
  const SPLAT_PX = 95;                // fatal fall distance
  const SPAWN_EVERY = 42;
  const BUILD_N = 12, BASH_N = 18, DIG_N = 14;
  const BUILD_T = 12, BASH_T = 7, DIG_T = 9;
  const SAVE_PTS = 80, LEVEL_PTS = 20, QUOTA_PTS = 300;
  const JOBS = ["BLOCK", "BUILD", "BASH", "DIG"];
  const MAX_TICKS = 36000;
  // marcher states
  const WALK = 0, FALL = 1, BLOCK = 2, BUILD = 3, BASH = 4, DIG = 5;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }
  function ti(c, r) { return r * GC + c; }

  function solid(s, c, r) {
    if (c < 0 || c >= GC || r < 0 || r >= GR) return false;
    return s.terrain[ti(c, r)] > 0;
  }
  function fill(s, c0, r0, w, h, v) {
    for (let r = r0; r < r0 + h; r++) {
      if (r < 0 || r >= GR) continue;
      for (let c = c0; c < c0 + w; c++) {
        if (c < 0 || c >= GC) continue;
        s.terrain[ti(c, r)] = v;
      }
    }
  }

  // Level generation: lay a walkable spine left-to-right, planting obstacles
  // whose count exactly sets the job budget — solvable by construction.
  function genLevel(s) {
    s.terrain = new Uint8Array(GC * GR);
    s.marchers = [];
    let row = 44 + rnd(s, 16);
    let col = 6;
    s.budgets = [2, 0, 0, 0];        // blockers always available
    // Containment wall so fresh spawns can't amble off the left edge.
    fill(s, col - 2, row - 9, 2, 12, 1);
    s.hatch = { x: (col + 4) * CELL, y: (row - 5) * CELL };

    const plat = (len) => {
      const L = Math.min(len, GC - 10 - col);
      if (L > 0) fill(s, col, row, L, 3, 1);
      col += Math.max(0, L);
    };
    const drop = () => {
      row = Math.min(166, row + 7 + rnd(s, 8));
      // Tuck the lower platform under the seam so a reversed walker falling
      // off it backwards lands on floor, not in the void.
      col = Math.max(6, col - 3);
    };

    plat(13 + rnd(s, 6));
    // Scenic descent even on featureless levels — the walk should be a journey.
    const scenic = 2 + rnd(s, 2);
    for (let i = 0; i < scenic; i++) { drop(); plat(10 + rnd(s, 8)); }
    const nFeatures = Math.min(6, s.level - 1);
    for (let i = 0; i < nFeatures && col < 200; i++) {
      const f = 1 + rnd(s, 3);
      if (f === 1 && row - 10 > 14) {
        // Gap: builder bridges it diagonally, so the far side sits higher.
        const gw = 5 + rnd(s, 4);
        col += gw;
        row -= gw;
        s.budgets[1]++;
      } else if (f === 2) {
        // Wall: short enough to bash through.
        fill(s, col, row - 7, 3, 10, 1);
        col += 3;
        s.budgets[2]++;
      } else {
        // Plug: a cap too thick to bash — dig down through the floor.
        fill(s, col, row - 16, 22, 19, 1);
        const row2 = Math.min(166, row + 9 + rnd(s, 5));
        fill(s, col - 14, row2, 40, 3, 1);
        row = row2;
        col += 26;
        s.budgets[3]++;
      }
      plat(9 + rnd(s, 8));
      if (rnd(s, 2) && col < 190) { drop(); plat(9 + rnd(s, 6)); }
    }
    plat(14);
    s.exit = { c: Math.min(GC - 6, col - 7), r: row };
    s.total = 8 + Math.min(6, s.level);
    s.spawnLeft = s.total;
    s.spawnCd = 30;
    s.saved = 0;
    s.dead = 0;
    s.levelTick = 0;
    s.levelTime = 4200 + nFeatures * 600;
    s.events.push({ t: "level", level: s.level, total: s.total, budgets: s.budgets.slice() });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, level: 1,
      cx: 300 << FP, cy: 200 << FP, jobSel: 0, prevIn: 0,
      terrain: null, marchers: [], budgets: [0, 0, 0, 0],
      hatch: null, exit: null,
      total: 0, spawnLeft: 0, spawnCd: 0, saved: 0, dead: 0,
      levelTick: 0, levelTime: 0,
      gameOver: 0,
      events: [],
    };
    genLevel(s);
    return s;
  }

  function land(s, m, row) {
    const dist = row * CELL - m.fs;
    m.y = (row * CELL) << FP;
    if (dist > SPLAT_PX) {
      m.st = -1;
      s.dead++;
      s.events.push({ t: "splat", x: m.x >> FP, y: m.y >> FP });
    } else {
      m.st = WALK;
    }
  }

  function stepMarcher(s, m) {
    const px = m.x >> FP, py = m.y >> FP;
    const col = Math.trunc(px / CELL), row = Math.trunc(py / CELL);

    // The exit takes anyone who reaches it on foot.
    if (m.st !== FALL && Math.abs(px - (s.exit.c * CELL + 6)) < 8 && Math.abs(row - s.exit.r) <= 1) {
      m.st = -2;
      s.saved++;
      s.score += SAVE_PTS + LEVEL_PTS * s.level;
      s.events.push({ t: "saved", x: px, y: py });
      return;
    }

    if (m.st === FALL) {
      const ny = m.y + FALL_V;
      const nrow = Math.trunc((ny >> FP) / CELL);
      if (ny >> FP > H + 10) {
        m.st = -1;
        s.dead++;
        s.events.push({ t: "lost", x: px });
        return;
      }
      if (solid(s, col, nrow)) { land(s, m, nrow); return; }
      m.y = ny;
      return;
    }

    if (m.st === BLOCK) return;

    if (m.st === BUILD) {
      if (--m.t > 0) return;
      m.t = BUILD_T;
      const nc = col + m.dir;
      if (m.n <= 0 || nc < 1 || nc >= GC - 1 || solid(s, nc, row - 1) || solid(s, nc, row - 3)) {
        m.st = WALK;
        return;
      }
      s.terrain[ti(nc, row - 1)] = 2;
      m.n--;
      m.x = (nc * CELL + 2) << FP;
      m.y = ((row - 1) * CELL) << FP;
      s.events.push({ t: "build", c: nc, r: row - 1 });
      return;
    }

    if (m.st === BASH) {
      const nc = col + m.dir;
      let wall = false;
      for (let r = row - 4; r <= row - 1; r++) if (solid(s, nc, r)) wall = true;
      if (wall) {
        if (--m.t > 0) return;
        m.t = BASH_T;
        for (let r = row - 4; r <= row - 1; r++) if (solid(s, nc, r)) s.terrain[ti(nc, r)] = 0;
        m.n--;
        m.x = (nc * CELL + 2) << FP;
        s.events.push({ t: "bash", c: nc, r: row - 2 });
        if (m.n <= 0) m.st = WALK;
        return;
      }
      if (m.n < BASH_N) { m.st = WALK; return; }   // came out the far side
      walkStep(s, m, col, row, px, py);            // no wall yet: march to it
      return;
    }

    if (m.st === DIG) {
      if (--m.t > 0) return;
      m.t = DIG_T;
      let hit = false;
      for (let c = col - 1; c <= col + 1; c++) {
        if (solid(s, c, row)) { s.terrain[ti(c, row)] = 0; hit = true; }
      }
      if (!hit) { m.st = WALK; return; }
      m.n--;
      s.events.push({ t: "dig", c: col, r: row });
      if (solid(s, col, row + 1)) {
        m.y = ((row + 1) * CELL) << FP;
        if (m.n <= 0) m.st = WALK;
      } else {
        m.st = FALL;
        m.fs = m.y >> FP;
      }
      return;
    }

    // WALK
    walkStep(s, m, col, row, px, py);
  }

  function walkStep(s, m, col, row, px, py) {
    if (!solid(s, col, row)) { m.st = FALL; m.fs = py; return; }
    // Blockers turn walkers around.
    for (const b of s.marchers) {
      if (b === m || b.st !== BLOCK) continue;
      const bx = b.x >> FP;
      if (Math.abs(bx - px) < 6 && Math.abs((b.y >> FP) - py) < 10 && Math.sign(bx - px) === m.dir) {
        m.dir = -m.dir;
        break;
      }
    }
    const nx = m.x + m.dir * WALK_V;
    const ncol = Math.trunc((nx >> FP) / CELL);
    if (ncol < 1 || ncol >= GC - 1) { m.dir = -m.dir; return; }
    if (ncol === col) { m.x = nx; return; }
    if (solid(s, ncol, row - 1)) {
      if (!solid(s, ncol, row - 2)) {
        m.x = nx; m.y = ((row - 1) * CELL) << FP;         // step up 1
      } else if (!solid(s, ncol, row - 3)) {
        m.x = nx; m.y = ((row - 2) * CELL) << FP;         // step up 2
      } else {
        m.dir = -m.dir;                                   // a wall
      }
    } else if (solid(s, ncol, row)) {
      m.x = nx;                                           // flat ground
    } else if (solid(s, ncol, row + 1)) {
      m.x = nx; m.y = ((row + 1) * CELL) << FP;           // step down 1
    } else if (solid(s, ncol, row + 2)) {
      m.x = nx; m.y = ((row + 2) * CELL) << FP;           // step down 2
    } else {
      m.x = nx; m.st = FALL; m.fs = py;                   // walked off an edge
    }
  }

  function simStep(s) {
    s.levelTick++;
    if (s.spawnLeft > 0 && --s.spawnCd <= 0) {
      s.spawnCd = SPAWN_EVERY;
      s.spawnLeft--;
      s.marchers.push({ x: s.hatch.x << FP, y: s.hatch.y << FP, dir: 1, st: FALL, fs: s.hatch.y, t: 0, n: 0 });
      s.events.push({ t: "spawn" });
    }
    for (const m of s.marchers) {
      if (m.st >= 0) stepMarcher(s, m);
    }
    // Level resolves when everyone is accounted for or the clock runs out.
    const resolved = s.saved + s.dead;
    const activeDone = s.spawnLeft === 0 && resolved >= s.total;
    if (activeDone || s.levelTick >= s.levelTime) {
      if (!activeDone) {
        // Stragglers (blocked, pacing, still walking) are lost.
        for (const m of s.marchers) if (m.st >= 0) { m.st = -1; s.dead++; }
      }
      if (s.saved * 5 >= s.total * 3) {
        const timeBonus = Math.trunc(Math.max(0, s.levelTime - s.levelTick) / 10);
        s.score += QUOTA_PTS * s.level + timeBonus;
        s.events.push({ t: "quota", saved: s.saved, total: s.total, bonus: QUOTA_PTS * s.level + timeBonus });
        s.level++;
        genLevel(s);
      } else {
        s.events.push({ t: "failed", saved: s.saved, total: s.total });
        s.gameOver = 1;
      }
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (input & 128) {
      s.cx = ((input >> 8) & 1023) << FP;
      s.cy = ((input >> 18) & 1023) << FP;
    } else {
      if (input & 1) s.cx -= CROSS_SPEED;
      if (input & 2) s.cx += CROSS_SPEED;
      if (input & 4) s.cy -= CROSS_SPEED;
      if (input & 8) s.cy += CROSS_SPEED;
    }
    if (s.cx < 8 << FP) s.cx = 8 << FP;
    if (s.cx > (W - 8) << FP) s.cx = (W - 8) << FP;
    if (s.cy < 8 << FP) s.cy = 8 << FP;
    if (s.cy > (H - 8) << FP) s.cy = (H - 8) << FP;

    const cycleEdge = (input & 32) && !(s.prevIn & 32);
    const assignEdge = (input & 16) && !(s.prevIn & 16);
    s.prevIn = input;

    if (cycleEdge) {
      s.jobSel = (s.jobSel + 1) % 4;
      s.events.push({ t: "job", job: s.jobSel });
    }
    if (assignEdge) {
      if (s.budgets[s.jobSel] > 0) {
        const cx = s.cx >> FP, cy = s.cy >> FP;
        let best = null, bd = 48 * 48;
        for (const m of s.marchers) {
          if (m.st !== WALK) continue;
          const dx = (m.x >> FP) - cx, dy = (m.y >> FP) - 8 - cy;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = m; }
        }
        if (best) {
          s.budgets[s.jobSel]--;
          if (s.jobSel === 0) best.st = BLOCK;
          else if (s.jobSel === 1) { best.st = BUILD; best.t = BUILD_T; best.n = BUILD_N; }
          else if (s.jobSel === 2) { best.st = BASH; best.t = BASH_T; best.n = BASH_N; }
          else { best.st = DIG; best.t = DIG_T; best.n = DIG_N; }
          s.events.push({ t: "assign", job: s.jobSel, x: best.x >> FP, y: best.y >> FP });
        } else {
          s.events.push({ t: "noassign" });
        }
      } else {
        s.events.push({ t: "nobudget", job: s.jobSel });
      }
    }

    simStep(s);
    if (!s.gameOver && (input & 64)) simStep(s);   // fast-forward
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.level);
    mix(s.cx); mix(s.cy); mix(s.jobSel); mix(s.prevIn);
    mix(s.total); mix(s.spawnLeft); mix(s.spawnCd); mix(s.saved); mix(s.dead);
    mix(s.levelTick); mix(s.rs); mix(s.gameOver);
    for (const b of s.budgets) mix(b);
    for (const m of s.marchers) { mix(m.x); mix(m.y); mix(m.dir); mix(m.st); mix(m.t); mix(m.n); mix(m.fs); }
    for (let i = 0; i < s.terrain.length; i += 13) mix(s.terrain[i] + i);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, saved: s.saved, hash: stateHash(s), gameOver: s.gameOver };
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
    W, H, FP, CELL, GC, GR, JOBS, MAX_TICKS,
    WALK, FALL, BLOCK, BUILD, BASH, DIG,
  };
})();
if (typeof module !== "undefined") module.exports = Exodus;
