// First-pass review of a held Bounty win: measure the run, then ask Claude
// whether a human played it. The verdict decides the path:
//   human, confident, no bot flags → pays without waking anyone
//   unsure / bot                   → the owner's phone, with Claude's reasoning
//   nobody answers in time         → Claude's recommendation (bot → reject)
// Any failure here (no key, API down, refusal, bad output) returns null and
// the hold falls back to the human-only path. Nothing pays because the
// reviewer broke.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = process.env.REVIEW_MODEL || "claude-opus-5";

// ---------- evidence ----------

// Void Rocks: how fast does the player steer after a threat appears? A threat
// is a rock or a saucer shot that comes inside striking range while closing
// on the ship. Reaction = ticks (1/60 s) until the steering/thrust input
// changes. Fire (bit 8) is excluded: players tap it constantly.
function voidRocksReactions(Engine, seed, masks) {
  const FP = Engine.FP || 8, W = (Engine.W || 960) << FP, H = (Engine.H || 720) << FP, ROCK_R = Engine.ROCK_R || [0, 11 << FP, 20 << FP, 38 << FP];
  const wrap = (d, span) => { d %= span; if (d > span / 2) d -= span; if (d < -span / 2) d += span; return d; };
  const s = Engine.createState(seed | 0), out = [];
  let prevThreat = false, pending = null;
  for (let i = 0; i < masks.length && !s.gameOver; i++) {
    const move = masks[i] & 7;
    let threat = false;
    if (!s.dead) {
      const near = (o, reach) => {
        const dx = wrap(o.x - s.x, W), dy = wrap(o.y - s.y, H);
        const closing = dx * (o.vx - s.vx) + dy * (o.vy - s.vy) < 0;
        return closing && dx * dx + dy * dy < reach * reach;
      };
      for (const r of s.rocks) if (near(r, ROCK_R[r.size] + (70 << FP))) { threat = true; break; }
      if (!threat) for (const b of s.ebullets || []) if (near(b, 90 << FP)) { threat = true; break; }
    }
    if (threat && !prevThreat && !pending) pending = { start: i, base: move };
    if (pending) {
      if (move !== pending.base) { out.push(i - pending.start); pending = null; }
      else if (s.dead || i - pending.start > 90) pending = null;   // no reaction within 1.5 s: not counted
    }
    prevThreat = threat;
    Engine.tick(s, masks[i]);
  }
  if (!out.length) return { threats: 0 };
  const a = out.slice().sort((x, y) => x - y), q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length, sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return {
    threats: a.length, unit: "ticks (1/60 s)",
    median: q(0.5), p10: q(0.1), p90: q(0.9), mean: Math.round(mean * 10) / 10, cv: mean ? Math.round((sd / mean) * 100) / 100 : 0,
    under6ticksShare: Math.round((a.filter((x) => x < 6).length / a.length) * 100) / 100,     // < 100 ms
    under10ticksShare: Math.round((a.filter((x) => x < 10).length / a.length) * 100) / 100,   // < 167 ms
  };
}

// Every game: the score curve (10 s samples) and how busy the inputs were.
function runShape(Engine, seed, masks) {
  const s = Engine.createState(seed | 0), curve = [];
  let presses = 0, prev = 0, active = 0;
  const seen = new Set();
  for (let i = 0; i < masks.length && !s.gameOver; i++) {
    const m = masks[i] & 0xff;
    if (m) active++; if (m & ~prev) presses++; prev = m; seen.add(m);
    Engine.tick(s, masks[i]);
    if (i % 600 === 599) curve.push(s.score);
  }
  curve.push(s.score);
  const perMin = curve.map((v, i) => v - (i ? curve[i - 1] : 0)).map((d) => d * 6);
  return { ticks: masks.length, seconds: Math.round(masks.length / 60), scoreEvery10s: curve, pointsPerMinuteBySegment: perMin,
    presses, pressesPerSecond: Math.round((presses / Math.max(1, masks.length / 60)) * 100) / 100,
    activeShare: Math.round((active / Math.max(1, masks.length)) * 100) / 100, distinctInputs: seen.size };
}

function buildEvidence({ Engine, game, seed, masks, score, target, tas, wallet }) {
  const ev = { game, score, scoreToBeat: target, run: runShape(Engine, seed, masks),
    botChecks: { flagged: !!tas.flagged, signals: tas.signals || [], features: tas.features || {} }, wallet };
  if (game === "voidrocks") ev.reactions = voidRocksReactions(Engine, seed, masks);
  return ev;
}

// ---------- the review call ----------

const SYSTEM = `You review winning runs in QUARTERS, a pay-to-play arcade where a run that beats the Bounty's score takes a real-money jackpot. Your job: decide whether a human played this run, or whether it was automated (a bot, a tool-assisted run, or inputs computed offline and replayed).

Every run is a deterministic replay, so the score itself is already proven correct. The only question is who, or what, produced the inputs.

You get measured evidence, not video:
- reactions (Void Rocks only): ticks (1/60 s) from a threat appearing near the ship to the player changing steering or thrust. What marks automation is uniformity, not speed. Humans are often already steering when a threat appears, so many of their reactions are very short, and the rest are slow and scattered. Reference, a verified human run (20,010 points, 401 s): 34 threats, median 19 ticks, p10 2, p90 54, cv 0.87, 29% under 100 ms. Scripted play measured on the same game: cv 0.0 whether it reacted in 1 tick or was deliberately slowed to 15. So: a low spread (cv under about 0.3), or nearly every reaction landing on the same few values, points to automation; a high share of very short reactions on its own does not.
- run: score every 10 s, points per minute by segment, presses per second, how often any input was held, distinct input combinations. Humans warm up, stall, recover, and fade; a perfectly steady climb over ten minutes is unusual.
- botChecks: timing heuristics already applied (metronome-like gaps, superhuman press speed, quantized hold lengths, no warm-up, heavy volume, submitted faster than real time). A flag is strong evidence, but its absence proves little: a careful bot adds jitter.
- wallet: plays today, earlier verified runs and best scores on record, on-chain transaction count. A brand-new wallet whose first-ever run breaks a hard record deserves scrutiny, but new players do exist.

Weigh everything together. Be concrete: cite the numbers that drove your decision. Say "unsure" when the evidence is mixed or thin; a human reviews every "unsure" and "bot". Only say "human" with high confidence when nothing points to automation.`;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["human", "bot", "unsure"] },
    confidence: { type: "number", description: "0 to 1: how sure you are of the verdict" },
    reasons: { type: "array", items: { type: "string" }, description: "2-5 short reasons, each citing the evidence" },
  },
  required: ["verdict", "confidence", "reasons"],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ timeout: 150_000, maxRetries: 2 });   // ms; a held run has ~8 minutes
  return client;
}

// Tests only: REVIEW_FAKE="human:0.95" answers without the API, and only on a
// local test chain (QR_NETWORK=local), so it can never stand in for a real review.
const FAKE = process.env.QR_NETWORK === "local" && /^(human|bot|unsure):[01](\.\d+)?$/.test(process.env.REVIEW_FAKE || "") ? process.env.REVIEW_FAKE.split(":") : null;

async function review(evidence, log = console.log) {
  if (FAKE) return { verdict: FAKE[0], confidence: Number(FAKE[1]), reasons: ["test verdict (REVIEW_FAKE)"], model: "fake", at: Date.now() };
  const c = getClient(); if (!c) return null;
  try {
    const res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",   // if the model declines, Anthropic's recommended fallback answers instead
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: "Evidence for one winning run:\n" + JSON.stringify(evidence, null, 1) }],
    });
    if (res.stop_reason === "refusal") { log("review: declined " + JSON.stringify(res.stop_details || {})); return null; }
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const v = JSON.parse(text);
    if (!["human", "bot", "unsure"].includes(v.verdict) || typeof v.confidence !== "number" || !Array.isArray(v.reasons)) { log("review: malformed verdict"); return null; }
    return { verdict: v.verdict, confidence: Math.max(0, Math.min(1, v.confidence)), reasons: v.reasons.slice(0, 6).map((r) => String(r).slice(0, 300)),
      model: res.model, at: Date.now() };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) log("review: API key rejected");
    else if (e instanceof Anthropic.RateLimitError) log("review: rate limited");
    else if (e instanceof Anthropic.APIError) log(`review: API error ${e.status}: ${String(e.message).slice(0, 160)}`);
    else if (e instanceof SyntaxError) log("review: verdict wasn't JSON");
    else log("review: " + String((e && e.message) || e).slice(0, 160));
    return null;   // the human path takes over
  }
}

module.exports = { buildEvidence, review, voidRocksReactions, runShape, enabled: () => !!(process.env.ANTHROPIC_API_KEY || FAKE), MODEL };
