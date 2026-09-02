// BREAKPOINT — deterministic breakout core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=left 2=right 8=serve. Classic 1976 rules: 8-row wall,
// deeper rows score more, ball speeds up at 4 hits / 12 hits / orange / red,
// paddle halves after the ball touches the ceiling. 3 balls, walls loop forever.
const Breakpoint = (() => {
  const W = 960, H = 720, FP = 8;
  const WF = W << FP, HF = H << FP;

  const QSIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function sin(a) {
    a &= 255;
    if (a < 64) return QSIN[a];
    if (a < 128) return QSIN[128 - a];
    if (a < 192) return -QSIN[a - 128];
    return -QSIN[256 - a];
  }
  function cos(a) { return sin(a + 64); }

  const COLS = 14, ROWS = 8;
  const BRICK_W = Math.trunc((W << FP) / COLS); // 17554 fp ≈ 68.57px, no edge gap
  const BRICK_H = 20 << FP;
  const WALL_TOP = 90 << FP;
  const ROW_PTS = [7, 7, 5, 5, 3, 3, 1, 1];  // top row first
  const PADDLE_Y = 684 << FP;
  const PADDLE_H = 12 << FP;
  const PADDLE_W_FULL = 88 << FP;
  const PADDLE_W_SHRUNK = 56 << FP;
  const PADDLE_SPEED = 11 << FP;
  const BALL_R = 5 << FP;
  const SPEEDS = [820, 1050, 1280, 1520, 1780];
  const START_BALLS = 3;
  const AUTO_SERVE = 180;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function freshWall() {
    const wall = [];
    for (let r = 0; r < ROWS; r++) { wall.push([]); for (let c = 0; c < COLS; c++) wall[r].push(1); }
    return wall;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, balls: START_BALLS, wallNo: 1,
      px: WF >> 1, pw: PADDLE_W_FULL,
      bx: 0, by: 0, bvx: 0, bvy: 0,
      serving: 1, serveCd: AUTO_SERVE,
      hits: 0, speedLvl: 0, baseSpeedLvl: 0, ceilingHit: 0,
      bricksLeft: COLS * ROWS,
      wall: freshWall(),
      gameOver: 0,
      events: [],
    };
    return s;
  }

  function ballSpeed(s) { return SPEEDS[Math.min(s.speedLvl, SPEEDS.length - 1)]; }

  function setVelFromAngle(s, a) {
    const sp = ballSpeed(s);
    s.bvx = (cos(a) * sp) >> 10;
    s.bvy = (sin(a) * sp) >> 10;
    // A near-horizontal ball never comes down; enforce a minimum vertical share.
    const minVy = sp >> 2;
    if (s.bvy > -minVy && s.bvy < minVy) s.bvy = s.bvy < 0 ? -minVy : minVy;
  }

  function serve(s) {
    s.serving = 0;
    s.bx = s.px;
    s.by = PADDLE_Y - PADDLE_H - BALL_R;
    setVelFromAngle(s, (192 + (rnd(s, 2) ? 20 : -20) + rnd(s, 9) - 4) & 255);
    s.events.push({ t: "serve" });
  }

  function loseBall(s) {
    s.balls--;
    s.events.push({ t: "lose" });
    if (s.balls <= 0) { s.gameOver = 1; return; }
    s.serving = 1;
    s.serveCd = AUTO_SERVE;
  }

  function maybeSpeedup(s, row) {
    let lvl = s.baseSpeedLvl;
    if (s.hits >= 4) lvl = Math.max(lvl, s.baseSpeedLvl + 1);
    if (s.hits >= 12) lvl = Math.max(lvl, s.baseSpeedLvl + 2);
    if (row <= 3) lvl = Math.max(lvl, s.baseSpeedLvl + 3);   // orange band
    if (row <= 1) lvl = Math.max(lvl, s.baseSpeedLvl + 4);   // red band
    if (lvl > s.speedLvl) {
      s.speedLvl = lvl;
      const sp = ballSpeed(s);
      // Rescale current velocity to the new speed, preserving direction.
      const cur = Math.max(1, Math.abs(s.bvx) + Math.abs(s.bvy));
      s.bvx = Math.trunc(s.bvx * sp / cur) || (s.bvx < 0 ? -1 : 1);
      s.bvy = Math.trunc(s.bvy * sp / cur) || (s.bvy < 0 ? -1 : 1);
      s.events.push({ t: "speedup", level: s.speedLvl });
    }
  }

  function brickAt(s, x, y) {
    if (y < WALL_TOP || y >= WALL_TOP + ROWS * BRICK_H) return null;
    const r = Math.trunc((y - WALL_TOP) / BRICK_H);
    const c = Math.trunc(x / BRICK_W);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    return s.wall[r][c] ? { r, c } : null;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (input & 1) s.px -= PADDLE_SPEED;
    if (input & 2) s.px += PADDLE_SPEED;
    const half = s.pw >> 1;
    if (s.px < half) s.px = half;
    if (s.px > WF - half) s.px = WF - half;

    if (s.serving) {
      s.bx = s.px;
      s.by = PADDLE_Y - PADDLE_H - BALL_R;
      if ((input & 8) || --s.serveCd <= 0) serve(s);
      return;
    }

    const px0 = s.bx, py0 = s.by;
    s.bx += s.bvx;
    s.by += s.bvy;

    if (s.bx < BALL_R) { s.bx = BALL_R; s.bvx = -s.bvx; s.events.push({ t: "wall" }); }
    if (s.bx > WF - BALL_R) { s.bx = WF - BALL_R; s.bvx = -s.bvx; s.events.push({ t: "wall" }); }
    if (s.by < BALL_R) {
      s.by = BALL_R; s.bvy = -s.bvy; s.events.push({ t: "wall" });
      if (!s.ceilingHit) { s.ceilingHit = 1; s.pw = PADDLE_W_SHRUNK; s.events.push({ t: "shrink" }); }
    }

    const hit = brickAt(s, s.bx, s.by);
    if (hit) {
      s.wall[hit.r][hit.c] = 0;
      s.bricksLeft--;
      s.hits++;
      s.score += ROW_PTS[hit.r];
      s.events.push({ t: "brick", row: hit.r });
      // Bounce axis: whichever grid coordinate changed since last tick.
      const sameCol = Math.trunc(px0 / BRICK_W) === hit.c;
      const sameRow = py0 >= WALL_TOP && Math.trunc((py0 - WALL_TOP) / BRICK_H) === hit.r;
      if (sameCol && !sameRow) s.bvy = -s.bvy;
      else if (sameRow && !sameCol) s.bvx = -s.bvx;
      else { s.bvy = -s.bvy; s.bvx = -s.bvx; }
      maybeSpeedup(s, hit.r);
      if (s.bricksLeft === 0) {
        s.wall = freshWall();
        s.bricksLeft = COLS * ROWS;
        s.wallNo++;
        s.hits = 0;
        s.baseSpeedLvl = Math.min(s.baseSpeedLvl + 1, SPEEDS.length - 1);
        s.speedLvl = s.baseSpeedLvl;
        s.serving = 1;
        s.serveCd = AUTO_SERVE;
        s.events.push({ t: "wall-clear", wall: s.wallNo });
        return;
      }
    }

    if (s.bvy > 0 &&
        s.by + BALL_R >= PADDLE_Y - PADDLE_H && s.by + BALL_R <= PADDLE_Y + (6 << FP) &&
        s.bx >= s.px - half - BALL_R && s.bx <= s.px + half + BALL_R) {
      // English: contact point picks one of 7 exit angles.
      let off = Math.trunc(((s.bx - s.px) * 3) / (half + BALL_R));
      if (off < -3) off = -3;
      if (off > 3) off = 3;
      // Never return dead-vertical: a center hit deflects with the ball's
      // incoming direction, or the ball loops one empty column forever.
      if (off === 0) off = s.bvx < 0 ? -1 : 1;
      setVelFromAngle(s, (192 + off * 8) & 255);
      s.by = PADDLE_Y - PADDLE_H - BALL_R;
      s.events.push({ t: "paddle" });
    }

    if (s.by > HF + BALL_R) loseBall(s);
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.balls); mix(s.wallNo);
    mix(s.px); mix(s.pw); mix(s.bx); mix(s.by); mix(s.bvx); mix(s.bvy);
    mix(s.serving); mix(s.serveCd); mix(s.hits); mix(s.speedLvl);
    mix(s.ceilingHit); mix(s.bricksLeft); mix(s.rs); mix(s.gameOver);
    for (let r = 0; r < ROWS; r++) {
      let bits = 0;
      for (let c = 0; c < COLS; c++) bits = (bits << 1) | s.wall[r][c];
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
    return { score: s.score, ticks: s.tick, wallNo: s.wallNo, bricksLeft: s.bricksLeft, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, W, H, FP, COLS, ROWS, ROW_PTS, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Breakpoint;
