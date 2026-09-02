// LANDER — deterministic descent core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=rotate left 2=rotate right 4|8=thrust. Gravity is always on,
// fuel is finite and persists across landings. Land upright and slow on a pad:
// the narrow pad pays 4x, the wide pad 1x, plus a fuel bonus. Three landers.
const Lander = (() => {
  const W = 960, H = 720, FP = 8;
  const WF = W << FP;

  const QSIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function sin(a) {
    a &= 255;
    if (a < 64) return QSIN[a];
    if (a < 128) return QSIN[128 - a];
    if (a < 192) return -QSIN[a - 128];
    return -QSIN[256 - a];
  }
  function cos(a) { return sin(a + 64); }

  const SEGS = 16;
  const SEG_W = W / SEGS;               // 60 px
  const GRAV = 12;                      // fp px/tick^2
  const THRUST = 30;
  const TURN = 2;
  const FUEL_START = 1400;
  const FUEL_LAND_BONUS = 400;
  const FUEL_MAX = 2000;
  const SHIP_R = 10;
  const LAND_VY = 480;                  // fp px/tick limits
  const LAND_VX = 340;
  const LAND_ANGLE_TOL = 10;            // byte-angle from straight up (192)
  const LANDERS = 3;
  const RESPAWN = 80;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  // Terrain: SEGS+1 points, random walk with two flat pads.
  // Wide pad = 2 segments, x1. Narrow pad = 1 segment, x4.
  function genTerrain(s) {
    const pts = [];
    let y = 480 + rnd(s, 120);
    for (let i = 0; i <= SEGS; i++) {
      pts.push(y);
      y += (rnd(s, 2) ? 1 : -1) * (30 + rnd(s, 90));
      if (y < 380) y = 380 + rnd(s, 40);
      if (y > 670) y = 670 - rnd(s, 40);
    }
    const wideSeg = 1 + rnd(s, SEGS - 5);
    pts[wideSeg + 1] = pts[wideSeg];
    pts[wideSeg + 2] = pts[wideSeg];
    let narrowSeg = 1 + rnd(s, SEGS - 3);
    for (let guard = 0; guard < 8 && narrowSeg >= wideSeg - 1 && narrowSeg <= wideSeg + 2; guard++) {
      narrowSeg = 1 + rnd(s, SEGS - 3);
    }
    if (narrowSeg < wideSeg - 1 || narrowSeg > wideSeg + 2) pts[narrowSeg + 1] = pts[narrowSeg];
    else narrowSeg = -1;
    s.terrain = pts;
    s.pads = [{ seg: wideSeg, len: 2, mult: 1 }];
    if (narrowSeg >= 0) s.pads.push({ seg: narrowSeg, len: 1, mult: 4 });
  }

  function resetShip(s) {
    s.x = (120 + rnd(s, W - 240)) << FP;
    s.y = 70 << FP;
    s.vx = 0;
    s.vy = 0;
    s.angle = 192;
    s.thrusting = 0;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, landers: LANDERS, landings: 0, round: 1,
      fuel: FUEL_START,
      x: 0, y: 0, vx: 0, vy: 0, angle: 192, thrusting: 0,
      dead: 0,
      terrain: [], pads: [],
      gameOver: 0,
      events: [],
    };
    genTerrain(s);
    resetShip(s);
    return s;
  }

  // Ground height (integer px) under x px, linear interpolation between points.
  function groundAt(s, xpx) {
    let seg = Math.trunc(xpx / SEG_W);
    if (seg < 0) seg = 0;
    if (seg >= SEGS) seg = SEGS - 1;
    const x0 = seg * SEG_W;
    const y0 = s.terrain[seg], y1 = s.terrain[seg + 1];
    return y0 + Math.trunc((y1 - y0) * (xpx - x0) / SEG_W);
  }

  function padUnder(s, xpx) {
    for (const p of s.pads) {
      if (xpx >= p.seg * SEG_W + 6 && xpx <= (p.seg + p.len) * SEG_W - 6) return p;
    }
    return null;
  }

  function crash(s) {
    s.landers--;
    s.events.push({ t: "crash", x: s.x >> FP, y: s.y >> FP });
    if (s.landers <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) resetShip(s);
      return;
    }

    if (input & 1) s.angle = (s.angle - TURN) & 255;
    if (input & 2) s.angle = (s.angle + TURN) & 255;
    const wantThrust = (input & 12) !== 0;
    s.thrusting = wantThrust && s.fuel > 0 ? 1 : 0;
    if (s.thrusting) {
      s.vx += (cos(s.angle) * THRUST) >> 10;
      s.vy += (sin(s.angle) * THRUST) >> 10;
      s.fuel--;
      if (s.fuel === 200) s.events.push({ t: "lowfuel" });
    }
    s.vy += GRAV;

    s.x += s.vx;
    s.y += s.vy;
    if (s.x < 0) s.x += WF;
    if (s.x >= WF) s.x -= WF;

    const xpx = s.x >> FP, ypx = s.y >> FP;
    const ground = groundAt(s, xpx);
    if (ypx + SHIP_R >= ground) {
      const pad = padUnder(s, xpx);
      const upright = Math.abs(((s.angle - 192 + 128) & 255) - 128) <= LAND_ANGLE_TOL;
      const gentle = s.vy <= LAND_VY && s.vy >= 0 && Math.abs(s.vx) <= LAND_VX;
      if (pad && upright && gentle) {
        const pts = 50 * pad.mult + Math.trunc(s.fuel / 20);
        s.score += pts;
        s.landings++;
        s.round++;
        s.fuel = Math.min(FUEL_MAX, s.fuel + FUEL_LAND_BONUS);
        s.events.push({ t: "land", mult: pad.mult, pts });
        genTerrain(s);
        resetShip(s);
      } else {
        crash(s);
      }
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.landers); mix(s.landings); mix(s.round);
    mix(s.fuel); mix(s.x); mix(s.y); mix(s.vx); mix(s.vy);
    mix(s.angle); mix(s.thrusting); mix(s.dead); mix(s.rs); mix(s.gameOver);
    for (const y of s.terrain) mix(y);
    for (const p of s.pads) { mix(p.seg); mix(p.len); mix(p.mult); }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, landings: s.landings, fuel: s.fuel, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, sin, cos, W, H, FP, SEGS, SEG_W, SHIP_R, LAND_VY, LAND_VX, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Lander;
