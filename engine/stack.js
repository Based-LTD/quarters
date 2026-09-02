// STACK — deterministic timing-tower core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 8=drop (edge). A row of blocks sweeps side to side; drop it
// on the stack and everything hanging over the edge is cut. The tower narrows
// on a schedule, the sweep gets faster, and one full miss ends the credit —
// the arcade prize machine, honest.
const Stack = (() => {
  const COLS = 13, ROWS = 20;
  const START_W = 4;
  const NARROW_AT = { 5: 3, 10: 2, 15: 1 };   // rows where max width shrinks
  const JACKPOT = 2000, PERFECT = 25;
  const ROW_LIMIT = 900;                       // 15s per row, then auto-drop
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function moveEvery(s) {
    return Math.max(2, 9 - (s.row >> 1) - (s.level - 1));
  }

  function newRow(s) {
    let w = START_W;
    for (const r of Object.keys(NARROW_AT)) {
      if (s.row >= +r) w = NARROW_AT[r];
    }
    if (w > s.baseW) w = s.baseW;
    s.curW = w;
    s.pos = rnd(s, COLS - w);
    s.dir = rnd(s, 2) ? 1 : -1;
    s.moveCd = moveEvery(s);
    s.rowTimer = ROW_LIMIT;
  }

  function towerStart(s) {
    s.rows = [{ x0: Math.trunc((COLS - START_W) / 2), w: START_W }];
    s.row = 1;
    s.baseW = START_W;
    newRow(s);
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, level: 1,
      rows: [], row: 1, baseW: START_W,
      pos: 0, dir: 1, curW: START_W, moveCd: 9, rowTimer: ROW_LIMIT,
      prevIn: 0,
      gameOver: 0,
      events: [],
    };
    towerStart(s);
    return s;
  }

  function drop(s) {
    const below = s.rows[s.rows.length - 1];
    const lo = Math.max(s.pos, below.x0);
    const hi = Math.min(s.pos + s.curW, below.x0 + below.w);
    const w = hi - lo;
    if (w <= 0) {
      s.events.push({ t: "miss", pos: s.pos, row: s.row });
      s.gameOver = 1;
      return;
    }
    const cut = s.curW - w;
    if (cut > 0) s.events.push({ t: "cut", n: cut, pos: s.pos, row: s.row });
    s.rows.push({ x0: lo, w });
    s.baseW = w;
    s.score += s.row * 10 + (cut === 0 && w === s.curW ? PERFECT : 0);
    if (cut === 0 && w === s.curW) s.events.push({ t: "perfect", row: s.row });
    s.events.push({ t: "place", row: s.row, w });
    s.row++;
    if (s.row > ROWS) {
      s.score += JACKPOT;
      s.level++;
      s.events.push({ t: "jackpot", level: s.level });
      towerStart(s);
      return;
    }
    newRow(s);
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    const dropEdge = (input & 8) && !(s.prevIn & 8);
    s.prevIn = input;

    // Drop resolves BEFORE the sweep steps — you place what you saw.
    if (dropEdge) { drop(s); return; }

    if (--s.moveCd <= 0) {
      s.moveCd = moveEvery(s);
      s.pos += s.dir;
      if (s.pos <= 0) { s.pos = 0; s.dir = 1; }
      if (s.pos + s.curW >= COLS) { s.pos = COLS - s.curW; s.dir = -1; }
      s.events.push({ t: "step" });
    }

    if (--s.rowTimer <= 0) { s.events.push({ t: "timeout" }); drop(s); }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.level); mix(s.row); mix(s.baseW);
    mix(s.pos); mix(s.dir); mix(s.curW); mix(s.moveCd); mix(s.rowTimer);
    mix(s.prevIn); mix(s.rs); mix(s.gameOver);
    for (const r of s.rows) { mix(r.x0); mix(r.w); }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, level: s.level, row: s.row, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, COLS, ROWS, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Stack;
