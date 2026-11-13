// What a LayerFS project session's agent is told about its project, in the runtime
// context (the `layerfs:workspace` system-prompt context). Kept apart so it can be
// tested without a host.

/** The binding fields the text names. */
export interface PromptBinding {
  project?: string
  machine?: string
  branch?: string
  sandbox?: string
  ws?: string
  scratch: string
  state?: string
}

export interface PromptOptions {
  /** Whether turn checkpoints are on (`checkpoints: turn`). */
  checkpoints: boolean
  /** Whether the agent is a subagent sharing its parent's Workspace. */
  subagent?: boolean
}

const q = (value: string | undefined, missing = 'not set yet') => value ? JSON.stringify(value) : `(${missing})`

/** The `## LayerFS project session` block for a bound (or binding) project session. */
export function projectContext(b: PromptBinding, options: PromptOptions): string {
  const sandbox = b.sandbox ?? b.ws?.split(':')[0]
  const lines = [
    '## LayerFS project session',
    'This conversation works on a LayerFS project. The project\'s files are **not** in the local working directory: they live in LayerFS, on the session Branch. Local commands such as `ls`, `cat` or `git status` see only the local working directory.',
    '',
    '| Setting | Value | In bash |',
    '| --- | --- | --- |',
    `| Project | ${q(b.project)} | \`$DSH_LAYERFS_PROJECT\` |`,
    `| Machine | ${q(b.machine, 'unknown')} | |`,
    `| Session Branch (the project as this conversation has it) | ${q(b.branch)} | \`$DSH_LAYERFS_BRANCH\` |`,
    `| Session Sandbox (where you mount Workspaces to run commands; at most 16) | ${q(sandbox, 'not running')} | \`\${DSH_LAYERFS_WS%%:*}\` |`,
    `| dsh's Workspace (records checkpoints; leave it alone) | ${q(b.ws, 'not mounted yet')} | \`$DSH_LAYERFS_WS\` |`,
    `| Local working directory (scratch, never saved) | ${q(b.scratch)} | \`pwd\` |`,
    '| LayerFS command / Node SDK | | `$DSH_LAYERFS_CLI` / `$DSH_LAYERFS_SDK` |',
    '',
    '- **Load the `dsh-layerfs` skill before your first LayerFS call.** It has the commands, the Node SDK, history, Branches, subagents, conflicts and limits.',
    '- **Files:** read, search and change them with `file` calls on the session Branch (`file read`, `file grep`, `file edit`, `file write`, `file apply`); each change is saved at once. Use a command instead only for a batch change with logic (a codemod, a formatter, a generator).',
    '- **Commands** (build, test, install, git) run in a Workspace you mount on the session Branch in the session Sandbox, usually one per bash call: mount, exec, commit, unmount. Use paths relative to the Workspace root, never its mount path.',
    '- **Installs and caches** (`node_modules`, `.venv`, Cargo\'s home and `target/`, tool caches) go inside the Workspace and are committed, so the next mount has them: never install into `HOME` or `/tmp`.',
    options.checkpoints && options.subagent
      ? '- **Checkpoints:** your `file` changes and Workspace Commits are saved on the session Branch at once; the main agent\'s turn end marks the checkpoint. Your own turns record none.'
      : options.checkpoints
      ? '- **Checkpoints:** your `file` changes and Workspace Commits are saved on the session Branch at once. At the end of every turn in which it moved, dsh records a checkpoint the user can restore; after a restore the session Branch has a new name, shown here.'
      : '- **Checkpoints are off:** your `file` changes and Workspace Commits are still saved on the session Branch; no restore points are recorded.',
    options.subagent
      ? '- **You are a subagent:** you share this project, Branch and Sandbox with the agent that started you. Work only on the files and Branch you were given, mount Workspaces under the names you were given, and report what you changed and committed.'
      : '- **Subagents** you start share this project, Branch and Sandbox, and its 16 Workspace slots. Give each one its own files, Branch and Workspace names as the skill describes.',
    '- **Local working directory:** the user\'s folder, possibly shared with other sessions. Use it for temporary files only and never clear it; nothing in it reaches the project.',
    '- **Leave alone:** never exec in, commit or unmount dsh\'s Workspace, and never create or close Sandboxes: dsh manages them. Unmount every Workspace you mounted before your turn ends. Work only in this project; machines, Stores, backups and other projects are the user\'s. The LayerFS paths the file policy lists as writable are for the LayerFS command itself: never read, write or `cd` into them directly.',
  ]
  return lines.join('\n')
}
