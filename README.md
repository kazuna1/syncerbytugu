# syncerbytugu

Sync **Claude Code** conversation history between your computers through one **private** git repo.
Exit Claude Code on one PC, run `claude --resume` on the other, and continue the exact same conversation.

> Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Setup (once per PC)

1. Create an **empty private** repo on GitHub (e.g. `my-claude-sessions`). One repo for all your PCs.
2. Make sure plain `git clone <that-url>` works on each PC without a password prompt
   (Git Credential Manager for HTTPS, or an SSH key).
3. On every PC:

```sh
npm install -g syncerbytugu
syncerbytugu init https://github.com/<you>/my-claude-sessions.git
```

That's it. Daily use needs no commands:

- **Exiting Claude Code** pushes your sessions (a `SessionEnd` hook).
- **Every 5 minutes and at logon** a hidden background task pushes and pulls.
- **Starting Claude Code** in a folder records where that project lives on this PC (a `SessionStart` hook).

On the other PC, `cd` into the project (it can be at a different path) and run `claude --resume`.

## Commands

| Command | What it does |
|---|---|
| `syncerbytugu init <repo-url>` | One-time setup. Safe to run again. `--machine <name>` sets this PC's name. |
| `syncerbytugu status` | Machine, repo, last push/pull, unmapped projects, conflicts, what's installed. |
| `syncerbytugu sync` | Push then pull now. |
| `syncerbytugu push` / `pull` | One direction only. |
| `syncerbytugu list` | Local sessions and the project key each maps to. |
| `syncerbytugu uninstall` | Removes the hooks and scheduled tasks. Asks before deleting `~/.syncerbytugu`. Never touches your transcripts. |

## How it works

- Claude Code stores sessions in `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the slug is the project path.
  Only those `*.jsonl` files are synced. Login, settings, MCP, and plugins are never synced.
- Projects are matched across PCs by their **git remote** (`git@github.com:you/app.git` and
  `https://github.com/you/app` are the same project), so `C:\dev\app` on one PC and `D:\code\app` on the other both work.
  Folders without a git remote inside your home folder (Desktop, Downloads, ...) are matched by their path relative
  to home; other folders without a remote are matched by folder name.
- On push, this PC's project path inside the transcript is replaced with a placeholder. On pull, it becomes the other PC's path.
- Transcripts only grow. The longer version wins when the shorter one is a prefix of it.
  If the same session was continued on both PCs, nothing is overwritten. The other copy is saved next to yours as
  `<session>.conflict-<machine>.jsonl`, and a warning is logged.
- State lives in `~/.syncerbytugu/`: `config.json`, `registry.json` (project → local folder), `repo/` (clone), `log.txt`.

## Known limitations

- **Exit Claude on one PC before resuming on the other.** If a session diverges, you get a conflict file, not a merge.
- **The sessions repo must be private.** Transcripts contain everything you typed or pasted into Claude.
  `init` refuses a public GitHub repo.
- A project that has never been opened or cloned on a PC can't be mapped there yet. Open it once in Claude Code (or clone
  it), and the next sync picks it up. `status` lists these projects.
- Background auto-sync is Windows-only in v0 (one hidden scheduled task, runs on battery too). On macOS/Linux, the exit hook still pushes. Run `syncerbytugu pull`
  yourself or from cron.
- The Claude Code Desktop app may not list sessions synced from another machine. Use the CLI `claude --resume`.

## Development

```sh
npm install
npm run build
npm test
npm link            # makes `syncerbytugu` point at this checkout
```

Test against copies, never your real chats. `SYNCERBYTUGU_CLAUDE_DIR` overrides `~/.claude`, and `SYNCERBYTUGU_HOME`
overrides `~/.syncerbytugu`. Use a local bare repo (`git init --bare C:\tmp\test-sessions.git`) instead of GitHub.
