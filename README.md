# Docs

**Review your agent's writing the way you'd review a colleague's: highlight, comment, done.**

Your coding agent writes specs, plans and design notes. Reviewing them shouldn't mean pasting paragraphs back
into a chat. With Docs, you open your repo's docs in a clean, Notion-style editor, highlight a sentence and
leave a comment. Claude Code, already running in that repo, edits the file and replies in the thread. You
watch the change land live, with a diff.

- **Point, don't describe.** Comment on the exact text you mean.
- **Plain Markdown in your repo.** Docs live in `.docs/`, next to the code. Nothing leaves your machine.
- **Grounded answers.** The agent can read your code before it replies.
- **Free while idle.** No comments waiting means no tokens spent.
- **One tab for every repo.** Every edit can be undone, and every version is kept.

## Get started in 1 minute

```bash
npm i -g @smarchone/docs                               # Node 22+
npx skills add smarchone/docs --skill collab-docs -g    # adds /collab-docs to Claude Code
```

Then, in any repo:

```bash
claude
> /collab-docs
```

Open http://127.0.0.1:3459, pick a doc and leave your first comment.
