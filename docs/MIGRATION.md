# Rename from teams-axi to teams-cli

The project is now named `teams-cli`. It is designed for agents operating a local
Teams session; the on-screen controls let the person using Teams pause or cancel
agent activity. The rename does not change the supported access model or add Bun.

| Previous name | Current name |
| --- | --- |
| `teams-axi` | `teams-cli` |
| `teams-axi-context` | `teams-cli-context` |
| `skills/teams-axi` | `skills/teams-cli` |
| `TEAMS_AXI_CDP_URL` | `TEAMS_CLI_CDP_URL` |
| `TEAMS_AXI_ACCOUNT` | `TEAMS_CLI_ACCOUNT` |
| `$XDG_STATE_HOME/teams-axi/` | `$XDG_STATE_HOME/teams-cli/` |

Rebuild and link the new package, update agent skill paths and environment
variables, and replace old executable references in your agent configuration.
The previous names are not runtime aliases. No hook is installed automatically.
If you installed hooks with the old checkout, uninstall them with that version
before switching, then explicitly install the new hooks if wanted. End any old
UI session before starting the new version.

Old traces remain in their original directory and are not rewritten, moved or
deleted. New commands write to the new state directory. To inspect an old trace,
use its recorded file path or the previous CLI; its existing command suggestions
still use the historical name. The record structure remains schema version 1;
the published schema identifier now uses the `teams-cli` namespace.

The vendored AXI hook helpers, upstream attribution, license and managed plugin
prefix are unchanged. These references describe third-party provenance, not the
current project name.
