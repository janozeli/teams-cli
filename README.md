# teams-cli

A CLI for AI agents to work with Microsoft Teams through a local desktop session.
It connects to [teams-for-linux](https://github.com/IsmaelMartinez/teams-for-linux)
through the Chrome DevTools Protocol (CDP), reads the local cache and performs
message actions through the Teams interface. Agents receive structured results,
explicit errors and operation traces; people retain control through the in-app bar.

- Read chats, messages, reactions, people and call history from the local cache.
- Send, edit and react through the UI, with verification of the result.
- Observe incoming events on demand; read calendar views and supported attachments.
- Return YAML or JSON, with an append-only trace for each operation.
- Give the person using Teams Pause/Resume and Cancel controls during agent activity.

**Status:** experimental. Developed and tested on Linux with teams-for-linux and
work/school Teams accounts. It depends on undocumented cache layouts and UI
selectors, which can change. Channel delivery and some transient event adapters
still need live validation. See [validation coverage](docs/IMPLEMENTATION.md) and
[known limitations](BACKLOG.md).

This is an independent project, not affiliated with Microsoft. Microsoft Teams
is a trademark of Microsoft Corporation.

## Setup for agent use

Requires Node.js 22+, npm and a signed-in teams-for-linux installation. The package
is installed from a local checkout; it is not published to npm.

From the repository directory:

```sh
npm ci
npm run build
npm link
```

Start teams-for-linux with local debugging enabled. If it is already running,
quit it before restarting with these flags:

```sh
teams-for-linux --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

The debugging endpoint can control the signed-in session. Keep it bound to
loopback and use it only with trusted local tools.

```sh
teams-cli doctor
teams-cli chats --limit 5
teams-cli read me --limit 3
teams-cli chats --format json
```

`me` selects your own notes chat. Other targets can be a title, a unique
case/accent-insensitive substring, or an exact conversation ID. Ambiguous names
return an error with the matching candidates.

An agent can preview a message and then send it to the notes chat when authorized:

```sh
teams-cli send me --markdown --text "**Reminder:** review the pull request" --dry-run
teams-cli send me --markdown --text "**Reminder:** review the pull request"
teams-cli session end
```

Opening a chat through the UI can mark it read. Cache-only reads do not.
All names, message IDs and message text in usage examples are fictional.

## Commands

| Command | Purpose |
| --- | --- |
| `teams-cli` | Show unread chats and the CDP endpoint |
| `chats`, `read`, `search` | Read cached conversations and messages |
| `people`, `presence`, `activity`, `calls` | Inspect cached participants, rail presence, activity and calls |
| `send`, `edit`, `react` | Act through the UI and verify the result |
| `wait`, `watch` | Observe new messages or events during a bounded wait |
| `calendar` | Open Calendar and read the ranges Teams loads |
| `attachments` | List cached file metadata; optionally open and capture a supported file |
| `session status`, `session end` | Inspect or close the persistent UI session |
| `trace` | Inspect, validate or export an operation trace |
| `doctor` | Check the core cache layout and composer selectors |
| `setup hooks` | Install an optional session-start summary for a coding agent |
| `update` | Show instructions for updating the checkout |

Use `teams-cli <command> --help` for options and examples. The generated
[agent skill](skills/teams-cli/SKILL.md) contains the full command reference.

## Output and operation handling

YAML 1.2 is the default. `--format json` returns the same data, including errors,
counts, scope information and trace references. `trace <id> --raw` returns the
original JSONL journal. See the [output contract](docs/OUTPUT.md).

UI operations display Pause/Resume and Cancel controls. Pause invalidates the
current command. After 30 seconds of inactivity, a visible 10-second countdown
releases the pause; Resume releases it immediately. **Release never replays the
interrupted command.** Inspect the trace and current UI before issuing a new one.
The session stays open until Cancel or `teams-cli session end`.

A send reported as `SEND_UNVERIFIED` may already have been delivered. Check the
conversation before retrying. A failed or interrupted operation can leave partial
effects; neither Pause nor Cancel rolls them back.

## Agent integration

The [agent skill](skills/teams-cli/SKILL.md) is generated from CLI help. Install it
using your agent's skill mechanism. For Claude Code, from this checkout:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/teams-cli" ~/.claude/skills/teams-cli
```

Optional session-start hooks provide a short unread summary to Claude Code, Codex
or OpenCode. They are never installed by a build or test:

```sh
teams-cli setup hooks --status
teams-cli setup hooks
teams-cli setup hooks --uninstall
```

Use `--scope project` for project configuration. Hosts may require an interactive
trust step before running a new hook. The helper times out after three seconds
if Teams is unavailable. See `teams-cli setup --help` for details.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `TEAMS_CLI_CDP_URL` | `http://127.0.0.1:9222` |
| `XDG_STATE_HOME` | `~/.local/state`; traces are stored in `teams-cli/traces/` |
| `TEAMS_CLI_ACCOUNT` | Account override (`<tenant>:<user>`) when automatic selection is ambiguous |

## Development

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run check:skill
```

Tests use synthetic data and a separate headless Chromium profile. They do not
use the desktop Teams account. `npm run test:joint` is a separate, coordinated
manual check on a real Teams window.

- [Architecture](docs/ARCHITECTURE.md): cache reads, UI targeting, observation and verification.
- [Teams internals](docs/TEAMS-INTERNALS.md): observed schemas and compatibility boundaries.
- [Interaction contract](docs/INTERACTION-CONTRACT.md): pause, countdown and session lifecycle.
- [Trace schema and semantics](docs/TRACE.md): ordering, attribution and uncertain outcomes.
- [Validation coverage](docs/IMPLEMENTATION.md) and [backlog](BACKLOG.md).
- [Contributing](CONTRIBUTING.md) and [security and privacy](SECURITY.md).

Existing development installations: see the [rename notes](docs/MIGRATION.md)
for updated command names, configuration and private trace locations.

## Acknowledgements and license

Inspired by [AXI](https://github.com/kunchenguid/axi)'s command-line interfaces for
agents. The optional hook helpers are an unmodified snapshot from `axi-sdk-js`;
[their provenance and MIT license](src/vendor/axi-hooks/README.md) are retained.

teams-cli is available under the [MIT license](LICENSE).
