// testing-harness.js — the complete timer-events test battery in a single file.
//
// Mechanical combination of the nine standalone suites (test-harness,
// test-threshold-scope, test-restore, test-validation, test-redundant-stop,
// test-elapsed, test-paused-restore, test-status-flicker,
// test-fractional-label). Each suite is preserved verbatim inside its own
// function scope — same stubs, same helpers, same checks, same labels — and
// the suites run sequentially. The only per-suite change is that the
// trailing process.exit() is replaced by returning the suite's failure
// count to the runner below, which prints a grand total and sets the single
// exit code: 0 on a fully clean run, 1 if any check failed.
//
// Run beside timer-events.js and cycle.js:  node testing-harness.js
// A healthy full run is 103 passing checks and takes roughly 2-3 minutes.
"use strict";

const __suites = [];
function __defineSuite(name, fn) { __suites.push({ name, fn }); }

// ============================================================================
// SUITE: test-harness
// ============================================================================
__defineSuite("test-harness", async function () {
// Test harness for the #1 fix: authoritative wall-clock remaining time.
// Stubs enough of the Node-RED runtime to instantiate the node, then
// exercises the exact scenarios that were broken, all with Status
// Reporting = "none" (the default, and the previously-broken case).
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function near(actual, expected, tol) { return Math.abs(actual - expected) <= tol; }

// ---- RED stub --------------------------------------------------------------
function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function lastEvent(node, type) {
  for (let i = node.sent.length - 1; i >= 0; i--) {
    const m = node.sent[i].find(x => x && x.timerEvent === type);
    if (m) return m;
  }
  return null;
}

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "t" + Math.random().toString(36).slice(2),
    duration: "5", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-test-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- T1: pause/resume accuracy with reporting off ("Never") ---------------
  {
    const n = makeNode(RED, { duration: "10" }); // 10s
    n.receive({ payload: "go" });
    await sleep(3000);
    n.receive({ payload: "pause" });
    let p = lastEvent(n, "paused");
    check("T1a pause freezes at ~7000ms (was: full 10000ms)", p && near(p.remainingTime, 7000, 300), p && p.remainingTime);
    await sleep(1500); // frozen time must not move
    n.receive({ payload: "query" });
    let q = lastEvent(n, "query");
    check("T1b remaining unchanged while paused", q && near(q.remainingTime, 7000, 300), q && q.remainingTime);
    n.receive({ payload: "resume" });
    const resumeAt = Date.now();
    await new Promise(res => {
      const iv = setInterval(() => { if (lastEvent(n, "expired")) { clearInterval(iv); res(); } }, 100);
    });
    const ranFor = Date.now() - resumeAt;
    check("T1c resume runs ~7s more, not 10s (was: full duration back)", near(ranFor, 7000, 500), ranFor);
    await n.close(false);
  }

  // -- T2: query mid-run reports live remaining time ------------------------
  {
    const n = makeNode(RED, { duration: "10" });
    n.receive({ payload: "go" });
    await sleep(4000);
    n.receive({ payload: "query" });
    const q = lastEvent(n, "query");
    check("T2 query at t+4s reports ~6000ms (was: 10000ms)", q && near(q.remainingTime, 6000, 300), q && q.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- T3: adjusttime computes from true remaining, and never leaks into next run
  {
    const n = makeNode(RED, { duration: "10" });
    n.receive({ payload: "go" });
    await sleep(2000);
    n.receive({ payload: "adjusttime", adjusttime: 5000 });
    const a = lastEvent(n, "timeadjusted");
    check("T3a adjust +5s at t+2s -> ~13000ms (was: 15000ms)", a && near(a.remainingTime, 13000, 300), a && a.remainingTime);
    n.receive({ payload: "stop" });
    n.sent.length = 0;
    n.receive({ payload: "go2" }); // fresh run: original duration must return
    const s = lastEvent(n, "started");
    check("T3b next run starts at original 10000ms (no adjustment leak)", s && near(s.remainingTime, 10000, 50), s && s.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- T4: settime while paused updates the frozen snapshot ------------------
  {
    const n = makeNode(RED, { duration: "10" });
    n.receive({ payload: "go" });
    await sleep(1000);
    n.receive({ payload: "pause" });
    n.receive({ payload: "settime", settime: 4000 });
    n.receive({ payload: "query" });
    const q = lastEvent(n, "query");
    check("T4 settime while paused -> frozen at exactly 4000ms", q && q.remainingTime === 4000, q && q.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- T5: persistence writes the real target (reporting off) ----------------
  {
    const n = makeNode(RED, { duration: "10", persist: true });
    n.receive({ payload: "go" });
    await sleep(3000);
    n.receive({ payload: "lock" }); // any mid-run writeState trigger
    const dir = path.join(userDir, "timerevents-timers");
    const file = fs.readdirSync(dir).map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const saved = JSON.parse(fs.readFileSync(file));
    const persistedRemaining = new Date(saved.time).getTime() - Date.now();
    check("T5 persisted target reflects ~7000ms left (was: ~10000ms)", near(persistedRemaining, 7000, 400), Math.round(persistedRemaining));
    n.receive({ payload: "stop" });
    await n.close(true);
  }

  // -- T6: cooldown query reports live cooldown remaining --------------------
  {
    const n = makeNode(RED, { duration: "1", cooldownduration: "6" });
    n.receive({ payload: "go" });
    await sleep(1300); // expire -> cooldown starts
    check("T6a cooldownstarted fired", !!lastEvent(n, "cooldownstarted"));
    await sleep(2000); // 2s into the 6s cooldown
    n.receive({ payload: "query" });
    const q = lastEvent(n, "query");
    check("T6b cooldown query state", q && q.timerState === "cooldown", q && q.timerState);
    check("T6c cooldown remaining ~4000ms (was: full 6000ms)", q && near(q.remainingTime, 3900, 400), q && q.remainingTime);
    n.receive({ payload: "stop" }); // cancel cooldown
    const st = lastEvent(n, "stopped");
    check("T6d stop after cooldown reports remainingTime 0", st && st.remainingTime === 0, st && st.remainingTime);
    await n.close(false);
  }

  // -- T7: regression - reporting ON still behaves (natural expiry timing) ---
  {
    const n = makeNode(RED, { duration: "4", reporting: "every_second" });
    const t0 = Date.now();
    n.receive({ payload: "go" });
    await new Promise(res => {
      const iv = setInterval(() => { if (lastEvent(n, "expired")) { clearInterval(iv); res(); } }, 100);
    });
    check("T7a expiry fires at ~4s with reporting on", near(Date.now() - t0, 4000, 500), Date.now() - t0);
    const e = lastEvent(n, "expired");
    check("T7b expired reports remainingTime 0", e && e.remainingTime === 0, e && e.remainingTime);
    await n.close(false);
  }

  // -- T8: regression - blocked restart while locked, envelope still sane ----
  {
    const n = makeNode(RED, { duration: "10", donotresettimer: true });
    n.receive({ payload: "go" });
    await sleep(2000);
    n.receive({ payload: "again" }); // ignored restart
    const r = lastEvent(n, "restarted");
    check("T8 ignored restart carries live remaining ~8000ms", r && r.ignored === true && near(r.remainingTime, 8000, 300), r && r.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-threshold-scope
// ============================================================================
__defineSuite("test-threshold-scope", async function () {
// Tests for fix #2: threshold actions scoped to an active run (running/paused).
// U1-U3 verify the fixed idle behavior; U4-U5 verify no regression to the
// legitimate paused-gate and lock-gate threshold paths.
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) {
    for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  }
  return out;
}
function output2(node) { // messages that appeared on output 2 specifically
  return node.sent.map(a => a[1]).filter(Boolean);
}
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "u" + Math.random().toString(36).slice(2),
    duration: "5", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t2-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- U1: idle + disabled + Add Time threshold must NOT start the timer -----
  {
    const n = makeNode(RED, { thresholdaction: "addtime", thresholdcount: "2", thresholdaddtime: "10", donotresettimer: true });
    n.receive({ payload: "disable" });
    for (let i = 0; i < 4; i++) n.receive({ payload: "go" }); // 4 blocked starts, threshold=2 hit twice
    await sleep(300);
    const q = (n.receive({ payload: "query" }), lastEvent(n, "query"));
    check("U1a timer stays idle (was: Add Time started it)", q.timerState === "stopped", q.timerState);
    check("U1b no timeadjusted fired from idle", events(n, "timeadjusted").length === 0, events(n, "timeadjusted").length);
    check("U1c blocked starts still counted", q.ignoredCount === 4, q.ignoredCount);
    const blocked = events(n, "started").filter(e => e.ignored === true);
    check("U1d each block still observable on output 4", blocked.length === 4, blocked.length);
    await n.close(false);
  }

  // -- U2: idle + disabled + Stop threshold -> no phantom stop on output 2 ---
  {
    const n = makeNode(RED, { thresholdaction: "stop", thresholdcount: "2" });
    n.receive({ payload: "disable" });
    for (let i = 0; i < 3; i++) n.receive({ payload: "go" });
    check("U2 no phantom stopped on output 2", output2(n).length === 0, output2(n).length);
    await n.close(false);
  }

  // -- U3: cooldown + Restart threshold -> still never fires (unchanged) -----
  {
    const n = makeNode(RED, { duration: "1", cooldownduration: "5", thresholdaction: "reset", thresholdcount: "1" });
    n.receive({ payload: "go" });
    await sleep(1300); // expire into cooldown
    n.sent.length = 0;
    for (let i = 0; i < 3; i++) n.receive({ payload: "go" }); // blocked by cooldown
    check("U3a no restart fired during cooldown", events(n, "restarted").length === 0, events(n, "restarted").length);
    const q = (n.receive({ payload: "query" }), lastEvent(n, "query"));
    check("U3b still in cooldown", q.timerState === "cooldown", q.timerState);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- U4: regression - lock gate + Add Time threshold still fires while running
  {
    const n = makeNode(RED, { duration: "10", donotresettimer: true, thresholdaction: "addtime", thresholdcount: "2", thresholdaddtime: "5" });
    n.receive({ payload: "go" });
    await sleep(500);
    n.receive({ payload: "poke1" });
    n.receive({ payload: "poke2" }); // hits threshold
    const a = lastEvent(n, "timeadjusted");
    check("U4a Add Time still fires for a running locked timer", !!a && a.source === "internal" && a.timeAdjusted === 5000, a && a.timeAdjusted);
    check("U4b remaining reflects the added time (~14500ms)", a && Math.abs(a.remainingTime - 14500) <= 400, a && a.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- U5: regression - paused gate + Restart threshold fires, stays paused --
  {
    const n = makeNode(RED, { duration: "10", thresholdaction: "reset", thresholdcount: "2" });
    n.receive({ payload: "go" });
    await sleep(2000);
    n.receive({ payload: "pause" });
    n.receive({ payload: "poke1" });
    n.receive({ payload: "poke2" }); // hits threshold while paused
    const r = events(n, "restarted").filter(e => e.ignored === false && e.source === "internal");
    check("U5a Restart threshold still fires from the paused gate", r.length === 1, r.length);
    const q = (n.receive({ payload: "query" }), lastEvent(n, "query"));
    check("U5b stays paused at full duration", q.timerState === "paused" && q.remainingTime === 10000, q.timerState + "/" + q.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  console.log(failures === 0 ? "\nALL #2 TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-restore
// ============================================================================
__defineSuite("test-restore", async function () {
// Tests for fix #3: running restore is a continuation of the same run.
// Simulates a Node-RED restart by constructing a node, running it, closing
// it (persist file survives), sleeping to simulate downtime, then
// reconstructing a node with the same id.
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function near(a, e, tol) { return Math.abs(a - e) <= tol; }

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  return out;
}
function output1(node) { return node.sent.map(a => a[0]).filter(Boolean); }
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "fixed-id", duration: "10", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: true, ignoretimerpass: false, donotresettimer: true,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t3-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // ---- Phase 1: run, accumulate ignored count, persist, "shut down" --------
  const n1 = makeNode(RED, { reporting: "every_second" }); // persisted reporting differs from phase-2 config
  n1.receive({ payload: "go", runTag: "original-run" });
  await sleep(1500);
  n1.receive({ payload: "poke1" });   // ignored (locked) -> ignoredCount 1
  n1.receive({ payload: "poke2" });   // ignored          -> ignoredCount 2
  n1.receive({ payload: "adjusttime", adjusttime: 0 }); // triggers writeState with current bookkeeping
  await sleep(1500);                   // ~3s elapsed total
  const preQ = (n1.receive({ payload: "query" }), lastEvent(n1, "query"));
  await n1.close(false);               // persist file survives (not removed)

  // ---- Phase 2: 2s of simulated Node-RED downtime, then restore ------------
  await sleep(2000);
  const restoreAt = Date.now();
  const n2 = makeNode(RED, { reporting: "none" }); // freshly-deployed config differs from persisted
  await sleep(200); // let restore-driven dispatch settle

  const started = lastEvent(n2, "started");
  check("V1a restore fires started, output 1, source internal",
    output1(n2).length === 1 && started && started.source === "internal" && started.ignored === false,
    output1(n2).length + "/" + (started && started.source));
  check("V1b original timerDuration preserved: 10000 (was: remaining time)",
    started && started.timerDuration === 10000, started && started.timerDuration);
  check("V1c ignoredCount survives restore: 2 (was: reset to 0)",
    started && started.ignoredCount === 2 && started.lastIgnoredTime !== null,
    started && started.ignoredCount + "/" + started.lastIgnoredTime);
  // ~3s original elapsed + ~2s downtime = ~5s elapsed; remaining ~5s
  check("V1d elapsedTime reflects run + downtime (~5000ms)",
    started && near(started.elapsedTime, 5000, 700), started && started.elapsedTime);
  check("V1e elapsed + remaining reconciles with duration",
    started && near(started.elapsedTime + started.remainingTime, started.timerDuration, 700),
    started && Math.round(started.elapsedTime + started.remainingTime));
  check("V1f remaining carried over minus downtime (~5000ms, was ~7000 pre-shutdown)",
    started && near(started.remainingTime, 5000, 700) && near(preQ.remainingTime, 7000, 700),
    started && Math.round(started.remainingTime) + " (pre: " + Math.round(preQ.remainingTime) + ")");

  // ---- V2: fresh config wins over persisted reporting settings -------------
  check("V2 freshly-deployed reporting config wins (was: persisted 'every_second')",
    n2.reporting === "none", n2.reporting);

  // ---- V3: restored run expires at the original wall-clock target ----------
  await new Promise(res => {
    const iv = setInterval(() => { if (lastEvent(n2, "expired")) { clearInterval(iv); res(); } }, 100);
  });
  const ranFor = Date.now() - restoreAt;
  check("V3 restored run expires after ~remaining (~5s), not full duration",
    near(ranFor, 5000, 800), ranFor);
  const exp = lastEvent(n2, "expired");
  check("V3b expired event still reports the original duration",
    exp && exp.timerDuration === 10000, exp && exp.timerDuration);
  await n2.close(true);

  // ---- V4: regression - a normal start still resets run identity -----------
  {
    const n = makeNode(RED, { id: "fresh-id", persist: false });
    n.receive({ payload: "go" });
    await sleep(500);
    n.receive({ payload: "poke" }); // ignored -> count 1
    n.receive({ payload: "stop" });
    n.receive({ payload: "unlock" });   // allow normal restart behavior
    n.sent.length = 0;
    n.receive({ payload: "go2" });
    const s = lastEvent(n, "started");
    check("V4 normal start resets ignoredCount and sets fresh duration",
      s && s.ignoredCount === 0 && s.lastIgnoredTime === null && s.timerDuration === 10000 && s.elapsedTime <= 50,
      s && s.ignoredCount + "/" + s.timerDuration + "/" + s.elapsedTime);
    n.receive({ payload: "stop" });
    await n.close(true);
  }

  console.log(failures === 0 ? "\nALL #3 TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-validation
// ============================================================================
__defineSuite("test-validation", async function () {
// Tests for fix #4: numeric validation of msg.delay, adjusttime, settime,
// setduration. Malformed values must be rejected cleanly (ignored:true or
// documented fallback) with zero state corruption; all previously-valid
// inputs must behave identically, including adjusttime: 0 (accepted per
// explicit decision) and fractional delays.
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function near(a, e, tol) { return Math.abs(a - e) <= tol; }

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  return out;
}
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "w" + Math.random().toString(36).slice(2),
    duration: "10", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t4-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- W1: msg.delay unconvertible ("5s") -> documented fallback -------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go", delay: "5s" });
    const s = lastEvent(n, "started");
    check("W1 delay '5s' falls back to configured 10000ms (was: NaN corruption)",
      s && near(s.remainingTime, 10000, 50) && s.timerDuration === 10000, s && s.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- W2: msg.delay negative -> documented clamp to 0 ------------------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go", delay: -5 });
    await sleep(300);
    const e = lastEvent(n, "expired");
    check("W2 negative delay clamps to 0 and expires immediately (was: negative remaining)",
      !!e && e.timerDuration === 0, e && e.timerDuration);
    await n.close(false);
  }

  // -- W3: fractional delay still works (regression) -------------------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go", delay: 2.5, units: "seconds" });
    const s = lastEvent(n, "started");
    check("W3 fractional delay 2.5s -> 2500ms preserved", s && s.remainingTime === 2500, s && s.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- W4: msg.delay empty string -> fallback, not zero -----------------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go", delay: "" });
    const s = lastEvent(n, "started");
    check("W4 empty-string delay falls back to configured (Number('') is 0 trap)",
      s && s.remainingTime === 10000, s && s.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- W5: adjusttime missing / non-numeric -> ignored, timer unharmed --------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(1000);
    n.receive({ payload: "adjusttime" });                    // property missing entirely
    let a1 = lastEvent(n, "timeadjusted");
    check("W5a missing adjusttime -> ignored:true, null attempted value",
      a1 && a1.ignored === true && a1.timeAdjusted === null, a1 && (a1.ignored + "/" + a1.timeAdjusted));
    n.receive({ payload: "adjusttime", adjusttime: "abc" }); // non-numeric
    let a2 = lastEvent(n, "timeadjusted");
    check("W5b non-numeric adjusttime -> ignored:true, raw value attached",
      a2 && a2.ignored === true && a2.timeAdjusted === "abc", a2 && a2.timeAdjusted);
    n.receive({ payload: "query" });
    const q = lastEvent(n, "query");
    check("W5c remaining time unharmed (~9000ms, was: NaN)",
      q && near(q.remainingTime, 9000, 300), q && q.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- W6: settime NaN passes-as-valid hole closed; valid settime unchanged ---
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(500);
    n.receive({ payload: "settime", settime: "abc" });
    let t1 = lastEvent(n, "timeset");
    check("W6a non-numeric settime -> ignored:true (NaN<=0 hole closed)",
      t1 && t1.ignored === true && t1.timeSet === "abc", t1 && t1.timeSet);
    n.receive({ payload: "settime", settime: 4000 });        // regression: valid still works
    let t2 = lastEvent(n, "timeset");
    check("W6b valid settime 4000 still applies",
      t2 && t2.ignored === false && near(t2.remainingTime, 4000, 50), t2 && t2.remainingTime);
    n.receive({ payload: "settime", settime: -1 });          // regression: <=0 still rejected
    let t3 = lastEvent(n, "timeset");
    check("W6c settime <= 0 still rejected, attempted value attached (ms default)",
      t3 && t3.ignored === true && t3.timeSet === -1, t3 && t3.timeSet);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- W7: setduration NaN can no longer poison the next run ------------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "setduration", setduration: "abc" });
    let d1 = lastEvent(n, "durationset");
    check("W7a non-numeric setduration -> ignored:true",
      d1 && d1.ignored === true && d1.durationSet === "abc", d1 && d1.durationSet);
    n.receive({ payload: "go" });
    let s1 = lastEvent(n, "started");
    check("W7b next run unpoisoned: starts at configured 10000ms (was: NaN)",
      s1 && near(s1.remainingTime, 10000, 50), s1 && s1.remainingTime);
    n.receive({ payload: "stop" });
    n.receive({ payload: "setduration", setduration: 3, setdurationunits: "seconds" }); // regression
    n.receive({ payload: "go2" });
    let s2 = lastEvent(n, "started");
    check("W7c valid setduration still applies to next run (3000ms)",
      s2 && near(s2.remainingTime, 3000, 50), s2 && s2.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- W8: adjusttime 0 is processed, NOT flagged ignored (explicit decision) -
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(500);
    n.receive({ payload: "adjusttime", adjusttime: 0 });
    const a = lastEvent(n, "timeadjusted");
    check("W8 adjusttime 0 accepted as successful no-op",
      a && a.ignored === false && a.timeAdjusted === 0 && near(a.remainingTime, 9500, 300),
      a && (a.ignored + "/" + a.timeAdjusted + "/" + Math.round(a.remainingTime)));
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  console.log(failures === 0 ? "\nALL #4 TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-redundant-stop
// ============================================================================
__defineSuite("test-redundant-stop", async function () {
// Tests for fix #5 (Option A): stop while truly idle (stopped/expired) is a
// redundant command - ignored:true on output 4, zero state change, no
// _timerpass arming. Stop stays genuine for running/paused/cooldown.
// Redundant disable harmonized to no-increment. Blocked idle starts still
// count (command-redundancy-only scope).
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  return out;
}
function output2(node) { return node.sent.map(a => a[1]).filter(Boolean); }
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "x" + Math.random().toString(36).slice(2),
    duration: "5", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t5-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- X1: stop on a never-started node -> ignored, output 4 only ------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "stop" });
    const st = lastEvent(n, "stopped");
    check("X1a stop while stopped -> ignored:true on output 4",
      st && st.ignored === true && st.timerState === "stopped", st && st.ignored + "/" + st.timerState);
    check("X1b nothing on output 2 (was: phantom stop)",
      output2(n).length === 0, output2(n).length);
    await n.close(false);
  }

  // -- X2: stop after natural expiry -> ignored, state stays expired ---------
  {
    const n = makeNode(RED, { duration: "1", donotresettimer: true });
    n.receive({ payload: "go" });
    await sleep(500);
    n.receive({ payload: "poke" }); // ignoredCount 1 during the run
    await sleep(800);               // expire (expiry resets count to 0)
    n.sent.length = 0;
    n.receive({ payload: "stop" });
    const st = lastEvent(n, "stopped");
    check("X2a stop after expiry -> ignored:true, state stays 'expired' (was: flip to stopped)",
      st && st.ignored === true && st.timerState === "expired", st && st.timerState);
    check("X2b no phantom stop on output 2", output2(n).length === 0, output2(n).length);
    check("X2c zero counter touch", st && st.ignoredCount === 0 && st.lastIgnoredTime === null,
      st && st.ignoredCount + "/" + st.lastIgnoredTime);
    n.receive({ payload: "stop" }); // second redundant stop, same treatment
    check("X2d repeated stops all ignored", events(n, "stopped").every(e => e.ignored === true) && events(n, "stopped").length === 2, events(n, "stopped").length);
    await n.close(false);
  }

  // -- X3: post-expiry stop no longer arms the _timerpass filter -------------
  {
    const n = makeNode(RED, { duration: "1" });
    n.receive({ payload: "go" });
    await sleep(1300); // expire
    n.receive({ payload: "stop" }); // ignored - must NOT arm the filter
    n.sent.length = 0;
    n.receive({ payload: "go", _timerpass: true }); // would die if filter were armed
    const s = lastEvent(n, "started");
    check("X3 _timerpass msg starts normally after ignored stop (filter not armed)",
      s && s.ignored === false, s && (s.timerEvent + "/" + s.ignored));
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- X4: regression - genuine stop still arms _timerpass filter ------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(300);
    n.receive({ payload: "stop" }); // genuine stop -> filter armed
    check("X4a genuine stop fires on output 2", output2(n).length === 1 && output2(n)[0].timerEvent === "stopped", output2(n).length);
    n.sent.length = 0;
    n.receive({ payload: "go", _timerpass: true }); // must die silently
    check("X4b armed filter still swallows _timerpass msg (no output at all)",
      n.sent.length === 0, n.sent.length);
    n.receive({ payload: "stop", _timerpass: true }); // stop variant also swallowed
    check("X4c armed filter swallows _timerpass stop too (preserved edge)",
      n.sent.length === 0, n.sent.length);
    n.receive({ payload: "go" }); // plain msg disarms and starts
    check("X4d plain msg still starts normally", !!lastEvent(n, "started"));
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- X5: regression - stop stays genuine for paused and cooldown -----------
  {
    const n = makeNode(RED, { duration: "5" });
    n.receive({ payload: "go" });
    await sleep(300);
    n.receive({ payload: "pause" });
    n.sent.length = 0;
    n.receive({ payload: "stop" });
    check("X5a stop while paused is genuine (output 2)",
      output2(n).length === 1 && lastEvent(n, "stopped").ignored === false, output2(n).length);
    await n.close(false);

    const c = makeNode(RED, { duration: "1", cooldownduration: "10" });
    c.receive({ payload: "go" });
    await sleep(1300); // expire into cooldown
    c.sent.length = 0;
    c.receive({ payload: "stop" });
    const st = lastEvent(c, "stopped");
    check("X5b stop during cooldown is genuine and cancels it",
      output2(c).length === 1 && st.ignored === false && st.timerState === "stopped", st && st.timerState);
    await c.close(false);
  }

  // -- X6: disable harmonized; blocked idle starts still count ---------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "disable" });  // genuine
    n.receive({ payload: "disable" });  // redundant - no longer increments
    n.receive({ payload: "disable" });  // redundant
    let d = lastEvent(n, "disabled");
    check("X6a redundant disable no longer increments (was: lone oddball)",
      d && d.ignored === true && d.ignoredCount === 0 && d.lastIgnoredTime === null,
      d && d.ignoredCount);
    n.receive({ payload: "go" });       // blocked idle start - MUST still count
    n.receive({ payload: "go" });
    let s = lastEvent(n, "started");
    check("X6b blocked idle starts still increment (scope: command redundancy only)",
      s && s.ignored === true && s.ignoredCount === 2 && s.lastIgnoredTime !== null, s && s.ignoredCount);
    n.receive({ payload: "stop" });     // stop while idle+disabled: redundant, zero touch
    let st = lastEvent(n, "stopped");
    check("X6c redundant stop while disabled leaves blocked-start count intact",
      st && st.ignored === true && st.ignoredCount === 2, st && st.ignoredCount);
    await n.close(false);
  }

  console.log(failures === 0 ? "\nALL #5 TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-elapsed
// ============================================================================
__defineSuite("test-elapsed", async function () {
// Tests for fix #6: state-aware elapsedTime.
//   paused   -> frozen at the moment of pause
//   idle     -> 0 (stopped/expired queries)
//   events   -> genuine stopped/expired carry the run's final elapsed
//   cooldown -> time into the cooldown period (elapsed+remaining ~= duration)
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function near(a, e, tol) { return Math.abs(a - e) <= tol; }

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  return out;
}
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "y" + Math.random().toString(36).slice(2),
    duration: "10", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}
function query(n) { n.receive({ payload: "query" }); return lastEvent(n, "query"); }

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t6-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- Y1: paused elapsed freezes; resume unfreezes ---------------------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(3000);
    n.receive({ payload: "pause" });
    const p = lastEvent(n, "paused");
    check("Y1a paused event carries frozen elapsed ~3000ms", p && near(p.elapsedTime, 3000, 300), p && p.elapsedTime);
    await sleep(1500);
    let q = query(n);
    check("Y1b elapsed unchanged while paused (~3000, was: ~4500 and growing)",
      q && near(q.elapsedTime, 3000, 300), q && q.elapsedTime);
    check("Y1c frozen pair reconciles: elapsed + remaining = duration",
      q && near(q.elapsedTime + q.remainingTime, 10000, 300), q && Math.round(q.elapsedTime + q.remainingTime));
    n.receive({ payload: "resume" });
    await sleep(1000);
    q = query(n);
    check("Y1d elapsed resumes growing (~4000ms)", q && near(q.elapsedTime, 4000, 400), q && q.elapsedTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- Y2: idle queries report 0 ----------------------------------------------
  {
    const n = makeNode(RED, { duration: "1" });
    n.receive({ payload: "go" });
    await sleep(400);
    n.receive({ payload: "stop" });
    await sleep(800);
    let q = query(n);
    check("Y2a query after stop -> elapsed 0 (was: growing forever)", q && q.elapsedTime === 0, q && q.elapsedTime);
    n.receive({ payload: "go" });
    await sleep(1300); // natural expiry
    await sleep(1000);
    q = query(n);
    check("Y2b query after expiry -> elapsed 0", q && q.elapsedTime === 0, q && q.elapsedTime);
    await n.close(false);
  }

  // -- Y3: genuine stopped/expired events carry the final elapsed --------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(3000);
    n.receive({ payload: "stop" });
    const st = lastEvent(n, "stopped");
    check("Y3a stopped event carries final elapsed ~3000ms",
      st && near(st.elapsedTime, 3000, 300), st && st.elapsedTime);
    n.receive({ payload: "go", delay: 2, units: "seconds" });
    await sleep(2400);
    const ex = lastEvent(n, "expired");
    check("Y3b expired event carries final elapsed ~2000ms",
      ex && near(ex.elapsedTime, 2000, 300), ex && ex.elapsedTime);
    n.receive({ payload: "stop" }); // redundant (idle) - should carry 0
    const rst = lastEvent(n, "stopped");
    check("Y3c redundant stop carries elapsed 0", rst && rst.ignored === true && rst.elapsedTime === 0, rst && rst.elapsedTime);
    await n.close(false);
  }

  // -- Y4: stop while paused carries the frozen snapshot -----------------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(2000);
    n.receive({ payload: "pause" });
    await sleep(1500);
    n.receive({ payload: "stop" });
    const st = lastEvent(n, "stopped");
    check("Y4 stop-from-paused carries frozen elapsed ~2000ms (not ~3500)",
      st && near(st.elapsedTime, 2000, 300), st && st.elapsedTime);
    await n.close(false);
  }

  // -- Y5: cooldown elapsed = time into the cooldown period --------------------
  {
    const n = makeNode(RED, { duration: "1", cooldownduration: "6" });
    n.receive({ payload: "go" });
    await sleep(1300); // expire into 6s cooldown
    await sleep(2000); // 2s into cooldown
    const q = query(n);
    check("Y5a cooldown elapsed ~2000ms into the period (was: dead run's drift)",
      q && q.timerState === "cooldown" && near(q.elapsedTime, 2000, 400), q && q.elapsedTime);
    check("Y5b cooldown pair reconciles: elapsed + remaining ~= 6000ms",
      q && near(q.elapsedTime + q.remainingTime, 6000, 400), q && Math.round(q.elapsedTime + q.remainingTime));
    n.receive({ payload: "stop" });
    const st = lastEvent(n, "stopped");
    check("Y5c stop during cooldown carries cooldown-elapsed (~2000ms)",
      st && near(st.elapsedTime, 2000, 500), st && st.elapsedTime);
    await n.close(false);
  }

  // -- Y6: threshold pause freezes; threshold stop carries final elapsed -------
  {
    const n = makeNode(RED, { donotresettimer: true, thresholdaction: "pause", thresholdcount: "2" });
    n.receive({ payload: "go" });
    await sleep(2000);
    n.receive({ payload: "p1" });
    n.receive({ payload: "p2" }); // threshold pause fires
    await sleep(1200);
    const q = query(n);
    check("Y6a threshold pause froze elapsed ~2000ms",
      q && q.timerState === "paused" && near(q.elapsedTime, 2000, 300), q && q.elapsedTime);
    n.receive({ payload: "stop" });
    await n.close(false);

    const m = makeNode(RED, { donotresettimer: true, thresholdaction: "stop", thresholdcount: "2" });
    m.receive({ payload: "go" });
    await sleep(2000);
    m.receive({ payload: "p1" });
    m.receive({ payload: "p2" }); // threshold stop fires
    const st = lastEvent(m, "stopped");
    check("Y6b threshold stop carries final elapsed ~2000ms",
      st && st.source === "internal" && near(st.elapsedTime, 2000, 300), st && st.elapsedTime);
    await m.close(false);
  }

  // -- Y7: paused restore reconstructs the frozen elapsed ----------------------
  {
    const id = "y7-fixed";
    const n1 = makeNode(RED, { id: id, persist: true });
    n1.receive({ payload: "go" });
    await sleep(3000);
    n1.receive({ payload: "pause" }); // persists paused at ~7000 remaining
    await n1.close(false);
    await sleep(1000); // downtime does not advance a paused timer's elapsed
    const n2 = makeNode(RED, { id: id, persist: true });
    await sleep(100);
    const q = query(n2);
    // Updated after the paused-restore fix (open-item 1): a paused timer
    // now restores at its exact frozen values, downtime excluded, matching
    // the documented "same remaining time" promise.
    check("Y7a restored pause: elapsed reconciles with restored remaining",
      q && q.timerState === "paused" && near(q.elapsedTime + q.remainingTime, 10000, 300),
      q && Math.round(q.elapsedTime + q.remainingTime));
    check("Y7b restored pause: frozen elapsed survives downtime (~3000ms)",
      q && near(q.elapsedTime, 3000, 400), q && q.elapsedTime);
    n2.receive({ payload: "stop" });
    await n2.close(true);
  }

  console.log(failures === 0 ? "\nALL #6 TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-paused-restore
// ============================================================================
__defineSuite("test-paused-restore", async function () {
// Tests for open-item 1 (Option A): a paused timer restores at the SAME
// frozen remaining and elapsed values regardless of Node-RED downtime.
// Running/cooldown restores remain wall-clock (downtime absorbed). Legacy
// persist files without the new fields fall back to the old calculation.
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function near(a, e, tol) { return Math.abs(a - e) <= tol; }

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.status = function() {};
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  return out;
}
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }
function query(n) { n.receive({ payload: "query" }); return lastEvent(n, "query"); }

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "z-fixed", duration: "10", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: true, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}
function persistFile(userDir, id) { return path.join(userDir, "timerevents-timers", id); }

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-oi1-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- Z1: paused restore ignores downtime -----------------------------------
  {
    const n1 = makeNode(RED, { id: "z1" });
    n1.receive({ payload: "go" });
    await sleep(3000);
    n1.receive({ payload: "pause" }); // frozen: ~7000 remaining / ~3000 elapsed
    await n1.close(false);
    await sleep(2000);                // 2s of downtime - must NOT be deducted
    const n2 = makeNode(RED, { id: "z1" });
    const q = query(n2);
    check("Z1a remaining unchanged across downtime (~7000, was: ~5000)",
      q && q.timerState === "paused" && near(q.remainingTime, 7000, 300), q && Math.round(q.remainingTime));
    check("Z1b elapsed unchanged across downtime (~3000, was: ~5000)",
      q && near(q.elapsedTime, 3000, 300), q && Math.round(q.elapsedTime));
    // resume must honor the frozen value end-to-end
    n2.receive({ payload: "resume" });
    const t0 = Date.now();
    await new Promise(res => { const iv = setInterval(() => { if (lastEvent(n2, "expired")) { clearInterval(iv); res(); } }, 100); });
    check("Z1c resume after restore runs the full frozen ~7s", near(Date.now() - t0, 7000, 600), Date.now() - t0);
    await n2.close(true);
  }

  // -- Z2: frozenElapsed independence survives (settime while paused) --------
  {
    const n1 = makeNode(RED, { id: "z2" });
    n1.receive({ payload: "go" });
    await sleep(3000);
    n1.receive({ payload: "pause" });                       // elapsed frozen ~3000
    n1.receive({ payload: "settime", settime: 9000 });      // remaining -> 9000, elapsed untouched
    await n1.close(false);
    await sleep(1000);
    const n2 = makeNode(RED, { id: "z2" });
    const q = query(n2);
    check("Z2a settime'd remaining restores exactly (9000)",
      q && q.remainingTime === 9000, q && q.remainingTime);
    check("Z2b frozen elapsed restores independently (~3000, not derived 1000)",
      q && near(q.elapsedTime, 3000, 300), q && Math.round(q.elapsedTime));
    n2.receive({ payload: "stop" });
    await n2.close(true);
  }

  // -- Z3: legacy persist file (no new fields) -> old fallback behavior ------
  {
    const n1 = makeNode(RED, { id: "z3" });
    n1.receive({ payload: "go" });
    await sleep(3000);
    n1.receive({ payload: "pause" });
    await n1.close(false);
    // Strip the new fields to simulate a pre-upgrade persist file
    const file = persistFile(userDir, "z3");
    const saved = JSON.parse(fs.readFileSync(file));
    delete saved.remaining;
    delete saved.frozenElapsed;
    fs.writeFileSync(file, JSON.stringify(saved));
    await sleep(2000);
    const n2 = makeNode(RED, { id: "z3" });
    const q = query(n2);
    check("Z3 legacy file falls back to target-minus-now (~5000 after 2s downtime)",
      q && q.timerState === "paused" && near(q.remainingTime, 5000, 400), q && Math.round(q.remainingTime));
    n2.receive({ payload: "stop" });
    await n2.close(true);
  }

  // -- Z4: regression - RUNNING restore still absorbs downtime ----------------
  {
    const n1 = makeNode(RED, { id: "z4" });
    n1.receive({ payload: "go" });
    await sleep(3000); // ~7000 remaining
    await n1.close(false);
    await sleep(2000); // downtime SHOULD be absorbed for a running timer
    const n2 = makeNode(RED, { id: "z4" });
    await sleep(150);
    const s = lastEvent(n2, "started");
    check("Z4 running restore still deducts downtime (~5000 remaining)",
      s && near(s.remainingTime, 5000, 700), s && Math.round(s.remainingTime));
    n2.receive({ payload: "stop" });
    await n2.close(true);
  }

  console.log(failures === 0 ? "\nALL OPEN-ITEM-1 TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-status-flicker
// ============================================================================
__defineSuite("test-status-flicker", async function () {
// Tests for the status-flicker fix: the unconditional node.status({}) at
// the top of handleInputEvent is gone. Verifies (a) a query against a
// running timer never emits an empty status call, and (b) every command
// path still ends with a non-empty status of its own (the invariant that
// replaced the blanket blank).
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function isBlank(s) { return !s || Object.keys(s).length === 0 || (!s.text && !s.fill && !s.shape); }

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.statusCalls = [];            // record every status call
        node.status = function(s) { node.statusCalls.push(s); };
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "s" + Math.random().toString(36).slice(2),
    duration: "10", durationType: "num", units: "Second",
    reporting: "none", reportingformat: "seconds",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-flicker-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- F1: the flicker itself - query against a running timer ----------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    await sleep(300);
    n.statusCalls.length = 0;
    n.receive({ payload: "query" });
    check("F1a query emits no blank status call (was: blank-then-repaint flicker)",
      n.statusCalls.every(s => !isBlank(s)), JSON.stringify(n.statusCalls));
    check("F1b query still repaints a non-empty status",
      n.statusCalls.length >= 1 && !isBlank(n.statusCalls[n.statusCalls.length - 1]),
      JSON.stringify(n.statusCalls[n.statusCalls.length - 1]));
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- F2: sweep - every command path ends with a non-empty status -----------
  // Sequence chosen to hit genuine AND redundant/ignored branches of each
  // handler, plus the gates, across running / paused / idle states.
  {
    const n = makeNode(RED, { donotresettimer: false });
    const steps = [
      { payload: "go" },                                   // start (startReporting paints)
      { payload: "go" },                                   // restart
      { payload: "lock" },                                 // genuine lock
      { payload: "lock" },                                 // redundant lock
      { payload: "poke" },                                 // lock gate (blocked restart)
      { payload: "unlock" },                               // genuine unlock
      { payload: "unlock" },                               // redundant unlock
      { payload: "adjusttime", adjusttime: 1000 },         // genuine adjust
      { payload: "adjusttime", adjusttime: "bad" },        // rejected adjust
      { payload: "settime", settime: 5000 },               // genuine settime
      { payload: "settime", settime: -1 },                 // rejected settime
      { payload: "setduration", setduration: 8000 },       // genuine setduration
      { payload: "setduration", setduration: "bad" },      // rejected setduration
      { payload: "pause" },                                // genuine pause
      { payload: "pause" },                                // redundant pause
      { payload: "poke" },                                 // paused gate
      { payload: "resume" },                               // genuine resume
      { payload: "resume" },                               // redundant resume
      { payload: "disable" },                              // genuine disable
      { payload: "disable" },                              // redundant disable
      { payload: "stop" },                                 // genuine stop
      { payload: "stop" },                                 // redundant stop (idle)
      { payload: "go" },                                   // blocked start (disabled gate)
      { payload: "enable" },                               // genuine enable
      { payload: "enable" },                               // redundant enable
      { payload: "query" }                                 // query while idle
    ];
    let ok = true, failedAt = null;
    for (const m of steps) {
      n.statusCalls.length = 0;
      n.receive(m);
      const last = n.statusCalls[n.statusCalls.length - 1];
      if (n.statusCalls.length === 0 || isBlank(last)) { ok = false; failedAt = JSON.stringify(m); break; }
    }
    check("F2 all 26 command paths end with a non-empty status (invariant holds)", ok, failedAt);
    await n.close(false);
  }

  // -- F3: close handler still blanks (unrelated blank preserved) ------------
  {
    const n = makeNode(RED);
    n.receive({ payload: "go" });
    n.receive({ payload: "stop" });
    n.statusCalls.length = 0;
    await n.close(false);
    check("F3 node close still blanks the status (deliberate blank preserved)",
      n.statusCalls.length === 1 && isBlank(n.statusCalls[0]), JSON.stringify(n.statusCalls));
  }

  console.log(failures === 0 ? "\nALL FLICKER TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

// ============================================================================
// SUITE: test-fractional-label
// ============================================================================
__defineSuite("test-fractional-label", async function () {
// Tests for the fractional-seconds status-label fix: rounding enforced at
// the single display boundary (displayTime). Reproduces the reported
// pause/resume case, sweeps the other fractional-sync paths, and confirms
// timing precision is untouched (labels round; clocks don't).
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}
function near(a, e, tol) { return Math.abs(a - e) <= tol; }
// A label is fraction-free if no decimal point appears in any numeric run
function hasFraction(text) { return typeof text === "string" && /\d+\.\d+/.test(text); }

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function(evt, fn) { node._handlers[evt] = fn; };
        node.receive = function(msg) { node._handlers["input"](msg); };
        node.close = function(removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function(arr) { node.sent.push(arr); };
        node.statusCalls = [];
        node.status = function(s) { node.statusCalls.push(s); };
        node.warn = function() {};
        node.error = function(e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); },
      evaluateNodeProperty(v) { return v; }
    },
    settings: { userDir: userDir }
  };
}

function events(node, type) {
  const out = [];
  for (const arr of node.sent) for (const m of arr) if (m && m.timerEvent === type) out.push(m);
  return out;
}
function lastEvent(node, type) { const e = events(node, type); return e.length ? e[e.length - 1] : null; }
function lastStatusText(node) {
  const s = node.statusCalls[node.statusCalls.length - 1];
  return s && s.text;
}

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("timer-events");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "r" + Math.random().toString(36).slice(2),
    duration: "40", durationType: "num", units: "Second",
    reporting: "every_second", reportingformat: "human",
    persist: false, ignoretimerpass: false, donotresettimer: false,
    thresholdaction: "donothing", thresholdcount: "0",
    thresholdaddtime: "0", thresholdaddtimeunits: "Second",
    heartbeatinterval: "0", heartbeatintervalunits: "Second",
    cooldownduration: "0", cooldownunits: "Second"
  }, cfg));
  return node;
}

await (async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-frac-"));
  const RED = makeRED(userDir);
  require(path.join(__dirname, "timer-events.js"))(RED);

  // -- R1: the reported bug - pause then resume, label must be whole seconds -
  {
    const n = makeNode(RED, { reportingformat: "seconds" }); // 35.221-style leak was most visible here
    n.receive({ payload: "go" });
    await sleep(4780); // engineered so remaining is a messy fraction (~35.22s)
    n.receive({ payload: "pause" });
    check("R1a paused label has no fractional seconds", !hasFraction(lastStatusText(n)), lastStatusText(n));
    n.receive({ payload: "resume" });
    check("R1b resume label has no fractional seconds (the reported case)",
      !hasFraction(lastStatusText(n)), lastStatusText(n));
    await sleep(2300); // let the countdown interval repaint a few times
    const fractional = n.statusCalls.filter(s => hasFraction(s && s.text));
    check("R1c no subsequent countdown tick shows fractions",
      fractional.length === 0, JSON.stringify(fractional.map(s => s.text)));
    // Timing untouched: envelope still carries the exact frozen-derived ms
    n.receive({ payload: "query" });
    const q = lastEvent(n, "query");
    check("R1d msg.remainingTime still exact ms (not rounded)",
      q && q.remainingTime % 1000 !== 0, q && q.remainingTime);
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- R2: sweep the other fractional-sync paths ------------------------------
  {
    const n = makeNode(RED, { reportingformat: "human", donotresettimer: true,
      thresholdaction: "addtime", thresholdcount: "2", thresholdaddtime: "5" });
    n.receive({ payload: "go" });
    await sleep(1370);
    n.receive({ payload: "adjusttime", adjusttime: 2500 });          // fractional base + fractional add
    check("R2a adjusttime label whole seconds", !hasFraction(lastStatusText(n)), lastStatusText(n));
    n.receive({ payload: "settime", settime: 1500 });                 // the flagged settime edge: now rounds
    check("R2b settime 1500 label rounds (edge resolved per display principle)",
      !hasFraction(lastStatusText(n)), lastStatusText(n));
    n.receive({ payload: "poke1" });
    n.receive({ payload: "poke2" });                                  // threshold Add Time fires on fractional base
    check("R2c threshold Add Time label whole seconds", !hasFraction(lastStatusText(n)), lastStatusText(n));
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- R3: threshold Pause label whole seconds --------------------------------
  {
    const n = makeNode(RED, { donotresettimer: true, thresholdaction: "pause", thresholdcount: "2" });
    n.receive({ payload: "go" });
    await sleep(1430);
    n.receive({ payload: "p1" });
    n.receive({ payload: "p2" }); // threshold pause fires at fractional remaining
    check("R3 threshold Pause label whole seconds", !hasFraction(lastStatusText(n)), lastStatusText(n));
    n.receive({ payload: "stop" });
    await n.close(false);
  }

  // -- R4: timing precision unchanged - resume runs the exact frozen time -----
  {
    const n = makeNode(RED, { duration: "8", reporting: "none" });
    n.receive({ payload: "go" });
    await sleep(2340); // frozen remaining will be ~5660ms, deliberately fractional
    n.receive({ payload: "pause" });
    const frozen = (n.receive({ payload: "query" }), lastEvent(n, "query")).remainingTime;
    n.receive({ payload: "resume" });
    const t0 = Date.now();
    await new Promise(res => { const iv = setInterval(() => { if (lastEvent(n, "expired")) { clearInterval(iv); res(); } }, 25); });
    const ranFor = Date.now() - t0;
    check("R4 resume-to-expiry matches the exact frozen ms (labels round; clocks don't)",
      near(ranFor, frozen, 150), ranFor + " vs frozen " + Math.round(frozen));
    await n.close(false);
  }

  console.log(failures === 0 ? "\nALL FRACTIONAL-LABEL TESTS PASSED" : "\n" + failures + " FAILURE(S)");
})();
  return failures;
});

(async function runAll() {
  let totalFailures = 0;
  for (const s of __suites) {
    console.log("\n==== " + s.name + " ====");
    totalFailures += await s.fn();
  }
  console.log(totalFailures === 0
    ? "\n==== FULL BATTERY: ALL SUITES PASSED ===="
    : "\n==== FULL BATTERY: " + totalFailures + " TOTAL FAILURE(S) ====");
  process.exit(totalFailures === 0 ? 0 : 1);
})();