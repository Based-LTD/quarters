// X poster for QUARTERS: composes and (optionally) publishes the daily results
// post from the settle records, with a rendered results card. Frugal by design:
// X bills per post ($0.015 plain, $0.20 with a URL), so this posts at most
// POST_MAX_PER_DAY times a day and only when there is something to report.
//
//   DRY_RUN=1 (default)  drafts are written to <dir>/posts/ and served at /posts, nothing is sent
//   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET   OAuth 1.0a user context (Read+Write app)
//   POST_TIME_UTC="00:35"  when the daily results post fires (after the day's settle grace)
//   POST_MAX_PER_DAY=2     hard cap, counted across kinds
//   POST_MEDIA=1           attach the results card (v2 media upload)
const fs = require("fs"), path = require("path"), crypto = require("crypto");
let canvasLib = null; try { canvasLib = require("@napi-rs/canvas"); } catch (e) {}

function makePoster({ dir, network, log = console.log }) {
  const POSTS = path.join(dir, "posts"); fs.mkdirSync(POSTS, { recursive: true });
  const dryRun = process.env.DRY_RUN !== "0";
  const keys = { key: process.env.X_API_KEY, secret: process.env.X_API_SECRET, token: process.env.X_ACCESS_TOKEN, tokenSecret: process.env.X_ACCESS_SECRET };
  const configured = !!(keys.key && keys.secret && keys.token && keys.tokenSecret);
  const MAX = Math.max(0, parseInt(process.env.POST_MAX_PER_DAY || "2", 10));
  const media = process.env.POST_MEDIA === "1";
  const file = path.join(POSTS, "posts.json");
  let posts = []; try { posts = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const save = () => { fs.writeFileSync(file + ".tmp", JSON.stringify(posts.slice(-200), null, 1)); fs.renameSync(file + ".tmp", file); };
  if (canvasLib) { try { canvasLib.GlobalFonts.registerFromPath(path.join(__dirname, "fonts/IBMPlexMono-Medium.ttf"), "PlexMono"); canvasLib.GlobalFonts.registerFromPath(path.join(__dirname, "fonts/IBMPlexMono-Bold.ttf"), "PlexMono"); } catch (e) { log("poster: font load failed " + e.message); } }

  // --- OAuth 1.0a (HMAC-SHA1), no dependency ---
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  function oauthHeader(method, url, extraParams = {}) {
    const p = { oauth_consumer_key: keys.key, oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: keys.token, oauth_version: "1.0", ...extraParams };
    const base = [method.toUpperCase(), enc(url), enc(Object.keys(p).sort().map((k) => enc(k) + "=" + enc(p[k])).join("&"))].join("&");
    p.oauth_signature = crypto.createHmac("sha1", enc(keys.secret) + "&" + enc(keys.tokenSecret)).update(base).digest("base64");
    return "OAuth " + Object.keys(p).filter((k) => k.startsWith("oauth_")).sort().map((k) => enc(k) + '="' + enc(p[k]) + '"').join(", ");
  }
  async function uploadMedia(png) {
    const url = "https://api.x.com/2/media/upload";
    const boundary = "----quarters" + crypto.randomBytes(8).toString("hex");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media_category"\r\n\r\ntweet_image\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="card.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = await fetch(url, { method: "POST", headers: { authorization: oauthHeader("POST", url), "content-type": "multipart/form-data; boundary=" + boundary }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("media upload " + r.status + " " + JSON.stringify(j).slice(0, 200));
    return (j.data && (j.data.id || j.data.media_id_string)) || j.media_id_string || j.id;
  }
  async function sendTweet(text, mediaId) {
    const url = "https://api.x.com/2/tweets";
    const payload = { text }; if (mediaId) payload.media = { media_ids: [String(mediaId)] };
    const r = await fetch(url, { method: "POST", headers: { authorization: oauthHeader("POST", url), "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("tweet " + r.status + " " + JSON.stringify(j).slice(0, 200));
    return j.data && j.data.id;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const sentToday = () => posts.filter((p) => p.status === "posted" && p.at.slice(0, 10) === today()).length;

  // Queue a post. `key` dedupes (one results post per day, one bounty post per record).
  // Returns the record; sends immediately unless dry-run / cap / unconfigured.
  async function queue(kind, key, text, png) {
    if (posts.some((p) => p.key === key && p.status !== "failed")) return null;
    if (text.length > 280) text = text.slice(0, 277) + "…";
    const rec = { id: crypto.randomBytes(6).toString("hex"), kind, key, text, at: new Date().toISOString(), status: "draft", network };
    if (png) { rec.card = rec.id + ".png"; fs.writeFileSync(path.join(POSTS, rec.card), png); }
    posts.push(rec); save();
    await trySend(rec);
    return rec;
  }
  async function trySend(rec) {
    if (dryRun) { rec.status = "draft"; rec.note = "dry run"; save(); return rec; }
    if (!configured) { rec.status = "draft"; rec.note = "X keys not set"; save(); return rec; }
    if (sentToday() >= MAX) { rec.status = "skipped"; rec.note = "daily cap"; save(); return rec; }
    try {
      let mediaId = null;
      if (media && rec.card) { try { mediaId = await uploadMedia(fs.readFileSync(path.join(POSTS, rec.card))); } catch (e) { rec.note = "no media: " + e.message.slice(0, 120); } }
      rec.tweetId = await sendTweet(rec.text, mediaId); rec.status = "posted"; rec.at = new Date().toISOString();
      log(`poster: posted ${rec.kind} ${rec.tweetId}`);
    } catch (e) { rec.status = "failed"; rec.error = String(e.message || e).slice(0, 200); log("poster: FAILED " + rec.error); }
    save(); return rec;
  }
  // Manual send of a draft (admin route) — ignores dry-run, respects the cap.
  async function send(id) { const rec = posts.find((p) => p.id === id); if (!rec) return null; if (!configured) { rec.note = "X keys not set"; save(); return rec; } if (sentToday() >= MAX) { rec.status = "skipped"; rec.note = "daily cap"; save(); return rec; }
    try { let mediaId = null; if (media && rec.card) { try { mediaId = await uploadMedia(fs.readFileSync(path.join(POSTS, rec.card))); } catch (e) { rec.note = "no media: " + e.message.slice(0, 120); } }
      rec.tweetId = await sendTweet(rec.text, mediaId); rec.status = "posted"; rec.at = new Date().toISOString(); } catch (e) { rec.status = "failed"; rec.error = String(e.message || e).slice(0, 200); }
    save(); return rec; }

  // --- the results card (1200×675) ---
  function resultsCard({ title, sub, lines, footer }) {
    if (!canvasLib) return null;
    const W = 1200, H = 675, c = canvasLib.createCanvas(W, H), x = c.getContext("2d");
    x.fillStyle = "#060708"; x.fillRect(0, 0, W, H);
    const g = x.createRadialGradient(W / 2, -120, 0, W / 2, -120, 760); g.addColorStop(0, "rgba(227,181,74,0.32)"); g.addColorStop(1, "rgba(227,181,74,0)"); x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.strokeStyle = "rgba(227,181,74,0.45)"; x.lineWidth = 3; x.strokeRect(24, 24, W - 48, H - 48);
    x.fillStyle = "#E3B54A"; x.font = "bold 30px PlexMono"; x.fillText("QUARTERS", 64, 84);
    x.fillStyle = "#8B949B"; x.font = "22px PlexMono"; x.textAlign = "right"; x.fillText("quarters.fun", W - 64, 84); x.textAlign = "left";
    x.fillStyle = "#E9EDEF"; x.font = "bold 46px PlexMono"; x.fillText(title, 64, 160);
    x.fillStyle = "#8B949B"; x.font = "22px PlexMono"; x.fillText(sub, 64, 196);
    let y = 256; x.font = "26px PlexMono";
    for (const [game, who, score, pay] of lines.slice(0, 8)) {
      x.fillStyle = "#E3B54A"; x.fillText(game, 64, y);
      x.fillStyle = "#E9EDEF"; x.fillText(who, 380, y);
      x.textAlign = "right"; x.fillText(String(score), 900, y); x.fillStyle = "#3DD8A8"; x.fillText(pay, W - 64, y); x.textAlign = "left";
      y += 44;
    }
    x.fillStyle = "#8B949B"; x.font = "20px PlexMono"; x.fillText(footer, 64, H - 56);
    return c.toBuffer("image/png");
  }
  // Compose the daily results post from a settle record: { day, periodSeconds, cabs: { id: { pool, houseAdd, entries: [{player,name,score,flagged,payout}] } } }.
  // Returns null when nothing was played (no post is better than a hollow one).
  function composeDaily(rec, { games = {}, runs = 0, dayLabel = null } = {}) {
    const sol = (l) => (l / 1e9).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") + " SOL";
    const who = (e) => e.name || (e.player.slice(0, 4) + "…" + e.player.slice(-4));
    const cabs = Object.entries(rec.cabs || {}).map(([id, c]) => ({ id: +id, ...c })).filter((c) => c.entries && c.entries.length).sort((a, b) => b.pool - a.pool);
    if (!cabs.length) return null;
    const paid = cabs.reduce((a, c) => a + c.entries.reduce((b, e) => b + (e.payout || 0), 0), 0);
    const players = new Set(); cabs.forEach((c) => c.entries.forEach((e) => { if (e.payout > 0) players.add(e.player); }));
    const label = dayLabel || ("day " + rec.day);
    const lines = cabs.map((c) => { const w = c.entries.find((e) => !e.flagged) || c.entries[0]; return [games[c.id] || ("#" + c.id), who(w), w.score, sol(w.payout || 0)]; });
    let text = "QUARTERS · " + label + " results\n\n" + lines.slice(0, 6).map((l) => l[0] + "  " + l[1] + " " + l[2] + " · " + l[3]).join("\n");
    if (cabs.length > 6) text += "\n+" + (cabs.length - 6) + " more machines";
    text += "\n\nPaid out: " + sol(paid) + " to " + players.size + " player" + (players.size === 1 ? "" : "s") + (runs ? " · " + runs + " verified runs" : "") + "\nEvery run replayable · quarters.fun";
    const png = resultsCard({ title: label.toUpperCase() + " RESULTS", sub: "top of every machine · verified on-chain · replay any run", lines, footer: "paid out " + sol(paid) + " to " + players.size + " players" + (runs ? " · " + runs + " verified runs" : "") + " · every receipt public" });
    return { text, png, key: "results:" + rec.day };
  }
  return { queue, send, trySend, resultsCard, composeDaily, list: () => posts.slice().reverse(), dryRun, configured, max: MAX, dir: POSTS };
}
module.exports = makePoster;
