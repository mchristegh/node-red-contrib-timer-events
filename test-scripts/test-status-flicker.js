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

(async function main() {
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
  process.exit(failures === 0 ? 0 : 1);
})();
