// CLAIM — deterministic territory-capture core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=left 2=right 4=up 8=down.
// Walk the claimed ground; step into the void and you're drawing a live wire.
// Reach claimed ground again and everything walled off from the QIX becomes
// yours. The QIX hunts your wire; the sparx hunt you on the ground you own.
// Claim 75% to advance. Three lives.
const Claim = (() => {
  const W = 960, H = 720;
  const CELL = 8, GC = 120, GR = 90;
  const UNCLAIMED = 0, CLAIMED = 1, TRAIL = 2;
  const MOVE_EVERY = 2;                // player cell step cadence
  const SPARX_EVERY = 4;
  const TARGET_PCT = 75;
  const AREA_DIV = 4;                  // 1 point per 4 cells claimed
  const WAVE_BONUS = 500;
  const START_LIVES = 3;
  const RESPAWN = 90;
  const INVULN = 150;
  const MAX_TICKS = 36000;
  const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];

  function mulberry(s) {
    s.rs = (s.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s.rs ^ (s.rs >>> 15), 1 | s.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  }
  function rnd(s, n) { return mulberry(s) % n; }
  function gi(c, r) { return r * GC + c; }

  function fieldStart(s) {
    s.grid = new Uint8Array(GC * GR);
    // Border ring is home ground.
    for (let c = 0; c < GC; c++) { s.grid[gi(c, 0)] = CLAIMED; s.grid[gi(c, GR - 1)] = CLAIMED; }
    for (let r = 0; r < GR; r++) { s.grid[gi(0, r)] = CLAIMED; s.grid[gi(GC - 1, r)] = CLAIMED; }
    s.claimedCount = 2 * GC + 2 * (GR - 2);
    s.trail = [];
    s.pc = GC >> 1;
    s.pr = GR - 1;
    s.qx = (GC >> 1) << 8;             // qix in cell-fixed-point
    s.qy = (GR >> 1) << 8;
    s.qvx = 40 + rnd(s, 30);
    s.qvy = 30 + rnd(s, 30);
    s.sparx = [];
    const n = Math.min(4, 1 + s.wave);
    for (let i = 0; i < n; i++) {
      s.sparx.push({ c: rnd(s, GC), r: rnd(s, 2) ? 0 : GR - 1, cd: SPARX_EVERY + i });
    }
    s.moveCd = MOVE_EVERY;
    s.invuln = INVULN;
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, lives: START_LIVES, wave: 1,
      grid: null, claimedCount: 0, trail: [],
      pc: 0, pr: 0, moveCd: MOVE_EVERY,
      qx: 0, qy: 0, qvx: 0, qvy: 0,
      sparx: [], invuln: 0, dead: 0,
      gameOver: 0,
      events: [],
    };
    fieldStart(s);
    return s;
  }

  function die(s) {
    s.lives--;
    s.events.push({ t: "die", c: s.pc, r: s.pr });
    // The wire burns away.
    for (const t of s.trail) s.grid[gi(t.c, t.r)] = UNCLAIMED;
    s.trail = [];
    if (s.lives <= 0) { s.gameOver = 1; return; }
    s.dead = RESPAWN;
  }

  function respawn(s) {
    s.pc = GC >> 1;
    s.pr = GR - 1;
    s.invuln = INVULN;
  }

  // Close the wire: flood the void from the QIX; anything it can't reach is
  // captured, wire included.
  function closeTrail(s) {
    for (const t of s.trail) s.grid[gi(t.c, t.r)] = CLAIMED;
    const reach = new Uint8Array(GC * GR);
    const qc = Math.max(0, Math.min(GC - 1, s.qx >> 8));
    const qr = Math.max(0, Math.min(GR - 1, s.qy >> 8));
    const stack = [];
    if (s.grid[gi(qc, qr)] === UNCLAIMED) stack.push(gi(qc, qr));
    while (stack.length) {
      const i = stack.pop();
      if (reach[i]) continue;
      reach[i] = 1;
      const c = i % GC, r = (i / GC) | 0;
      for (let d = 0; d < 4; d++) {
        const nc = c + DX[d], nr = r + DY[d];
        if (nc < 0 || nc >= GC || nr < 0 || nr >= GR) continue;
        const ni = gi(nc, nr);
        if (!reach[ni] && s.grid[ni] === UNCLAIMED) stack.push(ni);
      }
    }
    let gained = s.trail.length;
    for (let i = 0; i < s.grid.length; i++) {
      if (s.grid[i] === UNCLAIMED && !reach[i]) {
        s.grid[i] = CLAIMED;
        gained++;
      }
    }
    s.trail = [];
    s.claimedCount += gained;
    const pts = Math.trunc(gained / AREA_DIV);
    s.score += pts;
    s.events.push({ t: "claim", cells: gained, pts, c: s.pc, r: s.pr });

    const interior = (GC - 2) * (GR - 2);
    const interiorClaimed = s.claimedCount - (2 * GC + 2 * (GR - 2));
    if (interiorClaimed * 100 >= interior * TARGET_PCT) {
      s.score += WAVE_BONUS * s.wave;
      s.wave++;
      s.events.push({ t: "wave", wave: s.wave });
      fieldStart(s);
    }
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) respawn(s);
      return;
    }
    if (s.invuln > 0) s.invuln--;

    // Player steps
    if (--s.moveCd <= 0) {
      s.moveCd = MOVE_EVERY;
      let d = -1;
      if (input & 1) d = 0;
      else if (input & 2) d = 1;
      else if (input & 4) d = 2;
      else if (input & 8) d = 3;
      if (d >= 0) {
        const nc = s.pc + DX[d], nr = s.pr + DY[d];
        if (nc >= 0 && nc < GC && nr >= 0 && nr < GR) {
          const v = s.grid[gi(nc, nr)];
          if (v === TRAIL) {
            die(s);
            return;
          } else if (v === CLAIMED) {
            s.pc = nc;
            s.pr = nr;
            if (s.trail.length) closeTrail(s);
          } else {
            // Into the void: lay wire.
            s.grid[gi(nc, nr)] = TRAIL;
            s.trail.push({ c: nc, r: nr });
            s.pc = nc;
            s.pr = nr;
            if (s.trail.length === 1) s.events.push({ t: "wire" });
          }
        }
      }
    }

    // QIX drifts through the void, bouncing off anything solid.
    {
      const step = () => {
        let nx = s.qx + s.qvx, ny = s.qy + s.qvy;
        const nc = nx >> 8, nr = ny >> 8;
        if (nc < 1 || nc >= GC - 1 || s.grid[gi(Math.max(0, Math.min(GC - 1, nc)), Math.max(0, Math.min(GR - 1, s.qy >> 8)))] !== UNCLAIMED) {
          s.qvx = -s.qvx + (rnd(s, 11) - 5);
          nx = s.qx;
        }
        if (nr < 1 || nr >= GR - 1 || s.grid[gi(Math.max(0, Math.min(GC - 1, s.qx >> 8)), Math.max(0, Math.min(GR - 1, nr)))] !== UNCLAIMED) {
          s.qvy = -s.qvy + (rnd(s, 11) - 5);
          ny = s.qy;
        }
        s.qx = nx;
        s.qy = ny;
      };
      step();
      // QIX vs wire (and vs the player standing at the wire's tip).
      const qc = s.qx >> 8, qr = s.qy >> 8;
      if (qc >= 0 && qc < GC && qr >= 0 && qr < GR && s.grid[gi(qc, qr)] === TRAIL) {
        s.events.push({ t: "zap", c: qc, r: qr });
        die(s);
        return;
      }
    }

    // Sparx crawl the claimed ground toward the player.
    for (const sp of s.sparx) {
      if (--sp.cd > 0) continue;
      sp.cd = SPARX_EVERY;
      const dc = s.pc - sp.c, dr = s.pr - sp.r;
      const prefer = Math.abs(dc) >= Math.abs(dr)
        ? [dc < 0 ? 0 : 1, dr < 0 ? 2 : 3, dr < 0 ? 3 : 2, dc < 0 ? 1 : 0]
        : [dr < 0 ? 2 : 3, dc < 0 ? 0 : 1, dc < 0 ? 1 : 0, dr < 0 ? 3 : 2];
      for (const d of prefer) {
        const nc = sp.c + DX[d], nr = sp.r + DY[d];
        if (nc < 0 || nc >= GC || nr < 0 || nr >= GR) continue;
        if (s.grid[gi(nc, nr)] === CLAIMED) {
          sp.c = nc;
          sp.r = nr;
          break;
        }
      }
      if (s.invuln === 0 && s.dead === 0 && sp.c === s.pc && sp.r === s.pr && s.trail.length === 0) {
        die(s);
        return;
      }
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.lives); mix(s.wave); mix(s.claimedCount);
    mix(s.pc); mix(s.pr); mix(s.moveCd);
    mix(s.qx); mix(s.qy); mix(s.qvx); mix(s.qvy);
    mix(s.invuln); mix(s.dead); mix(s.rs); mix(s.gameOver);
    mix(s.trail.length);
    for (const t of s.trail) { mix(t.c); mix(t.r); }
    for (const sp of s.sparx) { mix(sp.c); mix(sp.r); mix(sp.cd); }
    for (let i = 0; i < s.grid.length; i += 89) mix(s.grid[i]);
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    const interior = (GC - 2) * (GR - 2);
    const interiorClaimed = s.claimedCount - (2 * GC + 2 * (GR - 2));
    return {
      score: s.score, ticks: s.tick, wave: s.wave,
      pct: Math.trunc(interiorClaimed * 100 / interior),
      hash: stateHash(s), gameOver: s.gameOver,
    };
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

  return {
    createState, tick, stateHash, runHeadless, encodeRLE, decodeRLE,
    W, H, CELL, GC, GR, UNCLAIMED, CLAIMED, TRAIL, TARGET_PCT, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Claim;
