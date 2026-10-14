# Backlog

Implemented commands and their verification coverage are described in the
[README](README.md) and [validation notes](docs/IMPLEMENTATION.md). This file
tracks remaining work and current limitations.

## Next investigations

- **Cache selection after locale changes.** Investigate cases where the active
  locale database is empty while another locale retains messages for the same
  account. Any fallback must preserve account binding and disclose cache scope.
- **Channel layouts.** Validate new posts and replies in both Threads and Posts
  layouts using a designated test channel. Composer identity checks have passed;
  end-to-end channel delivery has not been verified.
- **Transient events.** Capture naturally occurring typing, presence and incoming
  calls to validate the source-derived adapters. Synthetic fixtures do not replace
  positive live samples.
- **Attachment viewers.** Add support for inline images, Office viewers and
  partial/range responses. Current capture supports complete SharePoint download
  responses only.
- **Channel edits.** Study and implement post/reply editing. Current editing
  supports chats and the notes chat.
- **Account coverage.** Exercise selection with more than one signed-in account.
- **Agent integration.** Verify OpenCode hook execution in a live session.

## Known limitations

- Cache results reflect what Teams has stored locally, not the complete server
  history. Missing data must not be interpreted as absence of messages.
- Off-rail group chats cannot be opened by title (`NOT_REACHABLE`). Open them in
  Teams first so they appear in the rail.
- Channels must be present in the rail (`NOT_IN_SIDEBAR` otherwise). A reply target
  must already be rendered; the command does not scroll through old posts.
- The new-post button is matched by a known visible label because it has no stable
  conversation identifier. Unsupported labels fail explicitly.
- Attachment-chip detection uses DOM attributes; not every chip layout has been
  observed live. Unexpected files in a delivered message are reported.
- `doctor` checks core cache/composer contracts, not complete compatibility.
- Hook trust and configuration depend on the host application. Review its hook
  configuration after installation; hooks remain opt-in.
- Message arguments beginning with `--` should use `--text=<value>`.
- Pause invalidates pending work but cannot undo an already-dispatched effect.
  Independent CDP clients do not inherit the CLI's pause control or tracing.

## Interaction behavior

Only explicit Pause enters waiting. Focus, visibility, clicks and movement during
active use do not infer takeover. While paused, eligible input resets the idle
period or cancels the countdown. Resume and automatic release retain the session
and trace but never replay an interrupted command. Cancel or `session end` closes
the session. This behavior is implemented; automatic takeover detection is not
part of the current design.
