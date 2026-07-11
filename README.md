# codexswitch

**English** | [한국어](README.ko.md)

**Register multiple OpenAI Codex CLI accounts, switch between them with a single command, and automatically rotate to the next account when you hit a usage limit.**

Inspired by [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude) (a multi-account tool for Claude), adapted for the Codex CLI. Supports macOS / Windows / Linux, requires only Node.js, and has zero external dependencies.

## Who is this for?

- You have two or more ChatGPT accounts (personal/work, Plus/Pro, ...) and want to use Codex across them
- You want to **continue working on another account automatically** when one account hits its usage limit
- You are tired of repeating `codex logout` → `codex login` every time

The Codex CLI stores credentials in a single file (`auth.json`), so out of the box it only supports one account. codexswitch removes that limitation.

---

## 1. Prerequisites

Two things must be installed first.

### ① Node.js (v18+)

If `node --version` prints `v18` or higher, skip this step.

- **macOS**: download the LTS installer (.pkg) from [nodejs.org](https://nodejs.org/), or with Homebrew:
  ```bash
  brew install node
  ```
- **Windows**: download the LTS installer (.msi) from [nodejs.org](https://nodejs.org/) and run it. The default options are fine.

### ② Codex CLI

- **macOS** — in Terminal (Applications → Utilities → Terminal):
  ```bash
  npm install -g @openai/codex
  ```
- **Windows** — in PowerShell (search "PowerShell" in the Start menu):
  ```powershell
  npm install -g @openai/codex
  ```
  > Note: native Windows support in the Codex CLI is experimental; OpenAI recommends WSL (Windows Subsystem for Linux). If you use WSL, just follow the macOS/Linux instructions inside your WSL terminal.

Verify:

```bash
codex --version
```

---

## 2. Install codexswitch

Same command on macOS (Terminal) and Windows (PowerShell):

```bash
npm install -g @carjms/codexswitch
```

Verify:

```bash
codexswitch help
```

If you see the help text, you are done. `codexswitch` and the short alias `cxs` behave identically (the examples below use `cxs`).

---

## 3. Getting started (5 minutes)

A full walkthrough: register two accounts and switch between them.

### 3-1. Register the account you are already logged in with

If you have run `codex login` before, import that account as-is:

```bash
cxs import
```

```
added account "me@gmail.com" (me@gmail.com, plus)
set "me@gmail.com" as the active account
```

To pick your own name, append it: `cxs import personal`.

> Never logged in? Skip to 3-2.

### 3-2. Log in with a second account

```bash
cxs login work
```

A browser opens — log in with the **account you want to add**. (If your browser is already signed in to another account, switch accounts on the login screen.)

> This happens in an isolated temporary profile, so **your existing login is untouched.**

### 3-3. List registered accounts

```bash
cxs list
```

```
   name          email             plan  prio  status  token refreshed
-  ------------  ----------------  ----  ----  ------  ----------------
*  me@gmail.com  me@gmail.com      plus  0     ok      2026-07-08 09:12
   work          work@company.com  pro   0     ok      2026-07-08 09:15
```

`*` marks the active account.

### 3-4. Switch accounts

```bash
cxs use work
```

From now on, plain `codex` runs as the work account. Switch back with `cxs use me@gmail.com`, or cycle with `cxs next`.

### 3-5. Run with automatic limit rotation (the key feature)

```bash
cxs exec "write tests for this project"
```

While running `codex exec`, if the account **hits a usage limit**:

1. The account is marked "limited" for a while (times like "try again in 2 hours" in the error message are parsed automatically)
2. The next usable account **resumes the same session** (`codex exec resume`) and continues from where it stopped — no restarting from scratch (opt out with `--no-resume`)
3. It only stops when every account is exhausted

```
[codexswitch] exec as "me@gmail.com"
... (usage limit reached mid-run) ...
[codexswitch] "me@gmail.com" hit a usage/rate limit (paused until 2026-07-08 14:30) — rotating
[codexswitch] exec as "work" (attempt 2)
... (work continues) ...
```

`cxs exec` also adds `--skip-git-repo-check` automatically, so it works in folders that are not git repositories.

### 3-6. Run one account without switching

Leave the globally active account alone and run a different account just this once:

```bash
cxs run work            # interactive codex as "work"
cxs run work exec "..." # codex exec as "work"
```

Each account runs in its own isolated environment, so you can even **open two terminals and run codex as two different accounts simultaneously.** (Config and session history are shared.)

### 3-7. Set the rotation order and a default model

Set the rotation order in one command. `exec` and `next` follow this order afterwards:

```bash
cxs order work me@gmail.com   # use "work" first, then me@gmail.com
cxs order                     # show the current order
```

Set a default model to inject into every `run`/`exec` (an explicit `-m` always wins):

```bash
cxs model gpt-5.2-codex   # set the default model
cxs model                 # show the current setting
cxs model default         # reset to the codex default
```

### 3-8. Register an OpenAI API-key account

You can also register an account billed through API credits (Platform) instead of a ChatGPT subscription:

```bash
cxs add-key api-account sk-your-api-key
```

> Tip: to keep the key out of your shell history, omit it and pass it via the environment:
> `OPENAI_API_KEY=sk-... cxs add-key api-account`

### 3-9. Usage thresholds (rotate before hitting the wall)

Accounts whose recorded 5-hour/weekly usage reaches the configured percentage are skipped in rotation automatically (default 95%):

```bash
cxs threshold 90        # both 5h and weekly at 90%
cxs threshold 90 98     # 5h at 90%, weekly at 98%
cxs threshold           # show current settings
cxs list                # per-account 5h/week usage columns
```

> Usage numbers are read from what codex records in its session files. Some codex versions do not record them in `exec` mode; in that case they refresh after interactive runs (`cxs run`). Without numbers, rotation still works via limit-error detection.

---

## 4. All commands

| Command | Description |
|---|---|
| `cxs login [name]` | Log in to a new account and store it (existing login untouched; defaults to the email as the name) |
| `cxs import [name]` | Import the account currently in `~/.codex` |
| `cxs add-key <name> [key]` | Register an OpenAI API-key account (falls back to `$OPENAI_API_KEY`) |
| `cxs list` | List accounts: active marker, email, plan, priority, limit status, usage % |
| `cxs usage [name]` | Per-account usage dashboard: 5h/weekly gauge bars, reset countdowns, next rotation pick (alias: `status`) |
| `cxs chat` | **Interactive prompt loop (Claude Code-style)**: each turn runs through rotation and resumes the same codex session, so the conversation survives account switches. Slash commands inside: `/usage /use /next /model /new /quit` |
| `cxs watch` | Live interactive dashboard — refreshes every 5s; keys: `↑/↓` select, `s` switch, `e` enable/disable, `p` probe, `q` quit |
| `cxs probe [name]` | Warm up the usage gauges with one minimal request per account (costs a few tokens) |
| `cxs log [count]` | Recent activity: account switches, limits hit, rotations, probes |
| `cxs use <name>` | Switch the active account |
| `cxs current` | Show the active account |
| `cxs next` | Switch to the next account in rotation order (wraps around) |
| `cxs run [name] [args...]` | Run codex as a specific account without switching (isolated env) |
| `cxs exec [args...]` | `codex exec` + automatic rotation on usage limits — the next account resumes the same session; works outside git repos |
| `cxs exec -a <name> ...` | Start exec with a specific account (`--no-resume`: restart instead of resuming) |
| `cxs order [names...]` | Pin the rotation order; unlisted accounts rotate by **soonest weekly reset** (use-or-lose) |
| `cxs model [name]` | Set the default model injected into `run`/`exec` (`default` to reset) |
| `cxs threshold [5h%] [wk%]` | Rotate to the next account when usage reaches these percents (default 95; one value sets both) |
| `cxs patterns [add/remove]` | Custom regex patterns treated as rate-limit errors |
| `cxs export <file>` | Back up all accounts + settings (⚠️ contains tokens — treat like a password) |
| `cxs restore <file>` | Restore accounts from a backup (for moving machines) |
| `cxs completion <bash\|zsh>` | Print a shell completion script |
| `cxs <anything else>` | Forwarded to codex under the managed account — `cxs resume`, `cxs goal ...`, `cxs apply` all work like their codex counterparts |
| `cxs remove <name>` | Delete an account |
| `cxs rename <old> <new>` | Rename an account |
| `cxs disable / enable <name>` | Temporarily exclude from / restore to rotation |
| `cxs priority <name> <n\|auto>` | Pin one account's priority, or `auto` to unpin (use-or-lose rotation) |
| `cxs clear-limit <name>` | Manually clear a recorded rate-limit |
| `cxs cooldown [minutes]` | Show/set the default cooldown after a limit is detected (default 60) |
| `cxs sync` | Save tokens refreshed by codex back into the store |

---

## 5. FAQ / Troubleshooting

**Q. `codexswitch: command not found`.**
The npm global bin directory is not on your PATH. **Close and reopen your terminal/PowerShell.** If that does not help, add the path printed by `npm config get prefix` (on macOS, its `bin` subfolder) to your PATH.

**Q. `EACCES` permission error during `npm install -g` on macOS.**
Install with `sudo npm install -g @carjms/codexswitch`, or better, install Node.js via [nvm](https://github.com/nvm-sh/nvm), which avoids the permission problem entirely.

**Q. `codex CLI not found`.**
The Codex CLI is not installed or not on your PATH. Run `npm install -g @openai/codex` and try again. If it is installed somewhere unusual, point the `CODEX_SWITCH_CODEX_BIN` environment variable at the binary.

**Q. `Not inside a trusted directory and --skip-git-repo-check was not specified.`**
This is a Codex CLI safety check: `codex exec` refuses to run in folders that are not git repositories. **Since v0.2.0, `cxs exec` adds this flag automatically, so you should not see this error.** For interactive runs (`cxs run`), codex itself asks "do you trust this folder?" — just approve it.

**Q. Do I lose sessions or settings when I switch accounts?**
No. Only the **credentials (auth.json)** are swapped. `config.toml`, session history, skills, etc. are shared across all accounts.

**Q. Does `run`/`exec` work on Windows?**
Yes. Internally, macOS/Linux use symlinks and Windows uses directory junctions (no admin rights needed). For complete file sharing we recommend enabling Windows **Settings → Developer Mode**, but even without it, a copy-based fallback keeps everything working.

**Q. I want to use a limited account again right now.**
Clear it with `cxs clear-limit <name>`.

**Q. Can account names contain non-ASCII characters (e.g. Korean)?**
Yes. Letters from any language, digits, spaces, and `@ . _ + -` are allowed.

**Q. Is using multiple accounts against the terms of service?**
Use this to switch between accounts you legitimately own (e.g. a personal and a work account). Abusing accounts to evade usage limits may violate OpenAI's terms of service; you are responsible for how you use it.

---

## 6. Where data is stored

| Item | macOS/Linux | Windows |
|---|---|---|
| Account store | `~/.codex-switch/` | `C:\Users\<you>\.codex-switch\` |
| Codex config | `~/.codex/` | `C:\Users\<you>\.codex\` |

```
.codex-switch/
├── meta.json              # active account, order/priorities, limit states, settings
├── accounts/<name>.json   # per-account copy of auth.json (mode 600)
└── profiles/<name>/       # per-account isolated env used by run/exec
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_SWITCH_HOME` | `~/.codex-switch` | Account store location |
| `CODEX_HOME` | `~/.codex` | The codex config dir codexswitch manages |
| `CODEX_SWITCH_CODEX_BIN` | `codex` | Path to the codex binary |

- macOS/Linux: `export CODEX_SWITCH_HOME=/your/path`
- Windows PowerShell: `$env:CODEX_SWITCH_HOME = "D:\your\path"` (persist with `setx`)

---


## Development

```bash
git clone https://github.com/JIMyungSik/codexswitch.git
cd codexswitch
npm link       # link the local dev version as a global command
npm test       # full-flow test against a fake codex binary (never touches your real ~/.codex)
```

## License

MIT
