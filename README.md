# Docs

**Review your agent's writing the way you'd review a colleague's: highlight, comment, done.**

Your coding agent writes specs, plans, design notes and READMEs. Reviewing them today is clumsy. You either
paste paragraphs back into a chat ("in section 3, the second bullet…"), or you open the raw Markdown and fix it
yourself.

Docs gives you a better loop. Open your repo's docs in a clean, Notion-style editor. Highlight a sentence, leave
a comment ("make this shorter", "is this still true?", "add the retry logic here"), and keep reading. Claude
Code, already running in that repo, picks up the comment, edits the file, and replies in the thread. You
watch the change land live, with a diff.

```
   you, in the browser                          Claude Code, in your repo
 ┌──────────────────────────┐                 ┌──────────────────────────┐
 │  "make this shorter" 💬  │ ──── comment ──▶│  reads the thread        │
 │                          │                 │  edits .docs/spec.md     │
 │  ▌new, shorter text      │ ◀── edit+reply ─│  "Cut it to two lines."  │
 └──────────────────────────┘                 └──────────────────────────┘
```

## Why it's different

- **Comments are the interface.** You point at the exact text you mean. You don't have to describe where it
  is. Claude gets your highlight, the whole thread and the file path.
- **Your docs stay plain Markdown in your repo.** Everything lives in `<repo>/.docs/`, version-controlled next to
  the code it describes. No cloud, no export, no lock-in.
- **The agent has the full repo.** The worker is a real Claude Code session in that repo. When a comment asks
  "is this still how auth works?", it can read the code before it answers.
- **Idle costs nothing.** While no comments are waiting, the worker sits on a background long-poll and doesn't
  use any tokens.
- **One tab for all your repos.** A single local daemon serves every registered repo. Each repo has its own
  worker, and you can see at a glance which ones are listening.
- **You stay in control.** Only one writer works on a page at a time. Every Claude edit is highlighted, diffable
  and undoable, and **History** keeps every version.

## Get started in a minute

```bash
npm i -g @smarchone/docs                                    # the `docs` command and the daemon (Node 22+)
npx skills add smarchone/docs --skill collab-docs -g         # /collab-docs in Claude Code, in every repo
```

Then, in any repo:

```bash
claude
> /collab-docs
```

Open http://127.0.0.1:3459, pick a doc in `.docs/`, and leave your first comment.

To try it without installing anything, run `npx @smarchone/docs serve`. The skill also falls back to npx when
`docs` isn't installed.

## How it works

```
browser ⇄ docs daemon ⇄ poll.sh <workspace> ← Claude Code in repo A
          (one per machine) ⇄ poll.sh <workspace> ← Claude Code in repo B
```

`/collab-docs`:

1. runs `docs serve "$PWD"`. That starts the daemon if needed and registers the repo. The docs live in
   `<repo>/.docs/`, which is created if missing.
2. prints the URL and waits in the background for comments on this repo.

The daemon doesn't belong to any Claude session. Closing one session doesn't affect other repos.

| Command             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `docs serve [repo]` | Start the daemon if it isn't running, register the repo (default: here)   |
| `docs status`       | List the repos and whether Claude is listening, working or offline        |
| `docs stop`         | Stop the daemon                                                           |

The list of registered repos and the log live in `~/.docs-daemon/`.

## In the editor

- **Sidebar:** one group per repo. The dot shows its Claude: green = listening, orange = working,
  grey = offline. Click a repo to open it.
- **Batch mode** (top bar): every comment and reply stays a draft until you **Publish**. Then Claude handles
  each page's comments as one job. With batch mode off, comments go to Claude right away.
- **Only one writer per turn.** While Claude works on a page, that page is read-only and shows
  "Claude is editing this page". You can still comment. **Take over** gives the page back.
- **Claude's changes** get orange bars that match the diff. **View changes · Show comment · Undo** sit in the
  notice. **History** keeps every version.

## Bring your own agent

Claude Code is the default worker, but the protocol is a small HTTP API. Any agent that can run a shell command
and edit files can be the worker. Every repo is a workspace, and its routes live under `/api/w/<workspace>/`.

| Call                                                                       | Purpose                                     |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| `POST /api/workspaces` `{repo}`                                            | Register a repo (what `docs serve` calls)   |
| `GET /api/w/<ws>/jobs/next?timeout=300`                                    | Claim the next job in this repo (long-poll) |
| `POST /api/w/<ws>/jobs/complete` `{job_id, replies:[{thread_id,text,resolve}]}` | Post replies and unlock the page       |
| `POST /api/w/<ws>/jobs/release` `{job_id}`                                 | Unlock without replying                     |

A job contains `path`, the absolute `file` path, and its `threads`. Each thread has `highlighted_text` and
`conversation`.

```
docs serve "$PWD"                                   → workspace: <id>
.claude/skills/collab-docs/scripts/poll.sh <id>     → prints the next job as JSON
```

Everything stays on your machine. The daemon only accepts requests with a localhost `Host` header, and JSON
bodies for writes.

## Development

From this folder, run `npm link` to use your working copy as the global `docs`. Run `npm start` to start the
daemon in the foreground. Use `PORT` and `DOCS_HOME` to run a second copy for testing. The editor is
[Tiptap](https://tiptap.dev) v3, prebuilt into `app/vendor/tiptap.js`. To rebuild it, run
`npm install && npm run build:vendor`.

## Publishing

```bash
npm pack --dry-run   # check what's included (12 files, ~205 kB)
npm publish          # publishes @smarchone/docs publicly (publishConfig.access = public)
```

Bump `version` in `package.json` before each publish.
