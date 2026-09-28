// THE BOUNTY rotates. Cabinet 2 is the one machine $QTRS trading fees feed
// (BountyFeeder → seedBounty(2), fixed forever), so the pivot is WHICH GAME
// cabinet 2 runs: a published weekly schedule, jackpot-schedule.json.
//
// The contract keeps one record for cabinet 2 across every week, in whatever
// units we submit. Games score on different scales, so each week converts raw
// scores into jackpot points at a rate fixed for the whole week:
//
//   points = floor(raw × num / den)     num = the on-chain bar when the week's
//                                        first run lands, den = the week's target
//
// With num ≥ den (the owner raises bountyFloor(2) to at least the target before
// a week opens), points are strictly increasing in raw, so "beat the target"
// and, after a mid-week win at S, "beat S" mean exactly what they say in raw
// terms. Receipts carry raw, points, num and den, so anyone can re-derive it.
const fs = require("fs");

module.exports = function makeJackpot({ chain, cab = 2, scheduleFile, stateFile, log = console.log }) {
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (e) {}
  state.weeks = state.weeks || {}; state.rawByReplay = state.rawByReplay || {}; state.playerByReplay = state.playerByReplay || {};
  const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch (e) { log("jackpot: save failed " + e.message); } };

  function schedule() {
    const s = JSON.parse(fs.readFileSync(scheduleFile, "utf8"));
    return (s.weeks || []).map((w) => ({ from: w.from, game: w.game, target: Number(w.target), fromS: Math.floor(Date.parse(w.from) / 1000) }))
      .filter((w) => w.game && w.target > 0 && w.fromS > 0).sort((a, b) => a.fromS - b.fromS);
  }
  // The week in effect at a unix time: the last entry that has started. It
  // runs until the next entry starts (open-ended if none is published yet).
  function weekAt(ts) {
    const ws = schedule(); let cur = null, next = null;
    for (const w of ws) { if (w.fromS <= ts) cur = w; else if (!next) next = w; }
    return cur ? { ...cur, toS: next ? next.fromS : null, next } : null;
  }
  // Rate for a week, fixed at its first use. null = rotation pending: the
  // on-chain bar is still below the week's target, so paid runs must wait.
  async function rate(week) {
    const st = state.weeks[week.from]; if (st) return st;
    const b = await chain.bounty(cab);
    if (b.bar < week.target) return null;
    const snap = { game: week.game, num: b.bar, den: week.target, recordRaw: null, snapshotAt: Math.floor(Date.now() / 1000) };
    state.weeks[week.from] = snap; save();
    log(`jackpot: week ${week.from} (${week.game}) opened at ${b.bar} points, target ${week.target} raw → rate ${b.bar}/${week.target}`);
    return snap;
  }
  const toPoints = (raw, st) => Number((BigInt(Math.max(0, Math.floor(raw))) * BigInt(st.num)) / BigInt(st.den));
  // The raw score to beat this week: the week's target, or this week's record if someone already won.
  const barRaw = (week, st) => (st && st.recordRaw != null ? st.recordRaw : week.target);

  return {
    weekAt, rate, toPoints, barRaw, schedule,
    noteRaw(replayHashHex, raw) { state.rawByReplay[replayHashHex] = raw; const ks = Object.keys(state.rawByReplay); if (ks.length > 5000) delete state.rawByReplay[ks[0]]; save(); },
    rawFor(replayHashHex) { return state.rawByReplay[replayHashHex]; },
    // door plays sit on-chain under the door's address; this is who actually played
    notePlayer(replayHashHex, player) { state.playerByReplay[replayHashHex] = player; const ks = Object.keys(state.playerByReplay); if (ks.length > 5000) delete state.playerByReplay[ks[0]]; save(); },
    playerFor(replayHashHex) { return state.playerByReplay[replayHashHex]; },
    noteWin(week, raw) { const st = state.weeks[week.from]; if (st && (st.recordRaw == null || raw > st.recordRaw)) { st.recordRaw = raw; save(); } },
    // What the site shows: this week's game, the raw score to beat, when it rotates.
    async publicState(nowS) {
      const week = weekAt(nowS); if (!week) return null;
      let st = state.weeks[week.from] || null, paused = false;
      if (!st) { try { st = await rate(week); } catch (e) {} paused = !st; }
      return { cabinetId: cab, game: week.game, target: week.target, barRaw: barRaw(week, st), weekRecordRaw: st ? st.recordRaw : null,
        from: week.from, rotatesAt: week.toS, paused, rate: st ? { num: st.num, den: st.den } : null,
        next: week.next ? { from: week.next.from, game: week.next.game, target: week.next.target } : null };
    },
  };
};
