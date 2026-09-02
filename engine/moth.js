// MOTH — deterministic one-button core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 8=flap (rising edge). One life. Fly the gaps; the gold lamp
// inside a gap is the risk-lever: +5, never centered. Gaps shrink and the
// world speeds up as the run goes on.
const Moth = (() => {
  const W = 960, H = 720, FP = 8;
  const HF = H << FP;

  const MOTH_X = 280;                 // fixed screen x, integer px
  const MOTH_R = 10;
  const GRAV = 46;                    // fp px/tick^2
  const FLAP = -820;                  // fp px/tick impulse
  const VMAX = 950;
  const SCROLL_START = 640;           // fp px/tick
  const SCROLL_STEP = 18;             // + per gate passed
  const SCROLL_MAX = 980;
  const GATE_SPACING = 300;           // px between gates
  const GATE_W = 70;
  const GAP_START = 200, GAP_MIN = 132, GAP_SHRINK = 2;
  const LAMP_R = 12, LAMP_PTS = 5;
  const MAX_TICKS = 36000;

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }

  function spawnGate(s, x) {
    const gapH = Math.max(GAP_MIN, GAP_START - s.gates_spawned * GAP_SHRINK);
    const margin = 70;
    // Consecutive gaps stay within climbing range — the game must always be
    // winnable; difficulty comes from shrink and speed, not unfair deals.
    let lo = margin + (gapH >> 1);
    let hi = H - margin - (gapH >> 1);
    if (s.lastGapY) {
      lo = Math.max(lo, s.lastGapY - 200);
      hi = Math.min(hi, s.lastGapY + 240);
    }
    const gapY = lo + rnd(s, Math.max(1, hi - lo));
    s.lastGapY = gapY;
    let lamp = 0, lampY = 0;
    if (s.gates_spawned >= 2 && rnd(s, 2) === 0) {
      lamp = 1;
      // Off-center on purpose: near the top or bottom lip of the gap.
      const edge = (gapH >> 1) - 34;
      lampY = gapY + (rnd(s, 2) === 0 ? -edge : edge);
    }
    s.gates.push({ x: x << FP, gapY, gapH, lamp, lampY, passed: 0 });
    s.gates_spawned++;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, gatesPassed: 0, gates_spawned: 0, lastGapY: 0,
      y: (H >> 1) << FP, vy: 0,
      scroll: SCROLL_START,
      prevIn: 0, started: 0,
      gates: [],
      gameOver: 0,
      events: [],
    };
    for (let i = 0; i < 5; i++) spawnGate(s, 700 + i * GATE_SPACING);
    return s;
  }

  function die(s) {
    s.gameOver = 1;
    s.events.push({ t: "die", y: s.y >> FP });
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    const flapEdge = (input & 8) && !(s.prevIn & 8);
    s.prevIn = input;

    // Hover until the first flap so the credit starts on the player's terms —
    // but only for 10s, or an idle credit would coast to the tick cap.
    if (!s.started) {
      if (flapEdge) { s.started = 1; s.vy = FLAP; s.events.push({ t: "flap" }); }
      else if (s.tick > 600) { die(s); return; }
      else { s.y = ((H >> 1) << FP) + ((tri(s.tick) * 40) | 0); return; }
    } else if (flapEdge) {
      s.vy = FLAP;
      s.events.push({ t: "flap" });
    }

    s.vy += GRAV;
    if (s.vy > VMAX) s.vy = VMAX;
    s.y += s.vy;

    if (s.y < MOTH_R << FP || s.y > HF - (MOTH_R << FP)) { die(s); return; }

    for (const g of s.gates) g.x -= s.scroll;

    if (s.gates.length && s.gates[0].x < (-100 << FP)) s.gates.shift();
    const lastX = s.gates.length ? s.gates[s.gates.length - 1].x >> FP : 700;
    if (lastX < W + 100) spawnGate(s, lastX + GATE_SPACING);

    const my = s.y >> FP;
    for (const g of s.gates) {
      const gx = g.x >> FP;
      // Pillar collision while overlapping the gate column.
      if (MOTH_X + MOTH_R > gx - GATE_W / 2 && MOTH_X - MOTH_R < gx + GATE_W / 2) {
        const top = g.gapY - (g.gapH >> 1), bot = g.gapY + (g.gapH >> 1);
        if (my - MOTH_R < top || my + MOTH_R > bot) { die(s); return; }
        if (g.lamp) {
          const dy = my - g.lampY;
          if (dy > -(LAMP_R + MOTH_R) && dy < LAMP_R + MOTH_R && MOTH_X >= gx - LAMP_R && MOTH_X <= gx + LAMP_R) {
            g.lamp = 0;
            s.score += LAMP_PTS;
            s.events.push({ t: "lamp" });
          }
        }
      }
      if (!g.passed && gx + GATE_W / 2 < MOTH_X - MOTH_R) {
        g.passed = 1;
        s.score += 1;
        s.gatesPassed++;
        s.scroll = Math.min(SCROLL_MAX, s.scroll + SCROLL_STEP);
        s.events.push({ t: "gate", n: s.gatesPassed });
      }
    }
  }

  // Integer triangle wave in [-256, 256] for the pre-start hover bob.
  function tri(t) {
    const p = t % 240;
    return p < 120 ? (p * 512 / 120 - 256) | 0 : (256 - (p - 120) * 512 / 120) | 0;
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.gatesPassed); mix(s.gates_spawned); mix(s.lastGapY);
    mix(s.y); mix(s.vy); mix(s.scroll); mix(s.prevIn); mix(s.started);
    mix(s.rs); mix(s.gameOver);
    for (const g of s.gates) { mix(g.x); mix(g.gapY); mix(g.gapH); mix(g.lamp); mix(g.lampY); mix(g.passed); }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, gates: s.gatesPassed, hash: stateHash(s), gameOver: s.gameOver };
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

  return { createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE, W, H, FP, MOTH_X, MOTH_R, GATE_W, LAMP_R, MAX_TICKS };
})();
if (typeof module !== "undefined") module.exports = Moth;
