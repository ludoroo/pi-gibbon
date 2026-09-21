# pi-gibbon

`pi-gibbon` is a private [Pi](https://github.com/badlogic/pi-mono) package for safely relocating an active Pi session between Git worktrees.

Its public identities are deliberately stable:

- Package/product: `pi-gibbon`
- LLM-facing tool: `worktree_jump`
- Internal coordination command: `/worktree-jump`
- Configuration: `pi-gibbon.json`

## Requirements

- Pi 0.85.1 or newer
- Node.js 22.19.0 or newer
- Git
- Optional [Worktrunk](https://worktrunk.dev/) executable `wt`
- Optional [Herdr](https://github.com/qu8n/herdr) runtime and executable

Native Git is the fallback worktree backend. Outside Herdr, Pi can switch to the forked session in process. The `tmux` adapter name is reserved but intentionally reports that it is not implemented.

## Install from the private repository

Configure SSH access to `ludoroo/pi-gibbon`, then install an immutable release ref:

```sh
pi install 'git:git@github.com:ludoroo/pi-gibbon.git@v0.1.0'
```

On machines where the personal GitHub key is selected through the `ludoroo.github.com` SSH alias:

```sh
pi install 'git:git@ludoroo.github.com:ludoroo/pi-gibbon.git@v0.1.0'
```

A pinned tag or commit does not advance during `pi update --extensions`. Install the next explicit tag when upgrading.

Pi loads exactly one declared entrypoint from `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Configuration

The real configuration stays outside this package. Copy [`pi-gibbon.example.json`](pi-gibbon.example.json) to `pi-gibbon.json` in Pi's agent directory (normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR`):

```json
{
  "backend": "auto",
  "multiplexer": "auto"
}
```

Set `PI_GIBBON_CONFIG` to read a different configuration file.

### Backend

- `auto`: prefer `wt`, otherwise use native Git
- `worktrunk`: require `wt`
- `git`: use native Git worktree commands

### Multiplexer

- `auto`: use Herdr when Pi is running in a valid Herdr pane; otherwise switch in process
- `herdr`: require `HERDR_ENV=1`, `HERDR_PANE_ID`, and the `herdr` executable
- `none`: switch the current Pi runtime to the forked session
- `tmux`: reserved, currently not implemented

A tool call may override either configured adapter for one jump. For `destination: "new"`, `branch` is required. The compatibility mapping for an old `backend: "herdr"` request selects the Git backend and Herdr multiplexer.

`PI_GIBBON_READY_FILE` is an internal one-shot readiness handshake used when starting replacement Pi inside Herdr. It is not a persistent user setting.

## Safety model

Worktree materialization and session relocation are separate operations:

1. The selected backend resolves or creates a checkout and returns `{ worktreePath, branch }`.
2. `worktree_jump` synchronously queues `/worktree-jump` with a private token.
3. The command waits for the current agent turn to become idle, ensuring the tool result is persisted.
4. If the original tool call was aborted, finalization stops and retains the checkout.
5. Otherwise the complete session is forked into the destination cwd and the selected multiplexer adapter relocates Pi.

For Herdr relocation, replacement Pi must publish its `session_start` readiness marker before the source shuts down. A failed or timed-out replacement is closed while the source remains active. Source session deletion and pane closure occur only after the source PID exits; a timeout preserves both rather than risking the live session.

For an in-process switch, cleanup and continuation use Pi's replacement session context rather than the stale source context.

Use `worktree_jump` only when the user explicitly requests relocation. Checkout creation alone is not permission to move the session.

## Development

Install the locked development toolchain and run all checks:

```sh
npm ci
npm run check
```

The checks include:

- strict TypeScript type checking;
- adapter, config, Git porcelain, pending-dispatch, cancellation, and cleanup tests;
- end-to-end relocation lifecycle tests using real temporary sessions and mocked adapters;
- Pi's real resource loader, asserting one tool and one command registration;
- a production-style install omitting development and peer packages;
- an isolated Pi RPC load of that production package.

Tests use mocks, temporary directories, and an isolated `PI_CODING_AGENT_DIR`. They do not relocate the active Pi session.

GitHub Actions runs the same checks on Ubuntu 24.04 and macOS 14.

## Origin and license

Adapted from [`@ogulcancelik/pi-herdr-worktree-jump` v0.1.0](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-herdr-worktree-jump), originally written by Can Celik.

Licensed under the MIT License. The original copyright and license notice are preserved in [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
