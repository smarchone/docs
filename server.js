// Docs daemon: one server for the .docs folders of many repos.
// Each registered repo is a workspace: its <repo>/.docs/ Markdown files, comment threads and history
// (in <repo>/.docs/.collab/), and its own job queue for the local agent that works on its comments.
//
//   node server.js           (or: docs serve <repo> — starts this in the background and registers the repo)
//
// Registry and log: $DOCS_HOME (default ~/.docs-daemon).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3459;
const HOME = path.resolve(process.env.DOCS_HOME || path.join(os.homedir(), '.docs-daemon'));
const REGISTRY = path.join(HOME, 'workspaces.json');
const APP_DIR = path.join(HERE, 'app');
const SKIP_DIRS = new Set(['.collab', '.git', 'node_modules', 'dist', 'build', '.next', 'vendor']);
const DOC_EXT = /\.(md|markdown)$/i;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readDoc(abs) {
  try {
    return await readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const latest = (meta) => meta.versions[meta.versions.length - 1] || null;
const author = (a) => (a === 'claude' ? 'claude' : 'you');

function applyEdits(content, edits) {
  let out = content;
  edits.forEach((e, i) => {
    if (typeof e.old_text !== 'string' || typeof e.new_text !== 'string') throw httpError(400, `edits[${i}] needs old_text and new_text`);
    if (e.old_text === '') throw httpError(400, `edits[${i}].old_text is empty; use write_document to replace the whole doc`);
    const count = out.split(e.old_text).length - 1;
    if (count === 0) throw httpError(409, `edits[${i}].old_text was not found. Re-read the document and copy the text exactly.`);
    if (count > 1 && !e.replace_all) throw httpError(409, `edits[${i}].old_text matches ${count} places. Include more surrounding text, or set replace_all.`);
    out = e.replace_all ? out.split(e.old_text).join(e.new_text) : out.replace(e.old_text, () => e.new_text);
  });
  return out;
}

// Batched comments: a new thread (t.draft) or a reply (m.draft) stays a draft, invisible to Claude,
// until the user publishes the batch. Publishing everything at once hands Claude one job per page.
const published = (t) => t.messages.filter((m) => !m.draft);
const draftCount = (meta) => meta.threads.reduce((n, t) => n + (t.draft ? 1 : t.messages.filter((m) => m.draft).length), 0);

// A thread waits for Claude when the user spoke last (and didn't take it back with "Take over")
const needsClaude = (t) => t.status === 'open' && !t.draft && !t.on_hold && published(t).at(-1)?.author === 'you';

function publicThread(t, rel) {
  return { ...t, path: rel };
}

// Automatic pen: Claude's edits wait until the user has paused typing in that doc
const QUIET_MS = 3000;
const MAX_WAIT_MS = 30_000;
const COALESCE_MS = 5 * 60_000;

// ---------- Live updates (SSE), shared by all workspaces ----------

const clients = new Set();
function broadcastAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- A workspace: one repo's .docs folder ----------

function makeWorkspace(id, repo) {
  const ROOT = path.join(repo, '.docs');
  fs.mkdirSync(ROOT, { recursive: true });
  const COLLAB = path.join(ROOT, '.collab');
  // Every event names its workspace, so the editor can ignore other repos' events
  const broadcast = (event, data) => broadcastAll(event, { ...data, workspace: id });

  // ---------- Paths ----------

  function docPath(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw httpError(400, 'path is required');
    const clean = rel.replace(/^\/+/, '');
    if (!DOC_EXT.test(clean)) throw httpError(400, 'Only .md / .markdown files are supported');
    const abs = path.resolve(ROOT, clean);
    if (!abs.startsWith(ROOT + path.sep) || abs.startsWith(COLLAB + path.sep)) throw httpError(400, 'Path is outside the docs folder');
    return { rel: path.relative(ROOT, abs).split(path.sep).join('/'), abs };
  }
  const metaFile = (rel) => path.join(COLLAB, 'docs', `${rel}.json`);
  const versionFile = (rel, id) => path.join(COLLAB, 'versions', rel, `${id}.md`);

  // ---------- Doc metadata (versions + comment threads), cached in memory ----------

  const metas = new Map(); // rel -> { versions: [], threads: [] }
  const locks = new Map(); // rel -> promise chain, serialises writes per doc

  function withLock(rel, fn) {
    const prev = locks.get(rel) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(rel, next.catch(() => {}));
    return next;
  }

  async function loadMeta(rel) {
    if (metas.has(rel)) return metas.get(rel);
    let meta;
    try {
      meta = JSON.parse(await readFile(metaFile(rel), 'utf8'));
    } catch {
      meta = { versions: [], threads: [] };
    }
    delete meta.writer; // (older single-writer field, no longer used)
    metas.set(rel, meta);
    return meta;
  }

  async function saveMeta(rel) {
    await mkdir(path.dirname(metaFile(rel)), { recursive: true });
    await writeFile(metaFile(rel), JSON.stringify(metas.get(rel), null, 2));
  }

  // Automatic pen: Claude's edits wait until the user has paused typing in that doc
  const typingAt = new Map(); // rel -> last time the user typed or saved

  function userTyped(rel) {
    typingAt.set(rel, Date.now());
  }

  async function waitForQuiet(rel) {
    const deadline = Date.now() + MAX_WAIT_MS;
    let announced = false;
    while (Date.now() - (typingAt.get(rel) || 0) < QUIET_MS) {
      if (!announced) {
        broadcast('claude_waiting', { path: rel });
        announced = true;
      }
      if (Date.now() > deadline) throw httpError(409, 'The user is still typing in this document. Try the edit again in a few seconds.');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function versionContent(rel, id) {
    return readFile(versionFile(rel, id), 'utf8');
  }

  // Record `content` as a new version (caller holds the lock). Skips if unchanged.
  async function addVersion(rel, content, { author, message, threadId, coalesce, jobId }) {
    const meta = await loadMeta(rel);
    const last = latest(meta);
    if (last && (await versionContent(rel, last.id).catch(() => null)) === content) return last;
    // All of one job's edits fold into a single version, so "Undo" reverts the whole job
    if (jobId && last?.job_id === jobId) {
      await writeFile(versionFile(rel, last.id), content);
      Object.assign(last, { at: new Date().toISOString(), size: content.length });
      await saveMeta(rel);
      return last;
    }
    // Autosaves from one typing session fold into a single version
    if (coalesce && last && last.id > 1 && last.author === author && last.coalesce && Date.now() - new Date(last.at) < COALESCE_MS) {
      await writeFile(versionFile(rel, last.id), content);
      Object.assign(last, { at: new Date().toISOString(), size: content.length });
      await saveMeta(rel);
      return last;
    }
    const v = {
      id: (last?.id || 0) + 1,
      author,
      message: message || '',
      at: new Date().toISOString(),
      size: content.length,
      ...(threadId && { thread_id: threadId }),
      ...(jobId && { job_id: jobId }),
      ...(coalesce && { coalesce: true }),
    };
    await mkdir(path.dirname(versionFile(rel, v.id)), { recursive: true });
    await writeFile(versionFile(rel, v.id), content);
    meta.versions.push(v);
    await saveMeta(rel);
    return v;
  }

  // Make sure the doc's current file content is captured as a version.
  async function ensureTracked(rel, abs) {
    const content = await readDoc(abs);
    if (content === null) throw httpError(404, `No such document: ${rel}`);
    const meta = await loadMeta(rel);
    if (!meta.versions.length) await addVersion(rel, content, { author: 'initial', message: 'First tracked version' });
    return content;
  }

  async function writeDoc(rel, abs, content, info) {
    ignoreWatch.set(abs, content);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    const v = await addVersion(rel, content, info);
    broadcast('doc_changed', { path: rel, version: v.id, author: v.author, message: v.message, thread_id: info.threadId || null });
    return v;
  }

  async function listDocs() {
    const out = [];
    async function walk(dir) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= 500) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
        } else if (DOC_EXT.test(e.name)) {
          out.push(path.relative(ROOT, path.join(dir, e.name)).split(path.sep).join('/'));
        }
      }
    }
    await walk(ROOT);
    out.sort();
    return Promise.all(
      out.map(async (rel) => {
        const meta = await loadMeta(rel);
        return {
          path: rel,
          open_threads: meta.threads.filter((t) => t.status === 'open' && !t.draft).length,
          pending: meta.threads.filter(needsClaude).length,
          drafts: draftCount(meta),
        };
      }),
    );
  }

  // ---------- Threads ----------

  async function findThread(rel, id) {
    const meta = await loadMeta(rel);
    const t = meta.threads.find((x) => x.id === id);
    if (!t) throw httpError(404, `No thread ${id} in ${rel}`);
    return t;
  }

  // ---------- Jobs: one worker (a Claude Code session) handles comments, one doc at a time ----------
  //
  // GET  /api/jobs/next?timeout=300  long-poll; claims every waiting thread in one doc and locks that doc
  // POST /api/jobs/complete          { job_id, replies: [{ thread_id, text, resolve }] } posts replies, unlocks
  // POST /api/jobs/release           { job_id? } gives the doc back without replying (the editor's "Take over")
  //
  // While a doc is locked only the worker writes it (it edits the file on disk). The editor shows the page
  // read-only and applies the worker's edits live; every change is recorded as a version by Claude.

  let job = null; // { id, rel, thread_ids, claimed_at }
  let claiming = null; // in-flight claim, so concurrent polls share it
  let lastHumanActivity = Date.now();
  let lastClaudeActivity = 0;
  let waiters = [];

  // wake=true only for comment activity, so plain saves don't wake the worker
  function humanActed(wake = false) {
    lastHumanActivity = Date.now();
    if (wake) for (const w of waiters.slice()) w();
  }
  function claudeActed() {
    lastClaudeActivity = Date.now();
    broadcastPresence();
  }
  function presence() {
    return {
      workspace: id,
      listening: waiters.length > 0,
      last_claude_at: lastClaudeActivity || null,
      job: job && { id: job.id, path: job.rel, threads: job.thread_ids.length },
    };
  }
  function broadcastPresence() {
    broadcast('presence', presence());
  }

  const lockedFor = (rel, who) => who === 'you' && job?.rel === rel;
  function assertWritable(rel, who) {
    if (lockedFor(rel, who)) throw httpError(423, 'Claude is editing this page. Your changes will apply when it is done.');
  }

  // Before locking, give the user a moment to finish typing (their autosave lands within ~1s)
  async function waitForPause(rel) {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() - (typingAt.get(rel) || 0) < QUIET_MS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }

  async function claimJob() {
    if (job) return job;
    if (claiming) return claiming;
    claiming = (async () => {
      await listDocs(); // load metadata for every doc
      const pending = [];
      for (const [rel, meta] of metas) {
        const threads = meta.threads.filter(needsClaude);
        if (threads.length) pending.push({ rel, threads, at: Math.min(...threads.map((t) => Date.parse(t.messages.at(-1).at))) });
      }
      if (!pending.length) return null;
      const { rel } = pending.sort((a, b) => a.at - b.at)[0]; // oldest waiting comment first
      await waitForPause(rel);
      return withLock(rel, async () => {
        await ensureTracked(rel, docPath(rel).abs);
        const threads = (await loadMeta(rel)).threads.filter(needsClaude);
        if (!threads.length) return null;
        for (const t of threads) t.claude_working = true;
        job = { id: randomUUID().slice(0, 8), rel, thread_ids: threads.map((t) => t.id), claimed_at: new Date().toISOString() };
        await saveMeta(rel);
        broadcast('threads_changed', { path: rel });
        broadcastPresence();
        return job;
      });
    })();
    try {
      return await claiming;
    } finally {
      claiming = null;
    }
  }

  async function jobView(j) {
    const meta = await loadMeta(j.rel);
    const threads = j.thread_ids.map((id) => meta.threads.find((t) => t.id === id)).filter(Boolean);
    return {
      job: {
        id: j.id,
        path: j.rel,
        file: docPath(j.rel).abs,
        threads: threads.map((t) => ({
          thread_id: t.id,
          highlighted_text: t.anchor?.quote ?? null,
          conversation: published(t).map((m) => ({ author: m.author === 'you' ? 'user' : 'claude', text: m.text })),
        })),
      },
    };
  }

  // Resolves on a comment (wake), the timeout, or the poller hanging up (signal)
  function waitForWake(timeoutSec, signal) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        waiters = waiters.filter((w) => w !== done);
        broadcastPresence();
        resolve();
      };
      const timer = setTimeout(done, Math.min(timeoutSec, 300) * 1000);
      waiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
      broadcastPresence();
    });
  }

  // The poller's session closed: it's gone, not "recently active"
  function pollerGone() {
    if (!job) lastClaudeActivity = 0;
    broadcastPresence();
  }

  async function nextJob(timeoutSec, signal) {
    if (signal?.aborted) return pollerGone();
    claudeActed();
    let j = await claimJob();
    if (!j && timeoutSec > 0) {
      await waitForWake(timeoutSec, signal);
      if (signal?.aborted) return pollerGone();
      await new Promise((r) => setTimeout(r, 50)); // let a just-posted comment be saved
      j = await claimJob();
    }
    if (j && signal?.aborted) {
      // Claimed for a poller that hung up meanwhile: give the doc back instead of leaving it locked
      if (job?.id === j.id) await endJob(j);
      return pollerGone();
    }
    claudeActed();
    return j ? jobView(j) : { job: null, idle_seconds: Math.round((Date.now() - lastHumanActivity) / 1000) };
  }

  function currentJob(id) {
    if (!job) throw httpError(409, 'No job in progress. Poll /api/jobs/next for the next one.');
    if (id && id !== job.id) throw httpError(409, `Job ${id} is no longer active (it was released). Poll /api/jobs/next again.`);
    return job;
  }

  // Record any edit the worker made that the file watcher hasn't picked up yet, so it's credited to Claude
  async function captureJobEdits(j) {
    const { abs } = docPath(j.rel);
    const content = await readDoc(abs);
    if (content !== null) await recordExternal(j.rel, content);
  }

  async function endJob(j, replies = [], { hold = false } = {}) {
    await captureJobEdits(j);
    await withLock(j.rel, async () => {
      const meta = await loadMeta(j.rel);
      for (const r of replies) {
        const t = meta.threads.find((x) => x.id === r.thread_id);
        if (!t) throw httpError(404, `No thread ${r.thread_id} in ${j.rel}`);
        if (!String(r.text || '').trim()) throw httpError(400, `Reply to ${r.thread_id} needs text`);
      }
      for (const r of replies) {
        const t = meta.threads.find((x) => x.id === r.thread_id);
        t.messages.push({ author: 'claude', text: String(r.text), at: new Date().toISOString() });
        if (r.resolve) t.status = 'resolved';
      }
      for (const t of meta.threads) {
        if (!j.thread_ids.includes(t.id)) continue;
        delete t.claude_working;
        if (hold) t.on_hold = true; // don't hand it straight back; the user's next reply does
      }
      job = null;
      await saveMeta(j.rel);
    });
    broadcast('threads_changed', { path: j.rel });
    broadcast('job_done', { path: j.rel });
    claudeActed();
  }

  // ---------- Watch for changes made outside the editor (e.g. Claude's Edit tool, git) ----------

  const ignoreWatch = new Map(); // abs -> content we just wrote
  const watchTimers = new Map();

  let watcher = null;
  function startWatcher() {
    try {
      watcher = fs.watch(ROOT, { recursive: true }, (_type, filename) => {
        if (!filename) return;
        const rel = filename.split(path.sep).join('/');
        if (rel.startsWith('.collab/') || rel.split('/').some((p) => SKIP_DIRS.has(p))) return;
        if (!DOC_EXT.test(rel)) return;
        clearTimeout(watchTimers.get(rel));
        watchTimers.set(
          rel,
          setTimeout(() => onExternalChange(rel).catch((err) => console.error('watch:', err.message)), 250),
        );
      });
    } catch (err) {
      console.warn('File watching unavailable:', err.message);
    }
  }

  async function onExternalChange(rel) {
    const { abs } = docPath(rel);
    const content = await readDoc(abs);
    if (content === null) return broadcast('docs_changed', {});
    if (ignoreWatch.get(abs) === content) return;
    ignoreWatch.delete(abs);
    await recordExternal(rel, content);
  }

  // A change on disk. While a job runs it's the worker's edit; otherwise git, an IDE, etc.
  async function recordExternal(rel, content) {
    await withLock(rel, async () => {
      const meta = await loadMeta(rel);
      const isNew = !meta.versions.length;
      let info = { author: 'external', message: 'Changed outside the editor' };
      if (isNew) info = { author: 'initial', message: 'First tracked version' };
      else if (job) {
        const first = rel === job.rel && job.thread_ids.length === 1 ? meta.threads.find((t) => t.id === job.thread_ids[0]) : null;
        const said = first?.messages.findLast((m) => m.author === 'you')?.text.replace(/\s+/g, ' ');
        info = {
          author: 'claude',
          message: said ? `Addressed "${said.length > 50 ? `${said.slice(0, 50)}…` : said}"` : 'Addressed comments',
          threadId: first?.id,
          jobId: job.id,
        };
      }
      const before = latest(meta)?.id;
      const v = await addVersion(rel, content, info);
      if (v.id === before && !info.jobId) return; // unchanged
      broadcast('doc_changed', { path: rel, version: v.id, author: v.author, message: v.message, thread_id: v.thread_id || null });
      if (isNew) broadcast('docs_changed', {});
      if (info.jobId) claudeActed();
    });
  }

  // ---------- Routes (served under /api/w/<workspace>/...) ----------

  const routes = {
    'GET /api/docs': async () => ({ workspace: id, root: ROOT, docs: await listDocs() }),

    'GET /api/doc': async (q) => {
      const { rel, abs } = docPath(q.get('path'));
      const content = await withLock(rel, () => ensureTracked(rel, abs));
      const meta = await loadMeta(rel);
      return { path: rel, content, version: latest(meta).id, versions: meta.versions, threads: meta.threads };
    },

    'PUT /api/doc': async (_q, b) => {
      const { rel, abs } = docPath(b.path);
      const who = author(b.author);
      assertWritable(rel, who);
      if (who === 'you') userTyped(rel);
      else await waitForQuiet(rel);
      return withLock(rel, async () => {
        const exists = (await readDoc(abs)) !== null;
        if (exists) await ensureTracked(rel, abs);
        const meta = await loadMeta(rel);
        if (b.base_version && latest(meta) && latest(meta).id !== b.base_version) {
          throw Object.assign(httpError(409, `The document changed since version ${b.base_version} (now v${latest(meta).id}).`), {
            extra: { latest_version: latest(meta).id },
          });
        }
        const v = await writeDoc(rel, abs, String(b.content ?? ''), { author: who, message: b.message || (exists ? 'Edited' : 'Created'), coalesce: Boolean(b.coalesce) });
        if (!exists) broadcast('docs_changed', {});
        who === 'claude' ? claudeActed() : humanActed();
        return { path: rel, version: v.id };
      });
    },

    'POST /api/edit': async (_q, b) => {
      const { rel, abs } = docPath(b.path);
      if (!Array.isArray(b.edits) || !b.edits.length) throw httpError(400, 'edits must be a non-empty array');
      assertWritable(rel, author(b.author));
      if (author(b.author) === 'claude') await waitForQuiet(rel);
      else userTyped(rel);
      return withLock(rel, async () => {
        const before = await ensureTracked(rel, abs);
        const after = applyEdits(before, b.edits);
        const v = await writeDoc(rel, abs, after, { author: author(b.author), message: b.message || 'Edited', threadId: b.thread_id });
        author(b.author) === 'claude' ? claudeActed() : humanActed();
        return { path: rel, version: v.id, previous_version: v.id - 1 };
      });
    },

    'GET /api/version': async (q) => {
      const { rel } = docPath(q.get('path'));
      const id = Number(q.get('id'));
      return { path: rel, id, content: await versionContent(rel, id).catch(() => { throw httpError(404, `No version ${id}`); }) };
    },

    'POST /api/revert': async (_q, b) => {
      const { rel, abs } = docPath(b.path);
      assertWritable(rel, author(b.author));
      if (author(b.author) === 'claude') await waitForQuiet(rel);
      return withLock(rel, async () => {
        await ensureTracked(rel, abs);
        const content = await versionContent(rel, Number(b.version_id)).catch(() => { throw httpError(404, `No version ${b.version_id}`); });
        const v = await writeDoc(rel, abs, content, { author: author(b.author), message: `Reverted to v${b.version_id}` });
        author(b.author) === 'claude' ? claudeActed() : humanActed();
        return { path: rel, version: v.id };
      });
    },

    'POST /api/threads': async (_q, b) => {
      const { rel, abs } = docPath(b.path);
      if (!String(b.text || '').trim()) throw httpError(400, 'text is required');
      return withLock(rel, async () => {
        await ensureTracked(rel, abs);
        const meta = await loadMeta(rel);
        const who = author(b.author);
        const draft = Boolean(b.draft) && who === 'you';
        const thread = {
          id: randomUUID().slice(0, 8),
          anchor: b.anchor && b.anchor.quote ? { quote: b.anchor.quote, prefix: b.anchor.prefix || '', suffix: b.anchor.suffix || '' } : null,
          status: 'open',
          created_at: new Date().toISOString(),
          messages: [{ author: who, text: String(b.text), at: new Date().toISOString() }],
          ...(draft && { draft: true }),
        };
        meta.threads.push(thread);
        await saveMeta(rel);
        broadcast('threads_changed', { path: rel });
        who === 'claude' ? claudeActed() : humanActed(!draft);
        return publicThread(thread, rel);
      });
    },

    'POST /api/threads/reply': async (_q, b) => {
      const { rel } = docPath(b.path);
      if (!String(b.text || '').trim()) throw httpError(400, 'text is required');
      return withLock(rel, async () => {
        const t = await findThread(rel, b.thread_id);
        const who = author(b.author);
        const draft = Boolean(b.draft) && who === 'you';
        t.messages.push({ author: who, text: String(b.text), at: new Date().toISOString(), ...(draft && { draft: true }) });
        if (draft) {
          await saveMeta(rel);
          broadcast('threads_changed', { path: rel });
          humanActed();
          return publicThread(t, rel);
        }
        if (who === 'you' && t.status === 'resolved') t.status = 'open';
        if (who === 'you') delete t.on_hold;
        if (who === 'claude') {
          delete t.claude_working;
          if (b.resolve) t.status = 'resolved';
        }
        await saveMeta(rel);
        broadcast('threads_changed', { path: rel });
        who === 'claude' ? claudeActed() : humanActed(true);
        return publicThread(t, rel);
      });
    },

    'POST /api/threads/status': async (_q, b) => {
      const { rel } = docPath(b.path);
      if (!['open', 'resolved'].includes(b.status)) throw httpError(400, 'status must be open or resolved');
      return withLock(rel, async () => {
        const t = await findThread(rel, b.thread_id);
        t.status = b.status;
        delete t.claude_working;
        if (b.status === 'open') delete t.on_hold;
        await saveMeta(rel);
        broadcast('threads_changed', { path: rel });
        author(b.author) === 'claude' ? claudeActed() : humanActed(b.status === 'open');
        return publicThread(t, rel);
      });
    },

    'POST /api/threads/delete': async (_q, b) => {
      const { rel } = docPath(b.path);
      return withLock(rel, async () => {
        const meta = await loadMeta(rel);
        meta.threads = meta.threads.filter((t) => t.id !== b.thread_id);
        await saveMeta(rel);
        broadcast('threads_changed', { path: rel });
        return { ok: true };
      });
    },

    'GET /api/threads': async (q) => {
      const status = q.get('status');
      const only = q.get('path') ? docPath(q.get('path')).rel : null;
      await listDocs();
      const out = [];
      for (const [rel, meta] of metas) {
        if (only && rel !== only) continue;
        for (const t of meta.threads) {
          if (status === 'needs_reply' ? needsClaude(t) : !status || t.status === status) out.push(publicThread(t, rel));
        }
      }
      return { threads: out };
    },

    // Publish the batch: every draft thread and draft reply (in one doc, or everywhere)
    'POST /api/drafts/publish': async (_q, b) => {
      const only = b.path ? docPath(b.path).rel : null;
      await listDocs();
      let count = 0;
      for (const rel of [...metas.keys()]) {
        if (only && rel !== only) continue;
        await withLock(rel, async () => {
          const meta = await loadMeta(rel);
          if (!draftCount(meta)) return;
          const now = new Date().toISOString();
          for (const t of meta.threads) {
            const drafts = t.messages.filter((m) => m.draft);
            if (t.draft) {
              delete t.draft;
              t.messages[0].at = now;
              count++;
            } else if (drafts.length) {
              // Move draft replies after anything Claude said meanwhile
              t.messages = [...published(t), ...drafts.map(({ draft, ...m }) => ({ ...m, at: now }))];
              if (t.status === 'resolved') t.status = 'open';
              delete t.on_hold;
              count += drafts.length;
            }
          }
          await saveMeta(rel);
          broadcast('threads_changed', { path: rel });
        });
      }
      humanActed(true);
      return { published: count };
    },

    // Throw away a thread's unpublished draft (the whole thread if it is a draft)
    'POST /api/drafts/discard': async (_q, b) => {
      const { rel } = docPath(b.path);
      return withLock(rel, async () => {
        const meta = await loadMeta(rel);
        const t = await findThread(rel, b.thread_id);
        if (t.draft) meta.threads = meta.threads.filter((x) => x !== t);
        else t.messages = published(t);
        await saveMeta(rel);
        broadcast('threads_changed', { path: rel });
        return { ok: true };
      });
    },

    'GET /api/jobs/next': async (q, _b, signal) => nextJob(Number(q.get('timeout') ?? 300), signal),

    'GET /api/jobs/current': async () => (job ? jobView(job) : { job: null }),

    'POST /api/jobs/complete': async (_q, b) => {
      const j = currentJob(b.job_id);
      if (b.replies != null && !Array.isArray(b.replies)) throw httpError(400, 'replies must be an array');
      await endJob(j, b.replies || []);
      humanActed(true); // threads that arrived meanwhile can be claimed right away
      return { ok: true };
    },

    'POST /api/jobs/release': async (_q, b) => {
      if (!job) return { ok: true };
      await endJob(currentJob(b.job_id), [], { hold: author(b.author) === 'you' });
      return { ok: true };
    },

    'GET /api/presence': async () => presence(),

    // Typing heartbeat from the editor, so Claude's edits wait for a pause
    'POST /api/typing': async (_q, b) => {
      userTyped(docPath(b.path).rel);
      return { ok: true };
    },
  };

  startWatcher();
  return { id, repo, root: ROOT, routes, presence, listDocs, close: () => watcher?.close() };
}

// ---------- Registry: which repos the daemon serves ----------

const workspaces = new Map(); // id -> workspace

// Readable and stable: folder name plus a short hash of the full path
function workspaceId(repo) {
  const slug = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'docs';
  return `${slug}-${createHash('sha1').update(repo).digest('hex').slice(0, 4)}`;
}

async function saveRegistry() {
  await mkdir(HOME, { recursive: true });
  await writeFile(REGISTRY, JSON.stringify([...workspaces.values()].map((w) => ({ id: w.id, repo: w.repo })), null, 2));
}

function addWorkspace(repo) {
  const id = workspaceId(repo);
  if (!workspaces.has(id)) workspaces.set(id, makeWorkspace(id, repo));
  return workspaces.get(id);
}

async function loadRegistry() {
  let list = [];
  try {
    list = JSON.parse(await readFile(REGISTRY, 'utf8'));
  } catch {}
  for (const { repo } of list) {
    if (fs.existsSync(repo)) addWorkspace(repo);
    else console.warn(`Skipping ${repo}: folder no longer exists`);
  }
}

async function describe(w) {
  return { id: w.id, name: path.basename(w.repo), repo: w.repo, root: w.root, presence: w.presence(), docs: await w.listDocs() };
}

const globalRoutes = {
  'GET /api/workspaces': async () => ({ workspaces: await Promise.all([...workspaces.values()].map(describe)) }),

  // Register a repo (idempotent). Its docs live in <repo>/.docs/, created if missing.
  'POST /api/workspaces': async (_q, b) => {
    if (typeof b.repo !== 'string' || !path.isAbsolute(b.repo)) throw httpError(400, 'repo must be an absolute path');
    const repo = path.resolve(b.repo);
    if (!fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) throw httpError(400, `Not a folder: ${repo}`);
    const isNew = !workspaces.has(workspaceId(repo));
    const w = addWorkspace(repo);
    if (isNew) {
      await saveRegistry();
      broadcastAll('workspaces_changed', {});
    }
    return { id: w.id, repo: w.repo, root: w.root, url: `http://127.0.0.1:${PORT}/#/${w.id}/` };
  },

  'POST /api/workspaces/remove': async (_q, b) => {
    const w = workspaces.get(b.id);
    if (!w) throw httpError(404, `No workspace ${b.id}`);
    w.close();
    workspaces.delete(b.id);
    await saveRegistry();
    broadcastAll('workspaces_changed', {});
    return { ok: true };
  },

  'POST /api/shutdown': async () => {
    setTimeout(() => process.exit(0), 50);
    return { ok: true };
  },
};

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The daemon is long-lived and can register folders, so only talk to local tools:
// a localhost Host header (no DNS rebinding) and JSON bodies (other sites can't POST without a preflight)
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

function findRoute(method, pathname) {
  const m = pathname.match(/^\/api\/w\/([^/]+)(\/.*)$/);
  if (!m) return globalRoutes[`${method} ${pathname}`];
  const w = workspaces.get(decodeURIComponent(m[1]));
  if (!w) throw httpError(404, `No workspace ${m[1]}. Register it with: docs serve <repo>`);
  return w.routes[`${method} /api${m[2]}`];
}

await loadRegistry();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!LOCAL_HOST.test(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const w of workspaces.values()) res.write(`event: presence\ndata: ${JSON.stringify(w.presence())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, pid: process.pid, workspaces: workspaces.size });
    if (url.pathname.startsWith('/api/')) {
      const route = findRoute(req.method, url.pathname);
      if (!route) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      // Aborts when the client hangs up before we answer (e.g. a long-poll whose Claude session closed)
      const hangup = new AbortController();
      res.on('close', () => res.writableFinished || hangup.abort());
      const result = await route(url.searchParams, body, hangup.signal);
      if (hangup.signal.aborted) return;
      return send(res, 200, result);
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    const file = path.normalize(path.join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(APP_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: 'Not found' });
    // no-cache: the browser revalidates, so an upgraded daemon never runs a stale app.js / style.css
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    send(res, err.status || 500, { error: err.message, ...(err.extra || {}) });
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is the daemon already running?)` : err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Docs daemon at http://127.0.0.1:${PORT} (pid ${process.pid})`);
  console.log(`Serving ${workspaces.size} workspace(s). Add one with: docs serve <repo>`);
});
