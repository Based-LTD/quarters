// SWARM — deterministic fixed-shooter core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=left 2=right 8=fire. 11x5 formation marches and descends,
// speeding up as it thins. Four erodable shields. UFO bonus crosses the top.
// Aliens reaching the baseline ends the game regardless of lives.
const Swarm = (() => {
  const W = 960, H = 720, FP = 8;
  const WF = W << FP;

  const COLS = 11, ROWS = 5;
  const SPACE_X = 64, SPACE_Y = 48;
  const START_X = 96, START_Y = 140;
  const ALIEN_W = 34, ALIEN_H = 24;
  const ROW_PTS = [30, 20, 20, 10, 10];
  const STEP_PX = 10, DROP_PX = 26;
  const BASELINE = 620;

  const PLAYER_Y = 660, PLAYER_W = 36, PLAYER_H = 16;
  const PLAYER_SPEED = 6 << FP;
  const BULLET_SPEED = 11;             // px per tick (integer px math for this game)
  const BOMB_SPEED = 5;

  const SHIELDS = 4, SH_CW = 8, SH_CH = 5, SH_CELL = 9; // 4 shields of 8x5 cells
  const SH_Y = 556;

  const UFO_Y = 96, UFO_SPEED = 3, UFO_W = 40;

  const START_LIVES = 3;
  const RESPAWN = 90;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function shieldX(i) { return 120 + i * 220; }

  function freshShields() {
    const sh = [];
    for (let i = 0; i < SHIELDS; i++) {
      const cells = [];
      for (let c = 0; c < SH_CW * SH_CH; c++) cells.push(1);
      sh.push(cells);
    }
    return sh;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, wave: 1,
      px: WF >> 1, dead: 0,
      bullet: null,                     // {x,y} integer px
      bombs: [],                        // {x,y}
      alive: [], ox: START_X, oy: START_Y, dir: 1,
      marchCd: 0, bombCd: 120,
      ufo: null, ufoTimer: 900,
      shields: freshShields(),
      gameOver: 0,
      events: [],
    };
    resetWave(s);
    return s;
  }

  function aliensLeft(s) {
    let n = 0;
    for (const a of s.alive) if (a) n++;
    return n;
  }

  function resetWave(s) {
    s.alive = [];
    for (let i = 0; i < COLS * ROWS; i++) s.alive.push(1);
    s.ox = START_X;
    s.oy = START_Y + Math.min((s.wave - 1) * 24, 120);
    s.dir = 1;
    s.marchCd = 3 + COLS * ROWS;
    s.bombs = [];
    s.bombCd = Math.max(28, 130 - s.wave * 12);
  }

  function alienPos(s, i) {
    const c = i % COLS, r = (i / COLS) | 0;
    return { x: s.ox + c * SPACE_X, y: s.oy + r * SPACE_Y, r };
  }

  function shieldCellAt(s, x, y) {
    if (y < SH_Y || y >= SH_Y + SH_CH * SH_CELL) return null;
    for (let i = 0; i < SHIELDS; i++) {
      const sx = shieldX(i);
      if (x < sx || x >= sx + SH_CW * SH_CELL) continue;
      const c = ((x - sx) / SH_CELL) | 0;
      const r = ((y - SH_Y) / SH_CELL) | 0;
      const idx = r * SH_CW + c;
      if (s.shields[i][idx]) return { shield: i, idx };
    }
    return null;
  }

  function killPlayer(s) {
    s.lives--;
    s.dead = RESPAWN;
    s.events.push({ t: "playerhit" });
    if (s.lives <= 0) s.gameOver = 1;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) s.dead--;
    else {
      if (input & 1) s.px -= PLAYER_SPEED;
      if (input & 2) s.px += PLAYER_SPEED;
      const half = (PLAYER_W / 2) << FP;
      if (s.px < half) s.px = half;
      if (s.px > WF - half) s.px = WF - half;
      if ((input & 8) && !s.bullet) {
        s.bullet = { x: s.px >> FP, y: PLAYER_Y - 12 };
        s.events.push({ t: "shoot" });
      }
    }

    // Player bullet
    if (s.bullet) {
      s.bullet.y -= BULLET_SPEED;
      const b = s.bullet;
      if (b.y < 60) s.bullet = null;
      else {
        const cell = shieldCellAt(s, b.x, b.y);
        if (cell) {
          s.shields[cell.shield][cell.idx] = 0;
          s.events.push({ t: "shieldhit" });
          s.bullet = null;
        } else if (s.ufo && b.y <= UFO_Y + 12 && b.y >= UFO_Y - 12 &&
                   b.x >= s.ufo.x - UFO_W / 2 && b.x <= s.ufo.x + UFO_W / 2) {
          const pts = 50 + rnd(s, 6) * 50;
          s.score += pts;
          s.events.push({ t: "ufo", pts, x: s.ufo.x });
          s.ufo = null;
          s.ufoTimer = 900 + rnd(s, 1200);
          s.bullet = null;
        } else {
          for (let i = 0; i < s.alive.length; i++) {
            if (!s.alive[i]) continue;
            const p = alienPos(s, i);
            if (b.x >= p.x - ALIEN_W / 2 && b.x <= p.x + ALIEN_W / 2 &&
                b.y >= p.y - ALIEN_H / 2 && b.y <= p.y + ALIEN_H / 2) {
              s.alive[i] = 0;
              s.score += ROW_PTS[p.r];
              s.events.push({ t: "alien", x: p.x, y: p.y, row: p.r });
              s.bullet = null;
              break;
            }
          }
        }
      }
    }

    // Formation march
    if (--s.marchCd <= 0) {
      const left = aliensLeft(s);
      if (left === 0) {
        s.wave++;
        s.events.push({ t: "wave", wave: s.wave });
        resetWave(s);
      } else {
        s.marchCd = 3 + left;
        // Formation extents among living aliens only.
        let minC = COLS, maxC = -1, maxR = -1;
        for (let i = 0; i < s.alive.length; i++) {
          if (!s.alive[i]) continue;
          const c = i % COLS, r = (i / COLS) | 0;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
          if (r > maxR) maxR = r;
        }
        const leftEdge = s.ox + minC * SPACE_X - ALIEN_W / 2;
        const rightEdge = s.ox + maxC * SPACE_X + ALIEN_W / 2;
        if ((s.dir > 0 && rightEdge + STEP_PX > W - 20) || (s.dir < 0 && leftEdge - STEP_PX < 20)) {
          s.dir = -s.dir;
          s.oy += DROP_PX;
          s.events.push({ t: "drop" });
        } else {
          s.ox += s.dir * STEP_PX;
        }
        s.events.push({ t: "march" });
        if (s.oy + maxR * SPACE_Y + ALIEN_H / 2 >= BASELINE) { s.gameOver = 1; s.events.push({ t: "invaded" }); return; }
      }
    }

    // Bombs
    if (--s.bombCd <= 0 && aliensLeft(s) > 0) {
      s.bombCd = Math.max(28, 130 - s.wave * 12) + rnd(s, 40);
      // Bottom-most living alien in a random living column drops.
      const cols = [];
      for (let c = 0; c < COLS; c++) {
        for (let r = ROWS - 1; r >= 0; r--) {
          if (s.alive[r * COLS + c]) { cols.push(r * COLS + c); break; }
        }
      }
      if (cols.length) {
        const p = alienPos(s, cols[rnd(s, cols.length)]);
        s.bombs.push({ x: p.x, y: p.y + ALIEN_H / 2 });
        s.events.push({ t: "bomb" });
      }
    }
    for (let i = s.bombs.length - 1; i >= 0; i--) {
      const b = s.bombs[i];
      b.y += BOMB_SPEED;
      if (b.y > H) { s.bombs.splice(i, 1); continue; }
      const cell = shieldCellAt(s, b.x, b.y);
      if (cell) {
        s.shields[cell.shield][cell.idx] = 0;
        s.events.push({ t: "shieldhit" });
        s.bombs.splice(i, 1);
        continue;
      }
      const pxp = s.px >> FP;
      if (s.dead === 0 && b.y >= PLAYER_Y - PLAYER_H && b.y <= PLAYER_Y + 6 &&
          b.x >= pxp - PLAYER_W / 2 && b.x <= pxp + PLAYER_W / 2) {
        s.bombs.splice(i, 1);
        killPlayer(s);
      }
    }

    // Aliens grind shields they overlap.
    for (let i = 0; i < s.alive.length; i++) {
      if (!s.alive[i]) continue;
      const p = alienPos(s, i);
      const cell = shieldCellAt(s, p.x, p.y + ALIEN_H / 2);
      if (cell) { s.shields[cell.shield][cell.idx] = 0; }
    }

    // UFO
    if (s.ufo) {
      s.ufo.x += s.ufo.vx;
      if (s.ufo.x < -50 || s.ufo.x > W + 50) {
        s.ufo = null;
        s.ufoTimer = 900 + rnd(s, 1200);
      }
    } else if (--s.ufoTimer <= 0 && aliensLeft(s) > 4) {
      const fromLeft = rnd(s, 2) === 0;
      s.ufo = { x: fromLeft ? -40 : W + 40, vx: fromLeft ? UFO_SPEED : -UFO_SPEED };
      s.events.push({ t: "ufo-in" });
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.wave);
    mix(s.px); mix(s.dead); mix(s.ox); mix(s.oy); mix(s.dir);
    mix(s.marchCd); mix(s.bombCd); mix(s.ufoTimer); mix(s.rs); mix(s.gameOver);
    if (s.bullet) { mix(s.bullet.x); mix(s.bullet.y); }
    for (const b of s.bombs) { mix(b.x); mix(b.y); }
    if (s.ufo) { mix(s.ufo.x); mix(s.ufo.vx); }
    for (let i = 0; i < s.alive.length; i += 32) {
      let bits = 0;
      for (let j = i; j < Math.min(i + 32, s.alive.length); j++) bits = (bits << 1) | s.alive[j];
      mix(bits);
    }
    for (const sh of s.shields) {
      for (let i = 0; i < sh.length; i += 32) {
        let bits = 0;
        for (let j = i; j < Math.min(i + 32, sh.length); j++) bits = (bits << 1) | sh[j];
        mix(bits);
      }
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
    return { score: s.score, ticks: s.tick, wave: s.wave, hash: stateHash(s), gameOver: s.gameOver };
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
    W, H, FP, COLS, ROWS, SPACE_X, SPACE_Y, ALIEN_W, ALIEN_H,
    SHIELDS, SH_CW, SH_CH, SH_CELL, SH_Y, shieldX, alienPos,
    PLAYER_Y, PLAYER_W, PLAYER_H, UFO_Y, UFO_W, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Swarm;
