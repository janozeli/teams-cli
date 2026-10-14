# Output contract

- **YAML 1.2 is the default**, independent of whether stdout is a terminal.
  `--format json` (before or after the command) selects JSON for both results and
  errors. Both serialize the same JSON-compatible object. Format selection does
  not change fields, truncation, verification, or actions.
- Commands produce data; one renderer serializes at the process boundary, after
  adding the trace reference. Session IPC remains JSON and never carries formatted
  output. Error codes and exit codes remain separate (0 success, 1 failure or
  interruption, 2 invalid usage). Notices/heartbeat diagnostics go to stderr.
- Collections stay arrays when empty. Counts are numeric; `note`, `help`,
  `hasMore`, and `truncated` explain scope and available next steps. Cached results
  are not claims about the entire server history. `--full` controls message content,
  not output format. IDs stay strings.
- A structured `untrusted` descriptor names fields containing third-party content
  and records begin/end markers. YAML also prints those markers as comments;
  JSON carries them as ordinary string fields, never as invalid bare lines.
  Marker look-alikes in displayed content are neutralized in both formats.
  These labels guide the agent; they do not authorize instructions from a message.
- `trace <id> --raw` emits the original append-only **JSONL** file, preserving
  bytes including any incomplete final line; it cannot be combined with `--format`.
  Inspection may return exit 1 when validation detects an incomplete/invalid trace.
- Bare `--help` and `--version` remain text fast/reference paths. With an explicit
  `--format`, they return an object containing `help` or `version`.
- No built-in CSV/TSV/Markdown output matrix. Select fields from JSON and convert
  externally when needed.

```sh
teams-cli chats --format json
teams-cli --format json read me --full
teams-cli trace <id> --raw
```
