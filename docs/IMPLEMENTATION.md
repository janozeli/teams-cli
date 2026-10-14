# Implementation and validation coverage

This document separates implemented behavior, automated coverage and live Teams
observations. Live checks are dated snapshots, not a compatibility guarantee.
Historical observations below were recorded on September 23–25, 2026 with
teams-for-linux and a work/school account. Private messages, file identities and
local trace identifiers are intentionally omitted.

## Coverage

| Area | Implementation and automated checks | Recorded live observation | Remaining validation |
| --- | --- | --- | --- |
| Cache reads | Account/locale selection, conversation kinds, unread horizons, message normalization, reactions and cards | Chats, read, search, activity, people, rail presence and call history returned data | Multiple signed-in accounts; locale changes and incomplete cache selection |
| UI navigation | Bind chat and composer by identity; reject ambiguous or mismatched targets | Opened a 1:1 chat absent from the left rail without sending | Off-rail groups remain unsupported |
| Send | Correlate UI send response and cache by conversation, server ID and client ID; compare full normalized text | Self-chat sends confirmed by response and cache | Real channel post/reply delivery; Threads and Posts layout coverage |
| Edit | Bind edit box to message; check content before save; verify cache | Consecutive self-chat edits affected the intended messages | Channel post/reply editing is not implemented |
| Reactions | Bind toolbar to message; idempotent add/remove; verify cache | Self-chat add, repeat and removal restored original state | Broader UI/layout coverage |
| Observation | Arm page and related workers before acting; bound buffers; report disconnect/overflow | Message creation/update observed; outgoing send response correlated | Positive live typing, presence and incoming-call samples |
| Wait | Arm before cache baseline; retain arrivals during baseline; deduplicate IDs | Clean bounded timeout | Arrival-during-baseline behavior is covered by deterministic tests |
| Calendar | Arm before navigation; refuse drafts; read completed loaded ranges | A private fixture without attendees was created through the UI, read, deleted and confirmed absent | Other calendar configurations |
| Attachments | Bind file tile and SharePoint identity; capture complete responses; enforce budgets and no overwrite | Existing self-chat Markdown attachment read and exported with equal bytes | Inline images, Office viewers and partial/range responses |
| Interaction | Explicit Pause, 30s idle + 10s countdown, invalidated command guards, persistent sessions | Automatic release, manual Resume retaining view/session, and Cancel cleanup confirmed in a coordinated human test | Countdown reset and separate caller processes are covered by isolated fixtures |
| Output | YAML/JSON semantic parity, structured errors, untrusted-content labels, raw JSONL preservation | Both formats returned cache reads | No claim of complete server history |
| Agent integration | Generated skill drift checks; hook install/status/remove in temporary homes | Skill discovered by Claude Code; Claude Code and Codex hooks exercised and removed | OpenCode hook execution has no recorded live check |

## Automated validation

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run check:skill
```

The suite includes unit tests, isolated Chromium interactions and separate
caller/owner processes. Coverage includes worker readiness, buffered arrivals,
transport loss, response/cache mismatches, wrong or covered UI targets, duplicate
controls, interrupted writes, structured output, trace relations and session
persistence. Browser fixtures enforce Trusted Types and exercise responsive and
reduced-motion behavior.

The output-serialization checkpoint on September 25 recorded 252 passing tests,
a successful build/typecheck and a current generated skill. Test counts describe
that checkpoint; run the commands above for the current checkout.

## Live validation boundaries

Live `doctor` checks at the recorded checkpoints passed all 11 core checks.
`doctor` does not validate every event schema, cache freshness, account combination
or attachment viewer. A passing isolated fixture also does not establish live
Teams compatibility.

Typing, presence and incoming-call parsers use synthetic fixtures based on loaded
client schemas. Quiet observation windows establish lifecycle behavior only;
they do not provide positive samples for these event types. Unknown event schemas
are ignored. See [Teams internals](TEAMS-INTERNALS.md).

Channel composers passed identity checks without sending a real channel post.
That evidence must not be presented as end-to-end channel delivery. Further live
checks require an explicitly designated test channel and recipients.

The current interaction design uses explicit Pause. Earlier automatic input-based
pause experiments are superseded; their results do not validate the current
session lifecycle. See the [interaction contract](INTERACTION-CONTRACT.md).

## Local verification procedure

Run `teams-cli doctor`, `teams-cli chats` and `teams-cli read me` after changing
cache access or CDP transport. Test writes in the self chat unless another target
has been explicitly authorized. Coordinate `npm run test:joint` with the person
using Teams: it mounts a real control bar but sends no messages.

Keep real traces and exports private. A public report should describe the command,
expected behavior, observed result and remaining uncertainty using synthetic IDs.
