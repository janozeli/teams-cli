# Agent operation, explicit Pause and trace contract

UI operations use a persistent session with explicit Pause and **30s idle followed
by a separate 10s countdown**. The overlay is a view; execution output is always
noninteractive. This document specifies the current behavior and its validation
boundaries.

## Required behavior

- Every Teams command has an append-only trace. A UI session has one continuous
  JSONL journal, including input between commands; distinct commands have distinct IDs.
- UI operations arm observation and mount the view before acting, under the shared lock.
- **Pause is the sole entry into waiting.** Ordinary input during active use never
  infers takeover. Initial draft checks remain preconditions, not pause triggers.
- Pause synchronously invalidates the current command's captured document guard.
  This remains invalid after release and after later commands begin.
- Paused idle uses a monotonic clock, based on the observer receiving input. At 30s,
  idle stops being computed and a separate, full 10s countdown starts on the observing
  tick. A delayed tick never consumes an unseen countdown. Only countdown seconds are
  displayed, rounded up, clamped to 0–10. Internal view refresh is 250ms.
- Pointer, keyboard, input, wheel, scroll and touch events reset idle while paused.
  During countdown they cancel it and start idle from zero. Correlated agent input,
  focus, blur and visibility are trace-only. Source timestamps remain evidence; they
  do not backdate the host's monotonic deadline. Cross-process arrival can be delayed.
- Manual Resume releases either phase early; countdown expiry also releases. Both
  return the interrupted command without executing any pending steps. The agent reads
  trace/current UI and issues a fresh command in the same session. Release is not task
  completion. The bar remains mounted and active, including between commands.
- Cancel or `teams-cli session end` terminates the session and removes its view. Neither
  rolls back dispatched effects; uncertain outcomes remain uncertain. Interrupted work
  must not perform cleanup mutations that overwrite the user's editor.
- A private local process owns the observer and journal across CLI invocations.
  `teams-cli session status` reports it. There is no background owner for cache-only
  use without an existing UI session. Concurrent requests receive UI_BUSY, never a
  queue. A request arriving while the session is paused waits and returns interrupted;
  it is not executed after release. End the session when the task is finished.
- Control/trace inspection remains available while a command waits. A disconnected
  command client ends the session; requests are never retried after transmission.
  Observation or trace failure stops subsequent dispatch. The page removes an orphaned
  view after a 10s lease loss. An abrupt process crash leaves its journal intact.
- English stderr reports the pause without terminal animation or repeated heartbeat.
  Structured results include progress, command identity and the shared trace reference.
- The journal separates actor from recorder, intent from observation/assessment,
  source from recording timestamps, append order from uncertain occurrence order.
  IDs/refs/causedBy/supersedes support reconstruction. Text, clipboard content, scripts
  and credentials are excluded. Independent raw CDP does not inherit this barrier.

## Control bar and pointer

- One top bar, Teams purple (#464775), Segoe UI/system fallback and lilac controls.
  All text is English. Pause/Resume share a place near status; Cancel stays far right.
  Controls have visible labels and decorative SVG pause, play and octagonal cancel
  icons, with keyboard focus styling. No floating controls or component outlines.
- The red dot stays lit; only its halo pulses, over 3 seconds.
- A red diffuse frame starts below the bar and surrounds the remaining viewport.
  No solid border. A synchronized 4-second ease-in-out breath varies inset spread
  12–16 px, blur 28–60 px and alpha .36–.52. It never disappears while active.
- The rounded compact pointer uses dark purple fill, pale outline and lilac halo.
  It indicates known main-document DOM action targets and CDP mouse coordinates;
  keyboard actions use the focused element. It starts hidden until a location is
  known. User input does not move it; offscreen/covered targets are not depicted.
  Child documents are observed but do not mount a second bar or cursor; child-only
  target coordinates are not projected across frame boundaries.
- Pause removes the pointer, stops animations and dims the frame/dot. Resume returns
  the same view to its active appearance. Cancel removes the view. Reduced-motion preference makes active effects static.
- The frame follows the measured bar height, including wrapped narrow layouts.
  The page keeps its own background; #1f1f1f was only the preview canvas.
- Build DOM/SVG nodes directly to satisfy Teams Trusted Types; no HTML sinks/policy changes.

## Runtime and acceptance

`ActivityGate` owns monotonic idle/countdown state; `UiController` owns observation
and the view; `InteractionSession` owns the journal/controller across commands.
The CLI communicates with a private Unix socket scoped to installation, endpoint,
account and state directory. One writer flushes each JSONL record before dispatch.
Command generation and captured page guards prevent old continuations from becoming
valid when a new command begins. Paused local controls reject stale host refreshes.
Standalone library calls retain per-operation cleanup unless given an explicit
`InteractionSession`; embedders must end their session. The shared UI lock covers each
UI action and its wait; the page also rejects a competing session owner.

Automated checks cover exact 30s/10s boundaries, delayed ticks, countdown cancellation,
focus-only observation, permanent invalidation, unchanged view identity, continuous
trace between commands, fresh command IDs, independent CLI processes, no queuing,
Cancel/end cleanup, navigation, Trusted Types, responsive layout and reduced motion.
Fixtures alone do not establish live Teams acceptance; the coordinated check below
provides separate live evidence.

`npm run test:joint` mounts only the view on real Teams without sending messages.
Pause, test idle/countdown/reset or Resume, and observe that the command returns while
its view remains. Cancel ends the test session. Initial no-pause observation is bounded
at 60s; the retained session after interruption waits for Cancel. Run only when agreed
with the user. `scripts/check-interaction-cdp.ts` is the synthetic-control counterpart.

### Recorded live verification (2026-09-24)

A coordinated human test confirmed a separate 30-second idle period and visible
10-second countdown. Automatic release returned the command as interrupted with
zero dispatched steps while retaining the view. A subsequent Pause and manual
Resume reused the same session. Cancel ended it; a read-only inspection confirmed
that the view was removed and the page guard closed.

No Teams message was sent. Countdown cancellation/reset and separate CLI callers
were exercised in automated fixtures, not inferred from this zero-action live
check. The participant confirmed the visual behavior. Core read-only checks
(`doctor`, `chats`, `read me`) also passed at that checkpoint.

Earlier experiments used automatic pause triggers or removed the view on Resume.
Those designs are superseded. Their checks do not establish the behavior specified
here. Private trace identifiers are not included in public documentation; see
[validation coverage](IMPLEMENTATION.md) for the dated evidence summary.
