// COIL — deterministic snake core for QUARTERS. Same contract as voidrocks:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask is an absolute direction request: 1=left 2=right 4=up 8=down.
// One life. Walls are solid. Gold coin is the single risk-lever: big points,
// short fuse, usually somewhere inconvenient.
const Coil = (() => {
  const COLS = 40, ROWS = 30, CELL = 24;   // 960x720 board
  const MOVE_START = 9;                     // ticks per cell at speed 0
  const MOVE_MIN = 4;
  const APPLES_PER_SPEED = 5;
  const APPLE_PTS = 10;
  const COIN_PTS = 150;
  const COIN_TTL = 300;                     // 5s to grab it
  const GROW_PER_APPLE = 3;
  const START_LEN = 4;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1]; // dir: 0=left 1=right 2=up 3=down
  const OPP = [1, 0, 3, 2];

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, apples: 0, speed: 0,
      dir: 1, pendingDir: 1, pendingDir2: -1,
      moveCd: MOVE_START, grow: 0,
      snake: [],                            // head first, {x,y} cells
      apple: { x: 0, y: 0 },
      coin: null,                           // {x,y,ttl}
      coinTimer: 0,
      gameOver: 0,
      events: [],
    };
    const cy = ROWS >> 1;
    for (let i = 0; i < START_LEN; i++) s.snake.push({ x: 8 - i, y: cy });
    s.coinTimer = 400 + rnd(s, 600);
    placeApple(s);
    return s;
  }

  function occupied(s, x, y) {
    for (const c of s.snake) if (c.x === x && c.y === y) return true;
    return false;
  }

  // Pick the k-th free cell by walking the grid — bounded and deterministic
  // even when the board is nearly full.
  function placeAt(s, avoidApple) {
    let free = COLS * ROWS - s.snake.length;
    if (avoidApple) free--;
    if (s.coin) free--;
    if (free <= 0) return null;
    let k = rnd(s, free);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (occupied(s, x, y)) continue;
        if (avoidApple && s.apple.x === x && s.apple.y === y) continue;
        if (s.coin && s.coin.x === x && s.coin.y === y) continue;
        if (k === 0) return { x, y };
        k--;
      }
    }
    return null;
  }

  function placeApple(s) {
    const p = placeAt(s, false);
    if (p) { s.apple.x = p.x; s.apple.y = p.y; }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    // Latest single-direction request wins; reversing into yourself is ignored.
    let req = -1;
    if (input & 1) req = 0;
    else if (input & 2) req = 1;
    else if (input & 4) req = 2;
    else if (input & 8) req = 3;
    if (req >= 0) {
      if (req !== s.pendingDir && req !== OPP[s.pendingDir]) {
        if (s.pendingDir === s.dir) { if (req !== OPP[s.dir]) s.pendingDir = req; }
        else if (s.pendingDir2 !== req) s.pendingDir2 = req;
      }
    }

    if (s.coin) {
      s.coin.ttl--;
      if (s.coin.ttl <= 0) { s.coin = null; s.coinTimer = 500 + rnd(s, 700); }
    } else {
      if (--s.coinTimer <= 0) {
        const p = placeAt(s, true);
        if (p) { s.coin = { x: p.x, y: p.y, ttl: COIN_TTL }; s.events.push({ t: "coin-in" }); }
        else s.coinTimer = 120;
      }
    }

    if (--s.moveCd > 0) return;
    s.moveCd = Math.max(MOVE_MIN, MOVE_START - s.speed);

    s.dir = s.pendingDir;
    if (s.pendingDir2 >= 0 && s.pendingDir2 !== OPP[s.dir]) { s.pendingDir = s.pendingDir2; }
    s.pendingDir2 = -1;
    const head = s.snake[0];
    const nx = head.x + DX[s.dir], ny = head.y + DY[s.dir];

    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
      s.gameOver = 1; s.events.push({ t: "die", x: head.x, y: head.y }); return;
    }
    // Tail cell is safe to move into unless the snake is growing this step.
    const tailIdx = s.snake.length - 1;
    for (let i = 0; i < s.snake.length; i++) {
      if (i === tailIdx && s.grow === 0) continue;
      if (s.snake[i].x === nx && s.snake[i].y === ny) {
        s.gameOver = 1; s.events.push({ t: "die", x: head.x, y: head.y }); return;
      }
    }

    s.snake.unshift({ x: nx, y: ny });
    if (s.grow > 0) s.grow--;
    else s.snake.pop();

    if (nx === s.apple.x && ny === s.apple.y) {
      s.score += APPLE_PTS + s.speed * 2;
      s.apples++;
      s.grow += GROW_PER_APPLE;
      s.events.push({ t: "eat" });
      if (s.apples % APPLES_PER_SPEED === 0) { s.speed++; s.events.push({ t: "speedup", level: s.speed }); }
      placeApple(s);
    }
    if (s.coin && nx === s.coin.x && ny === s.coin.y) {
      s.score += COIN_PTS;
      s.grow += 1;
      s.coin = null;
      s.coinTimer = 500 + rnd(s, 700);
      s.events.push({ t: "coin" });
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.apples); mix(s.speed);
    mix(s.dir); mix(s.pendingDir); mix(s.pendingDir2); mix(s.moveCd); mix(s.grow);
    mix(s.rs); mix(s.gameOver); mix(s.coinTimer);
    mix(s.apple.x); mix(s.apple.y);
    if (s.coin) { mix(s.coin.x); mix(s.coin.y); mix(s.coin.ttl); }
    for (const c of s.snake) { mix(c.x); mix(c.y); }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, apples: s.apples, len: s.snake.length, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, COLS, ROWS, CELL, MOVE_START, MOVE_MIN, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Coil;
