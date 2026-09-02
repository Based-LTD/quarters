// SKYFALL — deterministic city-defense core for QUARTERS. Same contract:
// integer-only state, fixed 60Hz timestep, seeded RNG, score = f(seed, inputs).
// Input bitmask: 1=left 2=right 4=up 8=down (crosshair), 16=fire.
// Warheads fall on six cities and three silos; you detonate blast blooms in
// their paths from whichever silo still has ammo. Warheads split as they
// fall. The wave ends when the sky is clear; the game ends when the last
// city burns. Ammo and surviving cities pay bonuses between waves.
const Skyfall = (() => {
  const W = 960, H = 720, FP = 8;
  const GROUND = 660;
  const CROSS_SPEED = 9 << FP;
  const MISSILE_SPEED = 11;            // px/tick, integer px
  const BLAST_MAX = 46, BLAST_GROW = 28, BLAST_HOLD = 26, BLAST_FADE = 26;
  const CITY_X = [120, 240, 360, 600, 720, 840];
  const SILO_X = [60, 480, 900];
  const AMMO = 10;
  const KILL_PTS = 25, CITY_BONUS = 100, AMMO_BONUS = 5;
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

  function targetsAlive(s) {
    const t = [];
    for (let i = 0; i < 6; i++) if (s.cities[i]) t.push({ x: CITY_X[i], city: i });
    for (let i = 0; i < 3; i++) if (s.ammo[i] > 0) t.push({ x: SILO_X[i], silo: i });
    return t;
  }

  function spawnWaveQueue(s) {
    s.queue = 4 + s.wave * 3;
    s.spawnCd = 30;
    for (let i = 0; i < 3; i++) s.ammo[i] = AMMO;
    s.events.push({ t: "wave", wave: s.wave });
  }

  function spawnWarhead(s, x0, y0) {
    const targets = targetsAlive(s);
    if (targets.length === 0) return;
    const tgt = targets[rnd(s, targets.length)];
    const dx = tgt.x - x0, dy = GROUND - y0;
    const dist = isqrt(dx * dx + dy * dy) || 1;
    const spd = 70 + s.wave * 14 + rnd(s, 40);   // fp px/tick
    s.warheads.push({
      x: x0 << FP, y: y0 << FP,
      vx: Math.trunc(dx * spd / dist), vy: Math.trunc(dy * spd / dist),
      splitAt: y0 < 200 && rnd(s, 3) > 0 ? 200 + rnd(s, 240) : 0,
    });
  }

  function createState(seed) {
    const s = {
      rs: seed | 0,
      tick: 0, score: 0, wave: 1,
      cx: (W >> 1) << FP, cy: 280 << FP,
      fireHeld: 0,
      cities: [1, 1, 1, 1, 1, 1],
      ammo: [AMMO, AMMO, AMMO],
      missiles: [], blasts: [], warheads: [],
      queue: 0, spawnCd: 0, betweenCd: 0,
      gameOver: 0,
      events: [],
    };
    spawnWaveQueue(s);
    return s;
  }

  function tick(s, input) {
    if (s.gameOver) return;
    s.events = [];
    s.tick++;
    if (s.tick >= MAX_TICKS) { s.gameOver = 1; return; }

    // Crosshair
    if (input & 1) s.cx -= CROSS_SPEED;
    if (input & 2) s.cx += CROSS_SPEED;
    if (input & 4) s.cy -= CROSS_SPEED;
    if (input & 8) s.cy += CROSS_SPEED;
    if (s.cx < 20 << FP) s.cx = 20 << FP;
    if (s.cx > (W - 20) << FP) s.cx = (W - 20) << FP;
    if (s.cy < 30 << FP) s.cy = 30 << FP;
    if (s.cy > (GROUND - 60) << FP) s.cy = (GROUND - 60) << FP;

    // Fire from the nearest silo with ammo (edge-triggered).
    const fireEdge = (input & 16) && !s.fireHeld;
    s.fireHeld = input & 16 ? 1 : 0;
    if (fireEdge) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < 3; i++) {
        if (s.ammo[i] <= 0) continue;
        const d = Math.abs(SILO_X[i] - (s.cx >> FP));
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        s.ammo[best]--;
        const sx = SILO_X[best], sy = GROUND - 16;
        const tx = s.cx >> FP, ty = s.cy >> FP;
        const dx = tx - sx, dy = ty - sy;
        const dist = isqrt(dx * dx + dy * dy) || 1;
        s.missiles.push({
          x: sx << FP, y: sy << FP,
          vx: Math.trunc((dx << FP) * MISSILE_SPEED / dist),
          vy: Math.trunc((dy << FP) * MISSILE_SPEED / dist),
          tx, ty, sx, sy,
        });
        s.events.push({ t: "launch", silo: best });
      } else {
        s.events.push({ t: "dryfire" });
      }
    }

    // Missiles: fly to their mark, then bloom.
    for (let i = s.missiles.length - 1; i >= 0; i--) {
      const m = s.missiles[i];
      m.x += m.vx;
      m.y += m.vy;
      const dx = (m.x >> FP) - m.tx, dy = (m.y >> FP) - m.ty;
      if (dx * dx + dy * dy < MISSILE_SPEED * MISSILE_SPEED) {
        s.blasts.push({ x: m.tx, y: m.ty, age: 0 });
        s.events.push({ t: "bloom", x: m.tx, y: m.ty });
        s.missiles.splice(i, 1);
      }
    }

    // Blasts grow, hold, fade; radius as a function of age.
    for (let i = s.blasts.length - 1; i >= 0; i--) {
      const b = s.blasts[i];
      b.age++;
      if (b.age > BLAST_GROW + BLAST_HOLD + BLAST_FADE) s.blasts.splice(i, 1);
    }

    // Spawning
    if (s.queue > 0 && --s.spawnCd <= 0) {
      s.spawnCd = Math.max(20, 95 - s.wave * 8) + rnd(s, 30);
      s.queue--;
      spawnWarhead(s, 40 + rnd(s, W - 80), 10);
    }

    // Warheads fall; blasts kill them; ground contact resolves damage.
    for (let i = s.warheads.length - 1; i >= 0; i--) {
      const wh = s.warheads[i];
      wh.x += wh.vx;
      wh.y += wh.vy;
      const wx = wh.x >> FP, wy = wh.y >> FP;

      if (wh.splitAt && wy >= wh.splitAt) {
        wh.splitAt = 0;
        const n = 1 + rnd(s, 2);
        for (let k = 0; k < n; k++) spawnWarhead(s, wx, wy);
        s.events.push({ t: "split", x: wx, y: wy });
      }

      let dead = false;
      for (const b of s.blasts) {
        const r = b.age <= BLAST_GROW
          ? Math.trunc(BLAST_MAX * b.age / BLAST_GROW)
          : b.age <= BLAST_GROW + BLAST_HOLD
            ? BLAST_MAX
            : Math.trunc(BLAST_MAX * (BLAST_GROW + BLAST_HOLD + BLAST_FADE - b.age) / BLAST_FADE);
        const dx = wx - b.x, dy = wy - b.y;
        if (dx * dx + dy * dy <= r * r) { dead = true; break; }
      }
      if (dead) {
        s.score += KILL_PTS * s.wave;
        s.events.push({ t: "kill", x: wx, y: wy, pts: KILL_PTS * s.wave });
        s.blasts.push({ x: wx, y: wy, age: 0 });
        s.warheads.splice(i, 1);
        continue;
      }

      if (wy >= GROUND) {
        for (let c = 0; c < 6; c++) {
          if (s.cities[c] && Math.abs(CITY_X[c] - wx) < 34) {
            s.cities[c] = 0;
            s.events.push({ t: "cityhit", city: c });
          }
        }
        for (let c = 0; c < 3; c++) {
          if (s.ammo[c] > 0 && Math.abs(SILO_X[c] - wx) < 26) {
            s.ammo[c] = 0;
            s.events.push({ t: "silohit", silo: c });
          }
        }
        s.blasts.push({ x: wx, y: GROUND - 4, age: 0 });
        s.warheads.splice(i, 1);
      }
    }

    if (!s.cities.some((c) => c)) {
      s.events.push({ t: "theend" });
      s.gameOver = 1;
      return;
    }

    // Wave complete: sky clear, queue empty, no missiles in flight.
    if (s.queue === 0 && s.warheads.length === 0 && s.missiles.length === 0 && s.blasts.length === 0) {
      const ammoLeft = s.ammo[0] + s.ammo[1] + s.ammo[2];
      const citiesLeft = s.cities.filter((c) => c).length;
      const bonus = ammoLeft * AMMO_BONUS * s.wave + citiesLeft * CITY_BONUS * s.wave;
      s.score += bonus;
      s.events.push({ t: "wavebonus", bonus, ammoLeft, citiesLeft });
      s.wave++;
      spawnWaveQueue(s);
    }
  }

  function stateHash(s) {
    let h = 0x811c9dc5;
    const mix = (v) => {
      h = (h ^ ((v | 0) >>> 0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(s.tick); mix(s.score); mix(s.wave);
    mix(s.cx); mix(s.cy); mix(s.fireHeld);
    mix(s.queue); mix(s.spawnCd); mix(s.rs); mix(s.gameOver);
    for (const c of s.cities) mix(c);
    for (const a of s.ammo) mix(a);
    for (const m of s.missiles) { mix(m.x); mix(m.y); mix(m.tx); mix(m.ty); }
    for (const b of s.blasts) { mix(b.x); mix(b.y); mix(b.age); }
    for (const wh of s.warheads) { mix(wh.x); mix(wh.y); mix(wh.vx); mix(wh.vy); mix(wh.splitAt); }
    return h >>> 0;
  }

  function runHeadless(seed, masks, grace = 600) {
    const s = createState(seed);
    let i = 0;
    while (!s.gameOver && i < masks.length + grace && s.tick < MAX_TICKS) {
      tick(s, i < masks.length ? masks[i] : 0);
      i++;
    }
    return { score: s.score, ticks: s.tick, wave: s.wave, cities: s.cities.filter((c) => c).length, hash: stateHash(s), gameOver: s.gameOver };
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
    W, H, FP, GROUND, CITY_X, SILO_X, BLAST_MAX, BLAST_GROW, BLAST_HOLD, BLAST_FADE, MAX_TICKS,
  };
})();
if (typeof module !== "undefined") module.exports = Skyfall;
