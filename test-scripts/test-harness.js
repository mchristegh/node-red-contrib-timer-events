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

(async function main() {
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
  process.exit(failures === 0 ? 0 : 1);
})();
