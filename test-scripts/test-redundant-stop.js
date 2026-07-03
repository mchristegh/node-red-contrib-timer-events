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

(async function main() {
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
  process.exit(failures === 0 ? 0 : 1);
})();
