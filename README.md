# dsh-coding-agents

**Drive your local Codex and Claude Code from DeepSeek Harness — sessions, config and run state, from one settings page and six agent tools.**

[![npm version](https://img.shields.io/npm/v/dsh-coding-agents?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-coding-agents)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%20%7C%2024-339933?logo=node.js&logoColor=white)](#requirements)

English | [中文](README.zh.md)

The plugin calls the public, stable local interfaces of Codex and Claude Code. It never parses or rewrites their private databases, and every write goes through the vendor's own configuration protocol or a backup-plus-atomic-replace.

## Requirements

| Item | Value |
| --- | --- |
| DSH | 0.2.1-rc.5 (Cordis `4.0.5`, `@deepseek-ai/*` 0.2.1-rc.5) |
| Node.js | `^22.19.0 \|\| ^24.0.0` |
| Host services | `webServer`, `subprocess`, `tools` |
| Client services | `slots` (registers one section under Settings → Coding agents) |
| Bundled dependencies | `@openai/codex`, `@anthropic-ai/claude-agent-sdk` and their native binaries — the install is large |

## Install

The package ships `cordis.patch.yml` and a `dsh.bundle.patch` declaration, so it installs as a bundle:

```bash
dsh plugin --profile <profile> add dsh-coding-agents
```

Or add one loader entry to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-coding-agents
      name: 'dsh-coding-agents'
```

Restart the profile, then open **Settings → Coding agents**.

## What you can do

- Search the local session history of both Codex and Claude Code, and page through very long transcripts.
- Start, continue or fork a native session, watch text, tool calls and run state live, and cancel a run.
- Rename, tag, archive, unarchive, roll back and delete sessions. Operations that do not apply to an engine are refused explicitly instead of failing silently.
- Inspect configuration values, their effective values and their origin. Codex writes through its official config protocol; Claude Code uses backup plus atomic replace.
- The same capabilities are exposed to the DSH agent as six `coding_agent_*` tools, not only through the settings page.

## Natural-language examples

- "List the most recent Codex and Claude Code sessions."
- "Find the history that mentions the login failure."
- "Continue that Codex session and run the tests."
- "Start a Claude Code task in this workspace and fix the build error."
- "Read the current Codex configuration."

The plugin only drives engines that the current user has installed and logged in. Runs default to workspace-write permissions; full access still requires an explicit request from the user.

## Safety boundaries

- No vendor private database is read; only the public local interfaces.
- Configuration writes are backup plus atomic replace, so a failure never leaves a half-written file.
- Child processes live in the host's `subprocess` service and inherit a scrubbed environment (`scrubbedParentEnv`).
- Session operations are workspace-scoped and the HTTP route is same-origin only.

## Development

```bash
npm install
npm run typecheck   # source + client + tests
npm run build       # tsc → lib/, esbuild → lib/client.js
npm test            # vitest
npm run smoke:host  # load lib/index.js in a real cordis context with stubbed host services
```

`lib/client.js` is a `window.__ModuleLoader__.load({ id, factory })` closure factory, statically verified and executed in a sandbox by `scripts/verify-client.mjs`. The host contract is verified by `scripts/verify-host.mjs`: a real `@deepseek-ai/cordis` context loads the module, registers the route and tools, and cleans them up on dispose.

## Known limitations

- Requires a local Codex / Claude Code installation and login. Without it the engine reports an explicit unavailable state.
- Native executables are resolved at module load time; when the optional native package is missing the whole plugin fails to import (same behaviour as 0.1.5 — lazy loading is planned).
- The bundled native dependencies are large, so the first install depends on network speed.
- The plugin drives the vendor CLIs; it does not reimplement their agent loops.

## License

MIT © WilShi
