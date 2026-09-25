![pi-gibbon — From one worktree to another](https://raw.githubusercontent.com/ludoroo/pi-gibbon/main/media/banner.png)

# pi-gibbon

[![CI](https://github.com/ludoroo/pi-gibbon/actions/workflows/ci.yml/badge.svg)](https://github.com/ludoroo/pi-gibbon/actions/workflows/ci.yml)
[![release](https://img.shields.io/npm/v/pi-gibbon?label=release)](https://www.npmjs.com/package/pi-gibbon)
[![license: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)

Keep your [Pi](https://github.com/badlogic/pi-mono) session moving with your code: pi-gibbon swings the full conversation into another Git worktree—and, in Herdr, into its destination workspace—without missing a beat.

## What it does

When a task should continue on a different branch, ask Pi to move the current session. `pi-gibbon` will:

1. Create or open the requested Git worktree.
2. Fork the complete Pi session into that checkout.
3. Start the replacement session in the new working directory.
4. Continue the conversation with its existing context intact.
5. Clean up the source session only after the replacement is ready.

With [Herdr](https://github.com/qu8n/herdr), the replacement runs in the destination workspace. If you switch to another workspace while the jump is being prepared, `pi-gibbon` leaves the destination in the background instead of stealing focus. Outside Herdr, Pi switches sessions in the current process.

Worktrees can be managed through [Worktrunk](https://worktrunk.dev/) or native Git. In the default `auto` mode, `pi-gibbon` uses Worktrunk when available and falls back to Git.

## How to use it

Ask Pi explicitly to relocate the current session:

> Move this session to a new worktree on branch `fix/login-race`.

You can optionally name a base ref or destination workspace:

> Move this session to a new worktree on branch `experiment/cache`, based on `main`, and label it `cache experiment`.

To return to the repository's primary checkout:

> Move this session back to the main checkout.

The extension deliberately acts only on explicit relocation requests. Creating a checkout or discussing worktree strategy does not move the session.

## Requirements

- Pi 0.85.1 or newer
- Node.js 22.19.0 or newer
- Git
- Optional: [Worktrunk](https://worktrunk.dev/) executable `wt`
- Optional: [Herdr](https://github.com/qu8n/herdr) runtime and executable

## Install

```sh
pi install npm:pi-gibbon
```

Update it later with:

```sh
pi update npm:pi-gibbon
```

## Configuration

No configuration is required. By default, `pi-gibbon` automatically selects the available worktree and terminal integrations.

To override those defaults, copy [`pi-gibbon.example.json`](pi-gibbon.example.json) to `pi-gibbon.json` in Pi's agent directory—normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set:

```json
{
  "backend": "auto",
  "multiplexer": "auto"
}
```

Set `PI_GIBBON_CONFIG` to read a different configuration file.

### Worktree backend

- `auto`: prefer Worktrunk, otherwise use native Git
- `worktrunk`: require the `wt` executable
- `git`: use native Git worktree commands

### Terminal integration

- `auto`: use Herdr when Pi is running in a valid Herdr pane; otherwise switch in process
- `herdr`: require `HERDR_ENV=1`, `HERDR_PANE_ID`, and the `herdr` executable
- `none`: switch the current Pi runtime to the forked session
- `tmux`: reserved, currently not implemented

Adapter selection belongs to user configuration; the LLM cannot choose a backend or multiplexer.

## Tool reference

`pi-gibbon` registers one LLM-facing tool:

```text
worktree_jump
```

It accepts:

- `destination`: `new` or `main`; defaults to `new`
- `branch`: branch to create or open; required for `destination: new`
- `base`: optional starting ref when creating a branch
- `label`: optional destination workspace label

The internal `/worktree-jump` command and `PI_GIBBON_READY_FILE` environment variable coordinate relocation. They are not user-facing configuration.

Pi loads the extension through the package manifest:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "image": "https://raw.githubusercontent.com/ludoroo/pi-gibbon/main/media/logo.png"
  }
}
```

## Safety model

Worktree creation and session relocation are separate operations:

1. The selected backend resolves or creates the checkout.
2. `worktree_jump` queues relocation after the current tool turn settles.
3. Pi waits for the current agent turn to become idle, ensuring its result is saved.
4. If the original request was aborted, relocation stops and retains the checkout.
5. Otherwise, the complete session is forked into the destination working directory.

For Herdr relocation, the destination opens without focus and replacement Pi must report ready before the source shuts down. The destination receives focus only if the originating workspace is still focused. A failed or timed-out replacement is closed while the source remains active.

Source-session deletion and pane closure occur only after the source process exits. A cleanup timeout preserves both sessions rather than risking the live one.

## Development

Install the locked development toolchain and run all checks:

```sh
npm ci
npm run check
```

The checks include:

- strict TypeScript type checking;
- adapter, configuration, Git porcelain, cancellation, and cleanup tests;
- end-to-end relocation lifecycle tests with temporary sessions and mocked adapters;
- Pi resource-loader verification for exactly one tool and command;
- a production-style package installation and isolated Pi RPC load.

Tests do not relocate the active development session. GitHub Actions runs the same checks on Ubuntu and macOS.

## Origin and license

Adapted from [`@ogulcancelik/pi-herdr-worktree-jump` v0.1.0](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-herdr-worktree-jump), originally written by Can Celik.

Licensed under the MIT License. The original copyright and license notice are preserved in [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
