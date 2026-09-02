// VOID ROCKS — deterministic core for QUARTERS.
// Every field of game state is an integer; the only permitted ops on state are
// integer add/mul/shift/mod, so score = f(seed, inputs) is reproducible across
// any JS engine (browser client, Node verifier). Floats are allowed in the
// renderer only — never here.
// Input per tick is a bitmask: 1=left 2=right 4=thrust 8=fire.
// s.events is a per-tick scratch list for the renderer (sound/particles); it is
// derived from state transitions and deliberately excluded from the hash.
const VoidRocks = (() => {
  const W = 960, H = 720, FP = 8;
  const WF = W << FP, HF = H << FP;

  // Quarter-wave sine table, sin(2πi/256)*1024, embedded as literals because
  // Math.sin is not bit-identical across engines.
  const QSIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function sin(a) {
    a &= 255;
    if (a < 64) return QSIN[a];
    if (a < 128) return QSIN[128 - a];
    if (a < 192) return -QSIN[a - 128];
    return -QSIN[256 - a];
  }
  function cos(a) { return sin(a + 64); }

  const TURN = 4;              // angle units per tick (256 = full circle)
  const THRUST = 31;           // fp px/tick^2 at full cos
  const FRICTION = 1019;       // vel *= 1019/1024 per tick
  const BULLET_SPEED = 1800;   // fp px/tick
  const BULLET_LIFE = 45;
  const FIRE_COOLDOWN = 9;
  const MAX_BULLETS = 4;
  const SHIP_R = 10 << FP;
  const NOSE = 12 << FP;
  const ROCK_R = [0, 11 << FP, 20 << FP, 38 << FP];
  const ROCK_PTS = [0, 100, 50, 20];
  const ROCK_SPEED_MIN = [0, 200, 150, 100];
  const ROCK_SPEED_RNG = [0, 400, 300, 250];
  const START_LIVES = 3;
  const EXTRA_LIFE_EVERY = 10000;
  const RESPAWN_DELAY = 90;
  const INVULN = 120;
  const WAVE_DELAY = 90;
  const SAFE_SPAWN = 150 << FP; // rocks never spawn within this of ship
  const MAX_TICKS = 36000;     // 10 min hard cap on a single credit

  const SAUCER_R = [0, 8 << FP, 15 << FP];       // by size: 1=small 2=big
  const SAUCER_PTS = [0, 1000, 200];
  const SAUCER_VX = [0, 460, 320];               // fp px/tick
  const SAUCER_FIRST = 600;                      // earliest first spawn window
  const SAUCER_GAP = 900;                        // respawn window base
  const SAUCER_FIRE_EVERY = 55;
  const EBULLET_SPEED = 1500;
  const EBULLET_LIFE = 80;
  const SMALL_SAUCER_SCORE = 10000;              // small-only above this

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function wrap(v, m) { return ((v % m) + m) % m; }
  // Toroidal delta: shortest signed distance on a wrapped axis.
  function wdelta(a, b, m) { return wrap(a - b + (m >> 1), m) - (m >> 1); }

  // Integer aim: the byte-angle from (0,0) toward (dx,dy), found by coarse
  // 16-step scan then ±8 refinement over the dot product. ~24 int ops; no atan.
  function aimAngle(dx, dy) {
    let best = 0, bestDot = -0x7FFFFFFFFFFF;
    for (let a = 0; a < 256; a += 16) {
      const d = dx * cos(a) + dy * sin(a);
      if (d > bestDot) { bestDot = d; best = a; }
    }
    for (let a = best - 8; a <= best + 8; a++) {
      const d = dx * cos(a & 255) + dy * sin(a & 255);
      if (d > bestDot) { bestDot = d; best = a & 255; }
    }
    return best & 255;
  }

  function createState(seed) {
    return {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, wave: 0, nextLife: EXTRA_LIFE_EVERY,
      x: WF >> 1, y: HF >> 1, vx: 0, vy: 0, angle: 192,
      dead: 0, invuln: INVULN, cooldown: 0, thrusting: 0,
      bullets: [], rocks: [], ebullets: [],
      saucer: null, saucerTimer: SAUCER_FIRST, saucersSeen: 0,
      waveDelay: 1, gameOver: 0,
      events: [],
    };
  }

  function spawnWave(s) {
    s.wave++;
    const n = Math.min(3 + s.wave, 8);
    for (let i = 0; i < n; i++) spawnRock(s, 3, -1, -1);
  }

  function spawnRock(s, size, px, py) {
    let x, y;
    if (px >= 0) { x = px; y = py; }
    else {
      // Edge spawn, rejected if too close to the ship.
      for (let tries = 0; tries < 16; tries++) {
        if (rnd(s, 2) === 0) { x = rnd(s, WF); y = rnd(s, 2) === 0 ? 0 : HF - 1; }
        else { x = rnd(s, 2) === 0 ? 0 : WF - 1; y = rnd(s, HF); }
        const dx = wdelta(x, s.x, WF), dy = wdelta(y, s.y, HF);
        if (dx * dx + dy * dy > SAFE_SPAWN * SAFE_SPAWN) break;
      }
    }
    const a = rnd(s, 256);
    const sp = ROCK_SPEED_MIN[size] + rnd(s, ROCK_SPEED_RNG[size]);
    s.rocks.push({
      x, y,
      vx: (cos(a) * sp) >> 10, vy: (sin(a) * sp) >> 10,
      size, shape: rnd(s, 65536), spin: rnd(s, 5) - 2,
    });
  }

  function breakRock(s, i, scored) {
    const r = s.rocks[i];
    if (scored) addScore(s, ROCK_PTS[r.size]);
    s.events.push({ t: "rock", x: r.x, y: r.y, size: r.size });
    s.rocks.splice(i, 1);
    if (r.size > 1) { spawnRock(s, r.size - 1, r.x, r.y); spawnRock(s, r.size - 1, r.x, r.y); }
  }

  function addScore(s, pts) {
    s.score += pts;
    if (s.score >= s.nextLife) {
      s.lives++;
      s.nextLife += EXTRA_LIFE_EVERY;
      s.events.push({ t: "1up" });
    }
  }

  function spawnSaucer(s) {
    const size = s.score >= SMALL_SAUCER_SCORE ? 1 : (rnd(s, 4) === 0 ? 1 : 2);
    const fromLeft = rnd(s, 2) === 0;
    s.saucer = {
      x: fromLeft ? 0 : WF - 1,
      y: (60 << FP) + rnd(s, HF - (120 << FP)),
      vx: fromLeft ? SAUCER_VX[size] : -SAUCER_VX[size],
      vy: 0, size, fireCd: SAUCER_FIRE_EVERY, dirCd: 60 + rnd(s, 60),
    };
    s.saucersSeen++;
    s.events.push({ t: "saucer-in", size });
  }

  function killSaucer(s, scored) {
    const u = s.saucer;
    if (scored) addScore(s, SAUCER_PTS[u.size]);
    s.events.push({ t: "boom", x: u.x, y: u.y, big: 1 });
    s.saucer = null;
    s.saucerTimer = SAUCER_GAP + rnd(s, SAUCER_GAP);
  }

  function killShip(s) {
    s.lives--;
    s.dead = RESPAWN_DELAY;
    s.events.push({ t: "ship", x: s.x, y: s.y, a: s.angle });
    s.vx = 0; s.vy = 0; s.thrusting = 0;
    if (s.lives <= 0) s.gameOver = 1;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) {
        s.x = WF >> 1; s.y = HF >> 1; s.angle = 192; s.invuln = INVULN;
      }
    } else {
      if (input & 1) s.angle = (s.angle - TURN) & 255;
      if (input & 2) s.angle = (s.angle + TURN) & 255;
      s.thrusting = (input & 4) ? 1 : 0;
      if (s.thrusting) {
        s.vx += (cos(s.angle) * THRUST) >> 10;
        s.vy += (sin(s.angle) * THRUST) >> 10;
      }
      s.vx = (s.vx * FRICTION) >> 10;
      s.vy = (s.vy * FRICTION) >> 10;
      s.x = wrap(s.x + s.vx, WF);
      s.y = wrap(s.y + s.vy, HF);
      if (s.invuln > 0) s.invuln--;
      if (s.cooldown > 0) s.cooldown--;
      if ((input & 8) && s.cooldown === 0 && s.bullets.length < MAX_BULLETS) {
        s.cooldown = FIRE_COOLDOWN;
        s.events.push({ t: "fire" });
        s.bullets.push({
          x: wrap(s.x + ((cos(s.angle) * NOSE) >> 10), WF),
          y: wrap(s.y + ((sin(s.angle) * NOSE) >> 10), HF),
          vx: s.vx + ((cos(s.angle) * BULLET_SPEED) >> 10),
          vy: s.vy + ((sin(s.angle) * BULLET_SPEED) >> 10),
          life: BULLET_LIFE,
        });
      }
    }

    for (let i = s.bullets.length - 1; i >= 0; i--) {
      const b = s.bullets[i];
      b.life--;
      if (b.life <= 0) { s.bullets.splice(i, 1); continue; }
      b.x = wrap(b.x + b.vx, WF);
      b.y = wrap(b.y + b.vy, HF);
    }
    for (let i = s.ebullets.length - 1; i >= 0; i--) {
      const b = s.ebullets[i];
      b.life--;
      if (b.life <= 0) { s.ebullets.splice(i, 1); continue; }
      b.x = wrap(b.x + b.vx, WF);
      b.y = wrap(b.y + b.vy, HF);
    }

    for (const r of s.rocks) {
      r.x = wrap(r.x + r.vx, WF);
      r.y = wrap(r.y + r.vy, HF);
    }

    // Saucer lifecycle: crosses the field horizontally (no x-wrap), jinks
    // vertically on a timer, fires on a timer — big fires blind, small aims.
    if (s.saucer) {
      const u = s.saucer;
      u.x += u.vx;
      u.y = wrap(u.y + u.vy, HF);
      if (u.x < 0 || u.x >= WF) {
        s.saucer = null;
        s.saucerTimer = SAUCER_GAP + rnd(s, SAUCER_GAP);
      } else {
        if (--u.dirCd <= 0) {
          u.dirCd = 60 + rnd(s, 60);
          u.vy = (rnd(s, 3) - 1) * 300;
        }
        if (--u.fireCd <= 0 && s.dead === 0) {
          u.fireCd = SAUCER_FIRE_EVERY;
          let a;
          if (u.size === 1) {
            a = (aimAngle(wdelta(s.x, u.x, WF), wdelta(s.y, u.y, HF)) + rnd(s, 13) - 6) & 255;
          } else {
            a = rnd(s, 256);
          }
          s.events.push({ t: "efire" });
          s.ebullets.push({
            x: u.x, y: u.y,
            vx: (cos(a) * EBULLET_SPEED) >> 10,
            vy: (sin(a) * EBULLET_SPEED) >> 10,
            life: EBULLET_LIFE,
          });
        }
      }
    } else if (s.rocks.length > 0 || s.wave > 0) {
      if (--s.saucerTimer <= 0) spawnSaucer(s);
    }

    // Player bullets vs rocks. Backwards iteration; splits append and are not
    // re-tested this tick, keeping order deterministic.
    for (let i = s.rocks.length - 1; i >= 0; i--) {
      const r = s.rocks[i];
      const rr = ROCK_R[r.size];
      let hit = -1;
      for (let j = 0; j < s.bullets.length; j++) {
        const b = s.bullets[j];
        const dx = wdelta(b.x, r.x, WF), dy = wdelta(b.y, r.y, HF);
        if (dx * dx + dy * dy <= rr * rr) { hit = j; break; }
      }
      if (hit >= 0) { s.bullets.splice(hit, 1); breakRock(s, i, 1); }
    }

    // Saucer bullets vs rocks: rocks break, no points awarded.
    for (let i = s.rocks.length - 1; i >= 0; i--) {
      const r = s.rocks[i];
      const rr = ROCK_R[r.size];
      let hit = -1;
      for (let j = 0; j < s.ebullets.length; j++) {
        const b = s.ebullets[j];
        const dx = wdelta(b.x, r.x, WF), dy = wdelta(b.y, r.y, HF);
        if (dx * dx + dy * dy <= rr * rr) { hit = j; break; }
      }
      if (hit >= 0) { s.ebullets.splice(hit, 1); breakRock(s, i, 0); }
    }

    if (s.saucer) {
      const u = s.saucer;
      const ur = SAUCER_R[u.size];
      for (let j = 0; j < s.bullets.length; j++) {
        const b = s.bullets[j];
        const dx = wdelta(b.x, u.x, WF), dy = wdelta(b.y, u.y, HF);
        if (dx * dx + dy * dy <= ur * ur) {
          s.bullets.splice(j, 1);
          killSaucer(s, 1);
          break;
        }
      }
    }
    if (s.saucer) {
      const u = s.saucer;
      const ur = SAUCER_R[u.size];
      for (const r of s.rocks) {
        const rr = ROCK_R[r.size] + ur;
        const dx = wdelta(u.x, r.x, WF), dy = wdelta(u.y, r.y, HF);
        if (dx * dx + dy * dy <= rr * rr) { killSaucer(s, 0); break; }
      }
    }

    if (s.dead === 0 && s.invuln === 0) {
      for (const r of s.rocks) {
        const rr = ROCK_R[r.size] + SHIP_R;
        const dx = wdelta(s.x, r.x, WF), dy = wdelta(s.y, r.y, HF);
        if (dx * dx + dy * dy <= rr * rr) { killShip(s); break; }
      }
    }
    if (s.dead === 0 && s.invuln === 0) {
      for (let j = 0; j < s.ebullets.length; j++) {
        const b = s.ebullets[j];
        const rr = SHIP_R;
        const dx = wdelta(b.x, s.x, WF), dy = wdelta(b.y, s.y, HF);
        if (dx * dx + dy * dy <= rr * rr) {
          s.ebullets.splice(j, 1);
          killShip(s);
          break;
        }
      }
    }
    if (s.dead === 0 && s.invuln === 0 && s.saucer) {
      const u = s.saucer;
      const rr = SAUCER_R[u.size] + SHIP_R;
      const dx = wdelta(s.x, u.x, WF), dy = wdelta(s.y, u.y, HF);
      if (dx * dx + dy * dy <= rr * rr) { killSaucer(s, 1); killShip(s); }
    }

    if (s.rocks.length === 0) {
      if (s.waveDelay === 0) s.waveDelay = WAVE_DELAY;
      s.waveDelay--;
      if (s.waveDelay === 0) spawnWave(s);
    }
  }

  // FNV-1a over the full integer state, in fixed field order.
  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.wave); mix(s.nextLife);
    mix(s.x); mix(s.y); mix(s.vx); mix(s.vy); mix(s.angle);
    mix(s.dead); mix(s.invuln); mix(s.rs); mix(s.saucerTimer); mix(s.saucersSeen);
    for (const b of s.bullets) { mix(b.x); mix(b.y); mix(b.vx); mix(b.vy); mix(b.life); }
    for (const b of s.ebullets) { mix(b.x); mix(b.y); mix(b.vx); mix(b.vy); mix(b.life); }
    for (const r of s.rocks) { mix(r.x); mix(r.y); mix(r.vx); mix(r.vy); mix(r.size); }
    if (s.saucer) { mix(s.saucer.x); mix(s.saucer.y); mix(s.saucer.vx); mix(s.saucer.vy); mix(s.saucer.size); mix(s.saucer.fireCd); }
    return h >>> 0;
  }

  // Replay a full run. masks is one input bitmask per tick; after the log is
  // exhausted the run continues on empty input up to a small grace window, so
  // a log that ends exactly at death still verifies.
  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, wave: s.wave, saucers: s.saucersSeen, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, sin, cos, W, H, FP, ROCK_R, SAUCER_R, START_LIVES, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = VoidRocks;
