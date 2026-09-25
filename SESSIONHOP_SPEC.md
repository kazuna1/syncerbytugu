# sessionhop — Build Specification

> Working name: `sessionhop` (placeholder — rename freely, but do NOT use "claude" in the package name; it's Anthropic's trademark. Say "for Claude Code" in the description instead.)

## 1. What we are building

An npm CLI package that syncs **Claude Code** conversation history between multiple computers through **one private git repo**, so a user can exit Claude Code on one PC and run `claude --resume` on another PC and continue the **exact same conversation**.

**Product promise: zero extra daily steps.**
- Setup per PC: `npm i -g sessionhop` → `sessionhop init <private-repo-url>`. Done.
- Daily: nothing. Exiting Claude auto-pushes (hook). A background task auto-pulls (every 5 min + at login). `claude --resume` just shows the sessions.

**Scope of v0:** Windows first (the author's machines are two Windows PCs). Code must be structured so macOS/Linux schedulers can be added later without refactoring.

## 2. Background: how Claude Code stores sessions

- Sessions live at `~/.claude/projects/<slug>/<sessionId>.jsonl` (`~` = `%USERPROFILE%` on Windows).
- Subagent transcripts may live in subfolders, e.g. `<slug>/<sessionId>/subagents/*.jsonl`. Sync **all `*.jsonl` files recursively** inside a slug folder, preserving relative paths.
- **Slug** = the project's absolute path with every non-alphanumeric character replaced by `-`.
  Example: `C:\dev\airhouse` → `C--dev-airhouse`.
- Each line of a `.jsonl` file is one JSON object. Most lines include a `"cwd"` field containing the project's absolute path. **Verify against real files before relying on field names** — open a real transcript first.
- Transcripts are **append-only**: a conversation only grows. The sync logic depends on this.
- `claude --resume` lists sessions from the slug folder matching the **current working directory**. So a pulled session must be written into the slug folder that matches the project's path **on this PC**.
- Only sync `~/.claude/projects/**/*.jsonl`. Do NOT sync auth, settings, plugins, or anything else in `~/.claude`.

## 3. Core concepts

### 3.1 Project identity (`identity.ts`)
Two PCs may keep the same project at different paths (`C:\dev\airhouse` vs `D:\code\airhouse`). Match them by **git remote**, not by path.

1. Get `cwd` from the transcript.
2. Run `git -C <cwd> remote get-url origin`.
3. Normalize to a **project key**:
   - strip protocol (`https://`, `ssh://`), strip `git@`, strip trailing `.git`
   - convert `host:owner/repo` (scp-style) to `host/owner/repo`
   - strip credentials (`user:token@`), strip port if present
   - lowercase
   - Examples: `git@github.com:KaZuNa1/AirHouse.git` and `https://github.com/kazuna1/airhouse` → `github.com/kazuna1/airhouse`
4. Fallback when no git / no remote / folder no longer exists: `name/<folder-basename-lowercased>`.
5. Repo folder name for a key: replace `/` and any unsafe char with `_` → `github.com_kazuna1_airhouse`.

### 3.2 Path rewriting (`transform.ts`)
- **Push:** replace this PC's project root path with the token `{{ROOT}}` in the file content.
- **Pull:** replace `{{ROOT}}` with this PC's local path for that project.
- Inside JSON, a Windows path appears **escaped**: `C:\dev\airhouse` is written as `C:\\dev\\airhouse`. It may also appear with forward slashes `C:/dev/airhouse`. Handle both forms with two distinct tokens: `{{ROOT_ESC}}` and `{{ROOT_FWD}}`.
- Match **case-insensitively** on Windows.
- Match only at a **path boundary**: the root must be followed by `\`, `/`, `"`, or end of string. So root `C:\dev\air` must NOT match inside `C:\dev\airhouse2`.
- Restore uses plain string replacement (not regex) to avoid `$` issues.
- **Acceptance test:** push-transform then pull-transform with the same root must be byte-identical to the original.
- Read/write files as UTF-8 **without BOM**; preserve line endings.

### 3.3 Merge rule (`transcripts.ts`)
Compare incoming vs existing destination file:
- destination missing → write
- incoming has **more lines** and destination is a **prefix** of incoming → write (normal case)
- equal content → skip
- destination has more lines and incoming is a prefix of it → skip (destination is newer)
- **neither is a prefix of the other** (user continued the same session on two PCs) → do NOT overwrite; write incoming as `<sessionId>.conflict-<machineId>.jsonl` next to it and log a warning
- Never overwrite a longer file with a shorter one. Never delete anything.
- Prefix comparison is done **after** path transformation into the same space.

### 3.4 Knowing where projects live on this PC (`registry.ts`)
Pull needs `projectKey → local path` on this machine. `~/.sessionhop/registry.json` stores this map, filled from three sources:
1. **At `init`:** scan roots for folders containing `.git`, depth 3–4. Default roots: `%USERPROFILE%`, plus `C:\dev`, `C:\projects`, `D:\` if they exist; user can add roots in config. Skip `node_modules`, `AppData`, `.git` internals, hidden/system folders. Must stay fast (< ~10 s); use a timeout.
2. **SessionStart hook:** `sessionhop register` records the current working directory (Claude runs hooks in the project folder; read the cwd from hook stdin JSON if provided, else `process.cwd()`).
3. **Existing local transcripts:** read their `cwd`.

If a project in the repo has no known local path on this PC → leave it in the repo, log it, try again next pull. Never guess a path.

## 4. Storage layout

### 4.1 Private sessions repo (the user creates it, one per user)
```
sessions/
  github.com_kazuna1_airhouse/
    3f2a…c91.jsonl
    3f2a…c91/subagents/…jsonl
  name_notes/
    …
machines.json      # { "<sessionId>": { "machine": "OFFICE-PC", "pushedAt": "ISO date" } }
README.md          # "Private. Managed by sessionhop. Do not make public."
```

### 4.2 Local state (each PC)
```
~/.sessionhop/
  config.json      # repoUrl, repoDir, machineId (default = hostname), scanRoots, intervalMinutes
  registry.json    # projectKey -> local absolute path
  repo/            # clone of the sessions repo
  sync.lock        # prevents push and scheduled pull from running at the same time
  log.txt          # all background activity (rotating, keep last ~1 MB)
```

## 5. CLI commands

| Command | Behavior |
|---|---|
| `sessionhop init <repo-url>` | Check git installed. Clone repo to `~/.sessionhop/repo` (if empty repo, create initial commit with README). Test **non-interactive** git access (`git ls-remote` with `GIT_TERMINAL_PROMPT=0`) — fail loudly with a clear fix message if it would prompt. Write config. Scan for projects. Install hooks. Register scheduled tasks. Run first push + pull. Print a short success summary. Idempotent: running twice is safe. |
| `sessionhop push [--quiet]` | Acquire lock → `git pull --rebase` → for each local session: compute key + local root, transform to tokens, merge into repo per §3.3 → update `machines.json` → commit (`"<machineId> push <ISO time>"`) and push only if something changed → release lock. On push rejection: pull --rebase and retry up to 3 times. |
| `sessionhop pull [--quiet]` | Acquire lock → `git pull --rebase` → for each project folder in repo with a known local path: transform tokens to local path, merge into `~/.claude/projects/<local-slug>/` per §3.3 → release lock. |
| `sessionhop register` | Called by SessionStart hook. Record cwd in registry. Must be **fast (<300 ms) and silent**; never fail loudly (exit 0 even on error, log it). |
| `sessionhop status` | Show machine ID, repo URL, last push/pull times, number of projects/sessions synced, unmapped projects, conflicts, whether hooks and scheduled tasks are installed. |
| `sessionhop uninstall` | Remove our hooks from settings.json, delete scheduled tasks, ask whether to delete `~/.sessionhop` (default: keep). Never touch `~/.claude/projects`. |

`--quiet` = no console output (log file only). All background invocations use `--quiet`.

## 6. Claude Code hooks (`hooks.ts`)

- File: `~/.claude/settings.json`. **Merge, never overwrite.** If the file doesn't exist, create it. If it's invalid JSON, abort and tell the user — never clobber it.
- Back up the file to `settings.json.sessionhop-backup` before the first modification.
- Add:
  - `SessionEnd` → `sessionhop push --quiet`
  - `SessionStart` → `sessionhop register`
- Format:
```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "sessionhop push --quiet" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "sessionhop register" } ] }
    ]
  }
}
```
- Identify our entries by the command string containing `sessionhop` so `uninstall` removes exactly those and nothing else. Don't add duplicates on re-init.
- Verify the current hooks schema against the official Claude Code docs before finalizing.

## 7. Background auto-pull (`scheduler/`)

- `scheduler/index.ts` exposes `install()`, `uninstall()`, `isInstalled()` and picks the OS implementation. v0 implements `windows.ts` only; other OSes throw a clear "not supported yet" error.
- **Windows:** use `schtasks` to create two tasks for the current user (no admin rights):
  - `sessionhop-pull-interval`: every 5 minutes → `sessionhop pull --quiet`
  - `sessionhop-pull-logon`: at logon → `sessionhop pull --quiet`
- **Must not flash a console window** every 5 minutes. Launch hidden, e.g. via `conhost.exe --headless <command>` or a small generated `.vbs` wrapper run by `wscript.exe` stored in `~/.sessionhop/`. Resolve the absolute path of the `sessionhop` executable / node + script so the task works without the user's PATH.
- Later (not v0): macOS `launchd` plist, Linux `systemd --user` timer or cron.

## 8. Locking (`lock.ts`)
- `~/.sessionhop/sync.lock` containing PID + timestamp.
- If lock exists and is younger than 2 minutes and the PID is alive → skip this run quietly (scheduled pull) or wait up to 30 s (push from hook).
- Stale lock (older than 2 min or dead PID) → take it over.
- Always release in `finally`.

## 9. Git (`gitRepo.ts`)
- Use `child_process.execFile('git', args, { cwd })` — never build shell strings.
- Env for all background git calls: `GIT_TERMINAL_PROMPT=0` so it fails instead of hanging on a prompt.
- Use the user's existing git credentials (SSH key or credential manager). Never store tokens ourselves.

## 10. File structure
```
sessionhop/
  package.json          # "bin": { "sessionhop": "dist/cli.js" }, "type": "module", engines node >= 18
  tsconfig.json
  README.md
  src/
    cli.ts              # entry; first line of built file must be: #!/usr/bin/env node
    config.ts
    claudePaths.ts      # locate ~/.claude/projects, compute slugs; honor SESSIONHOP_CLAUDE_DIR env override
    identity.ts
    registry.ts
    transform.ts
    transcripts.ts
    gitRepo.ts
    sync.ts             # push() and pull()
    lock.ts
    hooks.ts
    log.ts
    scheduler/
      index.ts
      windows.ts
  test/
    transform.test.ts
    identity.test.ts
    transcripts.test.ts
```

## 11. Constraints
- **TypeScript, Node ≥ 18, ESM.**
- **Near-zero runtime dependencies.** Use Node built-ins (`fs`, `path`, `os`, `child_process`). Optional: one small CLI parser. People must be able to read the whole codebase and trust it with their private chats.
- Tests with Node's built-in test runner (`node --test`) or vitest as a dev dependency.
- Never delete or truncate user transcripts. Never touch files outside `~/.claude/projects/**/*.jsonl`, `~/.claude/settings.json` (hooks only), and `~/.sessionhop/`.
- Background runs must never show windows, never prompt, never crash noisily. Log everything.

## 12. Development safety
- **Before any testing, back up `~/.claude/projects`.**
- Env var `SESSIONHOP_CLAUDE_DIR` overrides the Claude directory, and `SESSIONHOP_HOME` overrides `~/.sessionhop`. Use them to test against copies, never your real chats.
- Use a **local bare repo** for testing instead of GitHub: `git init --bare C:\tmp\test-sessions.git`.
- Use `npm link` in the project folder to make the `sessionhop` command point to the dev build.

## 13. Build order (test each step before the next)
1. `claudePaths` + `transcripts` read side → command that lists every session: slug, sessionId, cwd, line count.
2. `identity` → print project key per session. Unit-test URL normalization.
3. `transform` → round-trip test: must be byte-identical. Test boundary cases (`C:\dev\air` vs `C:\dev\airhouse2`), escaped + forward-slash forms, mixed case drive letters.
4. `push` into the local bare repo. Inspect repo contents manually.
5. `pull` into a **second fake Claude dir** where the same project has a **different path**. Then, in that path, run `claude --resume` and confirm the session appears and continues.
6. Merge rule tests: newer, older, equal, diverged (conflict file created).
7. `lock`, `register`, `hooks` (test against a copy of settings.json).
8. Windows scheduler: tasks created, run hidden, `uninstall` removes them.
9. `init` + `uninstall` end-to-end.
10. Real test between two PCs using a private GitHub repo.

## 14. Definition of done (v0)
- On PC A: `sessionhop init <url>`, work in Claude Code, exit.
- On PC B (after its own one-time init): within 5 minutes, without typing any sync command, `cd` into the project (any path) → `claude --resume` shows the PC A session → it continues with full history.
- Continuing the same session on both PCs produces a conflict file and a warning, never data loss.
- `sessionhop uninstall` leaves the system as it was (except the kept `~/.sessionhop` if chosen).

## 15. Known limitations (document in README)
- Exit Claude on one PC before resuming on the other; diverged sessions become conflict files, not merges.
- Only conversation transcripts sync — not login, settings, MCP auth, or plugins.
- The sessions repo **must be private**: transcripts contain everything typed or pasted into Claude.
- The Claude Code Desktop app may not list sessions synced from another machine; use the CLI `claude --resume`.
