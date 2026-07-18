/**
 * timer-events
 * A Node-RED timer node with variable delay, pause/resume, persistence,
 * ignored message handling, threshold actions, heartbeat, and a
 * purpose-built 4-output event model:
 *   1. Start  - fires only on a true stopped/expired -> running transition
 *   2. Stop   - fires only on a true stop or natural expiry
 *   3. Query  - fires on an incoming query message, or on a heartbeat tick
 *   4. Events - fires for every other event, including tagged copies of
 *               ignored/blocked commands
 *
 * Derived from stoptimer-varidelay-plus.
 * Modifications copyright (C) 2025 mchristegh
 * Modifications copyright (C) 2020 hamsando
 * Copyright jbardi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Module-level constants
  // ---------------------------------------------------------------------------

  const TIMER_STATE = {
    RUNNING: "running",
    PAUSED: "paused",
    STOPPED: "stopped",
    EXPIRED: "expired",
    COOLDOWN: "cooldown",
  };

  // Canonical event-type list for output 4 (and output 3, for QUERY).
  // Note: a "restart" (a new/duplicate start while the timer is already
  // running or paused) is intentionally NOT the same as STARTED - it is
  // treated as a larger sibling of TIMESET (see design notes on
  // handleInputEvent) and never appears on output 1.
  const TIMER_EVENT = {
    STARTED: "started",
    RESTARTED: "restarted",
    STOPPED: "stopped",
    EXPIRED: "expired",
    PAUSED: "paused",
    RESUMED: "resumed",
    LOCKED: "locked",
    UNLOCKED: "unlocked",
    DISABLED: "disabled",
    ENABLED: "enabled",
    TIMEADJUSTED: "timeadjusted",
    TIMESET: "timeset",
    DURATIONSET: "durationset",
    WARNING: "warning",
    QUERY: "query",
    COOLDOWNSTARTED: "cooldownstarted",
    COOLDOWNENDED: "cooldownended",
  };

  // Identifies whether an event was triggered by a live incoming message
  // ("external") or by the node itself ("internal") - e.g. a heartbeat
  // tick or a threshold action firing on its own.
  const EVENT_SOURCE = {
    EXTERNAL: "external",
    INTERNAL: "internal",
  };

  const UNITS = {
    MILLISECOND: "Millisecond",
    SECOND: "Second",
    MINUTE: "Minute",
    HOUR: "Hour",
  };

  const UNITS_INPUT = {
    MILLISECOND: "millisecond",
    SECOND: "second",
    MINUTE: "minute",
    HOUR: "hour",
  };

  // Threshold action config values. Note the RESET action results in the
  // node emitting TIMER_EVENT.RESTARTED (not a "reset" event name) since a
  // threshold-triggered reset is treated identically to a message-triggered
  // restart - see handleThresholdAction().
  const THRESHOLD_ACTION = {
    DONOTHING: "donothing",
    STOP: "stop",
    PAUSE: "pause",
    RESET: "reset",
    ADDTIME: "addtime",
    WARNING: "warning",
  };

  const PAYLOAD = {
    STOP: "stop",
    PAUSE: "pause",
    RESUME: "resume",
    QUERY: "query",
    LOCK: "lock",
    UNLOCK: "unlock",
    DISABLE: "disable",
    ENABLE: "enable",
    ADJUSTTIME: "adjusttime",
    SETTIME: "settime",
    SETDURATION: "setduration",
  };

  const REPORTING_FORMAT = {
    HUMAN: "human",
    SECONDS: "seconds",
    MINUTES: "minutes",
    HOURS: "hours",
  };

  // Reporting only drives the node's status label now (see startReporting).
  // It no longer produces its own output message - that role is served by
  // the query output (manual query or heartbeat tick).
  const REPORTING = {
    NONE: "none",
    EVERY_SECOND: "every_second",
    LAST_MINUTE_SECONDS: "last_minute_seconds",
  };

  // ---------------------------------------------------------------------------
  // Node definition
  // ---------------------------------------------------------------------------

  function TimerEvents(n) {
    RED.nodes.createNode(this, n);
    const fs = require("fs");
    const path = require("path");
    let nodefile = n.id.toString();
    let nodepath = "";
    require("./cycle.js");

    if (n._alias != null) {
      nodepath = n._flow.path.replace(/\//g, "-") + "-";
      nodefile = n._alias;
    }

    const stvdtimersFile = path.join(
      RED.settings.userDir,
      "timerevents-timers",
      nodepath + nodefile,
    );

    // -------------------------------------------------------------------------
    // Node property initialization
    // -------------------------------------------------------------------------

    this.units = n.units || UNITS.SECOND;
    this.durationType = n.durationType;
    this.duration = isNaN(
      Number(
        RED.util.evaluateNodeProperty(
          n.duration,
          this.durationType,
          this,
          null,
        ),
      ),
    )
      ? 5
      : Number(
          RED.util.evaluateNodeProperty(
            n.duration,
            this.durationType,
            this,
            null,
          ),
        );
    this.reporting = n.reporting || REPORTING.NONE;
    this.reportingformat = n.reportingformat || REPORTING_FORMAT.HUMAN;
    this.persist = n.persist || false;
    this.ignoretimerpass = n.ignoretimerpass || false;
    this.donotresettimer = n.donotresettimer || false;
    this.thresholdaction = n.thresholdaction || THRESHOLD_ACTION.DONOTHING;
    this.thresholdcount = isNaN(Number(n.thresholdcount))
      ? 0
      : Number(n.thresholdcount);
    this.thresholdaddtime = isNaN(Number(n.thresholdaddtime))
      ? 0
      : Number(n.thresholdaddtime);
    this.thresholdaddtimeunits = n.thresholdaddtimeunits || UNITS.SECOND;
    this.heartbeatinterval = isNaN(Number(n.heartbeatinterval))
      ? 0
      : Number(n.heartbeatinterval);
    this.heartbeatintervalunits = n.heartbeatintervalunits || UNITS.SECOND;
    this.cooldownduration = isNaN(Number(n.cooldownduration))
      ? 0
      : Number(n.cooldownduration);
    this.cooldownunits = n.cooldownunits || UNITS.SECOND;

    if (this.duration <= 0) {
      this.duration = 0;
    } else {
      if (this.units === UNITS.SECOND) this.duration = this.duration * 1000;
      if (this.units === UNITS.MINUTE)
        this.duration = this.duration * 1000 * 60;
      if (this.units === UNITS.HOUR)
        this.duration = this.duration * 1000 * 60 * 60;
    }

    const node = this;

    // -------------------------------------------------------------------------
    // Runtime state variables
    // -------------------------------------------------------------------------

    let timeout = null;
    let miniTimeout = null;
    let countdown = null;
    let heartbeatTimer = null; // setInterval handle for heartbeat, independent of clearAllTimers
    let stopped = false;
    let paused = false;
    let disabled = false;
    let delayRemainingDisplay = 0;
    let delayFactor = 1000;
    let reporting = this.reporting;
    let reportingformat = this.reportingformat;

    const maxTimeout = 2147483647;
    let actualDelayInUse = 0;
    let actualDelayRemaining = 0;

    let ignoredCount = 0;
    let lastIgnoredTime = null;
    let timerRunning = false;
    let timerState = TIMER_STATE.STOPPED;
    let timerStartTime = null;
    let timerDuration = 0;
    let originalMsg = null; // last true start/restart's triggering msg; reused as the
    // payload base for events that have no live triggering msg
    // of their own (expiry, heartbeat, threshold actions, etc.)
    let overrideDuration = null;

    // Authoritative wall-clock remaining-time state. delayRemainingDisplay /
    // cooldownRemainingDisplay above are display-only counters driven by the
    // cosmetic reporting intervals and must never be used as a source of
    // truth - with reporting set to "none" they do not decrement at all.
    // getRemainingTime() derives the true remaining time from these instead:
    let expiryTarget = null; // ms epoch timestamp the running timer will fire at; null when not running
    let frozenRemaining = null; // exact remaining ms captured at the moment of pause; null when not paused
    let frozenElapsed = null; // exact elapsed ms captured at the moment of pause; null when not paused
    let cooldownExpiryTarget = null; // ms epoch timestamp the cooldown period ends at; null when not in cooldown

    // Cooldown - a self-expiring, timed block on new starts that begins
    // automatically after a natural expiry (never after an explicit stop).
    // Deliberately kept on its own timer handles, fully independent of the
    // main timeout/countdown/miniTimeout, so clearAllTimers() (used freely
    // elsewhere) can never accidentally interrupt an in-progress cooldown.
    let cooldownActive = false;
    let cooldownRemainingDisplay = 0;
    let cooldownTimeout = null;
    let cooldownReportInterval = null;
    let cooldownReportMiniTimeout = null;
    let actualCooldownDelayInUse = 0;
    let actualCooldownDelayRemaining = 0;

    // -------------------------------------------------------------------------
    // Persist restore
    // -------------------------------------------------------------------------

    if (this.persist === true) {
      try {
        if (fs.existsSync(stvdtimersFile)) {
          const savedState = JSON.retrocycle(JSON.parse(readState()));
          let targetMS = new Date(savedState.time.toString()).getTime();
          const nowMS = new Date().getTime();

          // Note: reporting / reportingformat are deliberately NOT restored
          // from the persisted file - the node's freshly-deployed config
          // always wins, so changing the Status Reporting dropdown and
          // redeploying mid-run takes effect immediately. (The fields are
          // still written to disk for backward compatibility with old
          // persist files; they are simply ignored on read.)

          if (typeof savedState.ignoredCount !== "undefined")
            ignoredCount = savedState.ignoredCount;
          if (
            typeof savedState.lastIgnoredTime !== "undefined" &&
            savedState.lastIgnoredTime !== null
          ) {
            lastIgnoredTime = new Date(savedState.lastIgnoredTime);
          }
          if (
            typeof savedState.timerStartTime !== "undefined" &&
            savedState.timerStartTime !== null
          ) {
            timerStartTime = new Date(savedState.timerStartTime);
          }
          if (typeof savedState.timerState !== "undefined")
            timerState = savedState.timerState;
          if (typeof savedState.donotresettimer !== "undefined")
            node.donotresettimer = savedState.donotresettimer;
          if (
            typeof savedState.overrideDuration !== "undefined" &&
            savedState.overrideDuration !== null
          ) {
            overrideDuration = savedState.overrideDuration;
          }
          if (typeof savedState.disabled !== "undefined")
            disabled = savedState.disabled;

          if (savedState.cooldownActive === true) {
            let remainingMS = targetMS - nowMS;
            if (remainingMS <= 0)
              remainingMS = Math.floor(Math.random() * 5 + 3) * 1000;
            cooldownRemainingDisplay = remainingMS;
            cooldownActive = true;
            cooldownExpiryTarget = Date.now() + remainingMS;
            timerState = TIMER_STATE.COOLDOWN;
            originalMsg = savedState.origmsg;
            node.status(
              buildStatus(
                displayTime(cooldownRemainingDisplay, node.reportingformat),
                TIMER_STATE.COOLDOWN,
              ),
            );
            startCooldownTimeout();
            startCooldownReporting();
            // Heartbeat restarts fresh after a restore - does not recalculate original schedule
            startHeartbeat();
          } else if (savedState.paused === true) {
            // A paused timer is FROZEN - Node-RED downtime must not deduct
            // from its remaining time (per the documented "restore as
            // paused at the same remaining time"). Read the persisted
            // frozen snapshot directly; fall back to the legacy
            // target-minus-now calculation only for old persist files that
            // predate the `remaining` field.
            let remainingMS =
              typeof savedState.remaining === "number"
                ? savedState.remaining
                : targetMS - nowMS;
            if (remainingMS <= 0)
              remainingMS = Math.floor(Math.random() * 5 + 3) * 1000;
            delayRemainingDisplay = remainingMS;
            frozenRemaining = remainingMS;
            timerDuration =
              typeof savedState.timerDuration !== "undefined"
                ? savedState.timerDuration
                : remainingMS;
            // frozenElapsed is persisted independently because settime
            // while paused changes remaining without touching elapsed -
            // deriving it from duration-remaining would be wrong in that
            // case. Derivation remains the fallback for old files.
            frozenElapsed =
              typeof savedState.frozenElapsed === "number"
                ? savedState.frozenElapsed
                : Math.max(0, timerDuration - remainingMS);
            timerStartTime = new Date(nowMS - (timerDuration - remainingMS));
            paused = true;
            timerRunning = false;
            timerState = TIMER_STATE.PAUSED;
            originalMsg = savedState.origmsg;
            node.status(
              buildStatus(
                displayTime(delayRemainingDisplay, node.reportingformat),
                TIMER_STATE.PAUSED,
              ),
            );
            // Heartbeat restarts fresh after a restore - does not recalculate original schedule
            startHeartbeat();
          } else {
            if (targetMS - nowMS <= 3000) {
              targetMS = Math.floor(Math.random() * 5 + 3) * 1000;
            } else {
              targetMS = Math.round((targetMS - nowMS) / 1000) * 1000;
            }
            savedState.origmsg.units = UNITS_INPUT.MILLISECOND;
            savedState.origmsg.delay = targetMS;
            // Continuation semantics: this is the same run picking up where
            // it left off, so the run's identity survives the restore.
            // Same duration fallback and timerStartTime back-calculation as
            // the paused branch above - Node-RED downtime counts as elapsed
            // time, so elapsedTime + remainingTime reconciles with
            // timerDuration immediately after restore.
            timerDuration =
              typeof savedState.timerDuration !== "undefined"
                ? savedState.timerDuration
                : targetMS;
            timerStartTime = new Date(nowMS - (timerDuration - targetMS));
            // A running restore is a true stopped/expired -> running transition,
            // so it is treated as a start (output 1) with an internal source.
            // handleInputEvent skips its fresh-run resets when isRestore is
            // true, preserving the timerDuration / timerStartTime /
            // ignoredCount / lastIgnoredTime restored above.
            handleInputEvent(savedState.origmsg, true);
          }
        }
      } catch (error) {
        this.error(
          "Error processing persistent file data for timer-events node " +
            n.id.toString() +
            "\n\n" +
            error.toString(),
        );
      }
    } else {
      deleteState();
    }

    // -------------------------------------------------------------------------
    // Event listeners
    // -------------------------------------------------------------------------

    this.on("input", function (msg) {
      handleInputEvent(msg, false);
    });

    this.on("close", function (removed, done) {
      if (timeout) clearTimeout(timeout);
      if (countdown) clearInterval(countdown);
      if (miniTimeout) clearTimeout(miniTimeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clearCooldownTimers();
      node.status({});
      if (removed) deleteState();
      done();
    });

    // -------------------------------------------------------------------------
    // Status helper
    // -------------------------------------------------------------------------

    function buildStatus(timeDisplay, state) {
      let baseText;
      let fill;
      let shape;

      if (state === TIMER_STATE.STOPPED || state === TIMER_STATE.EXPIRED) {
        fill = state === TIMER_STATE.STOPPED ? "red" : "blue";
        shape = state === TIMER_STATE.STOPPED ? "ring" : "square";
        if (node.donotresettimer) {
          const lastStr = lastIgnoredTime
            ? formatIgnoredTime(lastIgnoredTime)
            : "--";
          const stateLabel =
            state === TIMER_STATE.STOPPED ? "Stopped" : "Expired";
          baseText =
            stateLabel + " | Ignored: " + ignoredCount + ", Last: " + lastStr;
        } else {
          baseText = state === TIMER_STATE.STOPPED ? "stopped" : "expired";
        }
      } else if (state === TIMER_STATE.PAUSED) {
        fill = "yellow";
        shape = "ring";
        if (node.donotresettimer) {
          const lastStr = lastIgnoredTime
            ? formatIgnoredTime(lastIgnoredTime)
            : "--";
          baseText =
            "Paused: " +
            timeDisplay +
            " | Ignored: " +
            ignoredCount +
            ", Last: " +
            lastStr;
        } else {
          baseText = "Paused: " + timeDisplay;
        }
      } else if (state === TIMER_STATE.COOLDOWN) {
        // Deliberately short, no ignored-count/last-ignored detail here -
        // ignored messages during cooldown aren't actionable the way they
        // are while running, so surfacing them would just add clutter.
        fill = "yellow";
        shape = "dot";
        baseText = "Cooldown: " + timeDisplay;
      } else {
        fill = "green";
        shape = "dot";
        if (node.donotresettimer) {
          const lastStr = lastIgnoredTime
            ? formatIgnoredTime(lastIgnoredTime)
            : "--";
          baseText =
            "Remaining: " +
            timeDisplay +
            " | Ignored: " +
            ignoredCount +
            ", Last: " +
            lastStr;
        } else {
          baseText = timeDisplay;
        }
      }

      if (disabled) {
        if (state === TIMER_STATE.COOLDOWN) {
          return { fill: "grey", shape: "ring", text: "Disabled" };
        }
        return { fill: "grey", shape: "ring", text: "Disabled | " + baseText };
      }

      return { fill: fill, shape: shape, text: baseText };
    }

    // -------------------------------------------------------------------------
    // Utility helpers
    // -------------------------------------------------------------------------

    function formatIgnoredTime(date) {
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      return (
        months[date.getMonth()] +
        " " +
        String(date.getDate()).padStart(2, "0") +
        " " +
        String(date.getHours()).padStart(2, "0") +
        ":" +
        String(date.getMinutes()).padStart(2, "0") +
        ":" +
        String(date.getSeconds()).padStart(2, "0")
      );
    }

    /**
     * State-aware elapsed time, the mirror image of getRemainingTime():
     *   - running:  wall-clock time since timerStartTime
     *   - paused:   the exact snapshot frozen at the moment of pause
     *   - cooldown: time INTO the cooldown period (so during cooldown
     *               elapsedTime + remainingTime ~= the cooldown duration,
     *               symmetric with remainingTime reporting cooldown time)
     *   - idle (stopped/expired): 0 - there is no current run. The genuine
     *     stopped/expired events still carry the run's final elapsed value,
     *     snapshotted just before the state flips (see their dispatch sites).
     */
    function getElapsedTime() {
      if (timerState === TIMER_STATE.COOLDOWN) {
        const cooldownFullMS = convertToMilliseconds(
          node.cooldownduration,
          node.cooldownunits,
        );
        return Math.max(0, cooldownFullMS - getRemainingTime());
      }
      if (paused) {
        return frozenElapsed !== null ? frozenElapsed : 0;
      }
      if (timerRunning && timerStartTime !== null) {
        return Date.now() - timerStartTime.getTime();
      }
      return 0;
    }

    /**
     * The single authoritative source for "remaining time right now",
     * computed from wall-clock targets rather than the display counters
     * (which only tick when Status Reporting is enabled):
     *   - cooldown: time until cooldownExpiryTarget
     *   - paused:   the exact snapshot frozen at the moment of pause
     *   - running:  time until expiryTarget
     *   - idle (stopped/expired): 0
     * Returns exact milliseconds - rounding for the status label happens
     * only at the display boundary (see displayRemaining).
     */
    function getRemainingTime() {
      if (timerState === TIMER_STATE.COOLDOWN) {
        return cooldownExpiryTarget !== null
          ? Math.max(0, cooldownExpiryTarget - Date.now())
          : 0;
      }
      if (paused) {
        return frozenRemaining !== null ? frozenRemaining : 0;
      }
      if (timerRunning && expiryTarget !== null) {
        return Math.max(0, expiryTarget - Date.now());
      }
      return 0;
    }

    /**
     * Convenience wrapper: format the current authoritative remaining time
     * for the status label. Rounding to whole seconds happens inside
     * displayTime() itself - the single display boundary - so the raw ms
     * value passes through untouched here.
     */
    function displayRemaining(fmt) {
      return displayTime(getRemainingTime(), fmt);
    }

    function convertToMilliseconds(value, units) {
      switch (units) {
        case UNITS.SECOND:
          return value * 1000;
        case UNITS.MINUTE:
          return value * 1000 * 60;
        case UNITS.HOUR:
          return value * 1000 * 60 * 60;
        case UNITS.MILLISECOND:
          return value;
        default:
          return value;
      }
    }

    /**
     * Strict numeric validation for values arriving on incoming messages.
     * Returns a finite number, or NaN for anything unusable: missing
     * properties, non-numeric strings ("5s", "abc"), empty/whitespace
     * strings (Number("") is 0, which would silently mean "fire now"),
     * booleans, objects, and +/-Infinity. NaN <= 0 is false, which is how
     * NaN slipped past the settime/setduration validity checks - callers
     * must test the result with Number.isFinite before using it.
     */
    function toFiniteNumber(value) {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : NaN;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const num = Number(value);
        return Number.isFinite(num) ? num : NaN;
      }
      return NaN;
    }

    function normalizeUnits(units) {
      return typeof units === "string"
        ? units.toLowerCase().replace(/s$/, "")
        : null;
    }

    function msgValueToMs(value, units) {
      switch (units) {
        case UNITS_INPUT.SECOND:
          return value * 1000;
        case UNITS_INPUT.MINUTE:
          return value * 1000 * 60;
        case UNITS_INPUT.HOUR:
          return value * 1000 * 60 * 60;
        default:
          return value;
      }
    }

    // -------------------------------------------------------------------------
    // Event message construction + output dispatch
    // -------------------------------------------------------------------------

    /**
     * Builds the standard event message envelope by cloning a base message
     * (either the live triggering msg, or originalMsg when there is no live
     * trigger - e.g. expiry, heartbeat, threshold actions) and layering the
     * standard state/metadata fields on top, including the `ignored` and
     * `source` fields used across every output.
     */
    function buildEventMessage(timerEvent, baseMsg, ignored, source) {
      const evtMsg = RED.util.cloneMessage(baseMsg || {});
      evtMsg.timerEvent = timerEvent;
      evtMsg.timerState = timerState;
      evtMsg.remainingTime = getRemainingTime();
      evtMsg.timerDuration = timerDuration;
      evtMsg.elapsedTime = getElapsedTime();
      evtMsg.ignoredCount = ignoredCount;
      evtMsg.lastIgnoredTime = lastIgnoredTime
        ? lastIgnoredTime.toISOString()
        : null;
      evtMsg.doNotResetTimer = node.donotresettimer;
      evtMsg.disabled = disabled;
      evtMsg.ignored = ignored;
      evtMsg.source = source;
      return evtMsg;
    }

    /**
     * Central output router for every timer event. Applies the fixed
     * output-exclusivity rules:
     *   - Output 1 (Start):  TIMER_EVENT.STARTED only, and only when ignored
     *                        is false. A true start always also fires on
     *                        output 4.
     *   - Output 2 (Stop):   TIMER_EVENT.STOPPED or EXPIRED only, and only
     *                        when ignored is false. Always also fires on
     *                        output 4.
     *   - Output 3 (Query):  TIMER_EVENT.QUERY only. Never fires on output 4.
     *   - Output 4 (Events): every event except QUERY, including ignored
     *                        copies of what would otherwise be output 1/2
     *                        events.
     *
     * extraProps allows event-specific fields (e.g. timeAdjusted, timeSet,
     * durationSet) to be layered onto the built message.
     */
    function dispatchEvent(timerEvent, baseMsg, ignored, source, extraProps) {
      const evtMsg = buildEventMessage(timerEvent, baseMsg, ignored, source);
      if (extraProps) {
        for (const key in extraProps) {
          if (Object.prototype.hasOwnProperty.call(extraProps, key))
            evtMsg[key] = extraProps[key];
        }
      }

      if (timerEvent === TIMER_EVENT.QUERY) {
        node.send([null, null, evtMsg, null]);
        return;
      }

      let out1 = null;
      let out2 = null;
      const out4 = evtMsg;

      if (!ignored) {
        if (timerEvent === TIMER_EVENT.STARTED) {
          out1 = RED.util.cloneMessage(evtMsg);
        } else if (
          timerEvent === TIMER_EVENT.STOPPED ||
          timerEvent === TIMER_EVENT.EXPIRED
        ) {
          out2 = RED.util.cloneMessage(evtMsg);
        }
      }

      node.send([out1, out2, null, out4]);
    }

    // -------------------------------------------------------------------------
    // Timer management helpers
    // -------------------------------------------------------------------------

    /**
     * Clears the main timeout, countdown interval, and miniTimeout.
     * Does NOT clear the heartbeat - heartbeat runs on a fixed schedule
     * independent of pause/resume/adjusttime/settime/threshold actions.
     */
    function clearAllTimers() {
      clearTimeout(timeout);
      clearTimeout(miniTimeout);
      clearInterval(countdown);
      timeout = null;
      countdown = null;
      miniTimeout = null;
    }

    /**
     * Starts the heartbeat interval if heartbeatinterval is configured (> 0).
     * Clears any existing heartbeat interval first to avoid duplicates.
     * Runs on a fixed wall-clock schedule, unaffected by pause, resume,
     * adjusttime, settime, or threshold actions. Fires while running AND
     * while paused. Only stopped explicitly when the timer stops or expires.
     * Each tick triggers a QUERY event (output 3) with source "internal",
     * carrying a full status snapshot - the consumer can read timerState
     * from that snapshot to tell whether the tick landed while running or
     * paused.
     */
    function startHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (node.heartbeatinterval > 0) {
        const intervalMS = convertToMilliseconds(
          node.heartbeatinterval,
          node.heartbeatintervalunits,
        );
        if (intervalMS > 0) {
          heartbeatTimer = setInterval(function () {
            dispatchEvent(
              TIMER_EVENT.QUERY,
              originalMsg,
              false,
              EVENT_SOURCE.INTERNAL,
            );
          }, intervalMS);
        }
      }
    }

    /**
     * Stops the heartbeat interval. Called when the timer stops or expires.
     */
    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function startTimeout(msg) {
      actualDelayRemaining = delayRemainingDisplay;
      if (actualDelayRemaining > maxTimeout) {
        actualDelayInUse = maxTimeout;
        actualDelayRemaining = actualDelayRemaining - maxTimeout;
      } else {
        actualDelayInUse = actualDelayRemaining;
        actualDelayRemaining = 0;
      }
      timeout = setTimeout(timerElapsed, actualDelayInUse, msg);
    }

    /**
     * Drives the node's status label only. This no longer produces any
     * output message - periodic "time remaining" reporting on an output was
     * replaced by the query output (manual query or heartbeat tick). The
     * adaptive every-minute-then-every-second cadence is retained purely
     * for the on-canvas status display.
     */
    function startReporting() {
      if (reporting === REPORTING.NONE) {
        node.status(
          buildStatus(
            displayTime(delayRemainingDisplay, reportingformat),
            TIMER_STATE.RUNNING,
          ),
        );
        return;
      }

      node.status(
        buildStatus(
          displayTime(delayRemainingDisplay, reportingformat),
          TIMER_STATE.RUNNING,
        ),
      );

      if (
        delayRemainingDisplay > 60000 &&
        reporting === REPORTING.LAST_MINUTE_SECONDS
      ) {
        miniTimeout = setTimeout(function () {
          if (delayRemainingDisplay % 60000 !== 0) {
            delayRemainingDisplay -= delayRemainingDisplay % 60000;
            node.status(
              buildStatus(
                displayTime(delayRemainingDisplay, reportingformat),
                TIMER_STATE.RUNNING,
              ),
            );
          }

          if (delayRemainingDisplay <= 60000) {
            countdown = setInterval(function () {
              delayRemainingDisplay -= 1000;
              node.status(
                buildStatus(
                  displayTime(delayRemainingDisplay, reportingformat),
                  TIMER_STATE.RUNNING,
                ),
              );
            }, 1000);
          } else {
            countdown = setInterval(function () {
              if (delayRemainingDisplay > 60000) {
                delayRemainingDisplay -= 60000;
                node.status(
                  buildStatus(
                    displayTime(delayRemainingDisplay, reportingformat),
                    TIMER_STATE.RUNNING,
                  ),
                );
              }
              if (delayRemainingDisplay <= 60000) {
                clearInterval(countdown);
                countdown = null;
                countdown = setInterval(function () {
                  delayRemainingDisplay -= 1000;
                  node.status(
                    buildStatus(
                      displayTime(delayRemainingDisplay, reportingformat),
                      TIMER_STATE.RUNNING,
                    ),
                  );
                }, 1000);
              }
            }, 60000);
          }
          miniTimeout = null;
        }, delayRemainingDisplay % 60000);
      } else {
        countdown = setInterval(function () {
          delayRemainingDisplay -= 1000;
          node.status(
            buildStatus(
              displayTime(delayRemainingDisplay, reportingformat),
              TIMER_STATE.RUNNING,
            ),
          );
        }, 1000);
      }
    }

    // -------------------------------------------------------------------------
    // Cooldown management
    // -------------------------------------------------------------------------

    /**
     * Clears every cooldown-specific timer handle. Deliberately separate
     * from clearAllTimers() - a cooldown in progress must never be
     * interrupted by the normal timer's own timeout/countdown handling.
     */
    function clearCooldownTimers() {
      clearTimeout(cooldownTimeout);
      clearInterval(cooldownReportInterval);
      clearTimeout(cooldownReportMiniTimeout);
      cooldownTimeout = null;
      cooldownReportInterval = null;
      cooldownReportMiniTimeout = null;
    }

    /**
     * Begins a cooldown period following a natural expiry. Only ever called
     * right after TIMER_EVENT.EXPIRED has been dispatched. Heartbeat is left
     * running uninterrupted (it fires regardless of running/paused/cooldown
     * state) rather than being stopped and restarted.
     */
    function startCooldown(baseMsg) {
      const cooldownMS = convertToMilliseconds(
        node.cooldownduration,
        node.cooldownunits,
      );
      if (cooldownMS <= 0) return; // cooldown disabled - caller handles true idle expiry

      cooldownActive = true;
      cooldownRemainingDisplay = cooldownMS;
      cooldownExpiryTarget = Date.now() + cooldownMS;
      timerState = TIMER_STATE.COOLDOWN;
      writeState(baseMsg);
      node.status(
        buildStatus(
          displayTime(cooldownRemainingDisplay, reportingformat),
          TIMER_STATE.COOLDOWN,
        ),
      );
      dispatchEvent(
        TIMER_EVENT.COOLDOWNSTARTED,
        baseMsg,
        false,
        EVENT_SOURCE.INTERNAL,
      );
      startCooldownTimeout();
      startCooldownReporting();
    }

    function startCooldownTimeout() {
      actualCooldownDelayRemaining = cooldownRemainingDisplay;
      if (actualCooldownDelayRemaining > maxTimeout) {
        actualCooldownDelayInUse = maxTimeout;
        actualCooldownDelayRemaining =
          actualCooldownDelayRemaining - maxTimeout;
      } else {
        actualCooldownDelayInUse = actualCooldownDelayRemaining;
        actualCooldownDelayRemaining = 0;
      }
      cooldownTimeout = setTimeout(cooldownElapsed, actualCooldownDelayInUse);
    }

    /**
     * Drives the cooldown status label only, same adaptive
     * every-minute-then-every-second cadence as startReporting(), kept as a
     * separate implementation so it never shares timer handles with the
     * main countdown.
     */
    function startCooldownReporting() {
      if (reporting === REPORTING.NONE) {
        node.status(
          buildStatus(
            displayTime(cooldownRemainingDisplay, reportingformat),
            TIMER_STATE.COOLDOWN,
          ),
        );
        return;
      }

      node.status(
        buildStatus(
          displayTime(cooldownRemainingDisplay, reportingformat),
          TIMER_STATE.COOLDOWN,
        ),
      );

      if (
        cooldownRemainingDisplay > 60000 &&
        reporting === REPORTING.LAST_MINUTE_SECONDS
      ) {
        cooldownReportMiniTimeout = setTimeout(function () {
          if (cooldownRemainingDisplay % 60000 !== 0) {
            cooldownRemainingDisplay -= cooldownRemainingDisplay % 60000;
            node.status(
              buildStatus(
                displayTime(cooldownRemainingDisplay, reportingformat),
                TIMER_STATE.COOLDOWN,
              ),
            );
          }

          if (cooldownRemainingDisplay <= 60000) {
            cooldownReportInterval = setInterval(function () {
              cooldownRemainingDisplay -= 1000;
              node.status(
                buildStatus(
                  displayTime(cooldownRemainingDisplay, reportingformat),
                  TIMER_STATE.COOLDOWN,
                ),
              );
            }, 1000);
          } else {
            cooldownReportInterval = setInterval(function () {
              if (cooldownRemainingDisplay > 60000) {
                cooldownRemainingDisplay -= 60000;
                node.status(
                  buildStatus(
                    displayTime(cooldownRemainingDisplay, reportingformat),
                    TIMER_STATE.COOLDOWN,
                  ),
                );
              }
              if (cooldownRemainingDisplay <= 60000) {
                clearInterval(cooldownReportInterval);
                cooldownReportInterval = null;
                cooldownReportInterval = setInterval(function () {
                  cooldownRemainingDisplay -= 1000;
                  node.status(
                    buildStatus(
                      displayTime(cooldownRemainingDisplay, reportingformat),
                      TIMER_STATE.COOLDOWN,
                    ),
                  );
                }, 1000);
              }
            }, 60000);
          }
          cooldownReportMiniTimeout = null;
        }, cooldownRemainingDisplay % 60000);
      } else {
        cooldownReportInterval = setInterval(function () {
          cooldownRemainingDisplay -= 1000;
          node.status(
            buildStatus(
              displayTime(cooldownRemainingDisplay, reportingformat),
              TIMER_STATE.COOLDOWN,
            ),
          );
        }, 1000);
      }
    }

    /**
     * Fires when the cooldown period completes naturally. Settles back into
     * TIMER_STATE.EXPIRED (idle) - this does NOT re-fire TIMER_EVENT.EXPIRED,
     * since expiry was already reported once when the original countdown
     * hit zero. Only COOLDOWNENDED is dispatched.
     */
    function cooldownElapsed() {
      if (actualCooldownDelayRemaining === 0) {
        clearCooldownTimers();
        cooldownActive = false;
        cooldownRemainingDisplay = 0;
        cooldownExpiryTarget = null;
        timerState = TIMER_STATE.EXPIRED;
        stopHeartbeat();
        deleteState();
        node.status(buildStatus(null, TIMER_STATE.EXPIRED));
        dispatchEvent(
          TIMER_EVENT.COOLDOWNENDED,
          originalMsg,
          false,
          EVENT_SOURCE.INTERNAL,
        );
        return;
      } else if (actualCooldownDelayRemaining > maxTimeout) {
        actualCooldownDelayInUse = maxTimeout;
        actualCooldownDelayRemaining -= maxTimeout;
      } else {
        actualCooldownDelayInUse = actualCooldownDelayRemaining;
        actualCooldownDelayRemaining = 0;
      }
      cooldownTimeout = setTimeout(cooldownElapsed, actualCooldownDelayInUse);
    }

    // -------------------------------------------------------------------------
    // Threshold action handler
    // -------------------------------------------------------------------------

    /**
     * Fires automatically when the ignored-message count reaches the
     * configured threshold. Every action here is internally-sourced
     * (EVENT_SOURCE.INTERNAL) since nothing external directly triggered it -
     * it is a side effect of the ignored-message count, not a new incoming
     * command. All actions here genuinely alter timer state (ignored:false),
     * except WARNING, which is a deliberate no-state-change notification and
     * is therefore also ignored:false (it is not a blocked/declined action -
     * it did exactly what it was meant to do).
     */
    function handleThresholdAction() {
      // Threshold logic is scoped to an active run (running or paused) only.
      // From an idle state (stopped/expired/cooldown) there is no run to
      // stop, pause, restart, or extend - firing an action from idle could
      // even START the timer (Add Time / Restart Timer), defeating the very
      // block that produced the ignored count. Blocked idle starts are still
      // counted and individually observable on output 4; they just never
      // trip an action.
      if (!timerRunning && !paused) return;
      if (
        node.thresholdaction === THRESHOLD_ACTION.DONOTHING ||
        node.thresholdcount <= 0
      )
        return;
      if (ignoredCount % node.thresholdcount !== 0) return;

      switch (node.thresholdaction) {
        case THRESHOLD_ACTION.STOP: {
          const stopFinalElapsed = getElapsedTime(); // snapshot before the state flips to idle
          timerRunning = false;
          timerState = TIMER_STATE.STOPPED;
          stopped = true;
          expiryTarget = null;
          frozenRemaining = null;
          frozenElapsed = null;
          clearAllTimers();
          stopHeartbeat();
          deleteState();
          ignoredCount = 0;
          lastIgnoredTime = null;
          node.status(buildStatus(null, TIMER_STATE.STOPPED));
          dispatchEvent(
            TIMER_EVENT.STOPPED,
            originalMsg,
            false,
            EVENT_SOURCE.INTERNAL,
            { elapsedTime: stopFinalElapsed },
          );
          break;
        }

        case THRESHOLD_ACTION.PAUSE:
          if (timerRunning) {
            // Same ordering rule as the pause command: capture the exact
            // remaining and elapsed time while still in the running state.
            frozenRemaining = getRemainingTime();
            frozenElapsed = getElapsedTime();
            delayRemainingDisplay = frozenRemaining;
            timerRunning = false;
            timerState = TIMER_STATE.PAUSED;
            paused = true;
            expiryTarget = null;
            clearAllTimers();
            writeState(originalMsg);
            ignoredCount = 0;
            lastIgnoredTime = null;
            node.status(
              buildStatus(
                displayTime(delayRemainingDisplay, reportingformat),
                TIMER_STATE.PAUSED,
              ),
            );
            dispatchEvent(
              TIMER_EVENT.PAUSED,
              originalMsg,
              false,
              EVENT_SOURCE.INTERNAL,
            );
          }
          break;

        case THRESHOLD_ACTION.RESET:
          clearAllTimers();
          delayRemainingDisplay = timerDuration;
          if (paused) {
            frozenRemaining = timerDuration;
            frozenElapsed = 0; // full reset: nothing of the fresh run has elapsed yet
          } else {
            expiryTarget = Date.now() + timerDuration;
          }
          timerStartTime = new Date();
          ignoredCount = 0;
          lastIgnoredTime = null;
          writeState(originalMsg);
          if (paused) {
            node.status(
              buildStatus(
                displayTime(delayRemainingDisplay, reportingformat),
                TIMER_STATE.PAUSED,
              ),
            );
            dispatchEvent(
              TIMER_EVENT.RESTARTED,
              originalMsg,
              false,
              EVENT_SOURCE.INTERNAL,
            );
          } else {
            timerState = TIMER_STATE.RUNNING;
            timerRunning = true;
            dispatchEvent(
              TIMER_EVENT.RESTARTED,
              originalMsg,
              false,
              EVENT_SOURCE.INTERNAL,
            );
            startTimeout(originalMsg);
            startReporting();
          }
          break;

        case THRESHOLD_ACTION.ADDTIME: {
          const addTimeMS = convertToMilliseconds(
            node.thresholdaddtime,
            node.thresholdaddtimeunits,
          );
          // Read the true remaining time BEFORE any mutation - the display
          // counter may not have decremented at all with reporting off.
          const addTimeNewRemaining = getRemainingTime() + addTimeMS;
          clearAllTimers();
          delayRemainingDisplay = addTimeNewRemaining;
          if (paused) {
            frozenRemaining = addTimeNewRemaining;
          } else {
            expiryTarget = Date.now() + addTimeNewRemaining;
          }
          ignoredCount = 0;
          lastIgnoredTime = null;
          writeState(originalMsg);
          dispatchEvent(
            TIMER_EVENT.TIMEADJUSTED,
            originalMsg,
            false,
            EVENT_SOURCE.INTERNAL,
            { timeAdjusted: addTimeMS },
          );
          if (paused) {
            node.status(
              buildStatus(
                displayTime(delayRemainingDisplay, reportingformat),
                TIMER_STATE.PAUSED,
              ),
            );
          } else {
            timerState = TIMER_STATE.RUNNING;
            timerRunning = true;
            startTimeout(originalMsg);
            startReporting();
          }
          break;
        }

        case THRESHOLD_ACTION.WARNING:
          dispatchEvent(
            TIMER_EVENT.WARNING,
            originalMsg,
            false,
            EVENT_SOURCE.INTERNAL,
          );
          break;
      }
    }

    // -------------------------------------------------------------------------
    // Input event handler
    // -------------------------------------------------------------------------

    function handleInputEvent(msg, isRestore) {
      // INVARIANT: every exit path from this function must set the node
      // status itself. There is deliberately no blanket node.status({})
      // here - the old unconditional blank made every incoming message
      // (including a side-effect-free query) visibly flicker the status
      // label before the handler repainted it. All current paths set their
      // own status; a new handler that forgets will leave the PREVIOUS
      // label lingering rather than a blank, so set it explicitly.

      const msgPayload =
        typeof msg.payload === "string"
          ? msg.payload.toLowerCase()
          : msg.payload;
      const msgUnits = normalizeUnits(msg.units);
      const msgSource = isRestore
        ? EVENT_SOURCE.INTERNAL
        : EVENT_SOURCE.EXTERNAL;

      reporting = node.reporting;
      reportingformat = node.reportingformat;

      // -- Query -----------------------------------------------------------
      if (msgPayload === PAYLOAD.QUERY) {
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.QUERY, msg, false, msgSource);
        return;
      }

      // -- Redundant Stop ----------------------------------------------------
      // A stop while truly idle (stopped/expired) is redundant - there is
      // nothing alive to kill - so like every other redundant command it is
      // ignored:true on output 4 with ZERO state change: no counter touch,
      // no expired -> stopped flip, and (deliberately, per design decision)
      // no arming of the _timerpass filter. Stop remains fully genuine
      // whenever something is alive: running, paused, or cooldown ("still
      // the timer running, in a sense").
      if (
        msgPayload === PAYLOAD.STOP &&
        !timerRunning &&
        !paused &&
        !cooldownActive
      ) {
        // The _timerpass swallow is unrelated to this rule and is preserved
        // exactly: an armed node still silently absorbs _timerpass-tagged
        // messages, stop included.
        if (
          stopped === true &&
          msg._timerpass === true &&
          node.ignoretimerpass !== true
        ) {
          node.status({ fill: "red", shape: "ring", text: "stopped" });
          return;
        }
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.STOPPED, msg, true, msgSource);
        return;
      }

      // -- Disable ---------------------------------------------------------
      if (msgPayload === PAYLOAD.DISABLE) {
        if (disabled) {
          // Redundant command: no state change and (harmonized with every
          // other redundant command) no ignored-count bookkeeping.
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.DISABLED, msg, true, msgSource);
          return;
        }
        disabled = true;
        writeState(originalMsg);
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.DISABLED, msg, false, msgSource);
        return;
      }

      // -- Enable ----------------------------------------------------------
      if (msgPayload === PAYLOAD.ENABLE) {
        if (!disabled) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.ENABLED, msg, true, msgSource);
          return;
        }
        disabled = false;
        writeState(originalMsg);
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.ENABLED, msg, false, msgSource);
        return;
      }

      // -- Lock ------------------------------------------------------------
      if (msgPayload === PAYLOAD.LOCK) {
        if (node.donotresettimer) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.LOCKED, msg, true, msgSource);
          return;
        }
        node.donotresettimer = true;
        ignoredCount = 0;
        lastIgnoredTime = null;
        writeState(originalMsg);
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.LOCKED, msg, false, msgSource);
        return;
      }

      // -- Unlock ----------------------------------------------------------
      if (msgPayload === PAYLOAD.UNLOCK) {
        if (!node.donotresettimer) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.UNLOCKED, msg, true, msgSource);
          return;
        }
        node.donotresettimer = false;
        ignoredCount = 0;
        lastIgnoredTime = null;
        writeState(originalMsg);
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.UNLOCKED, msg, false, msgSource);
        return;
      }

      // -- Adjust Time -----------------------------------------------------
      if (msgPayload === PAYLOAD.ADJUSTTIME) {
        const adjustUnits = normalizeUnits(msg.adjusttimeunits);
        const adjustRaw = toFiniteNumber(msg.adjusttime);
        // A missing or non-numeric msg.adjusttime is rejected outright -
        // Math.max(0, NaN) is NaN, which used to silently corrupt the
        // remaining time. The attempted raw value rides along so a
        // downstream consumer can see what was rejected.
        if (!Number.isFinite(adjustRaw)) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.TIMEADJUSTED, msg, true, msgSource, {
            timeAdjusted: msg.adjusttime !== undefined ? msg.adjusttime : null,
          });
          return;
        }
        const adjustMS = msgValueToMs(adjustRaw, adjustUnits);
        if (timerRunning || paused) {
          const newRemaining = Math.max(0, getRemainingTime() + adjustMS);
          delayRemainingDisplay = newRemaining;
          if (paused) {
            frozenRemaining = newRemaining;
          } else {
            expiryTarget = Date.now() + newRemaining;
          }
          writeState(originalMsg);
          if (paused) {
            node.status(
              buildStatus(
                displayRemaining(reportingformat),
                TIMER_STATE.PAUSED,
              ),
            );
          } else {
            clearAllTimers();
            startTimeout(originalMsg);
            startReporting();
          }
          dispatchEvent(TIMER_EVENT.TIMEADJUSTED, msg, false, msgSource, {
            timeAdjusted: adjustMS,
          });
        } else {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.TIMEADJUSTED, msg, true, msgSource, {
            timeAdjusted: adjustMS,
          });
        }
        return;
      }

      // -- Set Time --------------------------------------------------------
      if (msgPayload === PAYLOAD.SETTIME) {
        const setUnits = normalizeUnits(msg.settimeunits);
        const setRaw = toFiniteNumber(msg.settime);
        // NaN <= 0 is false, so NaN used to pass the positive-value check
        // below as "valid" and corrupt the remaining time. Reject non-finite
        // values first, carrying the attempted raw value.
        if (!Number.isFinite(setRaw)) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.TIMESET, msg, true, msgSource, {
            timeSet: msg.settime !== undefined ? msg.settime : null,
          });
          return;
        }
        const setMS = msgValueToMs(setRaw, setUnits);
        if (timerRunning || paused) {
          if (setMS <= 0) {
            node.status(
              buildStatus(displayRemaining(reportingformat), timerState),
            );
            dispatchEvent(TIMER_EVENT.TIMESET, msg, true, msgSource, {
              timeSet: setMS,
            });
            return;
          }
          delayRemainingDisplay = setMS;
          if (paused) {
            frozenRemaining = setMS;
          } else {
            expiryTarget = Date.now() + setMS;
          }
          writeState(originalMsg);
          if (paused) {
            node.status(
              buildStatus(
                displayRemaining(reportingformat),
                TIMER_STATE.PAUSED,
              ),
            );
          } else {
            clearAllTimers();
            startTimeout(originalMsg);
            startReporting();
          }
          dispatchEvent(TIMER_EVENT.TIMESET, msg, false, msgSource, {
            timeSet: setMS,
          });
        } else {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.TIMESET, msg, true, msgSource, {
            timeSet: setMS,
          });
        }
        return;
      }

      // -- Set Duration ----------------------------------------------------
      if (msgPayload === PAYLOAD.SETDURATION) {
        const durUnits = normalizeUnits(msg.setdurationunits);
        const durRaw = toFiniteNumber(msg.setduration);
        // Same NaN <= 0 hole as settime, but worse: a NaN stored in
        // overrideDuration would poison the NEXT run, not just this one.
        if (!Number.isFinite(durRaw)) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.DURATIONSET, msg, true, msgSource, {
            durationSet: msg.setduration !== undefined ? msg.setduration : null,
          });
          return;
        }
        const durMS = msgValueToMs(durRaw, durUnits);
        if (durMS <= 0) {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.DURATIONSET, msg, true, msgSource, {
            durationSet: durMS,
          });
          return;
        }
        overrideDuration = durMS;
        writeState(originalMsg);
        node.status(buildStatus(displayRemaining(reportingformat), timerState));
        dispatchEvent(TIMER_EVENT.DURATIONSET, msg, false, msgSource, {
          durationSet: durMS,
        });
        return;
      }

      // -- Pause -----------------------------------------------------------
      if (msgPayload === PAYLOAD.PAUSE) {
        if (paused) {
          node.status(
            buildStatus(displayRemaining(reportingformat), TIMER_STATE.PAUSED),
          );
          dispatchEvent(TIMER_EVENT.PAUSED, msg, true, msgSource);
          return;
        }
        if (timerRunning) {
          // Capture the exact remaining AND elapsed time BEFORE flipping
          // state - both getters read live wall-clock values only while
          // running.
          frozenRemaining = getRemainingTime();
          frozenElapsed = getElapsedTime();
          delayRemainingDisplay = frozenRemaining; // keep the display counter in step for the paused label
          clearAllTimers();
          paused = true;
          timerRunning = false;
          timerState = TIMER_STATE.PAUSED;
          expiryTarget = null;
          writeState(originalMsg);
          node.status(
            buildStatus(displayRemaining(reportingformat), TIMER_STATE.PAUSED),
          );
          dispatchEvent(TIMER_EVENT.PAUSED, msg, false, msgSource);
        } else {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.PAUSED, msg, true, msgSource);
        }
        return;
      }

      // -- Resume ----------------------------------------------------------
      if (msgPayload === PAYLOAD.RESUME) {
        if (paused) {
          // Resume from the exact frozen snapshot, not the display counter
          // (which is stale when Status Reporting is "none").
          delayRemainingDisplay = getRemainingTime(); // startTimeout() and the label both read this
          paused = false;
          timerRunning = true;
          timerState = TIMER_STATE.RUNNING;
          expiryTarget = Date.now() + delayRemainingDisplay;
          frozenRemaining = null;
          frozenElapsed = null;
          timerStartTime = new Date(
            new Date().getTime() - (timerDuration - delayRemainingDisplay),
          );
          writeState(originalMsg);
          dispatchEvent(TIMER_EVENT.RESUMED, msg, false, msgSource);
          startTimeout(originalMsg);
          startReporting();
        } else {
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.RESUMED, msg, true, msgSource);
        }
        return;
      }

      // -- Paused gate -------------------------------------------------------
      // Any other message arriving while paused (other than stop) is blocked.
      // The intent of a plain message is to (re)start the timer, but since the
      // timer is already active (paused, not idle), it is a blocked RESTART,
      // not a blocked START.
      if (paused && msgPayload !== PAYLOAD.STOP) {
        ignoredCount++;
        lastIgnoredTime = new Date();
        node.status(
          buildStatus(displayRemaining(reportingformat), TIMER_STATE.PAUSED),
        );
        dispatchEvent(TIMER_EVENT.RESTARTED, msg, true, msgSource);
        handleThresholdAction();
        return;
      }

      // -- _timerpass gate -------------------------------------------------
      if (
        stopped === false ||
        msg._timerpass !== true ||
        node.ignoretimerpass === true
      ) {
        // -- donotresettimer gate --------------------------------------------
        // Same reasoning as the paused gate above: the timer is already
        // running, so a blocked message here is a blocked RESTART.
        if (
          node.donotresettimer &&
          timerRunning &&
          msgPayload !== PAYLOAD.STOP &&
          msg._timerpass !== true
        ) {
          ignoredCount++;
          lastIgnoredTime = new Date();
          node.status(
            buildStatus(displayRemaining(reportingformat), TIMER_STATE.RUNNING),
          );
          dispatchEvent(TIMER_EVENT.RESTARTED, msg, true, msgSource);
          handleThresholdAction();
          return;
        }

        stopped = false;
        // Snapshot elapsed BEFORE the shared paused-flag clear below - a
        // stop arriving while paused must report the frozen elapsed value,
        // and getElapsedTime() can no longer see it once paused is false.
        const preStopElapsed = getElapsedTime();
        paused = false;
        clearAllTimers();

        // -- Stop ----------------------------------------------------------
        if (msgPayload === PAYLOAD.STOP) {
          // preStopElapsed (captured above, before the paused flag was
          // cleared) is the run's final elapsed value: the frozen snapshot
          // if stopping from pause, wall-clock elapsed if running, or time
          // into the cooldown period if cancelling a cooldown. The stopped
          // event carries it - information available nowhere else once the
          // run dies.
          const finalElapsed = preStopElapsed;
          // An explicit stop always cancels an in-progress cooldown too -
          // it's the one way to cut a cooldown short.
          clearCooldownTimers();
          cooldownActive = false;
          cooldownExpiryTarget = null;
          timerRunning = false;
          timerState = TIMER_STATE.STOPPED;
          stopped = true;
          expiryTarget = null;
          frozenRemaining = null;
          frozenElapsed = null;
          stopHeartbeat();
          deleteState();
          ignoredCount = 0;
          lastIgnoredTime = null;
          node.status(buildStatus(null, TIMER_STATE.STOPPED));
          dispatchEvent(TIMER_EVENT.STOPPED, msg, false, msgSource, {
            elapsedTime: finalElapsed,
          });
          return;
        }

        // -- Disabled / Cooldown gate -----------------------------------------
        // The timer is currently idle (stopped/expired/cooldown), so a
        // blocked message here is a blocked true START. disabled and
        // cooldownActive are independent blocking conditions - either one
        // blocks a new start. Threshold actions never fire from here:
        // threshold logic is scoped to an active run (running or paused),
        // enforced centrally by the guard in handleThresholdAction(). The
        // ignored count still increments for status/envelope visibility.
        if ((disabled || cooldownActive) && !isRestore) {
          ignoredCount++;
          lastIgnoredTime = new Date();
          node.status(
            buildStatus(displayRemaining(reportingformat), timerState),
          );
          dispatchEvent(TIMER_EVENT.STARTED, msg, true, msgSource);
          return;
        }

        // -- Start / Restart -----------------------------------------------
        const wasRunning = timerRunning;

        msg._timerpass = true;

        if (msgUnits !== null) {
          switch (msgUnits) {
            case UNITS_INPUT.MILLISECOND:
              delayFactor = 1;
              break;
            case UNITS_INPUT.SECOND:
              delayFactor = 1000;
              break;
            case UNITS_INPUT.MINUTE:
              delayFactor = 1000 * 60;
              break;
            case UNITS_INPUT.HOUR:
              delayFactor = 1000 * 60 * 60;
              break;
            default:
              node.warn(
                "Unknown units in message, using node default: " + node.units,
              );
              delayFactor = convertToMilliseconds(1, node.units);
          }
        } else {
          delayFactor = convertToMilliseconds(1, node.units);
        }

        // Documented msg.delay behavior: an unconvertible value falls back
        // to the configured duration; a negative value is clamped to 0.
        // The old guard used parseInt while the math used the raw value, so
        // "5s" passed the guard but multiplied to NaN. Validate and compute
        // with the SAME numeric value. Fractional delays (e.g. 2.5 minutes)
        // remain supported.
        const msgDelay = msg.delay != null ? toFiniteNumber(msg.delay) : NaN;
        if (Number.isFinite(msgDelay)) {
          delayRemainingDisplay = Math.max(0, msgDelay) * delayFactor;
        } else {
          delayRemainingDisplay =
            overrideDuration !== null ? overrideDuration : node.duration;
          overrideDuration = null;
        }

        // Fresh-run identity resets. Skipped on a persisted restore
        // (isRestore) - a restore is a CONTINUATION of the interrupted run,
        // not a new one, so the run's original timerDuration, its
        // back-calculated timerStartTime, and its accumulated
        // ignoredCount / lastIgnoredTime (all placed by the restore block
        // before this call) survive. Only the output-1 Start event treats
        // it as a start, for downstream consumers' benefit.
        if (!isRestore) {
          ignoredCount = 0;
          lastIgnoredTime = null;
          timerStartTime = new Date();
          timerDuration = delayRemainingDisplay;
        }
        timerRunning = true;
        timerState = TIMER_STATE.RUNNING;
        expiryTarget = Date.now() + delayRemainingDisplay;
        frozenRemaining = null;
        frozenElapsed = null;
        originalMsg = msg;

        writeState(msg);

        if (wasRunning) {
          dispatchEvent(TIMER_EVENT.RESTARTED, msg, false, msgSource);
        } else {
          dispatchEvent(TIMER_EVENT.STARTED, msg, false, msgSource);
        }

        startTimeout(msg);
        startReporting();
        startHeartbeat();
      } else {
        node.status({ fill: "red", shape: "ring", text: "stopped" });
      }
    }

    // -------------------------------------------------------------------------
    // Timer elapsed handler
    // -------------------------------------------------------------------------

    function timerElapsed(msg) {
      if (actualDelayRemaining === 0) {
        // Snapshot the run's final elapsed value while still running -
        // reported on the expired event, since getElapsedTime correctly
        // returns 0 once the state is idle. With mid-run adjustments this
        // is the true wall-clock run length, which may differ from
        // timerDuration.
        const finalElapsed = getElapsedTime();
        clearInterval(countdown);
        timerRunning = false;
        timerState = TIMER_STATE.EXPIRED;
        expiryTarget = null;
        delayRemainingDisplay = 0; // Ensure remainingTime is correctly 0 on expiry
        node.status(buildStatus(null, TIMER_STATE.EXPIRED));

        if (stopped === false) {
          ignoredCount = 0;
          lastIgnoredTime = null;
          // Expiry is never externally triggered - it is always the node's
          // own clock reaching zero.
          dispatchEvent(
            TIMER_EVENT.EXPIRED,
            msg,
            false,
            EVENT_SOURCE.INTERNAL,
            { elapsedTime: finalElapsed },
          );

          // If a cooldown is configured, transition into it now - heartbeat
          // is left running uninterrupted throughout. Otherwise this is a
          // true idle expiry: stop the heartbeat and clear persisted state.
          startCooldown(msg);
          if (!cooldownActive) {
            stopHeartbeat();
            deleteState();
          }
          return;
        }
        stopHeartbeat();
        timeout = null;
        countdown = null;
        miniTimeout = null;
      } else if (actualDelayRemaining > maxTimeout) {
        actualDelayInUse = maxTimeout;
        actualDelayRemaining -= maxTimeout;
      } else {
        actualDelayInUse = actualDelayRemaining;
        actualDelayRemaining = 0;
      }
      timeout = setTimeout(timerElapsed, actualDelayInUse, msg);
    }

    // -------------------------------------------------------------------------
    // Display time formatter
    // -------------------------------------------------------------------------

    function displayTime(delayToDisplay, reportingformat) {
      // THE display boundary: every status label flows through here, and
      // nothing else does (message envelopes carry raw ms; timing never
      // reads formatted values). Rounding to whole seconds at this single
      // choke point guarantees no label ever shows fractional seconds -
      // e.g. the exact frozen value restored on resume (35221ms) displays
      // as 35, not 35.221.
      delayToDisplay = Math.round(delayToDisplay / 1000);
      switch (reportingformat) {
        case REPORTING_FORMAT.SECONDS:
          return delayToDisplay;
        case REPORTING_FORMAT.MINUTES:
          return delayToDisplay / 60;
        case REPORTING_FORMAT.HOURS:
          return delayToDisplay / 3600;
        default: {
          const hours = String(Math.floor(delayToDisplay / 3600)).padStart(
            2,
            "0",
          );
          delayToDisplay %= 3600;
          const minutes = String(Math.floor(delayToDisplay / 60)).padStart(
            2,
            "0",
          );
          const seconds = String(delayToDisplay % 60).padStart(2, "0");
          return hours + ":" + minutes + ":" + seconds;
        }
      }
    }

    // -------------------------------------------------------------------------
    // Persist helpers
    // -------------------------------------------------------------------------

    function writeState(msg) {
      if (node.persist !== true) return;
      try {
        if (!fs.existsSync(path.dirname(stvdtimersFile))) {
          fs.mkdirSync(path.dirname(stvdtimersFile), { recursive: true });
        }
        const target = new Date(Date.now() + getRemainingTime()).toISOString();
        fs.writeFileSync(
          stvdtimersFile,
          JSON.stringify(
            JSON.decycle({
              reporting: node.reporting,
              reportingformat: node.reportingformat,
              time: target,
              // Frozen snapshots, written only while paused. The `time` target
              // above is correct for states that live in wall-clock terms
              // (running, cooldown) but wrong for a frozen pause - computing
              // target-minus-now on restore would silently deduct Node-RED
              // downtime from a timer that is supposed to be frozen. The paused
              // restore reads these directly; old persist files without them
              // fall back to the legacy target-based calculation.
              remaining: paused ? frozenRemaining : null,
              frozenElapsed: paused ? frozenElapsed : null,
              origmsg: msg !== null ? msg : {},
              paused: paused,
              timerDuration: timerDuration,
              timerStartTime: timerStartTime
                ? timerStartTime.toISOString()
                : null,
              timerState: timerState,
              ignoredCount: ignoredCount,
              lastIgnoredTime: lastIgnoredTime
                ? lastIgnoredTime.toISOString()
                : null,
              donotresettimer: node.donotresettimer,
              overrideDuration: overrideDuration,
              disabled: disabled,
              cooldownActive: cooldownActive,
            }),
          ),
        );
      } catch (error) {
        node.error(
          "Error writing persistent file for timer-events node " +
            node.id.toString() +
            "\n\n" +
            error.toString(),
        );
      }
    }

    function readState() {
      try {
        const contents = fs.readFileSync(stvdtimersFile).toString();
        if (typeof contents !== "undefined") return contents;
      } catch (error) {
        node.error(
          "Error reading persistent file for timer-events node " +
            node.id.toString() +
            "\n\n" +
            error.toString(),
        );
      }
      return -1;
    }

    function deleteState() {
      try {
        if (fs.existsSync(stvdtimersFile)) fs.unlinkSync(stvdtimersFile);
      } catch (error) {
        node.error(
          "Error deleting persistent file for timer-events node " +
            node.id.toString() +
            "\n\n" +
            error.toString(),
        );
      }
    }
  }

  RED.nodes.registerType("timer-events", TimerEvents);
};
