# Contributor notes for coding agents

Read README.md first. Preserve these implementation constraints:

- **Authorization belongs to the caller.** Do not add tool-level allowlists or chat
  restrictions. Keep reads and writes as separate commands so the calling agent or
  application can enforce its own permissions (for example, on `teams-cli send`).
- **No `cdp` passthrough command.** A one-shot wrapper would not preserve persistent
  domains, events, interception or objectId chaining. Print the raw endpoint in the
  home view for operations outside the CLI commands.
- **Cache reads from IndexedDB, writes through the UI.** Cache reads never mark messages
  read. Calendar and attachment capture deliberately navigate the UI; document those
  view changes and the possibility of marking the opened chat read. Writes reuse the real composer so formatting and delivery match what a user does;
  auth tokens never leave the page.
- **Verify every write** against the cache and record its verification in the unified append-only operation trace.
- **Three levels of access; only 1 and 2 are allowed.** (1) Read what Teams stored
  locally (IndexedDB, DOM). (2) Passively observe what Teams itself sends and receives
  (CDP network/WebSocket events), filtering out headers and credentials at the source.
  (3) Making our own requests to Teams/Microsoft services with tokens taken from the
  page is **not allowed by this project**, even read-only. Writes go
  through the UI.
- **Level 2 is on demand and listens before acting.** No background daemon: a command
  opens its CDP session, arms the listeners (page and worker sessions, each confirmed by
  CDP), buffers events from that moment, and only then acts (click send, open a view).
  Never act first and hope to catch the event. For waits, arm first and read the cache
  baseline second, de-duplicating by message id.

## Output

- Commands return structured objects. Serialize once at the CLI edge: YAML 1.2 by
  default, JSON via `--format json`. Never append formatted fragments to results.
- Keep both formats semantically equivalent, including errors, interruptions,
  trust metadata, numeric counts, empty arrays, and trace references.
- `trace --raw` is the original JSONL journal, exclusive with `--format`.
- Hook helpers are vendored unchanged with provenance and MIT license in
  `src/vendor/axi-hooks/`; no SDK renderer or runtime dependency is needed.

## Examples and private data

Use synthetic names, IDs and content in examples and fixtures. Do not commit live
Teams exports, screenshots, profiles, traces or downloaded client bundles. Keep
third-party license notices and vendored provenance intact. See SECURITY.md.

## Verifying changes

- `npm test` covers logic plus real isolated headless browser interaction tests.
  Install the test browser once with `npx playwright install chromium`.
- The interaction barrier never resumes pending steps after Pause/Resume.
  Only explicit Pause enters waiting. While paused: 30s idle, then a visible 10s countdown; eligible input cancels countdown and restarts idle. Resume never replays pending work.
  Keep the UI/session/trace across commands; end with `teams-cli session end` or Cancel.
  Inspect the trace/UI and issue a fresh command; keep the overall task active.
  `--force` overrides only the initial draft check. No cleanup mutations after interruption.
- `npm run test:joint` mounts a view on real Teams for a coordinated human test;
  schedule it with the user so it does not compete with desktop use.
- Anything touching `src/page/scripts.ts` or `src/cdp.ts` needs a run against the live
  Teams: `npm run dev -- chats`, `npm run dev -- read me`.
- Only send test messages to the self chat (`me`) unless the user asked otherwise.
