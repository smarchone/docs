# Docs

**Stop telling your terminal which paragraph to fix. Just comment on it.**

Editing a doc through a terminal agent means describing where the problem is: "in the second section, the
bullet about retries…". Then you scroll the diff to check it got the right spot. That's a lot of attention for
a one-line fix.

Docs lets you edit your docs with comment threads instead. Open the doc, read it like a reviewer, and highlight
whatever bothers you: *"tighten this"*, *"is this still true?"*, *"add an example"*. Leave the comment and
keep reading. Claude, working in your repo, picks it up, makes the edit and replies in the thread. The change
shows up in place, marked, while you're already on the next paragraph.

You don't switch windows, write prompts or watch the agent work. You read and react, and the doc gets better
as you go.

## Get started in 1 minute

```bash
npm i -g @smarchone/docs                               # Node 22+
npx skills add smarchone/docs --skill collab-docs -g    # adds /collab-docs to Claude Code
```

Or skip the global install and run the server with npx:

```bash
npx @smarchone/docs serve
```

Then, in any repo:

```bash
claude
> /collab-docs
```

Open http://127.0.0.1:3459, pick a doc and leave your first comment.

To see or drop registered repos (the sidebar shows each repo's path; hover one for a × that unregisters it):

```bash
docs status          # list registered repos
docs remove [repo]   # unregister a repo (default: current folder); its .docs/ stays on disk
docs stop            # stop the daemon
```
