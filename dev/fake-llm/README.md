# fake-llm (dev only)

A scripted, offline, key-less LLM provider for end-to-end tests of dsh-layerfs. It
is a plain-ESM cordis function plugin (`index.js`) that subclasses `LlmAdapter`
from `@deepseek-ai/dsh-llm` and registers it with
`ctx.llm.registerAdapter(['fake'], adapter)`. The adapter advertises one model,
`fake/scripted` ("Fake scripted"), through `listModels()`, so the Web UI model
picker lists it under the provider "Fake (dev)". No network, no credentials.

Never ship it: it is loaded only by `dev/fake-llm.overlay.yml`.

## Use

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
DSH_LAYERFS_DEV_DIR=$PWD/.dev-fakellm \
DSH_LAYERFS_DEV_OVERLAY=$PWD/dev/fake-llm.overlay.yml \
  node scripts/dev.mjs --port 3095
DSH_LAYERFS_DEV_DIR=$PWD/.dev-fakellm node tools/e2e-chat.mjs   # one turn, prints JSON
```

The overlay (`dev/fake-llm.overlay.yml`):

- inserts this plugin by absolute path (edit the path if the checkout moves);
- patches `agent-default-model` to `fake/scripted`, so new sessions use it;
- patches `workspace-controller.documentsDirectory` to `$DSH_HOME/../documents`,
  so the first-use "Default workspace" is
  `<dev dir>/documents/deepseek-harness/default-workspace` instead of `~/Documents`;
- sets `autoApprove` (see below).

To pick it manually: composer model button → "Fake scripted".

## Script

The adapter reads the latest human user message (`role: user`, `source.kind: user`):

| Message line | Step 1 response |
|---|---|
| `bash: <command>` | one `bash` tool call `{description, command}` |
| `bash!: <command>` | `bash` call that also asks for the widest advertised `sandbox_permissions` escalation (triggers an approval prompt) |
| `write: <path> <text>` | one `write` tool call `{file_path, content}` (`\n` in text becomes a newline) |

All matching lines in one message become parallel tool calls in one assistant
step (finish `tool-calls`). Once tool results follow that user message, the next
step answers `done: <n> commands` (`(<k> failed)` appended when results are
errors) and stops. A message without such lines gets `echo: <message>` and
stops. Auxiliary calls (`options.purpose` set, e.g. session titles) get
`Fake session`. Text streams as `block-start` / `text-delta` (16-char pieces) /
`block-end`, then `usage`, then `finish`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `provider` | `fake` | provider route |
| `model` | `scripted` | advertised model id (any id is served) |
| `autoApprove` | `false` | prepend an `approval/request` listener answering `allowed-once` |
| `chunkDelayMs` | `0` | delay between streamed chunks |

The overlay sets `autoApprove` true unless `DSH_FAKE_LLM_AUTO_APPROVE=0` is in the
dev server's environment. Under the default `workspace-write` + `ask` policy plain
`bash:` commands inside the workspace never prompt; only `bash!:` escalations do.
`runTurn(page, { approve: 'click' })` (default) also clicks "Allow once" when a
prompt is shown, so either mechanism works; `approve: 'none'` leaves prompts.
