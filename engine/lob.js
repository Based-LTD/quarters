// LOB — deterministic bubble-lobber puzzle core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=aim left 2=aim right 4=fire (edge) 8=swap current/next.
// Lob bubbles into the cluster hanging from the ceiling; three or more of a
// color pop, and anything they were holding up drops for double. The ceiling
// grinds down every few shots — and on a timer, so nobody camps. Clear the
// board to advance.
const Lob = (() => {
  const W = 960, H = 720, FP = 8;
  const COLS = 13, D = 64, R = 32, ROWH = 56;
  const OX = (W - COLS * D) >> 1;
  const ROWS = 12;
  const AIM_MIN = 148, AIM_MAX = 236;       // byte angle, 192 = straight up
  const SHOT_V = 18;                        // px/tick
  const KILL_Y = 620;
  const POP_PTS = 15, DROP_PTS = 30, CLEAR_BONUS = 500;
  const SHOTS_PER_GRIND = 6, GRIND_TICKS = 900;
  const MAX_TICKS = 36000;

  const QSIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function sin(a) {
    a &= 255;
    if (a < 64) return QSIN[a];
    if (a < 128) return QSIN[128 - a];
    if (a < 192) return -QSIN[a - 128];
    return -QSIN[256 - a];
  }
  function cos(a) { return sin(a + 64); }

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }
  function gi(c, r) { return r * COLS + c; }
  function rowCols(r) { return (r & 1) ? COLS - 1 : COLS; }
  function cellX(c, r) { return OX + R + c * D + ((r & 1) ? R : 0); }
  function cellY(s, r) { return 40 + s.grind * 14 + r * ROWH; }

  function neighbors(c, r) {
    const odd = r & 1;
    return odd
      ? [[c - 1, r], [c + 1, r], [c, r - 1], [c + 1, r - 1], [c, r + 1], [c + 1, r + 1]]
      : [[c - 1, r], [c + 1, r], [c - 1, r - 1], [c, r - 1], [c - 1, r + 1], [c, r + 1]];
  }

  function colorsIn(s) { return 4 + Math.min(2, s.level - 1); }

  function genLevel(s) {
    s.grid = new Uint8Array(COLS * ROWS);
    const K = colorsIn(s);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < rowCols(r); c++) {
        s.grid[gi(c, r)] = 1 + rnd(s, K);
      }
    }
    s.grind = 0;
    s.shotsLeft = SHOTS_PER_GRIND;
    s.grindCd = GRIND_TICKS;
    s.cur = 1 + rnd(s, K);
    s.next = 1 + rnd(s, K);
    s.shot = null;
    s.events.push({ t: "level", level: s.level });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, level: 1,
      angle: 192, prevIn: 0,
      grid: null, grind: 0, shotsLeft: 0, grindCd: 0,
      cur: 0, next: 0, shot: null,
      gameOver: 0,
      events: [],
    };
    genLevel(s);
    return s;
  }

  // Pure flight: where does a shot fired at `angle` snap? Returns {c, r} or
  // null (no reachable cell). No RNG — bots and the aim guide share it.
  function previewShot(s, angle) {
    let x = 480 << FP, y = 690 << FP;
    let vx = (cos(angle) * SHOT_V) >> 2, vy = (sin(angle) * SHOT_V) >> 2;
    for (let i = 0; i < 2000; i++) {
      x += vx; y += vy;
      const px = x >> FP, py = y >> FP;
      if (px < OX + R) { x = (OX + R) << FP; vx = -vx; }
      if (px > W - OX - R) { x = (W - OX - R) << FP; vx = -vx; }
      if (py <= cellY(s, 0)) return snapCell(s, x >> FP, py);
      for (let r = 0; r < ROWS; r++) {
        const cy = cellY(s, r);
        if (py < cy - D || py > cy + D) continue;
        for (let c = 0; c < rowCols(r); c++) {
          if (!s.grid[gi(c, r)]) continue;
          const dx = (x >> FP) - cellX(c, r), dy = py - cy;
          if (dx * dx + dy * dy < (D - 10) * (D - 10)) return snapCell(s, x >> FP, py);
        }
      }
    }
    return null;
  }

  function snapCell(s, px, py) {
    let best = null, bd = 0x7FFFFFFF;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < rowCols(r); c++) {
        if (s.grid[gi(c, r)]) continue;
        // Only cells attached to the ceiling or an occupied neighbor count.
        let ok = r === 0;
        if (!ok) {
          for (const [nc, nr] of neighbors(c, r)) {
            if (nc >= 0 && nr >= 0 && nr < ROWS && nc < rowCols(nr) && s.grid[gi(nc, nr)]) { ok = true; break; }
          }
        }
        if (!ok) continue;
        const dx = px - cellX(c, r), dy = py - cellY(s, r);
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = { c, r }; }
      }
    }
    return best;
  }

  function resolveLanding(s, cell, color) {
    s.grid[gi(cell.c, cell.r)] = color;
    // Flood the same-color group.
    const seen = new Set([gi(cell.c, cell.r)]);
    const stack = [[cell.c, cell.r]];
    while (stack.length) {
      const [c, r] = stack.pop();
      for (const [nc, nr] of neighbors(c, r)) {
        if (nc < 0 || nr < 0 || nr >= ROWS || nc >= rowCols(nr)) continue;
        const i = gi(nc, nr);
        if (!seen.has(i) && s.grid[i] === color) { seen.add(i); stack.push([nc, nr]); }
      }
    }
    if (seen.size >= 3) {
      for (const i of seen) s.grid[i] = 0;
      s.score += POP_PTS * seen.size * s.level;
      s.events.push({ t: "pop", n: seen.size, c: cell.c, r: cell.r, color });
      // Anything no longer connected to the ceiling drops.
      const held = new Set();
      const st2 = [];
      for (let c = 0; c < rowCols(0); c++) {
        if (s.grid[gi(c, 0)]) { held.add(gi(c, 0)); st2.push([c, 0]); }
      }
      while (st2.length) {
        const [c, r] = st2.pop();
        for (const [nc, nr] of neighbors(c, r)) {
          if (nc < 0 || nr < 0 || nr >= ROWS || nc >= rowCols(nr)) continue;
          const i = gi(nc, nr);
          if (s.grid[i] && !held.has(i)) { held.add(i); st2.push([nc, nr]); }
        }
      }
      let dropped = 0;
      for (let r = 1; r < ROWS; r++) {
        for (let c = 0; c < rowCols(r); c++) {
          const i = gi(c, r);
          if (s.grid[i] && !held.has(i)) {
            s.events.push({ t: "drop", c, r, color: s.grid[i] });
            s.grid[i] = 0;
            dropped++;
          }
        }
      }
      if (dropped) s.score += DROP_PTS * dropped * s.level;
    } else {
      s.events.push({ t: "stick", c: cell.c, r: cell.r, color });
    }

    // Board clear?
    let any = false;
    for (let i = 0; i < s.grid.length; i++) if (s.grid[i]) { any = true; break; }
    if (!any) {
      s.score += CLEAR_BONUS * s.level;
      s.events.push({ t: "clear", bonus: CLEAR_BONUS * s.level });
      s.level++;
      genLevel(s);
      return;
    }
    // Death line?
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < rowCols(r); c++) {
        if (s.grid[gi(c, r)] && cellY(s, r) + R >= KILL_Y) {
          s.events.push({ t: "crush" });
          s.gameOver = 1;
          return;
        }
      }
    }
  }

  function grind(s) {
    s.grind++;
    s.shotsLeft = SHOTS_PER_GRIND;
    s.grindCd = GRIND_TICKS;
    s.events.push({ t: "grind", grind: s.grind });
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < rowCols(r); c++) {
        if (s.grid[gi(c, r)] && cellY(s, r) + R >= KILL_Y) {
          s.events.push({ t: "crush" });
          s.gameOver = 1;
          return;
        }
      }
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (input & 1) s.angle = Math.max(AIM_MIN, s.angle - 1);
    if (input & 2) s.angle = Math.min(AIM_MAX, s.angle + 1);

    const fireEdge = (input & 4) && !(s.prevIn & 4);
    const swapEdge = (input & 8) && !(s.prevIn & 8);
    s.prevIn = input;

    if (swapEdge && !s.shot) {
      const t = s.cur; s.cur = s.next; s.next = t;
      s.events.push({ t: "swap" });
    }
    if (fireEdge && !s.shot) {
      s.shot = {
        x: 480 << FP, y: 690 << FP,
        vx: (cos(s.angle) * SHOT_V) >> 2, vy: (sin(s.angle) * SHOT_V) >> 2,
        color: s.cur,
      };
      s.cur = s.next;
      s.next = 1 + rnd(s, colorsIn(s));
      s.events.push({ t: "fire" });
      if (--s.shotsLeft <= 0) grind(s);
      if (s.gameOver) return;
    }

    if (s.shot) {
      const sh = s.shot;
      sh.x += sh.vx; sh.y += sh.vy;
      const px = sh.x >> FP, py = sh.y >> FP;
      if (px < OX + R) { sh.x = (OX + R) << FP; sh.vx = -sh.vx; }
      if (px > W - OX - R) { sh.x = (W - OX - R) << FP; sh.vx = -sh.vx; }
      let landed = py <= cellY(s, 0);
      if (!landed) {
        outer:
        for (let r = 0; r < ROWS; r++) {
          const cy = cellY(s, r);
          if (py < cy - D || py > cy + D) continue;
          for (let c = 0; c < rowCols(r); c++) {
            if (!s.grid[gi(c, r)]) continue;
            const dx = px - cellX(c, r), dy = py - cy;
            if (dx * dx + dy * dy < (D - 10) * (D - 10)) { landed = true; break outer; }
          }
        }
      }
      if (landed) {
        const cell = snapCell(s, px, py);
        const color = sh.color;
        s.shot = null;
        if (cell) resolveLanding(s, cell, color);
      }
    } else if (--s.grindCd <= 0) {
      grind(s);      // idle ceilings grind too — no camping
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.level);
    mix(s.angle); mix(s.prevIn); mix(s.grind); mix(s.shotsLeft); mix(s.grindCd);
    mix(s.cur); mix(s.next); mix(s.rs); mix(s.gameOver);
    if (s.shot) { mix(s.shot.x); mix(s.shot.y); mix(s.shot.vx); mix(s.shot.vy); mix(s.shot.color); }
    for (let i = 0; i < s.grid.length; i += 2) mix(s.grid[i] * 8 + (s.grid[i + 1] || 0));
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
    previewShot, neighbors, cellX, cellY, rowCols, sin, cos,
    W, H, FP, COLS, ROWS, D, R, ROWH, OX, AIM_MIN, AIM_MAX, KILL_Y, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Lob;
