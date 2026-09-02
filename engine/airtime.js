// AIRTIME — deterministic tilt-bike core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 4|8=throttle, 1=tilt back (nose up), 2=tilt forward.
//
// Physics is the classic tilt-bike rig: the bike is TWO wheel particles under
// Verlet integration with a rigid wheelbase constraint. Each wheel collides
// with terrain independently; tilt applies equal-and-opposite impulses to the
// wheels (wheelies on the ground, flips in the air — same input); throttle
// pushes along the chassis while a wheel has grip. The only way to crash is
// the rider's head touching the ground — sketchy wheel landings are legal.
const Airtime = (() => {
  const W = 960, H = 720, FP = 8;

  const QSIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function sin(a) {
    a &= 255;
    if (a < 64) return QSIN[a];
    if (a < 128) return QSIN[128 - a];
    if (a < 192) return -QSIN[a - 128];
    return -QSIN[256 - a];
  }
  function cos(a) { return sin(a + 64); }

  const COL_W = 32;                  // terrain column width, px
  const WHEEL_R = 9 << FP;
  const WB = 38 << FP;               // wheelbase
  const HEAD_H = 27 << FP;           // rider head height above chassis mid
  const GRAV = 26;                   // fp px/tick^2
  const DRIVE = 36;                  // throttle force along chassis, fp
  const TILT = 78;                   // tilt impulse per tick, fp
  const VCLAMP_X = 2100, VCLAMP_Y = 2500;
  const AIR_DRAG = 1021;             // /1024 per tick on airborne wheels
  const GRIP = 250;                  // /256 tangential keep on contact
  const BOUNCE = 20;                 // /256 of impact speed returned
  const FLIP_PTS = 150;
  const DIST_STEP = 320;             // px per +10 distance points
  const FUEL_MAX = 900;              // ~15s tank; drains 1/tick, 2 throttled
  const FUEL_CAN = 560;
  const CAN_PTS = 25;
  const LOW_FUEL = 240;
  const LOOKAHEAD = 44;              // columns pre-generated per tick so the
                                     // renderer never has to touch the RNG
  const BIKES = 3;
  const RESPAWN = 80;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function isqrt(n) {
    if (n <= 0) return 0;
    let x = n, y = (x + 1) >> 1;
    while (y < x) { x = y; y = (x + Math.trunc(n / x)) >> 1; }
    return x;
  }

  // Byte-angle whose (cos,sin) best matches (dx,dy) — coarse scan + refine.
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

  // Signed shortest distance between byte angles.
  function adiff(a, b) { return ((a - b + 128) & 255) - 128; }

  // Terrain: rolling window of column heights (px), generated on demand.
  // Mostly rolling hills, plus seeded kickers — a steep rise into a cliff
  // drop — because smooth terrain alone never throws the bike.
  function genCols(s, upto) {
    while (s.colBase + s.heights.length <= upto) {
      const idx = s.colBase + s.heights.length;
      // Flat runway so every credit starts level with room to build speed.
      if (idx < 24) { s.heights.push(500); continue; }
      // Difficulty ramps with distance: bigger hills, deeper cliffs,
      // kickers arriving faster. Maxes out around column ~1400 (~45km/h ride).
      const scale = Math.min(340, 100 + Math.trunc(idx / 6));
      let hgt;
      const prev = s.heights[s.heights.length - 1];
      if (s.featPhase === 1) {
        // Kicker face: steepening ramp up.
        hgt = prev - Math.trunc((30 + (5 - s.featLeft) * 12) * scale / 200);
        if (--s.featLeft <= 0) { s.featPhase = 2; s.featLeft = 2; }
      } else if (s.featPhase === 2) {
        // Cliff after the lip.
        hgt = prev + Math.trunc((120 + rnd(s, 80)) * scale / 200);
        if (--s.featLeft <= 0) { s.featPhase = 0; s.trend = 0; }
      } else {
        s.trend += rnd(s, 29) - 14;
        const cap = Math.trunc(34 * scale / 100);
        if (s.trend > cap) s.trend = cap;
        if (s.trend < -cap) s.trend = -cap;
        hgt = prev + s.trend;
        if (--s.kickerIn <= 0) {
          s.featPhase = 1;
          s.featLeft = 5;
          s.kickerIn = Math.max(8, 20 - Math.trunc(idx / 150)) + rnd(s, 12);
        }
      }
      if (hgt < 180) { hgt = 180; s.trend = 6; }
      if (hgt > 650) { hgt = 650; s.trend = -6; }
      s.heights.push(hgt);
      // Fuel cans sit on the terrain at a steady cadence — keep pace or dry up.
      if (--s.canIn <= 0) {
        s.cans.push({ x: idx * COL_W + 16, y: hgt - 22, taken: 0 });
        s.canIn = 26 + rnd(s, 14);
      }
    }
    while (s.heights.length > 120 && s.colBase < upto - 80) {
      s.heights.shift();
      s.colBase++;
    }
    while (s.cans.length && (s.cans[0].taken || s.cans[0].x < s.colBase * COL_W)) {
      s.cans.shift();
    }
  }

  function groundAt(s, wxpx) {
    const col = Math.trunc(wxpx / COL_W);
    genCols(s, col + 2);
    const i = col - s.colBase;
    const y0 = s.heights[i], y1 = s.heights[i + 1];
    return y0 + Math.trunc((y1 - y0) * (wxpx - col * COL_W) / COL_W);
  }

  function placeBike(s, midXpx) {
    const rxpx = midXpx - 19, fxpx = midXpx + 19;
    s.rwx = rxpx << FP;
    s.rwy = (groundAt(s, rxpx) << FP) - WHEEL_R;
    s.fwx = fxpx << FP;
    s.fwy = (groundAt(s, fxpx) << FP) - WHEEL_R;
    s.prwx = s.rwx; s.prwy = s.rwy;
    s.pfwx = s.fwx; s.pfwy = s.fwy;
    s.angle = aimAngle(s.fwx - s.rwx, s.fwy - s.rwy);
    s.flipAcc = 0;
    s.airTicks = 0;
    s.grounded = 1;
    s.pmx = (s.rwx + s.fwx) >> 1;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, bonus: 0, bikes: BIKES, flips: 0, launches: 0,
      rwx: 0, rwy: 0, prwx: 0, prwy: 0,
      fwx: 0, fwy: 0, pfwx: 0, pfwy: 0,
      wx: 0, y: 0, vx: 0, pmx: 0,
      angle: 0, grounded: 1, flipAcc: 0, airTicks: 0,
      cR: 0, cF: 0,
      throttle: 0, dead: 0, distMark: 0,
      fuel: FUEL_MAX, cans: [], canIn: 34, lowWarned: 0,
      colBase: 0, heights: [500], trend: 0,
      featPhase: 0, featLeft: 0, kickerIn: 16,
      gameOver: 0,
      events: [],
    };
    genCols(s, LOOKAHEAD);
    placeBike(s, 64);
    s.wx = (s.rwx + s.fwx) >> 1;
    s.y = (s.rwy + s.fwy) >> 1;
    return s;
  }

  function crash(s) {
    s.bikes--;
    s.events.push({ t: "crash", wx: s.wx >> FP, y: s.y >> FP });
    if (s.bikes <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  // One wheel's Verlet step + terrain collision. Returns 1 on contact.
  function stepWheel(s, k) {
    const X = k + "wx", Y = k + "wy", PX = "p" + k + "wx", PY = "p" + k + "wy";
    let vx = s[X] - s[PX];
    let vy = s[Y] - s[PY];
    if (vx > VCLAMP_X) vx = VCLAMP_X;
    if (vx < -VCLAMP_X) vx = -VCLAMP_X;
    if (vy > VCLAMP_Y) vy = VCLAMP_Y;
    if (vy < -VCLAMP_Y) vy = -VCLAMP_Y;
    s[PX] = s[X];
    s[PY] = s[Y];
    s[X] += vx;
    s[Y] += vy + GRAV;

    const gy = groundAt(s, s[X] >> FP) << FP;
    if (s[Y] + WHEEL_R > gy) {
      const impact = vy;
      s[Y] = gy - WHEEL_R;
      // Mostly-dead bounce + rolling grip.
      s[PY] = s[Y] + ((impact * BOUNCE) >> 8);
      s[PX] = s[X] - (((s[X] - s[PX]) * GRIP) >> 8);
      return 1;
    }
    // Air drag.
    s[PX] = s[X] - ((vx * AIR_DRAG) >> 10);
    s[PY] = s[Y] - (((vy + GRAV) * AIR_DRAG) >> 10);
    return 0;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) placeBike(s, s.wx >> FP);
      return;
    }

    s.throttle = (input & 12) && s.fuel > 0 ? 1 : 0;

    // Fuel: constant burn, double under throttle. Empty tank + stopped = done.
    if (s.fuel > 0) {
      s.fuel -= s.throttle ? 2 : 1;
      if (s.fuel < 0) s.fuel = 0;
      if (s.fuel <= LOW_FUEL && !s.lowWarned) { s.lowWarned = 1; s.events.push({ t: "lowfuel" }); }
      if (s.fuel > LOW_FUEL) s.lowWarned = 0;
    }

    // The ONE place terrain grows: pre-generate well past the screen so the
    // renderer can read heights without ever touching the RNG.
    genCols(s, Math.trunc((s.wx >> FP) / COL_W) + LOOKAHEAD);

    // Tilt: equal-and-opposite impulses PERPENDICULAR to the chassis, so the
    // torque is constant at any orientation (world-vertical impulses stall
    // the moment the bike goes vertical). On the ground this is a wheelie or
    // stoppie; in the air it's rotation. Same lever, classic feel.
    if (input & 3) {
      const dx = s.fwx - s.rwx, dy = s.fwy - s.rwy;
      const dist = isqrt(dx * dx + dy * dy) || 1;
      const pux = Math.trunc(dy * TILT / dist);
      const puy = Math.trunc(-dx * TILT / dist);
      if (input & 1) { s.fwx += pux; s.fwy += puy; s.rwx -= pux; s.rwy -= puy; }
      if (input & 2) { s.fwx -= pux; s.fwy -= puy; s.rwx += pux; s.rwy += puy; }
    }

    // Throttle: force along the chassis while either wheel has grip.
    if (s.throttle && (s.cR || s.cF)) {
      const dx = s.fwx - s.rwx, dy = s.fwy - s.rwy;
      const dist = isqrt(dx * dx + dy * dy) || 1;
      const ax = Math.trunc(dx * DRIVE / dist);
      const ay = Math.trunc(dy * DRIVE / dist);
      s.rwx += ax; s.rwy += ay;
      s.fwx += ax; s.fwy += ay;
    }

    s.cR = stepWheel(s, "r");
    s.cF = stepWheel(s, "f");

    // Rigid wheelbase: pull the wheels back to spacing (3 relaxations).
    for (let it = 0; it < 3; it++) {
      const dx = s.fwx - s.rwx, dy = s.fwy - s.rwy;
      const dist = isqrt(dx * dx + dy * dy) || 1;
      const diff = WB - dist;
      const adjX = Math.trunc(dx * diff / (2 * dist));
      const adjY = Math.trunc(dy * diff / (2 * dist));
      s.fwx += adjX; s.fwy += adjY;
      s.rwx -= adjX; s.rwy -= adjY;
    }

    // Rotational damping: bleed uncommanded spin so bumps don't send the
    // bike tumbling — the rider's tilt is strong enough to overcome it.
    {
      const dx = s.fwx - s.rwx, dy = s.fwy - s.rwy;
      const dist = isqrt(dx * dx + dy * dy) || 1;
      const rvx = (s.fwx - s.pfwx) - (s.rwx - s.prwx);
      const rvy = (s.fwy - s.pfwy) - (s.rwy - s.prwy);
      const spin = Math.trunc((rvx * dy - rvy * dx) / dist);
      const k = Math.trunc(spin * 21 / 256);
      const hx = Math.trunc(dy * k / (2 * dist));
      const hy = Math.trunc(-dx * k / (2 * dist));
      s.pfwx += hx; s.pfwy += hy;
      s.prwx -= hx; s.prwy -= hy;
    }

    const prevAngle = s.angle;
    s.angle = aimAngle(s.fwx - s.rwx, s.fwy - s.rwy);

    const midX = (s.rwx + s.fwx) >> 1;
    const midY = (s.rwy + s.fwy) >> 1;
    s.vx = midX - s.pmx;
    s.pmx = midX;
    s.wx = midX;
    s.y = midY;

    // Air/ground bookkeeping + flip scoring.
    const inAir = !s.cR && !s.cF;
    if (inAir) {
      s.flipAcc += adiff(s.angle, prevAngle);
      s.airTicks++;
      if (s.airTicks === 4 && s.grounded) {
        s.grounded = 0;
        s.launches++;
        s.events.push({ t: "launch" });
      }
    } else {
      if (!s.grounded && s.airTicks > 10) {
        const spins = Math.trunc(Math.abs(s.flipAcc) / 256);
        if (spins > 0) {
          const pts = spins * FLIP_PTS;
          s.bonus += pts;
          s.flips += spins;
          s.events.push({ t: "flip", spins, pts });
        }
        s.events.push({ t: "land", air: s.airTicks });
      }
      s.grounded = 1;
      s.flipAcc = 0;
      s.airTicks = 0;
    }

    // The one true fail state: the rider's head touches the ground.
    {
      const dx = s.fwx - s.rwx, dy = s.fwy - s.rwy;
      const dist = isqrt(dx * dx + dy * dy) || 1;
      const hx = midX + Math.trunc(dy * HEAD_H / dist);
      const hy = midY - Math.trunc(dx * HEAD_H / dist);
      const hg = groundAt(s, hx >> FP) << FP;
      if (hy + (3 << FP) >= hg) {
        crash(s);
        return;
      }
    }

    // Fuel can pickups.
    for (const can of s.cans) {
      if (can.taken) continue;
      const dx = (can.x << FP) - midX, dy = (can.y << FP) - midY;
      if (dx > -(26 << FP) && dx < (26 << FP) && dy > -(44 << FP) && dy < (44 << FP)) {
        can.taken = 1;
        s.fuel = Math.min(FUEL_MAX, s.fuel + FUEL_CAN);
        s.bonus += CAN_PTS;
        s.events.push({ t: "fuel", x: can.x, y: can.y });
      }
    }

    // Out of gas and rolled to a stop: the run ends where you stand.
    if (s.fuel <= 0 && s.grounded && s.vx < 200 && s.vx > -200) {
      s.events.push({ t: "outofgas" });
      s.gameOver = 1;
      return;
    }

    // Distance scoring (forward high-water mark only).
    const distPts = Math.trunc((s.wx >> FP) / DIST_STEP) * 10;
    if (distPts > s.distMark) {
      s.distMark = distPts;
      s.events.push({ t: "dist" });
    }
    s.score = s.distMark + s.bonus;
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.bonus); mix(s.bikes); mix(s.flips); mix(s.launches);
    mix(s.rwx); mix(s.rwy); mix(s.prwx); mix(s.prwy);
    mix(s.fwx); mix(s.fwy); mix(s.pfwx); mix(s.pfwy);
    mix(s.wx); mix(s.y); mix(s.vx); mix(s.pmx);
    mix(s.angle); mix(s.grounded); mix(s.flipAcc); mix(s.airTicks);
    mix(s.cR); mix(s.cF); mix(s.throttle);
    mix(s.dead); mix(s.distMark); mix(s.colBase); mix(s.trend);
    mix(s.featPhase); mix(s.featLeft); mix(s.kickerIn);
    mix(s.fuel); mix(s.canIn); mix(s.lowWarned);
    mix(s.rs); mix(s.gameOver);
    for (const c of s.cans) { mix(c.x); mix(c.y); mix(c.taken); }
    for (const hgt of s.heights) mix(hgt);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, flips: s.flips, launches: s.launches, dist: s.wx >> FP, fuel: s.fuel, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, sin, cos, groundAt, W, H, FP, COL_W, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Airtime;
