# Sandboxes

A sandbox is where an agent's process runs. The default is this machine. A run can instead start in a container that is discarded when the process exits.

The sandbox changes the place. The run stays the same. Autonomy is still enforced by the agent's own process. The trace streams back over stdout as for a local run. The ledger records the sandbox on the `delegate_start` entry.

## Kinds

| Kind | Where the process runs | Status |
| --- | --- | --- |
| `local` | On this machine, in the agent's worktree. | Default. |
| `docker` | In one container per run. The worktree is mounted at `/work`. | Supported. |
| `ssh` | On a remote host, in a temporary copy of the worktree. | Experimental. |

Select one with `CEO_SANDBOX=docker`. A run can name a kind with the `sandbox` option of `runDelegation`, which wins over the environment variable. An unknown value means `local`.

Run `ceo sandbox` to print the configured kind, the image or host, and whether the sandbox can start. Run `ceo sandbox test` to execute `true` inside the sandbox.

## Docker

Each turn of a run becomes one command of this shape:

```
docker run --rm -i --name ceo-<run id> --network bridge \
  -v <worktree>:/work -w /work \
  -e KEY=VALUE ... \
  -v ~/.claude:/root/.claude:ro -v ~/.claude.json:/root/.claude.json:ro \
  <image> claude <the provider's own arguments>
```

`--rm` removes the container when the process exits. Nothing is left behind. A cancelled run also calls `docker rm -f ceo-<run id>`, as a best effort.

Stdin passes through. The codex task still arrives on stdin. Stdout and stderr stream back unchanged.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CEO_SANDBOX_IMAGE` | `ceo-agent:latest` | The image. The image must contain the agent CLIs. |
| `CEO_SANDBOX_NETWORK` | `bridge` | The docker network. `none` closes the network, which also stops the model calls. |
| `CEO_DOCKER_BIN` | `docker` | The docker binary. |
| `CEO_SANDBOX_CLAUDE_BIN` | `claude` | The CLI's name inside the image. |
| `CEO_SANDBOX_CODEX_BIN` | `codex` | The same for codex. |
| `CEO_SANDBOX_GEMINI_BIN` | `agy` | The same for gemini. |

### Building an image

The image must hold every CLI that agents in the org run on. CEO does not build one. The Dockerfile below is an example only. Pin versions and adapt it before relying on it.

```dockerfile
# Example only. Not shipped, not tested by CEO.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex
# The gemini provider needs agy. Use the vendor's install script.
WORKDIR /work
```

Build it with `docker build -t ceo-agent:latest .`. Then `ceo sandbox` reports the image as present.

### Authentication

Two things cross into the container.

Environment variables from a fixed allowlist, when set on the host: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and a few cloud selectors. No other host variable is passed.

The provider's own config directories, mounted read-only under `/root`. For claude these are `~/.claude` and `~/.claude.json`. For codex the directory is `$CODEX_HOME`, or `~/.codex` when that is unset. For gemini the directory is `~/.gemini`. A path that does not exist is skipped.

The mounts are read-only. A CLI cannot write session files there. Each container is also new. A session never survives a run.

### Files and permissions

The worktree is mounted read-write. The agent inside the container runs as root. On a Linux host, files the agent creates are owned by root. Docker Desktop on macOS maps ownership to the person's own account.

## ssh

Experimental. The behaviour and the settings can change.

The runner calls two hooks around the whole run.

1. Before the first turn: `ssh <host> -- mkdir -p <dir>`, then `rsync -a --delete <worktree>/ <host>:<dir>/`.
2. After the last turn, whatever happened: `rsync -a --delete <host>:<dir>/ <worktree>/`, then `ssh <host> -- rm -rf <dir>`.

Each turn runs `ssh <host> -- 'cd <dir> && <binary> <args>'`. The directory is `<CEO_SANDBOX_REMOTE_DIR>/ceo-<run id>`.

The copy back uses `--delete`. The worktree ends up identical to the remote directory. A failed copy back fails the run. The remote directory is removed regardless.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CEO_SANDBOX_HOST` | none | The ssh destination, such as `ci@build-box`. Required. |
| `CEO_SANDBOX_REMOTE_DIR` | `/tmp` | The parent of the remote directory. |
| `CEO_SSH_BIN` | `ssh` | The ssh binary. |
| `CEO_RSYNC_BIN` | `rsync` | The rsync binary. |

The remote host keeps its own CLI sign-in. No credential is sent over the connection, because a secret in a remote command line is visible to other users of that host. Only the environment a plan names itself is sent.

Readiness for ssh only checks that the host is set. The connection is not probed.

## Limits

No org tools inside a sandbox. The org MCP server reads the host ledger. A process in a container cannot reach the ledger. A sandboxed run gets no org tools. The compiled prompt leaves the tools out. The agent is never promised a tool that is absent. Notes from teammates are not delivered as follow-up turns either.

Session resume does not work. Every turn starts a new container. The config mounts are read-only. A chat that resumes a session needs the local sandbox.

Git inside the container is limited. A worktree's `.git` file points at a path on the host. That path does not exist in the container. The agent can edit files. Commands that need the repository's history may fail. CEO commits the worktree from the host when the run ends.

The network is on by default, because the model calls need it. Set `CEO_SANDBOX_NETWORK` to a restricted network to narrow it.

With `CEO_REQUIRE_STUBS` set, a sandbox launcher must be a stub. The test suite uses `tools/stub-docker` for this.
