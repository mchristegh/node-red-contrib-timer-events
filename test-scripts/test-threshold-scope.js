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

(async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t2-"));
  const RED = makeRED(userDir);
  require("/home/claude/timer-events.js")(RED);

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
  process.exit(failures === 0 ? 0 : 1);
})();
