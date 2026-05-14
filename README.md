# agent-be-gone

Scrub AI coding agents (Copilot, Claude, Cursor, Devin, Codex, Aider, …) from
your git history. Reattributes commits authored or committed by known agents
to **you**, and strips matching `Co-authored-by:` trailers from commit
messages.

Zero dependencies. One file. Uses git's built-in `filter-branch`.

## Quickstart

In any git repo with a clean working tree:

```bash
npx agent-be-gone --dry-run     # see what would change
npx agent-be-gone               # rewrite (asks for confirmation)
npx agent-be-gone --yes --push  # rewrite + force-push, no prompts
```

## Options

| Flag | Description |
|---|---|
| `-n, --dry-run` | Print affected commits, don't rewrite. |
| `-y, --yes` | Skip the confirmation prompt. |
| `--push` | `git push --force` after a successful rewrite. |
| `--branch <ref>` | Only rewrite this branch (default: current). |
| `--all` | Rewrite **all** refs. |
| `--name <name>` | Replacement author/committer name. Default: `git config user.name`. |
| `--email <addr>` | Replacement author/committer email. Default: `git config user.email`. |
| `--add <pattern>` | Extra case-insensitive regex pattern to match. Repeatable. |
| `--only <list>` | Comma-separated patterns to use **instead of** the built-ins. |
| `-h, --help` | Show help. |

## Built-in patterns

Matches (case-insensitive) the author/committer name+email and
`Co-authored-by:` trailers against:

```
copilot, claude, anthropic, chatgpt, openai, codex,
cursor, devin, aider, ghostwriter, sourcegraph, \bcody\b,
tabnine, \bbard\b, \bgemini\b, ai-bot, ai-agent, \bllm\b
```

Add more with `--add`, e.g. `--add "mybot" --add "internal-ai"`.

## What it actually does

For every commit on the chosen scope:

1. If the **author** name+email matches any pattern → rewrite to your
   `--name`/`--email` (or `git config user.name` / `user.email`).
2. Same for the **committer**.
3. Drop any `Co-authored-by: …` line whose value matches any pattern.
4. Collapse trailing blank lines from rewritten messages.
5. Clean up the `refs/original/*` backups `filter-branch` leaves behind.

## Caveats

- **Rewrites history.** If others have based work on the rewritten commits,
  coordinate before `--push`.
- Requires a clean working tree. Stash or commit first.
- `filter-branch` is technically deprecated upstream but ships with every
  git install. We set `FILTER_BRANCH_SQUELCH_WARNING=1` to keep output
  tidy. If you prefer `git-filter-repo`, run that yourself.
- The match is a regex against `Name <email>` and against each
  `Co-authored-by:` line. Tune with `--add` / `--only` if needed.

## License

MIT
