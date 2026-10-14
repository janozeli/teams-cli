# Operation traces and interaction

Implemented contract: [INTERACTION-CONTRACT.md](INTERACTION-CONTRACT.md).
Structural schema: [trace-event.v1.schema.json](../schemas/trace-event.v1.schema.json).
This document describes software behavior; real Teams acceptance is recorded separately
in the contract checklist. Headless browser tests do not establish Teams compatibility.

Every Teams CLI command, including reads, records into a private JSONL file in
`$XDG_STATE_HOME/teams-cli/traces/<operationId>.jsonl` (default state root:
`~/.local/state`). A persistent UI session shares one operationId/file across commands, with a new commandId for each call. Standalone cache reads use their own file. A single synchronous writer appends and flushes each event.
Required trace failure prevents subsequent dispatch. Files are never rotated, repaired,
rewritten or removed automatically. Legacy `actions.jsonl` files remain untouched;
new action attempts and outcomes use the unified trace. `TEAMS_AXI_AUDIT_LOG` is retired.

`teams-cli trace <id>` summarizes recorded steps and external input in append order;
only consecutive identical input events are grouped (their derived timer/notice records
do not break the group). First/last append sequences preserve the span. Summaries show
the last 20 steps, 12 activity groups and 12 outcomes, explicitly reporting omitted
earlier groups; `--raw` retains every individual record. The original file always keeps
individual events. `--raw` emits the full JSONL, `--validate` checks records and their
relations, and `--at-seq <n>` reconstructs knowledge available at that append sequence.
Trace inspection, help, setup and update do not start another Teams operation.
The session-start summary also records its cache access. Library integrations should
use `withOperation` and, when owning the UI, `withUiControl` inside the shared UI lock.
Pass an `InteractionSession` to `withOperation` to retain the view/journal across calls, then call `end()` when done. Independent CDP clients do not inherit these facilities.

## Identity, clocks and relations

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Version of this record; currently `1` |
| `eventId` | Stable UUID of one immutable record |
| `operationId` / `commandId` | Session (or standalone operation)/file and invoking command identities |
| `stepId` | Identity shared by a step's intent, dispatch and assessments |
| `seq` | Writer's append sequence; reconstruct using this, not line position |
| `timestamp` | Source occurrence time when available, otherwise observation time |
| `timestampSource` | `source` or `observer`, preventing silent substitution |
| `clockId` | Clock domain; host and document clocks need not agree |
| `recordedAt` | UTC recording time, distinct from occurrence time |
| `evidence` | `intent`, `observation`, or `assessment` |
| `refs` | Related records; makes no causal claim |
| `causedBy` | Established causal predecessors |
| `supersedes` | Replaced assessments of the same step; never replaces action facts |
| `uncertainty` | Why something is unknown and evidence needed to resolve it |

Both timestamps are UTC ISO strings. Monotonic clocks, not wall-clock timestamps,
drive wait calculations. A late event retains its source timestamp and later recording
time. Sorting cross-clock timestamps cannot establish a total causal order. References
are resolved by identity, even if a copy of the file has physically reordered lines.

`actor` describes origin; `component` describes the recorder:

| Actor | Meaning |
| --- | --- |
| `agent` | Executor-requested action, or an input explicitly correlated with it |
| `user` | Human input with evidence establishing that attribution |
| `application` | An occurrence from Teams, such as a passively observed response |
| `system` | Infrastructure lifecycle, timing, barrier or assessment |
| `unknown` | Origin not established; default for uncorrelated DOM input |

Components are `cli`, `executor`, `cdp`, `ui`, `activity-gate` and `trace`.
`isTrusted` alone cannot distinguish human input from another CDP client. A synchronous
owned DOM action can be correlated; expected CDP inputs are correlated by type and
available coordinates/key with a bounded lifetime. Matching concurrent external input
remains an explicit uncertainty. This is cooperative instrumentation, not a security
boundary against another client that changes the page instrumentation.

The schema defines structure and field descriptions. The relation validator additionally
checks duplicate identities/sequences, operation consistency, missing step starts,
dangling references, causal cycles and invalid supersession. An incomplete final line
is reported and excluded from reconstruction, never truncated on disk. Invalid traces
produce partial, explicitly non-authoritative summaries. No terminal record can mean
an active operation or an unclean exit; it never proves an action did not happen.

## Effects and reconstruction

`step.started` records intent. `step.dispatch.requested` records durable intent at the
transport boundary. A response establishes that a step returned, not that a message
was delivered. The summary also identifies the last observed local action return inside a script,
so an interrupted multi-action script does not hide earlier effects.
`action.outcome` separately records application-specific verification
(e.g. `sent` with `response+cache` confirmation). A dispatched step without a successful
result stays `unknown`, since partial effects may remain. An undispatched blocked step
is `not_executed`. Conflicting active assessments remain `conflicting_assessments`
until explicit supersession resolves them.

A compact relation example (complete records also carry all required schema fields):

```json
{"eventId":"00000000-0000-4000-8000-000000000001","seq":1,"event":"step.started","evidence":"intent","stepId":"00000000-0000-4000-8000-000000000004"}
{"eventId":"00000000-0000-4000-8000-000000000002","seq":2,"event":"step.outcome.unknown","evidence":"assessment","stepId":"00000000-0000-4000-8000-000000000004","refs":["00000000-0000-4000-8000-000000000001"],"data":{"outcome":"unknown"}}
{"eventId":"00000000-0000-4000-8000-000000000003","seq":3,"event":"step.outcome.confirmed","evidence":"assessment","stepId":"00000000-0000-4000-8000-000000000004","supersedes":["00000000-0000-4000-8000-000000000002"],"data":{"outcome":"completed"}}
```

At seq 2 the result is unknown; at seq 3 the current assessment is completed. The
original uncertainty and intent remain in the file. An independent later confirmation
of delivery is a different claim from whether the script returned; it must not replace
that script-result observation.

Trace metadata omits scripts, command text arguments, typed values, clipboard contents,
message bodies, previous edit content, raw protocol payloads and credentials. Target
hints are limited to tag/role/test attributes. They remain untrusted metadata; raw JSONL
is for parsing, never instruction following.

## Interaction and output

UI operations arm observation before acting and retain the shared lock through waiting.
The Teams-style top bar contains Pause/Resume and a distant Cancel. **Only Pause**
latches interruption synchronously in the document and notifies the executor. Ordinary
input during active use remains observed metadata without changing permission.
Guard checks run before owned page actions, after page waits and before transport steps.
Dispatched actions may finish or remain uncertain; interruption never implies rollback.

While paused, 30s idle starts a separate visible 10s countdown. Eligible input
cancels that countdown and resets idle; focus/visibility and owned agent input do not.
Manual Resume or countdown expiry releases the wait without replaying pending work.
The view/session/journal remain active for fresh commands. Cancel or explicit
`teams-cli session end` closes them. Dispatched effects are not undone.

Execution is noninteractive. The command remains pending during its wait. A private
local owner maintains the observer and trace between CLI invocations; its view refresh
is 250ms. Source input timestamps do not control the monotonic clock. A lost owner
lease removes the orphaned view after 10s; the existing journal is never repaired.

`control.pause/resume/cancel`, `gate.blocked`, `gate.idle.reset`,
`gate.countdown.started`, `gate.released` (reason resume/countdown), `gate.cancelled`,
and `session.started/end.requested/ended` describe the lifecycle. Input/control actors
remain unknown without attribution evidence. `gate.idle.reset` refers to the input
that caused it; source and recording clocks remain distinct.

Between commands, observations retain the most recent command context (the initial
session context before the first command). This contextual commandId does not assert
that the command caused the event. A command terminal record does not end a session;
`session.ended` is separate. Summaries include bounded command lifecycle records;
`--raw` preserves every event. A new command never rewrites its predecessor's outcome.
See [the governing interaction contract](INTERACTION-CONTRACT.md) for acceptance.
