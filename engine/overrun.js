// OVERRUN — deterministic twin-stick survival core for QUARTERS. Same
// contract: integer-only state, fixed 60Hz timestep, seeded RNG,
// score = f(seed, inputs).
// Input bitmask: move 1=L 2=R 4=U 8=D, fire 16=L 32=R 64=U 128=D (combine
// for diagonals). Everything on screen converges on you. The humans wander,
// oblivious; each rescue raises the multiplier for the whole wave. One
// touch is death. Three lives.
const Overrun = (() => {
  const W = 960, H = 720, FP = 8;
  const PLAYER_SPEED = 4 << FP;
  const BULLET_SPEED = 9;
  const FIRE_CD = 6;
  const GRUNT_PTS = 50, BRUTE_PTS = 150, RESCUE_PTS = 1000;
  const START_LIVES = 3;
  const RESPAWN = 90;
  const INVULN = 150;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  // Spawn away from the arena center so a fresh wave never insta-kills.
  function edgePoint(s) {
    const side = rnd(s, 4);
    if (side === 0) return { x: 40 + rnd(s, W - 80), y: 40 };
    if (side === 1) return { x: 40 + rnd(s, W - 80), y: H - 40 };
    if (side === 2) return { x: 40, y: 60 + rnd(s, H - 120) };
    return { x: W - 40, y: 60 + rnd(s, H - 120) };
  }

  function spawnWave(s) {
    s.enemies = [];
    const grunts = 6 + s.wave * 2;
    const brutes = Math.min(6, Math.max(0, s.wave - 2));
    for (let i = 0; i < grunts; i++) {
      const p = edgePoint(s);
      s.enemies.push({ x: p.x << FP, y: p.y << FP, type: 0, hp: 1, cd: rnd(s, 30) });
    }
    for (let i = 0; i < brutes; i++) {
      const p = edgePoint(s);
      s.enemies.push({ x: p.x << FP, y: p.y << FP, type: 1, hp: 3, cd: rnd(s, 30) });
    }
    s.humans = [];
    const n = 3 + Math.min(2, s.wave >> 1);
    for (let i = 0; i < n; i++) {
      s.humans.push({
        x: (160 + rnd(s, W - 320)) << FP,
        y: (140 + rnd(s, H - 280)) << FP,
        dir: rnd(s, 256), turn: 60 + rnd(s, 120),
      });
    }
    s.multiplier = 1;
    s.events.push({ t: "wave", wave: s.wave });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, wave: 1, multiplier: 1,
      px: (W >> 1) << FP, py: (H >> 1) << FP,
      fireCd: 0, invuln: INVULN, dead: 0,
      bullets: [], enemies: [], humans: [],
      gameOver: 0,
      events: [],
    };
    spawnWave(s);
    return s;
  }

  function kill(s) {
    s.lives--;
    s.events.push({ t: "die", x: s.px >> FP, y: s.py >> FP });
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  const QSIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function sin(a) {
    a &= 255;
    if (a < 64) return QSIN[a];
    if (a < 128) return QSIN[128 - a];
    if (a < 192) return -QSIN[a - 128];
    return -QSIN[256 - a];
  }
  function cos(a) { return sin(a + 64); }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) {
        s.px = (W >> 1) << FP;
        s.py = (H >> 1) << FP;
        s.invuln = INVULN;
        // Shove everything back so the respawn is survivable.
        for (const e of s.enemies) {
          const dx = e.x - s.px, dy = e.y - s.py;
          const away = Math.abs(dx >> FP) + Math.abs(dy >> FP);
          if (away < 220) {
            e.x += dx >= 0 ? 160 << FP : -(160 << FP);
            e.y += dy >= 0 ? 120 << FP : -(120 << FP);
          }
        }
      }
      return;
    }
    if (s.invuln > 0) s.invuln--;
    if (s.fireCd > 0) s.fireCd--;

    // Move
    if (input & 1) s.px -= PLAYER_SPEED;
    if (input & 2) s.px += PLAYER_SPEED;
    if (input & 4) s.py -= PLAYER_SPEED;
    if (input & 8) s.py += PLAYER_SPEED;
    if (s.px < 16 << FP) s.px = 16 << FP;
    if (s.px > (W - 16) << FP) s.px = (W - 16) << FP;
    if (s.py < 16 << FP) s.py = 16 << FP;
    if (s.py > (H - 16) << FP) s.py = (H - 16) << FP;

    // Fire (independent stick)
    let fx = 0, fy = 0;
    if (input & 16) fx -= 1;
    if (input & 32) fx += 1;
    if (input & 64) fy -= 1;
    if (input & 128) fy += 1;
    if ((fx || fy) && s.fireCd === 0 && s.bullets.length < 10) {
      s.fireCd = FIRE_CD;
      const norm = fx && fy ? 7 : 10;   // ~1/sqrt(2) for diagonals
      s.bullets.push({
        x: s.px >> FP, y: s.py >> FP,
        vx: fx * BULLET_SPEED * norm / 10, vy: fy * BULLET_SPEED * norm / 10,
      });
      s.events.push({ t: "fire" });
    }

    // Bullets
    for (let i = s.bullets.length - 1; i >= 0; i--) {
      const b = s.bullets[i];
      b.x += b.vx;
      b.y += b.vy;
      if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) { s.bullets.splice(i, 1); continue; }
      for (let j = s.enemies.length - 1; j >= 0; j--) {
        const e = s.enemies[j];
        const dx = b.x - (e.x >> FP), dy = b.y - (e.y >> FP);
        const rr = e.type === 1 ? 15 : 11;
        if (dx * dx + dy * dy < rr * rr) {
          s.bullets.splice(i, 1);
          e.hp--;
          if (e.hp <= 0) {
            s.score += (e.type === 1 ? BRUTE_PTS : GRUNT_PTS) * s.multiplier;
            s.events.push({ t: "boom", x: e.x >> FP, y: e.y >> FP, brute: e.type === 1 });
            s.enemies.splice(j, 1);
          } else {
            s.events.push({ t: "clang", x: e.x >> FP, y: e.y >> FP });
          }
          break;
        }
      }
    }

    // Enemies converge (grunts every tick, brutes every other)
    for (const e of s.enemies) {
      if (e.type === 1 && (s.tick & 1)) continue;
      const spd = e.type === 1 ? 190 : 230 + Math.min(150, s.wave * 15);
      e.x += e.x < s.px ? spd : -spd;
      e.y += e.y < s.py ? spd : -spd;
      if (s.dead === 0 && s.invuln === 0) {
        const dx = (e.x - s.px) >> FP, dy = (e.y - s.py) >> FP;
        if (dx * dx + dy * dy < 15 * 15) { kill(s); return; }
      }
    }

    // Humans wander; enemies trample them; you rescue them.
    for (let i = s.humans.length - 1; i >= 0; i--) {
      const hu = s.humans[i];
      if (--hu.turn <= 0) { hu.dir = rnd(s, 256); hu.turn = 60 + rnd(s, 120); }
      hu.x += (cos(hu.dir) * 90) >> 10;
      hu.y += (sin(hu.dir) * 90) >> 10;
      if (hu.x < 30 << FP || hu.x > (W - 30) << FP) hu.dir = (128 - hu.dir) & 255;
      if (hu.y < 30 << FP || hu.y > (H - 30) << FP) hu.dir = (-hu.dir) & 255;
      const pdx = (hu.x - s.px) >> FP, pdy = (hu.y - s.py) >> FP;
      if (s.dead === 0 && pdx * pdx + pdy * pdy < 18 * 18) {
        s.score += RESCUE_PTS * s.multiplier;
        s.events.push({ t: "rescue", x: hu.x >> FP, y: hu.y >> FP, pts: RESCUE_PTS * s.multiplier });
        s.multiplier = Math.min(5, s.multiplier + 1);
        s.humans.splice(i, 1);
        continue;
      }
      for (const e of s.enemies) {
        const dx = (hu.x - e.x) >> FP, dy = (hu.y - e.y) >> FP;
        if (dx * dx + dy * dy < 14 * 14) {
          s.events.push({ t: "trample", x: hu.x >> FP, y: hu.y >> FP });
          s.humans.splice(i, 1);
          break;
        }
      }
    }

    if (s.enemies.length === 0) {
      s.wave++;
      spawnWave(s);
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.wave); mix(s.multiplier);
    mix(s.px); mix(s.py); mix(s.fireCd); mix(s.invuln); mix(s.dead);
    mix(s.rs); mix(s.gameOver);
    for (const b of s.bullets) { mix(b.x); mix(b.y); mix(b.vx); mix(b.vy); }
    for (const e of s.enemies) { mix(e.x); mix(e.y); mix(e.type); mix(e.hp); }
    for (const hu of s.humans) { mix(hu.x); mix(hu.y); mix(hu.dir); mix(hu.turn); }
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, W, H, FP, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Overrun;
