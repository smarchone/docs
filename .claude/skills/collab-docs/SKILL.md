---
name: collab-docs
description: Work as the Docs editor's comment worker for the current repo. Registers the repo with the docs daemon (starting it if needed), waits in the background for comment threads on the repo's .docs/ files, edits them to address the comments, and posts replies. Use when the user runs /collab-docs or asks Claude to start listening to or working on Docs editor comments.
---

You are the worker for the Docs editor on **this repo**. The user comments on the Markdown docs in
`<repo>/.docs/` in the browser. The docs daemon (one server for all repos) turns waiting comment threads into
**jobs**, separately for each repo.

## Setup

1. Register this repo with the daemon. This also starts the daemon if it isn't running:
   `docs serve "$PWD"`. Read the `workspace:` line it prints (the workspace id) and tell the user the `url:`
   in one line.
   - If `docs` isn't on the PATH, run `npx -y @smarchone/docs serve "$PWD"` instead. Mention once that
     `npm i -g @smarchone/docs` makes this faster.
2. The poller is `scripts/poll.sh` in this skill's base directory. Always run it by its absolute path, with the
   workspace id: `<base>/scripts/poll.sh <workspace>`. It waits for the next job in this repo, prints it as JSON
   and exits.

## Loop

1. Start the poller with the Bash tool and `run_in_background: true`. Don't poll its output. You'll be woken
   when it exits. While it runs, stay idle and say nothing.
2. When it exits:
   - Exit 0 with a job: handle it as described below. Then go back to step 1.
   - Exit 1 (daemon unreachable): print the poller's message and stop. Don't retry, don't restart the daemon,
     don't do anything else.
3. If the user says to stop, stop the background poller with TaskStop and end.

## Handling a job

The job looks like this:

```json
{"job":{"id":"…","path":"specs/x.md","file":"/abs/path/specs/x.md",
  "threads":[{"thread_id":"…","highlighted_text":"…"|null,"conversation":[{"author":"user","text":"…"}]}]}}
```

While the job is open the page is locked. The editor is read-only for the user, and you are the only
writer. Work fast.

1. Read `file` once. `highlighted_text` is the visible text the user selected. Find the matching Markdown in
   the file. `null` means the comment is about the whole page.
2. For each thread, read the whole conversation. The last user message is what to act on now.
   - **Requested change:** edit `file` directly with the Edit tool. Keep each edit minimal and focused.
     Every edit appears live in the user's browser and is recorded as a version by Claude.
   - **Ambiguous, or needs a decision:** don't edit. Ask one concrete question and leave the thread open.
   - **Question only:** answer it and resolve the thread.
   Use your own tools (read code, search the repo) when a comment needs facts.
3. Finish the job with **one** call. Reply to every thread in the job, in one or two sentences each. Say what
   you changed, or what you're asking:

   ```bash
   curl -sf -X POST "${DOCS_URL:-http://127.0.0.1:3459}/api/w/<workspace>/jobs/complete" -H 'Content-Type: application/json' -d @- <<'JSON'
   {"job_id":"<id>","replies":[{"thread_id":"<thread_id>","text":"<reply>","resolve":true}]}
   JSON
   ```

   This unlocks the page. If it returns 409, the user took the page back: drop the job and keep listening.

Keep terminal output minimal. Print at most one line per job (doc, then what you did). The conversation
happens in the editor.
