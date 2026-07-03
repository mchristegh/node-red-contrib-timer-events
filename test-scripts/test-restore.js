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

(async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t3-"));
  const RED = makeRED(userDir);
  require("/home/claude/timer-events.js")(RED);

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
  process.exit(failures === 0 ? 0 : 1);
})();
