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

(async function main() {
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
  process.exit(failures === 0 ? 0 : 1);
})();
