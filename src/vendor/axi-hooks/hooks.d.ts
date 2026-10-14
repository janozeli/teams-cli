export interface HookEntry {
    type?: string;
    command?: string;
    timeout?: number;
}
export interface HookGroup {
    matcher?: string | null;
    hooks?: HookEntry[];
}
export interface HookSettings {
    hooks?: {
        SessionStart?: HookGroup[];
        session_start?: HookEntry[];
        [event: string]: HookGroup[] | HookEntry[] | undefined;
    };
    [key: string]: unknown;
}
export interface ManagedHookSpec {
    marker: string;
    command: string;
    timeoutSeconds?: number;
}
export interface NodeAxiExecPathPolicy {
    marker: string;
    binaryNames?: string[];
    distEntrypoints?: string[];
}
/**
 * `"user"` (the default) targets each agent's home-directory config, exactly
 * as before scope support existed. `"project"` targets the equivalent
 * per-repository config under `projectDir`, the way Claude Code natively
 * supports `<repo>/.claude/settings.json`.
 */
export type SessionStartHookScope = "user" | "project";
interface SessionStartHookScopeOptions {
    homeDir?: string;
    scope?: SessionStartHookScope;
    projectDir?: string;
}
export interface InstallSessionStartHooksOptions extends SessionStartHookScopeOptions {
    marker?: string;
    execPath?: string;
    binaryNames?: string[];
    distEntrypoints?: string[];
    timeoutSeconds?: number;
    shouldInstall?: (execPath: string) => boolean;
    onError?: (message: string) => void;
}
export interface SessionStartHookStatusOptions extends SessionStartHookScopeOptions {
    marker?: string;
    execPath?: string;
}
export interface UninstallSessionStartHooksOptions extends SessionStartHookScopeOptions {
    marker?: string;
    execPath?: string;
    onError?: (message: string) => void;
}
export interface SessionStartHookAgentStatus {
    installed: boolean;
    path: string;
}
export interface SessionStartHookCodexStatus extends SessionStartHookAgentStatus {
    /** Whether `[features].hooks = true` is set in the USER-level `config.toml`. */
    userFeatureEnabled: boolean;
    userFeaturePath: string;
}
export interface SessionStartHookStatus {
    marker: string;
    scope: SessionStartHookScope;
    claude: SessionStartHookAgentStatus;
    codex: SessionStartHookCodexStatus;
    opencode: SessionStartHookAgentStatus;
}
export interface PortableHookCommandContext {
    pathEntries: string[];
    pathExtensions: string[];
    resolveRealPath: (absolutePath: string) => string | undefined;
    resolveShimTarget?: (shimPath: string) => string | undefined;
}
export declare function computeSessionStartHookUpdate(settings: HookSettings, spec: ManagedHookSpec): [HookSettings, boolean];
export declare function computeSessionStartHookRemoval(settings: HookSettings, marker: string): [HookSettings, boolean];
export declare function computeCodexConfigUpdate(content: string): [string, boolean];
export declare function resolvePortableHookCommand(execPath: string, binaryNames: string[], marker: string, context: PortableHookCommandContext): string;
export declare function extractNpmShimScriptPath(content: string): string | undefined;
export declare function shouldInstallHooksForNodeAxiExecPath(execPath: string, policy: NodeAxiExecPathPolicy): boolean;
export declare function installSessionStartHooks(options?: InstallSessionStartHooksOptions): void;
/**
 * Reports whether managed SessionStart hooks (Claude Code, Codex) and the
 * OpenCode ambient plugin are installed for the given marker and scope.
 * Performs no writes. Throws if the marker cannot be resolved from either
 * `options.marker` or the current process's inferred identity.
 */
export declare function sessionStartHookStatus(options?: SessionStartHookStatusOptions): SessionStartHookStatus;
/**
 * Removes only marker-matched managed hook entries at the given scope:
 * the Claude Code and Codex SessionStart hook entries, and the OpenCode
 * ambient plugin file (only when it still carries the managed marker).
 * Unrelated hooks/groups and the Codex user-level `[features].hooks` flag
 * (shared across every AXI installed for that user) are left untouched.
 */
export declare function uninstallSessionStartHooks(options?: UninstallSessionStartHooksOptions): void;
export {};
