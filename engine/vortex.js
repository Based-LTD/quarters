// VORTEX — deterministic tube-shooter core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=ccw 2=cw 8=fire 4=pulse (edge; one per wave, clears all).
// Sixteen lanes around the web. Things crawl up from the deep; kill them
// before they reach the rim, because once they're on the rim they come for
// you along it. Three lives. Waves escalate.
const Vortex = (() => {
  const LANES = 16;
  const DEPTH = 256;               // 0 = deep center, 256 = rim
  const SHOT_SPEED = 9;            // depth units per tick (inward = negative)
  const MAX_SHOTS = 8;
  const FIRE_CD = 7;
  const MOVE_CD = 5;               // lane-step repeat while held
  const TYPES = [
    { pts: 50, spd: 1 },           // 0 crawler
    { pts: 100, spd: 1 },          // 1 weaver (changes lanes)
    { pts: 150, spd: 2 },          // 2 darter
  ];
  const RIM_SPEED_CD = 9;          // rim-walk: one lane step per N ticks
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

  function laneDist(a, b) {
    const d = Math.abs(a - b) % LANES;
    return Math.min(d, LANES - d);
  }

  function startWave(s) {
    s.wave++;
    s.pulse = 1;
    s.spawnQueue = 6 + s.wave * 2;
    s.spawnCd = 30;
    s.events.push({ t: "wave", wave: s.wave });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, wave: 0,
      lane: 0, moveCd: 0, fireCd: 0, invuln: INVULN, dead: 0,
      pulse: 1, prevIn: 0,
      shots: [],                  // {lane, depth}
      foes: [],                   // {lane, depth, type, onRim, rimCd, jinkCd}
      spawnQueue: 0, spawnCd: 0,
      gameOver: 0,
      events: [],
    };
    startWave(s);
    return s;
  }

  function kill(s) {
    s.lives--;
    s.events.push({ t: "die", lane: s.lane });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
    // Knock everything back into the deep so the respawn is survivable.
    for (const f of s.foes) {
      if (f.onRim) { f.onRim = 0; f.depth = DEPTH - 90; }
      else f.depth = Math.max(0, f.depth - 90);
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    const pulseEdge = (input & 4) && !(s.prevIn & 4);
    s.prevIn = input;

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) s.invuln = INVULN;
      return;
    }
    if (s.invuln > 0) s.invuln--;
    if (s.fireCd > 0) s.fireCd--;
    if (s.moveCd > 0) s.moveCd--;

    if (s.moveCd === 0) {
      if (input & 1) { s.lane = (s.lane + LANES - 1) % LANES; s.moveCd = MOVE_CD; s.events.push({ t: "move" }); }
      else if (input & 2) { s.lane = (s.lane + 1) % LANES; s.moveCd = MOVE_CD; s.events.push({ t: "move" }); }
    }
    if ((input & 8) && s.fireCd === 0 && s.shots.length < MAX_SHOTS) {
      s.fireCd = FIRE_CD;
      s.shots.push({ lane: s.lane, depth: DEPTH - 10 });
      s.events.push({ t: "fire" });
    }
    if (pulseEdge && s.pulse) {
      s.pulse = 0;
      let n = 0;
      for (const f of s.foes) { s.score += TYPES[f.type].pts; n++; }
      s.foes = [];
      s.events.push({ t: "pulse", n });
    }

    // Shots travel inward.
    for (let i = s.shots.length - 1; i >= 0; i--) {
      const sh = s.shots[i];
      sh.depth -= SHOT_SPEED;
      if (sh.depth <= 0) s.shots.splice(i, 1);
    }

    // Spawning.
    if (s.spawnQueue > 0 && --s.spawnCd <= 0) {
      s.spawnCd = Math.max(14, 46 - s.wave * 3) + rnd(s, 20);
      s.spawnQueue--;
      const type = rnd(s, Math.min(3, 1 + (s.wave >> 1)));
      s.foes.push({ lane: rnd(s, LANES), depth: 0, type, onRim: 0, rimCd: RIM_SPEED_CD, jinkCd: 40 + rnd(s, 60) });
      s.events.push({ t: "spawn" });
    }

    // Foes advance; weavers change lanes; rim-walkers hunt the player.
    for (const f of s.foes) {
      if (f.onRim) {
        if (--f.rimCd <= 0) {
          f.rimCd = RIM_SPEED_CD;
          const cw = (f.lane + 1) % LANES, ccw = (f.lane + LANES - 1) % LANES;
          f.lane = laneDist(cw, s.lane) < laneDist(ccw, s.lane) ? cw : ccw;
          s.events.push({ t: "rimstep" });
        }
      } else {
        f.depth += TYPES[f.type].spd;
        if (f.type === 1 && --f.jinkCd <= 0) {
          f.jinkCd = 40 + rnd(s, 60);
          f.lane = (f.lane + (rnd(s, 2) ? 1 : LANES - 1)) % LANES;
        }
        if (f.depth >= DEPTH) {
          f.depth = DEPTH;
          f.onRim = 1;
          s.events.push({ t: "rim", lane: f.lane });
        }
      }
    }

    // Shots vs foes.
    for (let i = s.foes.length - 1; i >= 0; i--) {
      const f = s.foes[i];
      for (let j = 0; j < s.shots.length; j++) {
        const sh = s.shots[j];
        if (sh.lane === f.lane && !f.onRim && Math.abs(sh.depth - f.depth) < 14) {
          s.shots.splice(j, 1);
          s.score += TYPES[f.type].pts;
          s.events.push({ t: "boom", lane: f.lane, depth: f.depth, pts: TYPES[f.type].pts });
          s.foes.splice(i, 1);
          break;
        }
        if (sh.lane === f.lane && f.onRim && sh.depth > DEPTH - 24) {
          s.shots.splice(j, 1);
          s.score += TYPES[f.type].pts;
          s.events.push({ t: "boom", lane: f.lane, depth: DEPTH, pts: TYPES[f.type].pts });
          s.foes.splice(i, 1);
          break;
        }
      }
    }

    // Rim foes reaching the player's lane.
    if (s.invuln === 0 && s.dead === 0) {
      for (const f of s.foes) {
        if (f.onRim && f.lane === s.lane) { kill(s); break; }
      }
    }

    if (s.spawnQueue === 0 && s.foes.length === 0) startWave(s);
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.wave);
    mix(s.lane); mix(s.moveCd); mix(s.fireCd); mix(s.invuln); mix(s.dead);
    mix(s.pulse); mix(s.prevIn); mix(s.spawnQueue); mix(s.spawnCd);
    mix(s.rs); mix(s.gameOver);
    for (const sh of s.shots) { mix(sh.lane); mix(sh.depth); }
    for (const f of s.foes) { mix(f.lane); mix(f.depth); mix(f.type); mix(f.onRim); mix(f.rimCd); mix(f.jinkCd); }
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, LANES, DEPTH, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Vortex;
