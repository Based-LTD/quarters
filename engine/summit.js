// SUMMIT — deterministic cube-hopping puzzle core for QUARTERS. Same
// contract: integer-only state, fixed 60Hz timestep, seeded RNG,
// score = f(seed, inputs).
// Input bitmask: 1=hop up-left 2=hop up-right 4=hop down-left
// 8=hop down-right (all edge-triggered; ignored mid-hop).
// A pyramid of cubes. Every cube you land on turns toward the summit color;
// turn them all and the mountain is yours. Boulders tumble down from the
// peak, and from world 3 the cubes need two visits each. Hop off the edge
// and it's a long way down. Three lives.
const Summit = (() => {
  const W = 960, H = 720;
  const N = 7;                          // pyramid rows
  const HOP_T = 14;
  const ADV_PTS = 25, CLEAR_BONUS = 500;
  const START_LIVES = 3;
  const INVULN = 110;
  const RESPAWN = 70;
  const MAX_TICKS = 36000;
  // hop targets: [dr, di] for up-left, up-right, down-left, down-right
  const HOPS = [[-1, -1], [-1, 0], [1, 0], [1, 1]];

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }
  function ci(r, i) { return (r * (r + 1)) / 2 + i; }
  function cubeX(r, i) { return 480 + (2 * i - r) * 38; }
  function cubeY(r) { return 120 + r * 62; }

  function target(s) { return s.level >= 3 ? 2 : 1; }

  function genLevel(s) {
    s.cubes = new Uint8Array((N * (N + 1)) / 2);
    s.pr = 0; s.pi = 0;
    s.hop = null;
    s.invuln = INVULN;
    s.deadT = 0;
    s.balls = [];
    s.spawnCd = 120;
    s.done = 0;
    s.events.push({ t: "level", level: s.level, target: target(s) });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, level: 1, lives: START_LIVES,
      cubes: null, pr: 0, pi: 0, hop: null, invuln: 0, deadT: 0,
      balls: [], spawnCd: 0, done: 0, prevIn: 0,
      gameOver: 0,
      events: [],
    };
    genLevel(s);
    return s;
  }

  function die(s, why) {
    s.lives--;
    s.events.push({ t: "die", why, r: s.pr, i: s.pi });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.deadT = RESPAWN;
  }

  function landOn(s, r, i) {
    s.pr = r; s.pi = i;
    const idx = ci(r, i);
    if (s.cubes[idx] < target(s)) {
      s.cubes[idx]++;
      s.score += ADV_PTS * s.level;
      s.events.push({ t: "advance", r, i, state: s.cubes[idx] });
      if (s.cubes[idx] === target(s)) {
        let all = true;
        for (let k = 0; k < s.cubes.length; k++) if (s.cubes[k] < target(s)) { all = false; break; }
        if (all) {
          s.score += CLEAR_BONUS * s.level;
          s.events.push({ t: "clear", bonus: CLEAR_BONUS * s.level });
          s.level++;
          genLevel(s);
          return;
        }
      }
    }
    // Boulder waiting on this cube?
    checkCrush(s);
  }

  function checkCrush(s) {
    if (s.invuln > 0 || s.deadT > 0 || s.hop) return;
    for (const b of s.balls) {
      if (!b.hop && b.r === s.pr && b.i === s.pi) { die(s, "crushed"); return; }
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.deadT > 0) {
      s.deadT--;
      if (s.deadT === 0) {
        s.pr = 0; s.pi = 0;
        s.hop = null;
        s.invuln = INVULN;
        // Sweep the peak so the respawn isn't an instant re-kill.
        s.balls = s.balls.filter((b) => b.r > 1);
      }
      s.prevIn = input;
      return;
    }
    if (s.invuln > 0) s.invuln--;

    const edge = input & ~s.prevIn;
    s.prevIn = input;

    if (s.hop) {
      if (--s.hop.t <= 0) {
        const hp = s.hop;
        s.hop = null;
        if (hp.off) { die(s, "fell"); }
        else landOn(s, hp.r, hp.i);
      }
    } else if (edge & 15) {
      const d = edge & 1 ? 0 : edge & 2 ? 1 : edge & 4 ? 2 : 3;
      const nr = s.pr + HOPS[d][0], ni = s.pi + HOPS[d][1];
      const off = nr < 0 || nr >= N || ni < 0 || ni > nr;
      s.hop = { r: nr, i: ni, t: HOP_T, off, fr: s.pr, fi: s.pi };
      s.events.push({ t: "hop", d, off });
    }

    // Boulders
    if (--s.spawnCd <= 0) {
      s.spawnCd = Math.max(70, 190 - s.level * 20) + rnd(s, 60);
      s.balls.push({ r: 0, i: 0, hop: null, cd: 30 + rnd(s, 20) });
      s.events.push({ t: "boulder" });
    }
    for (let bi = s.balls.length - 1; bi >= 0; bi--) {
      const b = s.balls[bi];
      if (b.hop) {
        if (--b.hop.t <= 0) {
          b.r = b.hop.r; b.i = b.hop.i; b.hop = null;
          b.cd = 20 + rnd(s, 16);
          if (b.r >= N) { s.balls.splice(bi, 1); continue; }
          if (s.invuln === 0 && s.deadT === 0 && !s.hop && b.r === s.pr && b.i === s.pi) { die(s, "crushed"); }
        }
      } else if (--b.cd <= 0) {
        const di = rnd(s, 2);
        b.hop = { r: b.r + 1, i: b.i + di, t: HOP_T };
      }
    }
    // A boulder resting on a resting player still crushes — landings are not
    // the only overlap (the idle camper at the peak found this out).
    checkCrush(s);
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.level); mix(s.lives);
    mix(s.pr); mix(s.pi); mix(s.invuln); mix(s.deadT); mix(s.spawnCd); mix(s.prevIn);
    mix(s.rs); mix(s.gameOver);
    if (s.hop) { mix(s.hop.r); mix(s.hop.i); mix(s.hop.t); mix(s.hop.off ? 1 : 0); }
    for (let i = 0; i < s.cubes.length; i++) mix(s.cubes[i] + i * 3);
    for (const b of s.balls) { mix(b.r); mix(b.i); mix(b.cd); if (b.hop) { mix(b.hop.r); mix(b.hop.t); } }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, lives: s.lives, hash: stateHash(s), gameOver: s.gameOver };
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
    ci, cubeX, cubeY, target, HOPS,
    W, H, N, HOP_T, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Summit;
