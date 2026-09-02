// CANNONADE — deterministic artillery-duel core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=angle left 2=angle right 4=power up 8=power down 16=fire.
// You against a gunner who learns: every miss tightens its aim. Wind shifts
// each volley, shells crater the terrain, and the terrain is the only cover
// you get. Score is damage dealt; a kill pays 500 and the duel resets
// harder. Three lives, 15 seconds per shot.
const Cannonade = (() => {
  const W = 960, H = 720, FP = 8;
  const COLS = 240, COL_W = 4;
  const GRAV = 18;                   // fp px/tick^2
  const POWER_K = 32;                // velocity = power * K (fp)
  const SHOT_CLOCK = 900;
  const CRATER_R = 6;                // columns
  const DMG_RADIUS = 44;
  const KILL_PTS = 500;
  const START_LIVES = 3;
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

  function heightAt(s, xpx) {
    let col = Math.trunc(xpx / COL_W);
    if (col < 0) col = 0;
    if (col >= COLS) col = COLS - 1;
    return s.heights[col];
  }

  function genRound(s) {
    const hts = [];
    let y = 480 + rnd(s, 80);
    let trend = 0;
    for (let i = 0; i < COLS; i++) {
      trend += rnd(s, 15) - 7;
      if (trend > 14) trend = 14;
      if (trend < -14) trend = -14;
      // A ridge rises mid-field for cover.
      if (i > 90 && i < 150) y -= rnd(s, 3);
      y += trend >> 1;
      if (y < 300) { y = 300; trend = 4; }
      if (y > 640) { y = 640; trend = -4; }
      hts.push(y);
    }
    s.heights = hts;
    s.playerCol = 20 + rnd(s, 25);
    s.aiCol = 195 + rnd(s, 25);
    s.playerHp = 100;
    s.aiHp = 100;
    s.wind = rnd(s, 121) - 60;       // fp px/tick^2
    s.angle = 220;                   // up-right-ish (byte angle; 192 = up)
    s.power = 60;
    s.phase = 0;                     // 0 player aim, 1 shell, 2 ai think
    s.clock = SHOT_CLOCK;
    s.shell = null;
    s.aiMisses = 0;
    s.aiThink = 0;
    s.prevIn = 0;
    s.events.push({ t: "round", round: s.round, wind: s.wind });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, round: 1,
      heights: [], playerCol: 0, aiCol: 0, playerHp: 100, aiHp: 100,
      wind: 0, angle: 220, power: 60, phase: 0, clock: SHOT_CLOCK,
      shell: null, aiMisses: 0, aiThink: 0, prevIn: 0,
      gameOver: 0,
      events: [],
    };
    genRound(s);
    return s;
  }

  function tankX(s, col) { return col * COL_W + 2; }
  function tankY(s, col) { return s.heights[col] - 6; }

  // Wind is drag toward a bounded drift velocity (wind*8 fp), never a raw
  // accumulating acceleration — an unbounded push once flew long lobs
  // backwards over the firer's head (the boomerang bug).
  function windStep(vx, wind) {
    return vx + ((wind * 8 - vx) >> 7);
  }

  // Pure flight preview: where does a shot land? (No RNG; exported so the
  // AI inside and any test bot outside can both aim with the same physics.)
  function previewShot(s, fromCol, angle, power, wind) {
    let x = tankX(s, fromCol) << FP;
    let y = (tankY(s, fromCol) - 6) << FP;
    let vx = (cos(angle) * power * POWER_K) >> 10;
    let vy = (sin(angle) * power * POWER_K) >> 10;
    for (let i = 0; i < 2000; i++) {
      vy += GRAV;
      vx = windStep(vx, wind);
      x += vx;
      y += vy;
      const xp = x >> FP, yp = y >> FP;
      if (xp < 0 || xp >= W) return xp < 0 ? 0 : W - 1;
      if (yp >= heightAt(s, xp)) return xp;
    }
    return x >> FP;
  }

  function fire(s, fromCol, angle, power, byPlayer) {
    s.shell = {
      x: tankX(s, fromCol) << FP,
      y: (tankY(s, fromCol) - 6) << FP,
      vx: (cos(angle) * power * POWER_K) >> 10,
      vy: (sin(angle) * power * POWER_K) >> 10,
      byPlayer,
    };
    s.phase = 1;
    s.events.push({ t: "fire", byPlayer, angle, power });
  }

  function aiAim(s) {
    // Deterministic gunnery: sweep power at a fixed lob angle toward the
    // player, pick the landing closest to a jittered aim point. The jitter
    // shrinks every miss and every round — it learns.
    const targetX = tankX(s, s.playerCol);
    const err = Math.max(4, 100 - s.round * 12 - s.aiMisses * 25);
    const aimX = targetX + rnd(s, err * 2 + 1) - err;
    const angle = 150;               // up-left lob (toward the player side)
    let bestP = 40, bd = 1e9;
    for (let p = 25; p <= 100; p += 1) {
      const land = previewShot(s, s.aiCol, angle, p, s.wind);
      const d = Math.abs(land - aimX);
      if (d < bd) { bd = d; bestP = p; }
    }
    fire(s, s.aiCol, angle, bestP, false);
  }

  function crater(s, xp) {
    const col0 = Math.trunc(xp / COL_W);
    for (let dc = -CRATER_R; dc <= CRATER_R; dc++) {
      const c = col0 + dc;
      if (c < 0 || c >= COLS) continue;
      const depth = Math.trunc((CRATER_R - Math.abs(dc)) * 4.5);
      s.heights[c] = Math.min(660, s.heights[c] + depth);
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    const fireEdge = (input & 16) && !(s.prevIn & 16);
    s.prevIn = input;

    if (s.phase === 0) {
      // Player aims.
      if (s.tick % 2 === 0) {
        if (input & 1) s.angle = Math.max(132, s.angle - 1);
        if (input & 2) s.angle = Math.min(252, s.angle + 1);
        if (input & 4) s.power = Math.min(100, s.power + 1);
        if (input & 8) s.power = Math.max(20, s.power - 1);
      }
      if (fireEdge || --s.clock <= 0) {
        fire(s, s.playerCol, s.angle, s.power, true);
      }
    } else if (s.phase === 2) {
      if (--s.aiThink <= 0) aiAim(s);
    } else if (s.phase === 1 && s.shell) {
      const sh = s.shell;
      sh.vy += GRAV;
      sh.vx = windStep(sh.vx, s.wind);
      sh.x += sh.vx;
      sh.y += sh.vy;
      const xp = sh.x >> FP, yp = sh.y >> FP;
      let impact = false;
      if (xp < -20 || xp > W + 20) impact = true;
      else if (yp >= heightAt(s, Math.max(0, Math.min(W - 1, xp)))) impact = true;
      if (impact) {
        const ix = Math.max(0, Math.min(W - 1, xp));
        crater(s, ix);
        s.events.push({ t: "impact", x: ix, y: heightAt(s, ix) });
        // Damage by proximity.
        for (const [col, isPlayer] of [[s.playerCol, true], [s.aiCol, false]]) {
          const d = Math.abs(tankX(s, col) - ix);
          if (d <= DMG_RADIUS) {
            const dmg = Math.max(12, 60 - d);
            if (isPlayer) {
              s.playerHp -= dmg;
              s.events.push({ t: "hit", who: "player", dmg });
            } else {
              s.aiHp -= dmg;
              if (sh.byPlayer) s.score += dmg;
              s.events.push({ t: "hit", who: "ai", dmg });
            }
          }
        }
        if (!sh.byPlayer && s.aiHp > 0 && s.playerHp > 0) {
          if (Math.abs(tankX(s, s.playerCol) - ix) > DMG_RADIUS) s.aiMisses++;
        }
        s.shell = null;
        // Tanks settle into fresh craters.
        // (heights only ever go down into the earth, so this is just a redraw.)

        if (s.aiHp <= 0) {
          s.score += KILL_PTS * s.round;
          s.round++;
          s.events.push({ t: "kill", pts: KILL_PTS });
          genRound(s);
          return;
        }
        if (s.playerHp <= 0) {
          s.lives--;
          s.events.push({ t: "destroyed" });
          if (s.lives <= 0) { s.gameOver = 1; return; }
          genRound(s);
          return;
        }
        // Next turn; wind shifts a little every volley.
        s.wind += rnd(s, 21) - 10;
        if (s.wind > 80) s.wind = 80;
        if (s.wind < -80) s.wind = -80;
        if (sh.byPlayer) {
          s.phase = 2;
          s.aiThink = 50;
        } else {
          s.phase = 0;
          s.clock = SHOT_CLOCK;
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
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.round);
    mix(s.playerCol); mix(s.aiCol); mix(s.playerHp); mix(s.aiHp);
    mix(s.wind); mix(s.angle); mix(s.power); mix(s.phase); mix(s.clock);
    mix(s.aiMisses); mix(s.aiThink); mix(s.prevIn); mix(s.rs); mix(s.gameOver);
    if (s.shell) { mix(s.shell.x); mix(s.shell.y); mix(s.shell.vx); mix(s.shell.vy); mix(s.shell.byPlayer ? 1 : 0); }
    for (const ht of s.heights) mix(ht);
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

  return {
    createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE,
    previewShot, sin, cos, W, H, FP, COLS, COL_W, tankX, tankY, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Cannonade;
