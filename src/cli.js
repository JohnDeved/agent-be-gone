#!/usr/bin/env node
// agent-be-gone — scrub AI coding agents from git history.
// Zero dependencies. Uses git's built-in `filter-branch`.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const BUILTIN_PATTERNS = [
  // GitHub Copilot
  'copilot',
  // Anthropic / Claude
  'claude',
  'anthropic',
  // OpenAI / ChatGPT / Codex
  'chatgpt',
  'openai',
  'codex',
  // Cursor
  'cursor',
  // Devin
  'devin',
  // Aider
  'aider',
  // Replit Ghostwriter
  'ghostwriter',
  // Sourcegraph Cody
  'sourcegraph',
  '\\bcody\\b',
  // Tabnine
  'tabnine',
  // Google
  '\\bbard\\b',
  '\\bgemini\\b',
  // Generic
  'ai-bot',
  'ai-agent',
  '\\bllm\\b',
]

const FLAG_SPEC = [
  { keys: ['-h', '--help'], field: 'help', kind: 'bool' },
  { keys: ['-n', '--dry-run'], field: 'dryRun', kind: 'bool' },
  { keys: ['-y', '--yes'], field: 'yes', kind: 'bool' },
  { keys: ['--push'], field: 'push', kind: 'bool' },
  { keys: ['--all'], field: 'all', kind: 'bool' },
  { keys: ['--branch'], field: 'branch', kind: 'value' },
  { keys: ['--name'], field: 'name', kind: 'value' },
  { keys: ['--email'], field: 'email', kind: 'value' },
  { keys: ['--add'], field: 'extra', kind: 'append' },
  { keys: ['--only'], field: 'only', kind: 'csv' },
]

function defaultArgs () {
  return {
    dryRun: false, yes: false, push: false, branch: null, all: false,
    name: null, email: null, extra: [], only: null, help: false,
  }
}

const FLAG_HANDLERS = {
  bool: (args, spec) => { args[spec.field] = true; return 0 },
  value: (args, spec, argv, i) => { args[spec.field] = argv[i + 1]; return 1 },
  append: (args, spec, argv, i) => { args[spec.field].push(argv[i + 1]); return 1 },
  csv: (args, spec, argv, i) => {
    args[spec.field] = (argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return 1
  },
}

function rejectUnknownFlag (token) {
  if (token.startsWith('-')) { console.error(`Unknown flag: ${token}`); process.exit(2) }
}

function parseArgs (argv) {
  const args = defaultArgs()
  const byKey = new Map(FLAG_SPEC.flatMap(s => s.keys.map(k => [k, s])))
  for (let i = 0; i < argv.length; i++) {
    const spec = byKey.get(argv[i])
    if (!spec) { rejectUnknownFlag(argv[i]); continue }
    i += FLAG_HANDLERS[spec.kind](args, spec, argv, i)
  }
  return args
}

function printHelp () {
  console.log(`agent-be-gone — scrub AI coding agents from git history

USAGE
  npx agent-be-gone [options]

WHAT IT DOES
  Rewrites the current git repository so that:
    • commits authored or committed by known AI agents are reattributed
      to you (or a name/email you specify), and
    • "Co-authored-by:" trailers naming those agents are removed from
      commit messages.

OPTIONS
  -n, --dry-run         Show what would change, don't rewrite anything.
  -y, --yes             Skip the confirmation prompt.
      --push            git push --force after a successful rewrite.
      --branch <ref>    Rewrite only this branch (default: current branch).
      --all             Rewrite all refs (--all). Overrides --branch.
      --name <name>     Replace author/committer name with this.
                        Default: git config user.name
      --email <addr>    Replace author/committer email with this.
                        Default: git config user.email
      --add <pattern>   Add a custom case-insensitive regex pattern to
                        match against author/committer name+email and
                        Co-authored-by trailers. Repeatable.
      --only <list>     Comma-separated list of patterns to use INSTEAD
                        of the built-in set (still combined with --add).
  -h, --help            Show this help.

EXAMPLES
  npx agent-be-gone --dry-run
  npx agent-be-gone --yes --push
  npx agent-be-gone --add "mybot" --add "internal-ai"
  npx agent-be-gone --only copilot,claude --branch main

BUILT-IN PATTERNS
  ${BUILTIN_PATTERNS.join(', ')}

NOTES
  • Requires git (>=2.22 recommended).
  • Uses \`git filter-branch\`. Filter-branch is technically deprecated
    upstream but ships with every git install. No external deps needed.
  • Rewrites history. Coordinate with collaborators before --push.
`)
}

function git (args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

function gitOk (args) {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  return r.status === 0
}

function ensureRepo () {
  if (!gitOk(['rev-parse', '--git-dir'])) {
    console.error('error: not inside a git repository')
    process.exit(1)
  }
  if (!gitOk(['rev-parse', '--verify', 'HEAD'])) {
    console.error('error: repository has no commits yet')
    process.exit(1)
  }
}

function ensureClean () {
  const status = git(['status', '--porcelain'])
  if (status.length > 0) {
    console.error('error: working tree is not clean. Commit or stash changes first.')
    process.exit(1)
  }
}

function buildRegex (patterns) {
  // case-insensitive OR of all patterns
  return new RegExp(patterns.join('|'), 'i')
}

function listCommits (range) {
  // Use unit separator and record separator for safe parsing.
  const sep = '\x1f'
  const rec = '\x1e'
  const fmt = ['%H', '%an', '%ae', '%cn', '%ce', '%B'].join(sep) + rec
  const out = git(['log', '--pretty=format:' + fmt, range])
  return out.split(rec).map(s => s.trim()).filter(Boolean).map(chunk => {
    const [hash, an, ae, cn, ce, ...rest] = chunk.split(sep)
    return { hash, an, ae, cn, ce, body: rest.join(sep) }
  })
}

function findAffected (commits, re) {
  const out = []
  for (const c of commits) {
    const inAuthor = re.test(`${c.an} <${c.ae}>`)
    const inCommitter = re.test(`${c.cn} <${c.ce}>`)
    const trailerLines = c.body.split(/\r?\n/).filter(l => /^Co-authored-by:/i.test(l))
    const matchedTrailers = trailerLines.filter(l => re.test(l))
    if (inAuthor || inCommitter || matchedTrailers.length > 0) {
      out.push({ ...c, inAuthor, inCommitter, matchedTrailers })
    }
  }
  return out
}

async function confirm (msg) {
  const rl = createInterface({ input: stdin, output: stdout })
  const ans = await rl.question(`${msg} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(ans.trim())
}

function buildEnvFilter (patterns, name, email) {
  // Bash snippet executed for each commit.
  // Patterns are joined into one extended-regex alternation.
  const re = patterns.join('|')
  // Single-quote-safe escape:
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`
  return `
re=${sq(re)}
NEW_NAME=${sq(name)}
NEW_EMAIL=${sq(email)}
if printf '%s <%s>' "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" | grep -Eqi -- "$re"; then
  export GIT_AUTHOR_NAME="$NEW_NAME"
  export GIT_AUTHOR_EMAIL="$NEW_EMAIL"
fi
if printf '%s <%s>' "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL" | grep -Eqi -- "$re"; then
  export GIT_COMMITTER_NAME="$NEW_NAME"
  export GIT_COMMITTER_EMAIL="$NEW_EMAIL"
fi
`.trim()
}

function buildMsgFilter (patterns) {
  // Drop Co-authored-by lines that match any pattern, then collapse
  // runs of trailing blank lines.
  const re = patterns.join('|')
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`
  return `awk -v re=${sq(re)} '
    BEGIN { IGNORECASE = 1 }
    /^Co-authored-by:/ {
      if ($0 ~ re) next
    }
    { print }
  ' | awk '
    { lines[NR] = $0 }
    END {
      n = NR
      while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--
      for (i = 1; i <= n; i++) print lines[i]
    }
  '`
}

function runFilterBranch (envFilter, msgFilter, refs) {
  // git filter-branch refuses to run if backup refs already exist.
  // We pass -f to force overwrite.
  const args = [
    'filter-branch', '-f',
    '--env-filter', envFilter,
    '--msg-filter', msgFilter,
    '--', ...refs,
  ]
  const r = spawnSync('git', args, {
    stdio: 'inherit',
    env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
  })
  if (r.status !== 0) {
    console.error('error: git filter-branch failed')
    process.exit(r.status ?? 1)
  }
}

function cleanupBackups () {
  // Remove refs/original/* that filter-branch leaves behind.
  const out = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/original/'], { encoding: 'utf8' })
  const refs = (out.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
  for (const r of refs) {
    spawnSync('git', ['update-ref', '-d', r], { stdio: 'ignore' })
  }
  spawnSync('git', ['reflog', 'expire', '--expire=now', '--all'], { stdio: 'ignore' })
  spawnSync('git', ['gc', '--prune=now', '--quiet'], { stdio: 'ignore' })
}

function gitConfig (key) {
  return gitOk(['config', key]) ? git(['config', key]) : null
}

function failIdentity () {
  console.error('error: cannot determine replacement identity. Pass --name and --email, or set git config user.name / user.email.')
  process.exit(1)
}

function resolveIdentity (args) {
  const name = args.name ?? gitConfig('user.name')
  const email = args.email ?? gitConfig('user.email')
  if (!args.dryRun && !(name && email)) failIdentity()
  return { name, email }
}

function resolveScope (args) {
  if (args.all) return { branch: null, range: '--all', refs: ['--all'], label: 'ALL refs' }
  const branch = args.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    console.error('error: cannot determine current branch. Use --branch <name> or --all.')
    process.exit(1)
  }
  return { branch, range: branch, refs: [branch], label: `branch "${branch}"` }
}

function describeAffected (c) {
  const tags = []
  if (c.inAuthor) tags.push('author')
  if (c.inCommitter) tags.push('committer')
  if (c.matchedTrailers.length) tags.push(`${c.matchedTrailers.length} trailer${c.matchedTrailers.length > 1 ? 's' : ''}`)
  const subject = c.body.split('\n')[0]
  return `  ${c.hash.slice(0, 8)}  [${tags.join(', ')}]  ${c.an} <${c.ae}>  —  ${subject}`
}

function printPlan ({ scope, patterns, identity, commits, affected }) {
  console.log('agent-be-gone')
  console.log(`  scope:        ${scope.label}`)
  console.log(`  patterns:     ${patterns.join(', ')}`)
  console.log(`  replace with: ${identity.name} <${identity.email}>`)
  console.log(`  scanned:      ${commits.length} commit(s)`)
  console.log(`  affected:     ${affected.length} commit(s)`)
  console.log()
  for (const c of affected) console.log(describeAffected(c))
  if (affected.length > 0) console.log()
}

function pushIfRequested (args, scope) {
  if (!args.push) {
    console.log('Next: review with `git log`, then `git push --force` when ready.')
    return
  }
  const target = args.all ? '--all' : scope.branch
  console.log(`Pushing (force) → origin ${target}`)
  const r = spawnSync('git', ['push', '--force', 'origin', target], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('error: git push failed')
    process.exit(r.status ?? 1)
  }
}

async function shouldProceed (args, scope, affected) {
  if (affected.length === 0) { console.log('Nothing to do — history is already clean. ✨'); return false }
  if (args.dryRun) { console.log('Dry run — no changes made.'); return false }
  if (args.yes) return true
  const ok = await confirm(`Rewrite ${affected.length} commit(s) on ${scope.label}?`)
  if (!ok) console.log('Aborted.')
  return ok
}

function reportPostRewrite (range, re, originalCount) {
  const after = findAffected(listCommits(range), re)
  if (after.length === 0) console.log(`✓ History scrubbed. ${originalCount} commit(s) rewritten.`)
  else console.log(`⚠ ${after.length} commit(s) still match after rewrite — review manually.`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printHelp(); return }

  ensureRepo()
  if (!args.dryRun) ensureClean()

  const identity = resolveIdentity(args)
  const scope = resolveScope(args)
  const patterns = [...(args.only ?? BUILTIN_PATTERNS), ...args.extra]
  const re = buildRegex(patterns)

  const commits = listCommits(scope.range)
  const affected = findAffected(commits, re)

  printPlan({ scope, patterns, identity, commits, affected })

  if (!await shouldProceed(args, scope, affected)) return

  runFilterBranch(buildEnvFilter(patterns, identity.name, identity.email), buildMsgFilter(patterns), scope.refs)
  cleanupBackups()
  reportPostRewrite(scope.range, re, affected.length)
  pushIfRequested(args, scope)
}

main().catch(err => { console.error(err.stack || err.message || err); process.exit(1) })
