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

(async function main() {
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
  process.exit(failures === 0 ? 0 : 1);
})();
