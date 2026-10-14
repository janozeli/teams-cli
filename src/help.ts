import { activitySpec, attachmentsSpec, calendarSpec, chatsSpec, editSpec, readSpec, reactSpec, searchSpec, sendSpec, waitSpec, watchSpec } from "./commands.js";
import { traceSpec } from "./trace-command.js";
import { setupSpec } from "./setup.js";

export const DESCRIPTION = "A CLI for AI agents to work with Microsoft Teams through a local desktop session";

export const TOP_LEVEL_HELP = `usage: teams-cli [command] [args] [flags]
output: YAML by default; --format json returns the same data as JSON (global option)
commands:
  (none): "Unread chats, CDP endpoint and target"
  chats: List cached conversations
  read <chat>: Recent messages of a chat (never marks as read)
  send <chat>: "Send a message, then verify it landed"
  edit <chat> <messageId>: "Replace one of your sent messages, then verify"
  react <chat> <messageId> <key>: Add or remove your reaction through the UI
  wait <chat>: Wait for a new message from someone else
  watch [<chat>]: Observe Teams events on demand
  activity: "Mentions, replies and reactions to you"
  search <text>: Search cached messages
  presence [<chat>]: Presence as shown in the left rail
  people [<query>]: People from your cached chats
  attachments <chat> <messageId>: Inspect or read an attachment through Teams
  calendar: Calendar views loaded by Teams
  calls: Call history from the local cache
  session <status|end>: Inspect or end the persistent UI session
  trace <operationId>: Inspect the unified append-only operation trace
  doctor: "Read-only self-check of the local cache and UI contract"
  setup hooks: "Opt-in session-start summary for Claude Code, Codex, OpenCode"
  update: How to update (not published to npm)
chat: a title (case/accent-insensitive, unique substring ok), an exact id, or "me" for your own notes chat
env:
  TEAMS_CLI_CDP_URL: "CDP endpoint (default http://127.0.0.1:9222)"
  XDG_STATE_HOME: "trace parent directory (default ~/.local/state)"
  TEAMS_CLI_ACCOUNT: "<tenant>:<user> cache to use when several accounts are cached (default: the signed-in one)"
`;

export const COMMAND_HELP: Record<string, string> = {
  presence: `usage: teams-cli presence [<chat>]
notes: Reads the presence currently shown in the left rail.
`,
  people: `usage: teams-cli people [<query>] [--limit n]
notes: Searches people in cached chats; default limit 30.
`,
  calls: `usage: teams-cli calls [--limit n]
notes: Reads cached call history; default limit 20.
`,
  doctor: `usage: teams-cli doctor
notes: Read-only checks of the cache layout and UI selectors.
`,
  update: `usage: teams-cli update
notes: Prints checkout update instructions; does not modify files.
`,
  session: `usage: teams-cli session <status|end>
notes: "Resume keeps the view and trace alive. End the session when the task is done. Cancel also ends it. Commands are never queued or replayed."
`,
  trace: `usage: ${traceSpec.usage}
flags:
  --raw: original JSONL records; exclusive with --format (untrusted metadata)
  --validate: structural and relational validation only
  --at-seq: reconstruct knowledge through this append sequence
notes: "Local read only; no Teams connection or new trace. One file mixes executor, input, application and lifecycle events. Seq orders recorded knowledge, not necessarily occurrence across clocks. Missing results never prove non-execution. An invalid or incomplete trace is only partial evidence."
`,
  chats: `usage: ${chatsSpec.usage}
flags:
  --unread: only chats with unread messages
  --kind: "self, chat (1:1), group, channel, meeting"
  --search: case-insensitive substring of the title
  --limit: "max rows (default 30)"
  --fields: "comma list of title,kind,unread,last,from,preview,team,id (default title,kind,unread,last)"
examples:
  - teams-cli chats --unread
  - teams-cli chats --kind channel --fields title,from,preview
  - teams-cli chats --search alex --fields title,id
`,
  read: `usage: ${readSpec.usage}
flags:
  --limit: "number of latest messages to show (default 15)"
  --full: do not truncate long messages (default preview 400 chars)
  --ids: add id and thread (root message id) columns
  --unread: only messages you have not read yet (a "new" column appears when some are unread)
notes: "Reads Teams' local cache, so it never marks messages as read. Replies are prefixed with ↳; a reply whose post is older than the shown window says so."
examples:
  - teams-cli read me
  - teams-cli read "Alex Morgan" --limit 5
  - teams-cli read "Code Review" --full
`,
  send: `usage: ${sendSpec.usage}
flags:
  --text: "plain text; each line becomes a paragraph (a value starting with -- needs --text=<value>)"
  --html: "Teams-flavoured HTML (b, i, u, s, code, pre, a, ul/ol, blockquote, table, h2/h3)"
  --stdin: read the message from stdin (HTML if it starts with <, else plain text)
  --reply-to: "channels only: reply in the thread of this message id (see read --ids); without it a channel gets a new post"
  --markdown: "treat --text/--stdin as Markdown: **bold**, *italic*, ~~strike~~, \`code\`, fenced code, # headings, - and 1. lists, > quotes, [links](url)"
  --dry-run: resolve the chat and show what would be sent, without sending
  --force: override only the initial focused-draft check; never the live interaction barrier
notes: "Opens the chat in the Teams window (which marks it read), pastes into the composer, clicks send, and confirms the message appeared. 1:1 chats missing from the left rail are opened through Teams search by the person's exact id; group chats must be in the rail. Channels: the channel must be in the left rail; replies need the post to be rendered in the channel view. Only one send runs at a time. Every command records a private append-only operation trace; message content is not recorded."
outcomes:
  sent: confirmed in the chat
  "failed (exit 1)": inspect the error and trace before retrying
  "interrupted / cancelled (exit 1)": pending steps will not execute; inspect effects already dispatched
  "SEND_UNVERIFIED (exit 1)": "send was clicked but not confirmed; check with teams-cli read before retrying, a retry may duplicate it"
examples:
  - teams-cli send me --text "Reminder: review the pull request"
  - teams-cli send me --markdown --text "**PR #12** ready: \`npm test\` passed"
  - teams-cli send "Alex Morgan" --html "<p>Hello <b>Alex</b></p>" --dry-run
  - cat msg.html | teams-cli send me --stdin
  - teams-cli send "Example Team > Development" --reply-to 1790000000001 --text "Done" --dry-run
`,
  setup: `usage: ${setupSpec.usage}
flags:
  --scope: "user (default: ~/.claude, ~/.codex, ~/.config/opencode) or project (./.claude, ./.codex, ./.opencode)"
  --status: report what is installed, without writing
  --uninstall: remove only teams-cli's managed entries
notes: "Installs a SessionStart hook that runs teams-cli-context: one line with the unread count and top chats, or 'unavailable' when Teams is not reachable. Idempotent; duplicate managed entries are collapsed. Codex only runs it after you trust it in codex (startup prompt or /hooks)."
examples:
  - teams-cli setup hooks
  - teams-cli setup hooks --status
  - teams-cli setup hooks --uninstall
`,
  edit: `usage: ${editSpec.usage}
flags:
  --text / --html / --stdin / --markdown: the new content, same as send
  --dry-run: show the current and the new text, without changing anything
notes: "Chats and your own notes chat only. Opens the edit box of that message (hover, Edit), checks that the box belongs to that message id, clears it, pastes the new content, checks it, then saves and confirms in the cache. Validation failures may cancel the edit box; user interruption leaves the current UI untouched and never resumes pending steps. Message ids come from read --ids. Attempts and outcomes share the operation trace; previous and new message content are omitted."
examples:
  - teams-cli edit me 1790000000002 --markdown --text "**Updated** text" --dry-run
  - teams-cli edit "Alex Morgan" 1790000000003 --stdin --markdown
`,
  react: `usage: ${reactSpec.usage}
flags:
  --remove: remove your reaction (default adds it; repeating is a no-op)
  --dry-run: inspect the target and current reactions without changing anything
  --force: override only the initial focused-draft check; never the live interaction barrier
notes: "Chats and notes. Uses the reaction keys available in Teams' hover toolbar (usually like, heart, laugh, surprised). The toolbar identity must match the message before clicking. Verifies your reaction in the cache and records the outcome. Unavailable keys fail explicitly."
`,
  attachments: `usage: ${attachmentsSpec.usage}
flags:
  --read: 1-based attachment index to open and read (default lists cached file identities)
  --output: export captured bytes to this new local file; never overwrites an existing file
  --timeout: response wait in seconds (default 20, max 120)
  --max-bytes: capture budget (default 8388608, max 268435456)
  --force: override only the initial focused-draft check; never the live interaction barrier
notes: "Arms page/frame/worker observation before opening the message's exact file tile. Full SharePoint download responses are matched by origin and unique file id. Thumbnails and partial responses are not accepted. Plain UTF-8 files are fenced as untrusted text; other formats can be exported. Opening the chat may mark it read; the preview remains open. Unsupported viewers fail explicitly; no independent file request is made."
`,
  calendar: `usage: ${calendarSpec.usage}
flags:
  --timeout: seconds to wait for completed calendar responses (default 20, max 120)
  --force: override only the initial focused-draft check; never the live interaction barrier
notes: "Arms observation before opening Calendar. May refresh only its Outlook iframe after refusing visible dialogs/drafts. Returns the exact loaded ranges and their events. An empty successful response is distinct from a failed/missing response. Calendar stays open; no event is created or modified."
`,
  watch: `usage: ${watchSpec.usage}
flags:
  --kind: message, typing, presence or call (default all)
  --timeout: seconds to observe (default 30, max 3600)
  --limit: max matching events (default 20, max 1000)
notes: "Page and related workers are armed before collecting. No daemon, no history. Returns when the limit or timeout is reached; disconnects and buffer overflow are errors. Chat filtering requires a conversation id in the event, so presence needs watch without a chat. Typing is an observed pulse, not a maintained typing state. Unknown schemas are ignored; typing/presence/call adapters have source-derived fixture tests but no live positive sample yet."
`,
  wait: `usage: ${waitSpec.usage}
flags:
  --timeout: "seconds to wait (default 300, max 3600)"
  --from: only messages whose sender name contains this
notes: "Arms page and worker observation before reading the cache baseline. Incoming events wake the wait; cache supplies message content. Ignores your own messages. A timeout is an answer; observation loss is an error."
examples:
  - teams-cli wait "Alex Morgan" --timeout 600
  - teams-cli wait "Project Chat" --from alex
`,
  activity: `usage: ${activitySpec.usage}
flags:
  --unread: only items you have not seen
  --limit: "max items (default 20)"
notes: Mentions, replies and reactions from Teams' local activity feed, with the source message when cached. Reading here marks nothing as read.
examples:
  - teams-cli activity --unread
`,
  search: `usage: ${searchSpec.usage}
flags:
  --chat: limit to one chat
  --limit: "max results (default 20)"
notes: "Every word must appear (case- and accent-insensitive). Only messages in Teams' local cache are searched."
examples:
  - teams-cli search "database setup"
  - teams-cli search deploy --chat "Project Chat"
`,
};

for (const command of Object.keys(COMMAND_HELP)) {
  COMMAND_HELP[command] += "output: YAML by default; --format json returns the same data as JSON\n";
}
