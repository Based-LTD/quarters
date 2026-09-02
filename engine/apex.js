// APEX — deterministic time-trial racing core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG (unused — the track is
// FIXED so every lap record on this cabinet is comparable), score =
// f(seed, inputs). Input bitmask: 1=steer left 2=steer right 4=throttle
// 8=brake. One car, one track, three minutes. Grass is slow; the racing
// line is everything. Laps under par pay; the best lap is the record.
const Apex = (() => {
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

  // The track: a fixed centerline loop (24 points) with a pinched chicane.
  // Built once from integer math — identical for every credit forever.
  const TRACK = (() => {
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const a = Math.trunc(i * 256 / 24);
      let rx = 380, ry = 250;
      if (i >= 5 && i <= 7) { rx = 250; ry = 165; }     // chicane pinch
      if (i >= 16 && i <= 18) { rx = 320; ry = 210; }   // sweeper tightens
      pts.push([480 + ((cos(a) * rx) >> 10), 360 + ((sin(a) * ry) >> 10)]);
    }
    return pts;
  })();
  const TRACK_W = 62;              // half-width, px
  const N = TRACK.length;

  // GRASS_DRAG must stay BELOW ACC: at 46 it exceeded throttle and a car
  // that stopped on grass could never move again — bricked mid-credit.
  const ACC = 22, BRAKE = 40, DRAG = 8, GRASS_DRAG = 16;
  const MAXV = 2100;               // fp px/tick (~8.2 px/t)
  const TURN_BASE = 4;             // byte-angle per tick at low speed
  const CREDIT = 10800;            // 3 minutes
  const PAR = 1500;                // 25s par lap
  const LAP_PTS = 500;
  const START_LIVES = 0;           // no lives — just the clock

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }

  // Squared distance from point to segment, integer approximation.
  function segDist2(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const ab2 = abx * abx + aby * aby || 1;
    let t = Math.trunc(((apx * abx + apy * aby) * 256) / ab2);
    if (t < 0) t = 0;
    if (t > 256) t = 256;
    const cx = ax + ((abx * t) >> 8), cy = ay + ((aby * t) >> 8);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy;
  }

  function trackDist2(xpx, ypx) {
    let best = 0x7FFFFFFF;
    for (let i = 0; i < N; i++) {
      const a = TRACK[i], b = TRACK[(i + 1) % N];
      const d = segDist2(xpx, ypx, a[0], a[1], b[0], b[1]);
      if (d < best) best = d;
    }
    return best;
  }
  function onTrack(xpx, ypx) {
    return trackDist2(xpx, ypx) <= TRACK_W * TRACK_W;
  }
  // Beyond this you're not cutting a corner, you're lost — rescue range.
  const LOST_R = Math.trunc(TRACK_W * 5 / 2);

  // Progress index: nearest centerline point — used for lap/checkpoint logic.
  function nearestIdx(xpx, ypx) {
    let best = 0, bd = 0x7FFFFFFF;
    for (let i = 0; i < N; i++) {
      const dx = xpx - TRACK[i][0], dy = ypx - TRACK[i][1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0,
      x: TRACK[0][0] << FP, y: TRACK[0][1] << FP,
      heading: 64,               // along the loop (index 0 -> 1 is +y-ish)
      v: 0,
      lap: 0, lapTick: 0, bestLap: 0, halfway: 0,
      lastIdx: 0, odo: 0,
      timeLeft: CREDIT,
      gameOver: 0,
      events: [],
    };
    // Face the first segment.
    const dx = TRACK[1][0] - TRACK[0][0], dy = TRACK[1][1] - TRACK[0][1];
    s.heading = aimAngle(dx, dy);
    return s;
  }

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

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    s.lapTick++;

    if (--s.timeLeft <= 0) { s.gameOver = 1; s.events.push({ t: "flag" }); return; }

    // Steering authority fades a little with speed.
    const turn = TURN_BASE - Math.min(2, Math.trunc(s.v / 900));
    if (input & 1) s.heading = (s.heading - turn) & 255;
    if (input & 2) s.heading = (s.heading + turn) & 255;

    const d2 = trackDist2(s.x >> FP, s.y >> FP);
    const grass = d2 > TRACK_W * TRACK_W;
    if (input & 4) s.v += ACC;
    if (input & 8) s.v -= BRAKE;
    s.v -= grass ? GRASS_DRAG : DRAG;
    if (s.v < 0) s.v = 0;
    if (s.v > MAXV) s.v = MAXV;
    if (grass && s.v > 900) s.v = 900;
    if (grass && s.tick % 20 === 0) s.events.push({ t: "grass" });

    // Wandered clean off the circuit (or into the infield): tow the car back
    // to the nearest centerline point at zero speed. Losing the run to
    // scenery is not a fair way to spend a quarter.
    if (d2 > LOST_R * LOST_R) {
      const i = nearestIdx(s.x >> FP, s.y >> FP);
      const p = TRACK[i], nx = TRACK[(i + 1) % N];
      s.x = p[0] << FP;
      s.y = p[1] << FP;
      s.heading = aimAngle(nx[0] - p[0], nx[1] - p[1]);
      s.v = 0;
      s.events.push({ t: "rescue" });
      s.lastIdx = i;
      return;
    }

    s.x += (cos(s.heading) * s.v) >> 10;
    s.y += (sin(s.heading) * s.v) >> 10;
    s.odo += s.v;

    // Lap logic: pass the halfway marker, then cross start going forward.
    const idxNow = nearestIdx(s.x >> FP, s.y >> FP);
    if (idxNow === (N >> 1)) s.halfway = 1;
    if (s.halfway && idxNow === 0 && s.lastIdx >= N - 3) {
      s.lap++;
      const lt = s.lapTick;
      s.lapTick = 0;
      s.halfway = 0;
      let pts = LAP_PTS;
      if (lt < PAR) pts += (PAR - lt);
      s.score += pts;
      if (s.bestLap === 0 || lt < s.bestLap) {
        s.bestLap = lt;
        s.events.push({ t: "lap", n: s.lap, ticks: lt, pts, best: 1 });
      } else {
        s.events.push({ t: "lap", n: s.lap, ticks: lt, pts, best: 0 });
      }
    }
    s.lastIdx = idxNow;
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.x); mix(s.y); mix(s.heading); mix(s.v);
    mix(s.lap); mix(s.lapTick); mix(s.bestLap); mix(s.halfway);
    mix(s.lastIdx); mix(s.odo); mix(s.timeLeft); mix(s.rs); mix(s.gameOver);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, laps: s.lap, bestLap: s.bestLap, odo: s.odo, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, sin, cos, aimAngle, trackDist2, TRACK, TRACK_W, LOST_R, W, H, FP, PAR, CREDIT, MAX_TICKS: CREDIT + 10 };
})();
if (typeof module !== "undefined") module.exports = Apex;
