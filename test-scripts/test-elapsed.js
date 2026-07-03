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

(async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "timerevents-t6-"));
  const RED = makeRED(userDir);
  require("/home/claude/timer-events.js")(RED);

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
  process.exit(failures === 0 ? 0 : 1);
})();
