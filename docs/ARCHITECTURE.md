# Architecture

teams-cli connects to a running Teams web app through a local CDP endpoint.
Cache reads, passive observation and UI actions use separate paths.

```
teams-cli ── HTTP /json/list ──► pick the teams.cloud.microsoft page
          ├─ WebSocket, Runtime.evaluate/Input per UI step ──► Teams web app
          └─ Command-scoped WebSocket ──► Network events on page + related targets
```

- **Cache reads** come from Teams' own IndexedDB cache (`conversation-manager`,
  `replychain-manager`). No UI is touched, so reading never marks anything as
  read, and it is fast. The cache only holds what Teams has synced; very old
  or never-opened chats may be missing.
- **Unread** is derived from the read horizon (`consumptionhorizon`, the id of the
  last message read): a conversation is unread when its last message is newer and
  not yours; in `read`, each message is `new` on the same rule (a thread's own
  horizon wins when Teams keeps one).
- **Third-party content is labelled.** Message text in `read` (and previews in
  `chats --fields preview`) is identified by the `untrusted` descriptor and, in YAML, comment markers
  `# untrusted-content-begin <nonce>` and `# untrusted-content-end <nonce>`. The nonce is random per run and any
  marker look-alike inside the content is neutralised, so a message cannot close
  the block early; the skill tells agents to treat it as data, never instructions.
  Cards are labelled `[app card]`.
- **Observation** is command-scoped: a persistent CDP connection arms Network on the
  page and recursively on related workers/frames, waiting for acknowledgements before
  acting. New workers resume after their listeners are ready. `watch` returns a bounded
  event batch; it does not run a daemon. Loss of observation or buffer overflow is an
  explicit error. Raw headers, request bodies and push envelopes are not retained or
  logged; only selected business fields survive parsing. The current live-verified
  event adapter handles message creation/updates and send responses. Exact adapters
  also decode typing pulses, UPS presence batches and incoming call notifications
  (plain/base64/compressed); these have source-derived fixtures, but no live positive
  sample yet. Unrecognized event schemas are ignored. `watch --kind presence` is
  unscoped: presence has a person id, not a chat id. Typing events are pulses, not a
  maintained “currently typing” state. See [validation notes](IMPLEMENTATION.md) for evidence.
- **Calendar and attachment reads** drive the UI after arming observation. Calendar
  returns only completed `GetCalendarView` ranges; it may refresh its iframe and
  refuses a visible event dialog/draft. Files are selected by conversation, message,
  tile index/name/path and correlated by SharePoint origin/unique id. Only complete
  `download.aspx` responses are accepted; thumbnails, partial responses and unsupported
  viewers fail explicitly. UTF-8 text is fenced; `--output` exports original bytes to
  a new file without overwriting. Default file budget: 8 MiB; configurable to 256 MiB.
  These commands change the visible app/view, leave it open, and opening an attachment’s
  chat can mark messages read. They share the UI lock and user-activity check.
- **Sends** drive the UI like a user: open the chat (left rail by conversation
  id; for a 1:1 chat not in the rail, Teams search picking the suggestion whose
  `data-tid` carries the peer's exact MRI, never a text match), paste HTML into the composer, click send, then correlate Teams' own `201` response with the cached message by
  conversation id, server message id and client message id, and compare the complete
  normalized message text. Opening the chat marks it as
  read in Teams.
  - The target is bound by identity, not by position: the pane header
    (`chat-header-<id>`) and the send button's `data-track-thread-id` must both
    name the target conversation, and the editor must share the button's
    container. An untagged or duplicated button is refused (`WRONG_CHAT`).
  - A non-empty composer (text, inline media or attachments) is refused
    (`COMPOSER_NOT_EMPTY`) instead of being sent along.
  - Confirmation requires an own message, newer than the send, whose text
    matches, with a server-assigned id. Teams first caches an optimistic copy
    with id `-1`; that is not accepted.
  - Outcomes are phased: a failure before the click is `failed` (nothing sent,
    safe to retry); after the click the cache decides between `sent` and
    `SEND_UNVERIFIED` (check before retrying, a retry may duplicate).
  - Sends are serialized across processes with a lock file.
  - UI operations refuse (`USER_ACTIVE`) while Teams is focused and the open chat
    has an unsent draft, since driving the UI would capture your keystrokes;
    `--force` overrides only this initial check, never the live interaction barrier.
- **Reactions** are idempotent additions/removals in chats and notes. The hover panel
  must have both the requested message's portal id and Tabster identity before a click.
  Only buttons within its reaction toolbar are eligible. Cache verification and audit
  follow; a transport failure never causes a blind toggle retry. Keys absent from the
  toolbar fail explicitly. `read` shows cached reaction actors, using their names when
  known and preserving ids otherwise.
- **Edits** open the message's edit box through the hover toolbar (real mouse
  events). That toolbar floats outside the message and can belong to another one,
  so the edit box itself is checked: it must sit in the item holding
  `[data-mid=<id>]`. It is cleared (Ctrl+A, Backspace) before pasting, because
  pasting over a selection makes Teams turn the old text into a link; the new
  text is compared before saving. Validation failures may cancel the edit box;
  interruption leaves the current UI untouched. Message content is not written to traces.
- **Session binding**: each command resolves one Teams page (refusing if there
  are several) and uses it for every step; cache databases are bound to the
  signed-in account (refusing if it cannot be identified among several).
- **Unified operation trace**: every Teams CLI operation, including reads, writes a private
  append-only JSONL trace under `~/.local/state/teams-cli/traces/`; UI-session commands
  share a file and carry distinct command IDs. This replaces new writes
  to `actions.jsonl`; existing logs are left untouched. `TEAMS_AXI_AUDIT_LOG` is retired.
  Agent, external input, application and system events share the same trace. Scripts,
  typed content, clipboard contents, messages and full protocol payloads are omitted.
  `teams-cli trace <id>` reconstructs progress; `--raw` returns the complete JSONL,
  `--validate` checks schema/relations, and `--at-seq <n>` reconstructs earlier knowledge.
  See [the schema and trace contract](TRACE.md).
- **Interaction barrier**: UI operations show a Teams-style bar with **Pause/Resume**
  and **Cancel**, a breathing red frame and a rounded agent cursor. Only Pause enters
  waiting. While paused, 30 seconds without eligible input starts a visible 10-second
  resume countdown. Input during countdown cancels it and restarts idle; focus/visibility
  and correlated agent input do not reset it. Resume releases either phase early.
  Release returns **interrupted**, never executing the old command's pending steps.
  The same view and trace stay active across subsequent CLI commands. A private local
  session owner records input even between calls; `teams-cli session status` inspects it.
  **Run `teams-cli session end` when the task is done.** Cancel also ends the session.
  Each accepted command gets its own `commandId` in the shared journal. Concurrent
  requests are rejected, never queued or replayed. A command submitted while an idle
  session is paused waits for release and returns interrupted without running.
  Cache-only use without an existing UI session leaves no background owner. Trace
  inspection stays available while paused. Initial draft checks remain; `--force`
  cannot bypass Pause. Dispatched effects are not rolled back: inspect trace/UI before
  issuing another command. English output is noninteractive; the overlay is a view.
  Independent raw CDP clients do not inherit this barrier. See
  [the interaction contract](INTERACTION-CONTRACT.md).

Channels: the open channel is identified by header controls tagged with its
thread id inside the single message pane. A **reply** goes through the composer
inside `reply-chain-summary-<rootId>`, whose send button carries the channel id;
confirmation requires the new message to sit in that thread. A **new post**
uses the post composer, whose button has no id and is matched by its label
(`Postar`/`Post`/...) inside that pane; confirmation requires a new root post.
The channel must be in the left rail, and a reply target must be rendered in
the channel view. For anything else, drive the UI over CDP directly or with
[chrome-devtools-axi](https://github.com/kunchenguid/chrome-devtools-axi)
(`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222`).


Page-side scripts are plain JavaScript strings in `src/page/scripts.ts`. They are
evaluated inside Teams with `Runtime.evaluate`, without build-time loader helpers.
