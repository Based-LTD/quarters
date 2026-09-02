// MYRIAPOD — deterministic garden-shooter core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=left 2=right 4=up 8=down 16=fire.
// A segmented myriapod weaves down through the mushrooms; every hit turns a
// segment into a mushroom and splits the chain. The spider hunts your zone
// and eats the cover. Clear the whole chain and a faster one arrives angrier.
const Myriapod = (() => {
  const W = 960, H = 720, FP = 8;
  const CELL = 24, COLS = 40, ROWS = 30;
  const ZONE_TOP = 24;                 // player confined to rows 24..29
  const PLAYER_SPEED = 5 << FP;
  const BULLET_SPEED = 14;             // px/tick, integer px
  const FIRE_CD = 8;
  const MUSH_HP = 4;
  const SEG_PTS = 10, HEAD_PTS = 100, SPIDER_PTS = 600, MUSH_CLEAR_PTS = 5;
  const START_LIVES = 3;
  const RESPAWN = 90;
  const INVULN = 120;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function mi(c, r) { return r * COLS + c; }

  function seedMushrooms(s) {
    s.mush = new Array(COLS * ROWS).fill(0);
    for (let i = 0; i < 60; i++) {
      const c = rnd(s, COLS), r = 1 + rnd(s, ZONE_TOP - 2);
      s.mush[mi(c, r)] = MUSH_HP;
    }
  }

  function spawnChain(s) {
    const len = Math.min(12, 8 + s.wave);
    const cells = [];
    for (let i = 0; i < len; i++) cells.push({ c: 19 - i, r: 0 });
    s.chains = [{ cells, dir: 1, dropping: 0 }];
    s.moveEvery = Math.max(3, 7 - (s.wave >> 1));
    s.moveCd = s.moveEvery;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, wave: 1,
      px: (W >> 1) << FP, py: (H - 40) << FP,
      fireCd: 0, invuln: INVULN, dead: 0,
      bullet: null,
      mush: [], chains: [], moveEvery: 7, moveCd: 7,
      spider: null, spiderTimer: 600,
      gameOver: 0,
      events: [],
    };
    seedMushrooms(s);
    spawnChain(s);
    return s;
  }

  function kill(s) {
    s.lives--;
    s.events.push({ t: "die", x: s.px >> FP, y: s.py >> FP });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  function stepChains(s) {
    for (const ch of s.chains) {
      for (let i = ch.cells.length - 1; i > 0; i--) {
        ch.cells[i] = { ...ch.cells[i - 1] };
      }
      const head = ch.cells[0];
      const nc = head.c + ch.dir;
      if (nc < 0 || nc >= COLS || (head.r < ROWS && s.mush[mi(nc, head.r)] > 0)) {
        // Blocked: drop a row and reverse — the classic weave.
        let nr = head.r + 1;
        if (nr >= ROWS) nr = ZONE_TOP;   // reached the floor: cycle the zone
        ch.cells[0] = { c: head.c, r: nr };
        ch.dir = -ch.dir;
      } else {
        ch.cells[0] = { c: nc, r: head.r };
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
      if (s.dead === 0) {
        s.px = (W >> 1) << FP;
        s.py = (H - 40) << FP;
        s.invuln = INVULN;
      }
      return;
    }
    if (s.invuln > 0) s.invuln--;
    if (s.fireCd > 0) s.fireCd--;

    // Player: free movement inside the bottom zone.
    if (input & 1) s.px -= PLAYER_SPEED;
    if (input & 2) s.px += PLAYER_SPEED;
    if (input & 4) s.py -= PLAYER_SPEED;
    if (input & 8) s.py += PLAYER_SPEED;
    const minX = 12 << FP, maxX = (W - 12) << FP;
    const minY = (ZONE_TOP * CELL + 12) << FP, maxY = (H - 12) << FP;
    if (s.px < minX) s.px = minX;
    if (s.px > maxX) s.px = maxX;
    if (s.py < minY) s.py = minY;
    if (s.py > maxY) s.py = maxY;

    if ((input & 16) && s.fireCd === 0 && !s.bullet) {
      s.fireCd = FIRE_CD;
      s.bullet = { x: s.px >> FP, y: (s.py >> FP) - 12 };
      s.events.push({ t: "fire" });
    }

    // Bullet
    if (s.bullet) {
      const b = s.bullet;
      b.y -= BULLET_SPEED;
      if (b.y < 0) s.bullet = null;
      else {
        const c = Math.trunc(b.x / CELL), r = Math.trunc(b.y / CELL);
        if (r >= 0 && r < ROWS && s.mush[mi(c, r)] > 0) {
          s.mush[mi(c, r)]--;
          if (s.mush[mi(c, r)] === 0) { s.score += MUSH_CLEAR_PTS; s.events.push({ t: "mushdown", c, r }); }
          else s.events.push({ t: "mushhit", c, r });
          s.bullet = null;
        } else {
          // Segment hit?
          outer:
          for (let ci = 0; ci < s.chains.length; ci++) {
            const ch = s.chains[ci];
            for (let si = 0; si < ch.cells.length; si++) {
              const cell = ch.cells[si];
              if (cell.c === c && cell.r === r) {
                s.bullet = null;
                s.score += si === 0 ? HEAD_PTS : SEG_PTS;
                s.events.push({ t: "seg", c, r, head: si === 0 });
                if (r >= 0 && r < ROWS) s.mush[mi(c, r)] = MUSH_HP;
                const tail = ch.cells.slice(si + 1);
                ch.cells = ch.cells.slice(0, si);
                if (tail.length) s.chains.push({ cells: tail, dir: -ch.dir, dropping: 0 });
                if (ch.cells.length === 0) s.chains.splice(ci, 1);
                break outer;
              }
            }
          }
        }
        // Spider hit?
        if (s.bullet && s.spider) {
          const dx = s.bullet.x - (s.spider.x >> FP), dy = s.bullet.y - (s.spider.y >> FP);
          if (dx * dx + dy * dy < 18 * 18) {
            s.bullet = null;
            s.score += SPIDER_PTS;
            s.events.push({ t: "spider", x: s.spider.x >> FP, y: s.spider.y >> FP });
            s.spider = null;
            s.spiderTimer = 500 + rnd(s, 500);
          }
        }
      }
    }

    // Chains march
    if (--s.moveCd <= 0) {
      s.moveCd = s.moveEvery;
      stepChains(s);
      s.events.push({ t: "march" });
    }

    // Spider
    if (s.spider) {
      const sp = s.spider;
      sp.x += sp.vx;
      sp.y += sp.vy;
      if (sp.x < 12 << FP || sp.x > (W - 12) << FP) sp.vx = -sp.vx;
      if (sp.y < (ZONE_TOP - 4) * CELL << FP) sp.vy = 300 + rnd(s, 200);
      if (sp.y > (H - 12) << FP) sp.vy = -(300 + rnd(s, 200));
      if (rnd(s, 40) === 0) sp.vx = (rnd(s, 2) ? 1 : -1) * (250 + rnd(s, 250));
      // Eats mushrooms it crosses
      const c = Math.trunc((sp.x >> FP) / CELL), r = Math.trunc((sp.y >> FP) / CELL);
      if (r >= 0 && r < ROWS && s.mush[mi(c, r)] > 0 && rnd(s, 6) === 0) s.mush[mi(c, r)] = 0;
      if (s.dead === 0 && s.invuln === 0) {
        const dx = (sp.x - s.px) >> FP, dy = (sp.y - s.py) >> FP;
        if (dx * dx + dy * dy < 16 * 16) { kill(s); return; }
      }
    } else if (--s.spiderTimer <= 0) {
      s.spider = {
        x: (rnd(s, 2) ? 12 : W - 12) << FP,
        y: (ZONE_TOP * CELL) << FP,
        vx: (rnd(s, 2) ? 1 : -1) * (300 + rnd(s, 200)),
        vy: 300 + rnd(s, 200),
      };
      s.events.push({ t: "spider-in" });
    }

    // Segment vs player
    if (s.dead === 0 && s.invuln === 0) {
      const pc = Math.trunc((s.px >> FP) / CELL), pr = Math.trunc((s.py >> FP) / CELL);
      for (const ch of s.chains) {
        for (const cell of ch.cells) {
          if (cell.c === pc && cell.r === pr) { kill(s); return; }
        }
      }
    }

    // Wave clear
    if (s.chains.length === 0) {
      s.wave++;
      s.events.push({ t: "wave", wave: s.wave });
      spawnChain(s);
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.wave);
    mix(s.px); mix(s.py); mix(s.fireCd); mix(s.invuln); mix(s.dead);
    mix(s.moveEvery); mix(s.moveCd); mix(s.spiderTimer); mix(s.rs); mix(s.gameOver);
    if (s.bullet) { mix(s.bullet.x); mix(s.bullet.y); }
    if (s.spider) { mix(s.spider.x); mix(s.spider.y); mix(s.spider.vx); mix(s.spider.vy); }
    for (const ch of s.chains) {
      mix(ch.dir); mix(ch.cells.length);
      for (const c of ch.cells) { mix(c.c); mix(c.r); }
    }
    for (let i = 0; i < s.mush.length; i += 12) {
      let bits = 0;
      for (let j = i; j < Math.min(i + 12, s.mush.length); j++) bits = bits * 5 + s.mush[j];
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, W, H, FP, CELL, COLS, ROWS, ZONE_TOP, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Myriapod;
