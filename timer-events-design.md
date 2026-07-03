# timer-events — Design Document

## Overview

`timer-events` is a Node-RED countdown timer node derived from
`stoptimer-varidelay-plus`. It replaces that node's five loosely-purposed
outputs with four purpose-built ones, and introduces a consistent event
envelope (`ignored`, `source`) that lets every command — successful or
blocked — be traced from a single output.

The node has **1 input** and **4 outputs**:

| # | Label  | Fires on |
|---|--------|----------|
| 1 | Start  | A true `stopped`/`expired` → `running` transition. Nothing else. |
| 2 | Stop   | A genuine `stop` command, or natural expiry. Nothing else. |
| 3 | Query  | An incoming `query` message, or a Heartbeat tick. Nothing else. |
| 4 | Events | Every other event, plus a duplicate copy of every Start/Stop event. The only output where `msg.ignored` can be `true`. |

Outputs 1 and 2 **never** carry a blocked/ignored message — anything that
didn't truly happen only appears on output 4.

---

## Timer States (`msg.timerState`)

```
                 new message (start)
 stopped ─────────────────────────────────┐
 expired ──────────────────────────────┐  │
                                       ▼  ▼
                        ┌─ pause ──── running ────expire────┬─► expired
                        ▼               ▲                   │   (no cooldown
                     paused ── resume ──┘                   │    configured)
                                                            │
                                       (cooldown configured)└─► cooldown ──ends──► expired

 stop (genuine):    running │ paused │ cooldown  ──► stopped
 stop (redundant):  stopped │ expired            ──► no change (ignored:true, output 4 only)
 blocked start:     disabled or cooldown         ──► no change (ignored:true, output 4 only)
```

- `running` — actively counting down
- `paused` — countdown frozen at a fixed remaining time
- `stopped` — idle, reached via a genuine `stop` of something alive
  (a running timer, a paused timer, or an active cooldown)
- `expired` — idle, reached via the countdown naturally hitting zero (with
  no cooldown configured, or after a cooldown period ends). A `stop`
  received while already idle (`stopped` or `expired`) is **redundant** and
  does not change state — `expired` stays `expired`.
- `cooldown` — idle-but-blocked, a timed period following a natural expiry
  during which new starts are refused

---

## Message Envelope

Every output message is a **clone of the message that triggered it** (see
"originalMsg lineage" below), with these properties layered on top:

| Property | Description |
|---|---|
| `msg.timerEvent` | The event type (see table below) |
| `msg.timerState` | Current state: `running`, `paused`, `stopped`, `expired`, `cooldown` |
| `msg.remainingTime` | Remaining ms, per state: live wall-clock while `running`, frozen while `paused`, cooldown time left while in `cooldown`, `0` while idle |
| `msg.timerDuration` | Current run's total duration in ms (the original duration — mid-run `adjusttime`/`settime` do not redefine it, so `elapsedTime + remainingTime` may not equal it after an adjustment) |
| `msg.elapsedTime` | Elapsed ms, per state: wall-clock since run start while `running`, frozen at the moment of pause while `paused`, time *into* the cooldown period while in `cooldown` (so `elapsed + remaining ≈ cooldown duration`), `0` while idle. Exception: genuine `stopped`/`expired` events carry the run's **final** elapsed value, snapshotted just before the run ended |
| `msg.ignoredCount` | Number of messages ignored during the current run |
| `msg.lastIgnoredTime` | ISO 8601 timestamp of the last ignored message, or `null` |
| `msg.doNotResetTimer` | Current runtime lock state (boolean) |
| `msg.disabled` | Current disabled state (boolean) |
| `msg.ignored` | `true` if this message was received but did not change timer state. Always `false` on outputs 1, 2, 3. |
| `msg.source` | `"external"` (a live incoming message) or `"internal"` (heartbeat tick, threshold action, persisted restore) |

Event-specific extras (`timeAdjusted`, `timeSet`, `durationSet`) are added
only to the relevant event types.

---

## Event Type Taxonomy (`msg.timerEvent`)

| Event | Output(s) | Can be `ignored:true`? | `source` values |
|---|---|---|---|
| `started` | 1 + 4 | Yes, on 4 only (blocked start while disabled/cooldown) | external, internal |
| `restarted` | 4 only | Yes (blocked restart while paused/locked) | external, internal |
| `stopped` | 2 + 4 | Yes, on 4 only (redundant stop while idle: `stopped`/`expired`) | external, internal |
| `expired` | 2 + 4 | No | internal only |
| `paused` | 4 only | Yes | external, internal |
| `resumed` | 4 only | Yes | external |
| `locked` | 4 only | Yes | external |
| `unlocked` | 4 only | Yes | external |
| `disabled` | 4 only | Yes | external |
| `enabled` | 4 only | Yes | external |
| `timeadjusted` | 4 only | Yes | external, internal |
| `timeset` | 4 only | Yes | external |
| `durationset` | 4 only | Yes | external |
| `warning` | 4 only | No — deliberate, side-effect-free notification | internal only |
| `query` | 3 only | No | external, internal |
| `cooldownstarted` | 4 only | No | internal only |
| `cooldownended` | 4 only | No | internal only |

**Key design decision — Start vs. Restart:** `started` fires *only* on a
true `stopped`/`expired` → `running` transition. A new message arriving
while the timer is already running is a **restart**, not a start — it's
treated as a bigger sibling of `timeset` (same routing/labeling
philosophy), not a fresh start, and never touches output 1. A restart
still performs the old node's full state reset (ignored count, last
ignored time, timer start time) — it's just labeled/routed differently
than a manual `settime`.

**Key design decision — `ignored` vs. event identity:** rather than a
separate "ignored message" event category, `ignored` is a modifier on the
*real* event type that would have occurred. A blocked start is still
labeled `started` (with `ignored:true`); a blocked restart is still
labeled `restarted`. This means `msg.timerEvent` always tells you what was
*attempted*, and `msg.ignored` tells you whether it *took effect*.

---

## Control Commands (`msg.payload`, case-insensitive)

| Command | Effect |
|---|---|
| `stop` | Genuine whenever something is alive to kill: cancels a running or paused timer, or an in-progress Cooldown, immediately. While truly idle (`stopped`/`expired`) it is a **redundant command**: `ignored:true` on output 4, zero state change — no counter reset, no `expired`→`stopped` flip, no `_timerpass` arming. |
| `pause` | Freezes the countdown (running only) |
| `resume` | Restarts the countdown from the frozen point (paused only) |
| `query` | Returns a full snapshot on output 3, no side effects |
| `lock` | Enables Do Not Reset Timer at runtime |
| `unlock` | Disables Do Not Reset Timer at runtime |
| `disable` | Blocks new starts (current run continues) |
| `enable` | Re-allows new starts. Has no effect on an active Cooldown. |
| `adjusttime` | Adds/subtracts `msg.adjusttime` ms (running or paused only) |
| `settime` | Sets remaining time to `msg.settime` ms, must be positive (running or paused only) |
| `setduration` | Sets duration for future runs to `msg.setduration` ms, must be positive. Works in any state. |

**Numeric validation (`adjusttime`/`settime`/`setduration`):** a missing or
non-numeric value (`"abc"`, empty string, absent property, `±Infinity`) is
rejected as `ignored:true` with no state change. The attempted value rides
on `timeAdjusted`/`timeSet`/`durationSet`: the raw value when unconvertible,
`null` when the property was absent, converted ms for finite-but-invalid
values (e.g. `settime ≤ 0`). `adjusttime: 0` is a valid, successful no-op.
**`msg.delay`** is validated the same strict-numeric way (fractional values
supported): unconvertible → fall back to the configured duration; negative
→ clamped to 0 (fires immediately).

Any other message (no recognized command) starts or restarts the timer,
unless blocked (see gating rules below).

---

## Blocking / Gating Rules

Three independent conditions can block an incoming message. Each is
checked in this order and each produces an `ignored:true` event on output
4 (never output 1/2):

1. **Paused gate** — while `paused`, any message other than `stop` is a
   blocked `restarted` attempt.
2. **Do Not Reset Timer gate** — while `running` with the lock enabled,
   any message other than `stop` is a blocked `restarted` attempt.
3. **Disabled / Cooldown gate** — while idle (`stopped`/`expired`) and
   either `disabled` or in `cooldown`, any non-`stop` message is a blocked
   `started` attempt.

`disabled` and Cooldown are **fully independent** blocking conditions —
either one blocks a start regardless of the other, and toggling one has
no effect on the other. `enable` never cancels a Cooldown; only `stop`
does.

**Threshold actions** are scoped to an active run and enforced by a single
central guard in `handleThresholdAction()`: they can only fire while the
timer is `running` or `paused` — never from gate 3 (idle, whether blocked
by `disabled` or Cooldown). Blocked idle starts still increment the visible
ignored count, but that count can never trip an action; every true start
resets it to 0.

**Redundant commands never touch the counters.** A `lock` while locked, a
`disable` while disabled, a `stop` while idle, and every other
already-in-that-state command is `ignored:true` with zero side effects —
`ignoredCount`/`lastIgnoredTime` are reserved for genuinely *blocked*
actions (gates 1–3 above), not redundant ones.

---

## Authoritative Time Model

Remaining and elapsed time are computed from **wall-clock state**, never
from the display counters that drive the status label (those only tick
when Status Reporting is enabled, so with reporting off — the default —
they never decrement and must not be trusted).

| Variable | Meaning |
|---|---|
| `expiryTarget` | ms epoch timestamp the running timer will fire at; `null` when not running |
| `frozenRemaining` / `frozenElapsed` | exact snapshots captured at the moment of pause; `null` when not paused. Independent of each other: `settime` while paused changes `frozenRemaining` but not `frozenElapsed` |
| `cooldownExpiryTarget` | ms epoch timestamp the Cooldown ends at; `null` when not in cooldown |

Two getters are the sole read path — `getRemainingTime()` and
`getElapsedTime()` — each branching on state (running → live wall-clock;
paused → frozen snapshot; cooldown → cooldown-relative; idle → 0). Every
consumer (the message envelope, pause capture, persistence writes, status
labels) goes through them. Values are exact milliseconds; rounding to
whole seconds happens **only at the display boundary** (`displayRemaining()`
for the status label) — outgoing messages carry raw ms.

Snapshot ordering rule: pause (and any stop/expiry wanting the run's final
elapsed) must capture values **before** flipping state flags, since the
getters branch on those flags. The genuine `stopped`/`expired` events
attach the pre-flip snapshot via the dispatcher's `extraProps`.

`delayRemainingDisplay`/`cooldownRemainingDisplay` remain as display-only
counters for the reporting cadence, resynced from the getters at the
points where reporting (re)starts.

---

## Feature: Pause / Resume

- `pause` freezes the countdown at the current remaining time; the main
  timeout/countdown/miniTimeout handles are cleared, but the Heartbeat
  keeps ticking.
- `resume` recalculates `timerStartTime` from the frozen remaining time
  and restarts the countdown.
- Redundant or out-of-state attempts (`pause` while already paused,
  `pause` while not running, `resume` while not paused) are `ignored:true`
  events, no state change.

## Feature: Lock / Unlock

- `lock` / `unlock` toggle `donotresettimer` at runtime, independent of
  the node's configured default. Both reset `ignoredCount`/
  `lastIgnoredTime` to 0 on a genuine (non-redundant) change.
- A redundant lock/unlock (already in that state) is `ignored:true`.

## Feature: Disable / Enable

- `disable` blocks new starts only — the current run (including its
  Heartbeat) continues uninterrupted. Stop/pause/resume/query/lock/
  unlock/adjusttime/settime/setduration all still work while disabled.
- A blocked start while disabled is `started`/`ignored:true` (a blocked
  true start, not a restart, since the timer is idle).
- A redundant `disable`/`enable` (already in that state) is
  `ignored:true`.

## Feature: Time Adjustment Commands

- `adjusttime`/`settime` only take effect while `running` or `paused`.
  Outside those states, the command is `ignored:true` and the *attempted*
  value is still included on the message (`timeAdjusted`/`timeSet`) so a
  downstream consumer can see what was rejected.
- All three commands strictly validate their value: missing, non-numeric,
  or non-finite input is rejected as `ignored:true` with zero state change
  (previously `NaN` could corrupt the remaining time, or poison the next
  run via `setduration`'s `overrideDuration`). The attempted value on the
  rejection is the raw value when unconvertible, or `null` when absent.
- `settime` additionally requires a positive value; `≤ 0` is
  `ignored:true`. `adjusttime: 0` is a valid, successful no-op.
- `setduration` works in any state and only affects future runs; `≤ 0` is
  `ignored:true`. A valid value is always treated as a real change (no
  redundancy detection against the previous value).
- No `node.warn()` calls remain for any of these — the `ignored:true`
  output-4 event is the sole surfacing mechanism.

## Feature: Threshold Actions

When `donotresettimer` is enabled and the ignored-message count reaches a
configured threshold, one automatic action fires:

| Action | Behavior | Event emitted |
|---|---|---|
| Do Nothing (default) | No action, count increments indefinitely | — |
| Stop | Stops the timer | `stopped` (output 2 + 4) |
| Pause | Pauses the timer (only if running) | `paused` (output 4) |
| Restart Timer | Full reset to original duration, same effect as a message-triggered restart | `restarted` (output 4) |
| Add Time | Adds configured time to remaining | `timeadjusted` (output 4) |
| Emit Warning | No timer effect, pure notification | `warning` (output 4) |

All threshold-triggered events use `source: "internal"` and
`ignored: false` — Emit Warning is never `ignored:true` since it's a
deliberate, fully-successful notification, not a blocked action. For all
actions except Do Nothing and Emit Warning, `ignoredCount` resets to 0
after firing. If paused when Restart Timer or Add Time fires, the
remaining time updates but the timer stays paused until `resume`.

**Scope (enforced centrally):** threshold actions fire only against an
active run — `running` or `paused`. Never while idle, Disabled, or in
Cooldown; the guard lives in one place (`handleThresholdAction()`) so
every current and future call site is safe by construction. Without this
guard, a blocked start while Disabled could trip an Add Time or Restart
action that *starts the timer* — defeating the very block that produced
the count.

**Threshold Count is the master switch:** `0` (the default) disables
threshold logic entirely, regardless of the configured action — mirrored
in the editor, which hides the Action dropdown (and Add Time fields)
while the count is 0, leaving the stored action untouched so toggling the
count off and back doesn't lose it. Do Nothing remains available for the
count-and-watch pattern: the count increments indefinitely and every
ignored event on output 4 carries `ignoredCount`, letting a consumer
react on their own terms without the node taking any action.

## Feature: Heartbeat

- Configurable fixed-interval tick (`heartbeatinterval` + units) that
  fires a Query-output message (output 3, `source: "internal"`) at a
  regular cadence, regardless of running/paused/cooldown state.
- Unaffected by pause, resume, adjusttime, settime, or threshold actions —
  runs on its own independent `setInterval`, kept separate from the main
  timer's timeout/countdown handles. A *restart* of the timer (a new
  message while already running) does restart the heartbeat schedule,
  since a restart begins a new run.
- Starts the moment the timer starts; stops when the timer stops or fully
  expires (not when it enters Cooldown — it keeps ticking through
  Cooldown too).
- After a persisted restore, restarts fresh rather than recalculating the
  original schedule.

## Feature: Status Reporting (node status label only)

- Purely cosmetic — drives the colored status text under the node in the
  editor. Produces **no output message** (that role now belongs to Query/
  Heartbeat).
- `Every Minute, Last minute by seconds` retains the old adaptive cadence:
  decrement by the minute until 1 minute remains, then decrement every
  second.
- Format (`hh:mm:ss` / seconds / minutes / hours) controlled by
  *Reporting Format*.

## Feature: Cooldown

A self-expiring, timed block on new starts that begins automatically
after a **natural expiry only** — an explicit `stop` never leads to
Cooldown.

- Configured via *Cooldown Duration* + *Cooldown Units*; `0` disables the
  feature entirely.
- **Sequence:** `running` → `expired` (output 2 + 4, fires exactly once)
  → `cooldown` (output 4: `cooldownstarted`) → cooldown ends → settles
  back to idle `expired` (output 4: `cooldownended` — `expired` is
  **not** re-fired on output 2).
- Blocks new starts identically to `disabled`, but is tracked as a fully
  independent condition (see Blocking / Gating Rules above).
- `stop` sent during Cooldown cancels it immediately and fires a normal
  `stopped` event (output 2 + 4) — the only way to cut a Cooldown short.
- Threshold actions never fire during Cooldown (threshold logic is scoped
  to a genuinely running timer).
- Heartbeat keeps ticking through Cooldown.
- `query` during Cooldown reports `timerState: "cooldown"` with
  `remainingTime` reflecting Cooldown time left.
- Status shows a short `Cooldown: HH:MM:SS` (yellow dot), using the same
  Reporting cadence/format as the main countdown — no ignored-count
  detail, to keep the line short. If also `disabled`, status shows just
  `Disabled`.
- Runs on its own dedicated timer handles (`cooldownTimeout`,
  `cooldownReportInterval`, `cooldownReportMiniTimeout`), completely
  separate from the main timer's, so `clearAllTimers()` (used freely
  elsewhere) can never accidentally interrupt an in-progress Cooldown.
- Persisted and restored across deploy/restart the same way as a running
  or paused timer (recalculates remaining time from elapsed wall-clock
  time; randomizes to 3-8s if negligible time was left).

---

## `originalMsg` Lineage

Many events have no live triggering message of their own (natural expiry,
Heartbeat ticks, threshold actions, Cooldown events). These clone
`originalMsg` — the most recent **true start or restart's** triggering
message — as their payload base, instead of carrying no payload at all.

- **Set/overwritten on:** a true start (output 1), or a restart
  (settime-style event on output 4) — both represent "a new run began,"
  so both refresh the baseline.
- **Read/cloned by:** natural expiry, Heartbeat ticks, threshold-pause/
  addtime/warning, Cooldown start/end.
- **Untouched by:** pause, resume, lock, unlock, disable, enable,
  adjusttime, settime, setduration — these clone whatever message
  actually triggered them, not `originalMsg`.

---

## Persistence (`Resume timer on deploy/restart`)

Disabled by default. When enabled, timer state is written to
`<userDir>/timerevents-timers/<node-id>` on every meaningful state change
and restored on node startup:

- **Running** restore is a **continuation of the same run**, not a new
  one: recalculates elapsed downtime and continues toward the original
  wall-clock target; the run's original `timerDuration`, its accumulated
  `ignoredCount`/`lastIgnoredTime`, and its elapsed time (including the
  downtime, via a back-calculated `timerStartTime`) all survive. It is
  emitted as a true Start (output 1 + 4, `source: "internal"`) purely for
  downstream consumers, who see the timer coming back from nothing.
- **Paused** restore honors the frozen semantics: a paused timer is
  frozen, so Node-RED downtime is **not** deducted. The frozen remaining
  and frozen elapsed values are persisted as explicit fields (`remaining`,
  `frozenElapsed`) and restored directly — elapsed independently of
  remaining, so a `settime` issued while paused survives a restart without
  distorting elapsed. (Old persist files lacking these fields fall back to
  the legacy target-timestamp calculation.) No event is emitted.
- **Cooldown** restore: restores directly into `cooldown` state at the
  recalculated remaining Cooldown time (wall-clock, downtime absorbed —
  a cooldown is alive, unlike a pause), no event emitted; Heartbeat
  restarts fresh.
- **Special case:** if less than 3 seconds remain (or the timer/cooldown
  should have already elapsed) on restore, the remaining time is
  randomized to 3-8 seconds, to avoid a flood of simultaneous triggers
  across many timers and to give dependent nodes time to initialize.
- `disabled` and `donotresettimer` (lock) state also persist and restore
  independently of the above.
- **Freshly-deployed config wins:** `reporting`/`reportingformat` are
  deliberately *not* restored from the persisted file — changing the
  Status Reporting settings and redeploying mid-run takes effect
  immediately. (The fields are still written for backward compatibility;
  they are ignored on read.)
- **Limitation:** the ignored count is only written to disk when the next
  state-changing event triggers a save — ignored messages themselves do
  not write. A hard crash can therefore lose counts accumulated since the
  last save; timing is never affected, and a lost count can at worst delay
  a threshold action past its intended trigger point after recovery.

This is unrelated to Node-RED's built-in "Persistent Context."

---

## What Was Deliberately Dropped

- **Second/"Additional" payload output** — the old node's configurable
  second payload on expiry was a shortcut around using a `change` node.
  Removed: composable Node-RED primitives (`change`, `switch`) are the
  better fit, and the new event messages carry far richer structured data
  than the old node did, closing most of the original gap.
- **Dedicated "Ignored Message" output** — folded into output 4 as the
  `ignored:true` modifier on the relevant event type, rather than a
  separate output or event category.
- **Per-output-2 event filtering** (e.g., "only expired," "only stopped")
  — deliberately not implemented; a downstream `switch` node handles this
  more transparently than a hidden config option would.

---

## Configuration Reference

| Field | Default | Notes |
|---|---|---|
| Timer / Units | 5 Seconds | Base duration for new runs |
| Status Reporting | Never | Drives status label only, no output |
| Reporting format | HH:MM:SS | Also used for Cooldown status |
| Resume timer on deploy/restart | Off | Persistence |
| Ignore incoming `_timerpass` | Off | The armed swallow behaves as in the prior node, but arming differs: only a *genuine* stop (of a running/paused timer or an active Cooldown) arms the filter — a redundant stop while idle does not |
| Do Not Reset Timer on Subsequent Incoming Message | Off | Lock, toggleable at runtime via `lock`/`unlock` |
| Threshold Count | 0 | Master switch: `0` disables threshold actions entirely; > 0 arms them and reveals the Action dropdown in the editor. Shown above the Action in the form. |
| Ignored Message Threshold Action | Do Nothing | stop / pause / restart / add time / warning. Hidden in the editor while Threshold Count is 0 (stored value preserved). |
| Add Time Amount / Units | 0 / Second | Used only by the Add Time threshold action |
| Heartbeat Interval / Units | 0 / Second | `0` disables; fires Query output on a fixed schedule |
| Cooldown Duration / Units | 0 / Second | `0` disables; blocks new starts for a fixed period after natural expiry |
