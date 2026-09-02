// GIRDER — deterministic climb-and-dodge core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=left 2=right 4=up 8=down 16=jump.
// Six sloped girders zigzag up to the RIGGER, a crane-bot hurling kegs that
// roll the slopes and sometimes take the ladders. Jump a keg for points,
// grab the wrench to smash them (no climbing or jumping while armed), reach
// the top to free the Coin. Faster every level. Three lives.
const Girder = (() => {
  const W = 960, H = 720, FP = 8;

  // Girders: [x0, y0, x1, y1] px, alternating slopes like a fire-escape.
  // Kegs roll toward the LOW end and drop to the girder below.
  const GIRDERS = [
    [0, 648, 960, 632],     // 0 floor — low at left (kegs exit left)
    [60, 564, 900, 580],    // 1 — low at right
    [60, 484, 900, 468],    // 2 — low at left
    [60, 380, 900, 396],    // 3 — low at right
    [60, 300, 900, 284],    // 4 — low at left
    [60, 196, 900, 212],    // 5 — low at right (kegs spawn left, by the RIGGER)
  ];
  const TOP = { x0: 60, x1: 300, y: 150 };   // platform with the RIGGER + Coin
  // Ladders: [x, lowerGirder] — connects lowerGirder to the one above.
  const LADDERS = [
    [780, 0], [300, 0],
    [120, 1], [620, 1],
    [840, 2], [400, 2],
    [160, 3], [700, 3],
    [860, 4], [260, 4],
    [90, 5],                 // final ladder to the platform
  ];
  const WRENCHES = [[2, 500], [4, 420]];     // [girder, x] per level

  const RUN = 460;            // fp px/tick
  const CLIMB = 320;
  const JUMP_V = -900;
  const GRAV = 40;
  const KEG_SPEED = 300;      // base fp px/tick along slope
  const KEG_R = 10;
  const LADDER_W = 14;
  const WRENCH_TICKS = 360;
  const JUMP_PTS = 100, SMASH_PTS = 75, CLIMB_PTS = 50, TOP_PTS = 500;
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

  function girderY(g, xpx) {
    const [x0, y0, x1, y1] = GIRDERS[g];
    if (xpx <= x0) return y0;
    if (xpx >= x1) return y1;
    return y0 + Math.trunc((y1 - y0) * (xpx - x0) / (x1 - x0));
  }
  function lowEnd(g) {
    const [x0, y0, x1, y1] = GIRDERS[g];
    return y0 > y1 ? x0 : x1;   // larger y = lower on screen
  }
  function ladderAt(g, xpx, tol) {
    for (let i = 0; i < LADDERS.length; i++) {
      if (LADDERS[i][1] === g && xpx >= LADDERS[i][0] - tol && xpx <= LADDERS[i][0] + tol) return i;
    }
    return -1;
  }

  function resetPlayer(s) {
    s.px = 120 << FP;
    s.pg = 0;                  // girder index; -1 = on ladder, -2 = airborne
    s.py = girderY(0, 120) << FP;
    s.pvy = 0;
    s.ladder = -1;
    s.climbing = 0;
    s.invuln = INVULN;
    s.wrench = 0;
    s.prevIn = 0;
  }

  function levelStart(s) {
    s.kegs = [];
    s.spawnCd = 60;
    s.levelTick = 0;
    s.wrenches = WRENCHES.map(([g, x]) => ({ g, x, taken: 0 }));
    resetPlayer(s);
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, level: 1, bestG: 0,
      px: 0, py: 0, pvy: 0, pg: 0, ladder: -1, climbing: 0,
      invuln: 0, wrench: 0, prevIn: 0, dead: 0,
      kegs: [], spawnCd: 60, levelTick: 0,
      wrenches: [],
      gameOver: 0,
      events: [],
    };
    levelStart(s);
    return s;
  }

  function kegSpeed(s) { return KEG_SPEED + (s.level - 1) * 40; }
  function spawnGap(s) { return Math.max(60, 160 - s.level * 14); }

  function kill(s) {
    s.lives--;
    s.events.push({ t: "die", x: s.px >> FP, y: s.py >> FP });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    s.levelTick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) resetPlayer(s);
      s.prevIn = input;
      return;
    }
    if (s.invuln > 0) s.invuln--;
    if (s.wrench > 0) {
      s.wrench--;
      if (s.wrench === 0) s.events.push({ t: "wrench-out" });
    }

    const jumpEdge = (input & 16) && !(s.prevIn & 16);
    s.prevIn = input;
    const pxp = s.px >> FP;

    // ---- player movement ----
    if (s.pg === -2) {
      // Airborne (jump arc); horizontal drift allowed.
      if (input & 1) s.px -= RUN >> 1;
      if (input & 2) s.px += RUN >> 1;
      s.pvy += GRAV;
      s.py += s.pvy;
      // Land on the girder whose line we cross while falling.
      if (s.pvy > 0) {
        for (let g = GIRDERS.length - 1; g >= 0; g--) {
          const gy = girderY(g, s.px >> FP) << FP;
          if (s.py >= gy && s.py - s.pvy < gy + (2 << FP)) {
            s.py = gy;
            s.pg = g;
            s.pvy = 0;
            s.events.push({ t: "land" });
            break;
          }
        }
      }
      if (s.py > (H + 40) << FP) { kill(s); return; }
    } else if (s.ladder >= 0) {
      // On a ladder.
      const lx = LADDERS[s.ladder][0], lg = LADDERS[s.ladder][1];
      const topY = (lg === 5 ? TOP.y : girderY(lg + 1, lx)) << FP;
      const botY = girderY(lg, lx) << FP;
      if (input & 4) s.py -= CLIMB;
      if (input & 8) s.py += CLIMB;
      s.px = lx << FP;
      if (s.py <= topY) {
        s.py = topY;
        s.ladder = -1;
        s.pg = lg === 5 ? 6 : lg + 1;      // 6 = top platform
        if (s.pg !== 6 && s.pg > s.bestG) {
          s.bestG = s.pg;
          s.score += CLIMB_PTS;
          s.events.push({ t: "height", g: s.pg });
        }
      } else if (s.py >= botY) {
        s.py = botY;
        s.ladder = -1;
        s.pg = lg;
      }
    } else if (s.pg === 6) {
      // Top platform — reaching it frees the Coin.
      const bonus = Math.max(0, 3000 - s.levelTick);
      s.score += TOP_PTS + Math.trunc(bonus / 10);
      s.level++;
      s.bestG = 0;
      s.events.push({ t: "rescue", level: s.level });
      levelStart(s);
      return;
    } else {
      // On a girder.
      if (input & 1) s.px -= RUN;
      if (input & 2) s.px += RUN;
      const [gx0, , gx1] = GIRDERS[s.pg];
      if (s.pg === 0) {
        // The floor has walls — nobody falls out of the site.
        if (s.px < 14 << FP) s.px = 14 << FP;
        if (s.px > (W - 14) << FP) s.px = (W - 14) << FP;
      } else if ((s.px >> FP) < gx0 - 6 || (s.px >> FP) > gx1 + 6) {
        s.pg = -2;               // walked off the end
        s.pvy = 0;
      }
      if (s.pg >= 0) {
        s.py = girderY(s.pg, s.px >> FP) << FP;
        // Ladders: up from here, or down to below (wrench forbids climbing).
        if (!s.wrench && (input & 4)) {
          const li = ladderAt(s.pg, s.px >> FP, LADDER_W);
          if (li >= 0) { s.ladder = li; s.climbing = 1; s.py -= CLIMB; }
        } else if (!s.wrench && (input & 8) && s.pg > 0) {
          const li = ladderAt(s.pg - 1, s.px >> FP, LADDER_W);
          if (li >= 0) { s.ladder = li; s.pg = -1; s.py += CLIMB; }
        }
        if (s.ladder < 0 && !s.wrench && jumpEdge && s.pg >= 0) {
          s.pvy = JUMP_V;
          s.pg = -2;
          s.events.push({ t: "jump" });
        }
      }
    }

    // Wrench pickups.
    for (const wr of s.wrenches) {
      if (wr.taken) continue;
      if (s.pg === wr.g && Math.abs((s.px >> FP) - wr.x) < 16) {
        wr.taken = 1;
        s.wrench = WRENCH_TICKS;
        s.events.push({ t: "wrench" });
      }
    }

    // ---- RIGGER spawns kegs onto girder 5's high (left) end ----
    if (--s.spawnCd <= 0) {
      s.spawnCd = spawnGap(s) + rnd(s, 30);
      s.kegs.push({ x: 100 << FP, y: (girderY(5, 100) - 10) << FP, g: 5, vy: 0, onLadder: -1, ly: 0, scored: 0 });
      s.events.push({ t: "keg" });
    }

    // ---- kegs ----
    const spd = kegSpeed(s);
    for (let i = s.kegs.length - 1; i >= 0; i--) {
      const k = s.kegs[i];
      if (k.onLadder >= 0) {
        // Sliding down a ladder.
        k.y += 360;
        const lg = LADDERS[k.onLadder][1];
        const botY = (girderY(lg, LADDERS[k.onLadder][0]) - 10) << FP;
        if (k.y >= botY) { k.y = botY; k.g = lg; k.onLadder = -1; }
      } else if (k.g === -2) {
        // Falling off a girder end.
        k.vy += GRAV;
        k.y += k.vy;
        for (let g = GIRDERS.length - 1; g >= 0; g--) {
          const gy = (girderY(g, k.x >> FP) - 10) << FP;
          if (k.y >= gy && k.y - k.vy < gy + (2 << FP)) { k.y = gy; k.g = g; k.vy = 0; break; }
        }
        if (k.y > (H + 40) << FP) { s.kegs.splice(i, 1); continue; }
      } else {
        // Rolling toward the low end.
        const dir = lowEnd(k.g) === GIRDERS[k.g][0] ? -1 : 1;
        k.x += dir * spd;
        const kxp = k.x >> FP;
        // Sometimes take a ladder down.
        const li = ladderAt(k.g - 1, kxp, 6);
        if (k.g > 0 && li >= 0 && rnd(s, 4) === 0) {
          k.onLadder = li;
          k.x = LADDERS[li][0] << FP;
        } else if (k.g === 0 && (kxp < -20 || kxp > W + 20)) {
          s.kegs.splice(i, 1);
          continue;
        } else if (k.g > 0 && (kxp < GIRDERS[k.g][0] - 8 || kxp > GIRDERS[k.g][2] + 8)) {
          k.g = -2;
          k.vy = 0;
        } else {
          k.y = (girderY(k.g, kxp) - 10) << FP;
        }
      }

      // Player interaction.
      const dx = (k.x - s.px) >> FP, dy = (k.y - s.py) >> FP;
      const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
      if (s.wrench > 0 && adx < 20 && ady < 24) {
        s.score += SMASH_PTS;
        s.events.push({ t: "smash", x: k.x >> FP, y: k.y >> FP });
        s.kegs.splice(i, 1);
        continue;
      }
      if (s.dead === 0 && s.invuln === 0 && adx < 15 && dy > -14 && dy < 10) {
        kill(s);
        return;
      }
      // Jump-over bonus: airborne, clearly above a near keg.
      if (!k.scored && s.pg === -2 && adx < 36 && dy > 14) {
        k.scored = 1;
        s.score += JUMP_PTS;
        s.events.push({ t: "over", x: k.x >> FP, y: (k.y >> FP) - 20 });
      }
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.level); mix(s.bestG);
    mix(s.px); mix(s.py); mix(s.pvy); mix(s.pg); mix(s.ladder);
    mix(s.invuln); mix(s.wrench); mix(s.prevIn); mix(s.dead);
    mix(s.spawnCd); mix(s.levelTick); mix(s.rs); mix(s.gameOver);
    for (const k of s.kegs) { mix(k.x); mix(k.y); mix(k.g); mix(k.vy); mix(k.onLadder); mix(k.scored); }
    for (const wr of s.wrenches) mix(wr.taken);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, bestG: s.bestG, hash: stateHash(s), gameOver: s.gameOver };
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
    GIRDERS, TOP, LADDERS, girderY, W, H, FP, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Girder;
