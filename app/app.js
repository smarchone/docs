import { Editor, Extension, StarterKit, Markdown, Placeholder, TableKit, Plugin, PluginKey, Decoration, DecorationSet, Mapping } from './vendor/tiptap.js';
import { buildIndex, anchorFromRange, locate } from './anchor.js';
import { diffLines, withContext } from './diff.js';

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), pages: $('pages'), newPage: $('new-page'),
  crumbs: $('crumbs'), saveState: $('save-state'), presence: $('presence'), presenceText: $('presence-text'),
  notice: $('notice'), canvas: $('canvas'), editor: $('editor'), empty: $('empty'),
  margin: $('margin'), threads: $('threads'), showResolved: $('show-resolved'), threadCount: $('thread-count'),
  bubble: $('bubble'), history: $('history'), versions: $('versions'),
  diffDialog: $('diff-dialog'), diffTitle: $('diff-title'), diffBody: $('diff-body'), diffVsCurrent: $('diff-vs-current'), diffRestore: $('diff-restore'),
  lock: $('lock'), publish: $('publish'), batchMode: $('batch-mode'),
};

const state = {
  workspaces: [], // every repo the daemon serves: { id, name, root, presence, docs }
  wsId: null, // the open workspace
  presenceByWs: {}, // workspace id -> { listening, last_claude_at, job }
  docs: [], // the open workspace's pages
  doc: null, // { path, version, versions, threads }
  serverContent: '', // file content as last loaded from / saved to the server
  baseline: '', // the editor's serialization of serverContent (to detect real edits)
  baseDoc: null, // editor document matching serverContent
  localMap: new Mapping(), // your edits since baseDoc (to place incoming changes correctly)
  lastTypingPing: 0,
  saveMessage: null, // message for the next save (default "Edited")
  dirty: false,
  saving: false,
  loading: false,
  saveTimer: null,
  active: null,
  draft: null, // { anchor, range } while composing a new thread
  replyDrafts: new Map(),
  presence: { listening: false, last_claude_at: null, job: null },
  diffVersion: null,
  // Claude's unreviewed changes since you last reviewed: how many, the version before them,
  // and their inverse steps (so Undo reverts just Claude's changes, not your edits since)
  review: null, // { edits, baseVersion, author, inverses: [{ step, at }], trail: Mapping }
};

// ---------- API ----------

// Doc / thread / job calls belong to the open workspace: /api/doc -> /api/w/<id>/doc
const GLOBAL_API = /^\/api\/(workspaces|events|health)\b/;
const apiUrl = (url) => (url.startsWith('/api/') && !GLOBAL_API.test(url) ? `/api/w/${encodeURIComponent(state.wsId)}${url.slice(4)}` : url);

async function api(method, url, body, opts = {}) {
  const res = await fetch(apiUrl(url), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ ...body, author: 'you' }) : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- Small helpers ----------

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const md = (text) => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(text)) : el('pre', {}, text).outerHTML);
const whoName = (a) => ({ claude: 'Claude', you: 'You', external: 'Outside editor', initial: 'Initial' })[a] || a;
const avatar = (a) => el('span', { class: `avatar ${a === 'claude' ? 'claude' : 'you'}` }, a === 'claude' ? 'C' : a === 'you' ? 'Y' : '·');

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

const narrow = () => matchMedia('(max-width: 1180px)').matches;
const claudeRecent = () => state.presence.listening || (state.presence.last_claude_at && Date.now() - state.presence.last_claude_at < 5 * 60_000);

// ---------- Comments plugin: inline highlights + "Claude changed this" blocks ----------

const commentsKey = new PluginKey('comments');

function buildDecorations(doc, s) {
  const index = buildIndex(doc);
  const decos = [];
  const ranges = new Map();
  for (const t of s.threads) {
    if (!t.anchor || (t.status === 'resolved' && !s.showResolved)) continue;
    const r = locate(index, t.anchor);
    if (!r || r.to <= r.from) continue;
    ranges.set(t.id, r);
    const cls = ['cm-hl', t.id === s.active && 'active', t.status === 'resolved' && 'resolved', t.draft && 'draft'].filter(Boolean).join(' ');
    decos.push(Decoration.inline(r.from, r.to, { class: cls, 'data-thread': t.id }));
  }
  if (s.draft?.range) decos.push(Decoration.inline(s.draft.range.from, s.draft.range.to, { class: 'cm-hl draft' }));
  return { decos: DecorationSet.create(doc, [...decos, ...s.changed.find()]), ranges };
}

// Node decorations on every paragraph / heading / list item inside [from, to]
function changedBlocks(doc, from, to) {
  const out = [];
  // A pure deletion has no text left to mark, so mark the blocks on either side of it
  const [f, t] = from === to ? [from - 1, to + 1] : [from, to];
  doc.nodesBetween(Math.max(0, f), Math.min(doc.content.size, t), (node, pos) => {
    if (!node.isTextblock) return true;
    out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'claude-changed' }));
    return false;
  });
  return out;
}

const Comments = Extension.create({
  name: 'comments',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: commentsKey,
        state: {
          init: (_, st) => {
            const base = { threads: [], active: null, showResolved: false, draft: null, changed: DecorationSet.empty };
            return { ...base, ...buildDecorations(st.doc, base) };
          },
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(commentsKey);
            if (!meta && !tr.docChanged) return value;
            const { addChanged, clearChanged, ...patch } = meta || {};
            const next = { ...value, ...patch };
            if (tr.docChanged) {
              if (next.draft?.range) next.draft = { ...next.draft, range: { from: tr.mapping.map(next.draft.range.from), to: tr.mapping.map(next.draft.range.to) } };
              next.changed = value.changed.map(tr.mapping, tr.doc); // marks follow the text as you keep typing
            }
            if (clearChanged) next.changed = DecorationSet.empty;
            if (addChanged) next.changed = next.changed.add(newState.doc, changedBlocks(newState.doc, addChanged.from, addChanged.to));
            return { ...next, ...buildDecorations(newState.doc, next) };
          },
        },
        props: { decorations: (st) => commentsKey.getState(st).decos },
      }),
    ];
  },
});

const pluginState = () => commentsKey.getState(editor.state);
function setPlugin(patch) {
  editor.view.dispatch(editor.state.tr.setMeta(commentsKey, patch));
}

// ---------- Editor ----------

const editor = new Editor({
  element: els.editor,
  extensions: [
    StarterKit.configure({ link: { openOnClick: false } }),
    TableKit,
    Markdown,
    Placeholder.configure({ placeholder: 'Start writing…' }),
    Comments,
  ],
  content: '',
  onUpdate: ({ transaction }) => onUserEdit(transaction),
  onTransaction: ({ transaction }) => {
    if (transaction.docChanged) {
      if (!transaction.getMeta('remote')) state.localMap.appendMapping(transaction.mapping);
      state.review?.trail.appendMapping(transaction.mapping);
    }
    scheduleLayout();
  },
});

// Editor content as Markdown, with the trailing newline files conventionally have
const serialize = () => editor.getMarkdown().replace(/\n*$/, '\n');

function setEditorContent(markdown) {
  state.loading = true;
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
  state.loading = false;
  state.serverContent = markdown;
  state.baseline = serialize();
  state.baseDoc = editor.state.doc;
  state.localMap = new Mapping();
  state.dirty = false;
}

// Apply a newer server version as a minimal in-place change, so your cursor, scroll
// and any unsaved typing elsewhere are kept. Returns the changed range, or null.
// The editor may keep an empty paragraph at the end that the file doesn't have; ignore those
function withoutTrailingEmpty(fragment) {
  let f = fragment;
  while (f.lastChild?.type.name === 'paragraph' && f.lastChild.content.size === 0) f = f.cut(0, f.size - f.lastChild.nodeSize);
  return f;
}

// Changed regions between two fragments, as [{ fromA, toA, fromB, toB }] in ascending order.
// Like a line diff: blocks are matched with an LCS, and a changed list / quote is diffed item by item,
// so two separate edits stay two marks instead of one span over everything in between.
function diffHunks(a, b, offA = 0, offB = 0, out = []) {
  const A = [];
  const B = [];
  a.forEach((n, p) => A.push({ n, p: offA + p }));
  b.forEach((n, p) => B.push({ n, p: offB + p }));
  const n = A.length;
  const m = B.length;
  const posA = (i) => (i < n ? A[i].p : offA + a.size);
  const posB = (j) => (j < m ? B[j].p : offB + b.size);
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = A[i].n.eq(B[j].n) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const same = (i, j) => i < n && j < m && A[i].n.eq(B[j].n);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (same(i, j)) {
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while ((i < n || j < m) && !same(i, j)) {
      if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) j++;
      else i++;
    }
    // Neighbouring changed blocks: pair them up one to one from both ends (an edited paragraph next to an
    // edited list stays two separate changes); whatever is left over is one inserted / deleted run
    let [ia, ib, ja, jb] = [i0, i, j0, j];
    const pairable = (x, y) => x.sameMarkup(y) && !x.isLeaf;
    const tail = [];
    while (ia < ib && ja < jb && pairable(A[ia].n, B[ja].n)) refine(ia++, ja++);
    while (ib > ia && jb > ja && pairable(A[ib - 1].n, B[jb - 1].n)) tail.unshift([--ib, --jb]);
    if (ia < ib || ja < jb) out.push({ fromA: posA(ia), toA: posA(ib), fromB: posB(ja), toB: posB(jb) });
    for (const [x, y] of tail) refine(x, y);
  }

  // One changed block on each side, same kind: recurse into a list / quote, or narrow a paragraph to its text
  function refine(ia, ja) {
    const x = A[ia].n;
    const y = B[ja].n;
    const [fa, fb] = [A[ia].p + 1, B[ja].p + 1];
    if (!x.isTextblock) return diffHunks(x.content, y.content, fa, fb, out);
    const s = x.content.findDiffStart(y.content);
    if (s == null) return;
    let { a: ea, b: eb } = x.content.findDiffEnd(y.content);
    const overlap = s - Math.min(ea, eb);
    if (overlap > 0) {
      ea += overlap;
      eb += overlap;
    }
    out.push({ fromA: fa + s, toA: fa + ea, fromB: fb + s, toB: fb + eb });
  }
  return out;
}

function applyRemoteContent(markdown) {
  const next = editor.schema.nodeFromJSON(editor.markdown.parse(markdown));
  const [a, b] = [withoutTrailingEmpty(state.baseDoc.content), withoutTrailingEmpty(next.content)];
  state.serverContent = markdown;
  const hunks = diffHunks(a, b);
  if (!hunks.length) return null;
  state.review ??= { edits: 0, inverses: [], trail: new Mapping() };
  let range = null;
  // Last change first, so the positions of earlier ones stay valid
  for (const h of hunks.reverse()) {
    const from = state.localMap.map(h.fromA, -1);
    const to = Math.max(from, state.localMap.map(h.toA, 1));
    const tr = editor.state.tr.replace(from, to, next.slice(h.fromB, h.toB));
    if (!tr.steps.length) continue;
    const inverse = tr.steps[0].invert(tr.docs[0]);
    range = { from, to: from + (h.toB - h.fromB) };
    tr.setMeta('remote', true).setMeta('addToHistory', false).setMeta(commentsKey, { addChanged: range });
    const at = state.review.trail.to;
    editor.view.dispatch(tr);
    state.review.inverses.push({ step: inverse, at });
  }
  state.baseDoc = next;
  if (state.dirty) {
    // You had unsaved typing: it's now merged on top of Claude's change; save the result
    state.localMap = new Mapping();
    state.baseDoc = editor.state.doc;
    flushSave();
  } else {
    state.localMap = new Mapping();
    state.baseline = serialize();
  }
  return range;
}

// ---------- Autosave ----------

function setSaveState(text) {
  els.saveState.textContent = text;
}

function onUserEdit(tr) {
  if (state.loading || !state.doc || tr?.getMeta('remote')) return;
  // Tell the server you're typing, so Claude's edits wait for a pause
  if (Date.now() - state.lastTypingPing > 1000) {
    state.lastTypingPing = Date.now();
    api('POST', '/api/typing', { path: state.doc.path }).catch(() => {});
  }
  state.dirty = true;
  setSaveState('Editing…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 900);
}

async function flushSave({ force = false } = {}) {
  clearTimeout(state.saveTimer);
  if (!state.doc || !state.dirty) return;
  if (state.saving) {
    state.saveTimer = setTimeout(flushSave, 300);
    return;
  }
  const markdown = serialize();
  const snapshot = editor.state.doc;
  const stepsAtSnapshot = state.localMap.to;
  if (markdown === state.baseline && !force) {
    state.dirty = false;
    setSaveState(`Saved · v${state.doc.version}`);
    return;
  }
  state.saving = true;
  setSaveState('Saving…');
  try {
    const r = await api('PUT', '/api/doc', {
      path: state.doc.path,
      content: markdown,
      message: state.saveMessage || 'Edited',
      coalesce: !state.saveMessage,
      ...(force ? {} : { base_version: state.doc.version }),
    });
    state.saveMessage = null;
    state.doc.version = r.version;
    state.serverContent = markdown;
    state.baseline = markdown;
    state.baseDoc = snapshot;
    state.localMap = state.localMap.slice(stepsAtSnapshot);
    state.dirty = serialize() !== markdown;
    setSaveState(`Saved · v${r.version}`);
    hideNotice('conflict');
  } catch (err) {
    if (err.status === 409) showConflict();
    else if (err.status === 423) setSaveState('Claude is editing · your change is kept');
    else setSaveState('Save failed, retrying…');
  } finally {
    state.saving = false;
    if (state.dirty && !els.notice.dataset.kind && !isLocked()) state.saveTimer = setTimeout(flushSave, 1500);
  }
}

window.addEventListener('beforeunload', () => {
  if (!state.dirty || !state.doc) return;
  fetch(apiUrl('/api/doc'), {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.doc.path, content: serialize(), message: 'Edited', coalesce: true, author: 'you' }),
  });
});

// ---------- Pages ----------

async function loadDocs() {
  const r = await api('GET', '/api/workspaces');
  state.workspaces = r.workspaces;
  for (const w of r.workspaces) state.presenceByWs[w.id] ??= w.presence;
  const ws = r.workspaces.find((w) => w.id === state.wsId);
  state.docs = ws?.docs || [];
  renderPages();
}

// ---------- Batch: draft comments wait here until you publish them together ----------

const draftCount = () => state.docs.reduce((n, d) => n + (d.drafts || 0), 0);
const hasDrafts = () => draftCount() > 0;

// Batch mode: while on, every comment and reply is a draft until you publish. Remembered per browser.
const MODE_KEY = 'docs.batchMode';
let batchMode = false;
try {
  batchMode = localStorage.getItem(MODE_KEY) === '1';
} catch {}
const batching = () => batchMode;

function setBatchMode(on) {
  batchMode = on;
  try {
    localStorage.setItem(MODE_KEY, on ? '1' : '0');
  } catch {}
  els.batchMode.checked = on;
  document.body.classList.toggle('batch-mode', on);
  renderPublish();
  if (state.doc) renderThreads();
}

els.batchMode.addEventListener('change', async () => {
  if (els.batchMode.checked) return setBatchMode(true);
  // Leaving batch mode: send what's waiting, or stay in it
  const n = draftCount();
  if (n && !confirm(`Publish your ${n} draft comment${n === 1 ? '' : 's'} and leave batch mode?`)) {
    els.batchMode.checked = true;
    return;
  }
  setBatchMode(false);
  if (n) await publishBatch();
});

function renderPublish() {
  const n = draftCount();
  els.publish.hidden = !n && !batchMode;
  els.publish.disabled = !n;
  els.publish.textContent = n ? `Publish ${n} comment${n === 1 ? '' : 's'}` : 'Publish';
}

async function publishBatch() {
  if (!hasDrafts()) return;
  els.publish.disabled = true;
  try {
    await api('POST', '/api/drafts/publish', {});
    await loadDocs();
  } catch (err) {
    alert(err.message);
  } finally {
    renderPublish();
  }
}
els.publish.addEventListener('click', publishBatch);

function wsStatus(id) {
  // Same rule as the top bar: a job, an open poll, or Claude active in the last 2 minutes
  const p = state.presenceByWs[id] || {};
  if (p.job) return 'working';
  if (p.listening) return 'listening';
  return p.last_claude_at && Date.now() - p.last_claude_at < 2 * 60_000 ? 'working' : 'offline';
}

// One group per repo: its status, and the open repo's pages
function renderPages() {
  renderPublish();
  els.pages.replaceChildren(
    ...state.workspaces.flatMap((w) => {
      const current = w.id === state.wsId;
      const status = wsStatus(w.id);
      const pending = w.docs.reduce((n, d) => n + d.pending, 0);
      const head = el(
        'li',
        { class: `ws${current ? ' current' : ''}`, title: `${w.repo}\nClaude: ${status}`, onclick: () => !current && go(w.id, w.docs[0]?.path || '') },
        el('span', { class: `ws-dot ${status}` }),
        el('span', { class: 'name' }, w.name),
        !current && pending ? el('span', { class: 'pending', title: 'Waiting for Claude' }, pending) : null,
        el('button', { class: 'ws-remove', title: 'Unregister this repo', 'aria-label': `Unregister ${w.name}`, onclick: (e) => removeWorkspace(e, w) }, '×'),
        // The full path, since repo names alone can collide
        el('span', { class: 'ws-path' }, `\u200E${w.repo}`),
      );
      // The open repo's pages sit in an indented group under it, ending with its + New page
      const group = current ? el('li', { class: 'ws-pages' }, el('ul', {}, ...pageItems(w.docs), el('li', { class: 'page-new' }, els.newPage))) : null;
      return [el('li', { class: `ws-group${current ? ' current' : ''}` }, el('ul', {}, head, group))];
    }),
  );
}

// Stops serving the repo. Its .docs/ folder stays on disk; `docs serve <repo>` or /collab-docs adds it back.
async function removeWorkspace(e, w) {
  e.stopPropagation();
  if (!confirm(`Unregister ${w.name}?\n${w.repo}\n\nIts .docs/ folder stays on disk. Run "docs serve" or /collab-docs in the repo to add it back.`)) return;
  try {
    await api('POST', '/api/workspaces/remove', { id: w.id });
  } catch (err) {
    alert(err.message);
  }
  // The workspaces_changed event refreshes the sidebar and moves off a removed repo
}

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.75h5.25L12.5 5v9.25h-8.5z"/><path d="M9 1.75V5.25h3.5"/></svg>';

function pageItems(docs) {
  return docs.map((d) => {
      const slash = d.path.lastIndexOf('/');
      return el(
        'li',
        { class: `page${d.path === state.doc?.path ? ' active' : ''}`, onclick: () => navigate(d.path), title: d.path },
        el('span', { class: 'page-icon', 'aria-hidden': 'true', html: FILE_ICON }),
        el('span', { class: 'name' }, slash > -1 ? el('span', { class: 'dir' }, d.path.slice(0, slash + 1)) : null, d.path.slice(slash + 1)),
        d.drafts ? el('span', { class: 'drafts', title: 'Draft comments, not yet published' }, d.drafts) : null,
        d.pending ? el('span', { class: 'pending', title: 'Waiting for Claude' }, d.pending) : null,
      );
  });
}

// URLs are #/<workspace>/<page path>
async function go(wsId, path) {
  await flushSave();
  location.hash = `#/${encodeURIComponent(wsId)}/${encodeURI(path)}`;
}
const navigate = (path) => go(state.wsId, path);

window.addEventListener('hashchange', () => openFromHash());

async function openFromHash() {
  const [wsPart, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const ws = state.workspaces.find((w) => w.id === decodeURIComponent(wsPart || ''));
  if (!ws) {
    const first = state.workspaces[0];
    if (first) return go(first.id, first.docs[0]?.path || '');
    return showEmpty('No repos yet. Run "docs serve <repo>", or /collab-docs in Claude Code inside a repo.');
  }
  if (ws.id !== state.wsId) {
    state.wsId = ws.id;
    state.doc = null;
    await loadDocs();
    state.presence = state.presenceByWs[ws.id] || ws.presence;
    renderPresence();
  }
  const path = decodeURI(rest.join('/'));
  if (!path) {
    if (state.docs[0]) return navigate(state.docs[0].path);
    return showEmpty('No pages in this repo yet. Create one with + New page.');
  }
  await loadDoc(path);
}

function showEmpty(message) {
  state.doc = null;
  els.empty.hidden = false;
  els.empty.textContent = message || 'Pick a page on the left, or create one.';
  els.editor.hidden = true;
  els.margin.hidden = true;
  els.crumbs.textContent = '';
  setSaveState('');
}

// Load (or reload) a document. keepView: same doc, apply changes in place.
// Calls run one at a time so concurrent live updates can't apply the same change twice.
let loadQueue = Promise.resolve();
function loadDoc(path, opts) {
  const run = loadQueue.then(() => loadDocNow(path, opts));
  loadQueue = run.catch(() => {});
  return run;
}

async function loadDocNow(path, { keepView = false } = {}) {
  let d;
  try {
    d = await api('GET', `/api/doc?path=${encodeURIComponent(path)}`);
  } catch (err) {
    return showEmpty(err.message);
  }
  const switching = state.doc?.path !== d.path;
  const contentChanged = switching || d.content !== state.serverContent;
  state.doc = { path: d.path, version: d.version, versions: d.versions, threads: d.threads };
  els.empty.hidden = true;
  els.editor.hidden = false;
  els.margin.hidden = false;

  if (switching) {
    state.active = null;
    state.draft = null;
    state.review = null;
    hideNotice();
    els.canvas.scrollTop = 0;
  }
  let changedRange = null;
  if (contentChanged) {
    if (keepView && !switching && state.baseDoc) changedRange = applyRemoteContent(d.content);
    else setEditorContent(d.content);
  }
  setPlugin({ threads: d.threads, active: state.active, draft: state.draft, showResolved: els.showResolved.checked, ...(switching && { clearChanged: true }) });
  renderHeader();
  renderLock();
  renderPages();
  renderThreads();
  renderVersions();
  if (!state.dirty) setSaveState(`Saved · v${d.version}`);
  if (changedRange && state.review) noteRemoteChange(d.versions);
  return changedRange;
}

// Count the not-yet-reviewed versions by Claude / outside the editor and show the notice
function noteRemoteChange(versions) {
  const r = state.review;
  const latest = versions[versions.length - 1];
  r.baseVersion ??= latest.id - 1;
  const unreviewed = versions.filter((v) => v.id > r.baseVersion && v.author !== 'you');
  r.edits = Math.max(1, unreviewed.length);
  r.author = unreviewed.some((v) => v.author === 'claude') ? 'claude' : latest.author;
  showReviewNotice({ message: latest.message, thread_id: latest.thread_id });
}

function renderHeader() {
  const p = state.doc.path;
  const slash = p.lastIndexOf('/');
  els.crumbs.replaceChildren(slash > -1 ? `${p.slice(0, slash).split('/').join(' / ')} / ` : '', el('b', {}, p.slice(slash + 1)));
  document.title = `${p.slice(slash + 1)} · Docs`;
}

// ---------- Notices ----------

function showNotice(kind, ...children) {
  els.notice.dataset.kind = kind;
  els.notice.replaceChildren(...children.filter(Boolean), el('button', { onclick: () => hideNotice(), title: 'Dismiss' }, '✕'));
  els.notice.hidden = false;
}
function hideNotice(kind) {
  if (kind && els.notice.dataset.kind !== kind) return;
  if (els.notice.dataset.kind === 'edit' && state.review) {
    state.review = null;
    setPlugin({ clearChanged: true });
  }
  els.notice.hidden = true;
  delete els.notice.dataset.kind;
}

function showConflict() {
  setSaveState('Not saved');
  showNotice(
    'conflict',
    el('span', { class: 'grow' }, el('b', {}, 'This page changed outside the editor while you were typing.')),
    el('button', { onclick: async () => { hideNotice(); state.dirty = false; await loadDoc(state.doc.path); } }, 'Load latest (drop my edits)'),
    el('button', { onclick: async () => { hideNotice(); await flushSave({ force: true }); } }, 'Keep mine (theirs stays in History)'),
  );
}

// ---------- Selection bubble → comment / format ----------

function domSelectionRange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!els.editor.contains(r.commonAncestorContainer)) return null;
  try {
    const from = editor.view.posAtDOM(r.startContainer, r.startOffset);
    const to = editor.view.posAtDOM(r.endContainer, r.endOffset);
    return to > from ? { from, to } : null;
  } catch {
    return null;
  }
}

function updateBubble() {
  const range = state.doc && domSelectionRange();
  if (!range || state.draft) return (els.bubble.hidden = true);
  const a = editor.view.coordsAtPos(range.from);
  const b = editor.view.coordsAtPos(range.to);
  const c = els.canvas.getBoundingClientRect();
  els.bubble.style.left = `${(Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - c.left + els.canvas.scrollLeft}px`;
  els.bubble.style.top = `${a.top - c.top + els.canvas.scrollTop}px`;
  els.bubble.hidden = false;
}

els.editor.addEventListener('mouseup', () => setTimeout(updateBubble, 0));
els.editor.addEventListener('keyup', (e) => e.shiftKey && updateBubble());
document.addEventListener('selectionchange', () => {
  if (!window.getSelection()?.isCollapsed) return;
  els.bubble.hidden = true;
});
els.bubble.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
els.bubble.addEventListener('click', (e) => {
  const cmd = e.target.closest('button')?.dataset.cmd;
  if (!cmd) return;
  if (cmd === 'comment') return commentOnSelection();
  const chain = editor.chain().focus();
  ({
    bold: () => chain.toggleBold(),
    italic: () => chain.toggleItalic(),
    code: () => chain.toggleCode(),
    h2: () => chain.toggleHeading({ level: 2 }),
    bullet: () => chain.toggleBulletList(),
  })[cmd]?.().run();
  setTimeout(updateBubble, 0);
});

function commentOnSelection() {
  const range = domSelectionRange();
  if (!range) return;
  const anchor = anchorFromRange(editor.state.doc, range.from, range.to);
  if (!anchor) return;
  els.bubble.hidden = true;
  window.getSelection().removeAllRanges();
  startDraft({ anchor, range });
}

function startDraft(draft) {
  state.draft = draft;
  state.active = 'draft';
  setPlugin({ draft, active: null });
  if (narrow()) els.margin.classList.add('open');
  renderThreads();
  els.threads.querySelector('.draft textarea')?.focus();
}

function cancelDraft() {
  state.draft = null;
  state.active = null;
  setPlugin({ draft: null });
  renderThreads();
}

async function submitDraft(text, { batch = false } = {}) {
  if (!text.trim() || !state.draft) return;
  const t = await api('POST', '/api/threads', { path: state.doc.path, text, anchor: state.draft.anchor, draft: batch });
  if (batch) await loadDocs();
  state.draft = null;
  state.active = t.id;
  setPlugin({ draft: null });
  await loadDoc(state.doc.path, { keepView: true });
}

$('page-comment').addEventListener('click', () => state.doc && startDraft({ anchor: null, range: null }));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey && hasDrafts()) {
    e.preventDefault();
    e.stopPropagation();
    return publishBatch();
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.altKey && (e.key === 'm' || e.code === 'KeyM')) {
    e.preventDefault();
    commentOnSelection();
  } else if (mod && e.key === 's') {
    e.preventDefault();
    flushSave();
  } else if (e.key === 'Escape' && state.draft) {
    cancelDraft();
  }
});

// Clicking a highlight opens its thread
els.editor.addEventListener('click', (e) => {
  const hl = e.target.closest('.cm-hl[data-thread]');
  if (hl && window.getSelection().isCollapsed) setActive(hl.dataset.thread);
});

// ---------- Margin threads ----------

function setActive(id, { scrollDoc = false } = {}) {
  if (state.draft && id !== 'draft') cancelDraft();
  state.active = id;
  setPlugin({ active: id });
  if (narrow()) els.margin.classList.add('open');
  renderThreads();
  const range = pluginState().ranges.get(id);
  if (scrollDoc && range) {
    const c = els.canvas.getBoundingClientRect();
    const y = editor.view.coordsAtPos(range.from).top - c.top + els.canvas.scrollTop;
    els.canvas.scrollTo({ top: Math.max(0, y - 160), behavior: 'smooth' });
  }
}

function chipFor(t) {
  if (t.draft) return el('span', { class: 'chip draft' }, 'Draft');
  if (t.status === 'resolved') return el('span', { class: 'chip' }, 'Resolved');
  const last = t.messages[t.messages.length - 1];
  if (last.author === 'claude') {
    return el('span', { class: 'chip replied' }, t.messages.length === 1 ? 'Claude' : 'Claude replied');
  }
  if (t.claude_working && claudeRecent()) return el('span', { class: 'chip working' }, 'Claude is on it');
  if (t.on_hold) return el('span', { class: 'chip' }, 'Taken back · reply to send to Claude');
  return el('span', { class: 'chip waiting' }, 'Waiting for Claude');
}

function threadCard(t, anchored) {
  const active = state.active === t.id;
  const msgs = active || t.messages.length < 3 ? t.messages : [t.messages[0], t.messages[t.messages.length - 1]];
  const card = el(
    'div',
    {
      class: ['thread', active && 'active', t.status === 'resolved' && 'resolved', t.draft && 'is-draft', !t.anchor && 'page-level'].filter(Boolean).join(' '),
      'data-id': t.id,
      onclick: () => !active && setActive(t.id, { scrollDoc: narrow() }),
    },
    !t.anchor ? el('div', { class: 't-quote', style: 'border-color: var(--faint)' }, 'Page comment') : null,
    t.anchor && !anchored ? el('div', { class: 't-orphan' }, 'Highlighted text was removed') : null,
    t.anchor && (!anchored || narrow()) ? el('div', { class: 't-quote' }, t.anchor.quote) : null,
    ...msgs.map((m, i) =>
      el(
        'div',
        { class: 't-msg' },
        el('div', { class: 't-head' }, avatar(m.author), el('span', { class: 'name' }, whoName(m.author)), el('span', { class: 'when' }, ago(m.at)), m.draft ? el('span', { class: 'chip draft' }, 'Draft') : i === 0 ? chipFor(t) : null),
        el('div', { class: 't-body', html: md(m.text) }),
      ),
    ),
    !active && t.messages.length > 2 ? el('div', { class: 't-more' }, `${t.messages.length - 2} earlier repl${t.messages.length === 3 ? 'y' : 'ies'}`) : null,
  );
  if (active) card.append(...threadControls(t));
  return card;
}

function threadControls(t) {
  const ta = el('textarea', { rows: '1', placeholder: t.status === 'resolved' ? 'Reply to reopen…' : 'Reply…', 'data-draft': t.id });
  ta.value = state.replyDrafts.get(t.id) || '';
  ta.addEventListener('input', () => {
    state.replyDrafts.set(t.id, ta.value);
    autoGrow(ta);
  });
  const send = async ({ batch = false } = {}) => {
    const text = ta.value.trim();
    if (!text) return;
    state.replyDrafts.delete(t.id);
    // A reply on a draft thread is part of that draft
    await api('POST', '/api/threads/reply', { path: state.doc.path, thread_id: t.id, text, draft: batch || Boolean(t.draft) });
    if (batch || t.draft) await loadDocs();
    await loadDoc(state.doc.path, { keepView: true });
  };
  const hasDraft = t.draft || t.messages.some((m) => m.draft);
  const discard = async () => {
    await api('POST', '/api/drafts/discard', { path: state.doc.path, thread_id: t.id });
    if (t.draft) state.active = null;
    await loadDocs();
    await loadDoc(state.doc.path, { keepView: true });
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.stopPropagation();
    // ⌘⇧↵ adds this reply to the batch and publishes everything
    if (e.shiftKey) send({ batch: true }).then(publishBatch);
    else send({ batch: batching() });
  });
  const del = async () => {
    if (!confirm('Delete this thread?')) return;
    await api('POST', '/api/threads/delete', { path: state.doc.path, thread_id: t.id });
    state.active = null;
    await loadDoc(state.doc.path, { keepView: true });
  };
  const toggle = async () => {
    await api('POST', '/api/threads/status', { path: state.doc.path, thread_id: t.id, status: t.status === 'open' ? 'resolved' : 'open' });
    await loadDoc(state.doc.path, { keepView: true });
  };
  return [
    composer(ta, sendButton(send, 'Reply', Boolean(t.draft), ta)),
    el(
      'div',
      { class: 't-actions' },
      t.draft ? null : el('button', { class: 'link', onclick: toggle }, t.status === 'open' ? '✓ Resolve' : 'Reopen'),
      hasDraft ? el('button', { class: 'link', onclick: discard }, t.draft ? 'Discard' : 'Discard draft') : null,
      t.draft ? null : el('button', { class: 'link danger', onclick: del }, 'Delete'),
    ),
  ];
}

// The text box and its send button share one rounded frame that lights up on focus
function composer(ta, send, extra = null) {
  return el(
    'div',
    { class: 'composer', onclick: (e) => e.target === e.currentTarget && ta.focus() },
    ta,
    el('div', { class: 'composer-bar' }, el('span', { class: 'hint' }, extra || '⌘↵ to send'), send),
  );
}

function draftCard() {
  const ta = el('textarea', { rows: '2', 'data-draft': 'draft', placeholder: batchMode ? 'Draft comment, sent when you publish…' : state.draft.anchor ? 'Comment for Claude…' : 'Comment on this page…' });
  // Kept on state.draft so re-renders (batch toggle, presence updates) don't wipe what you typed
  ta.value = state.draft.text || '';
  ta.addEventListener('input', () => (state.draft.text = ta.value));
  const submit = (opts) => submitDraft(ta.value, opts);
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.stopPropagation();
    if (e.shiftKey) submit({ batch: true }).then(publishBatch);
    else submit({ batch: batching() });
  });
  ta.addEventListener('input', () => autoGrow(ta));
  return el(
    'div',
    { class: `thread active draft${state.draft.anchor ? '' : ' page-level'}`, 'data-id': 'draft' },
    el('div', { class: 't-quote' }, state.draft.anchor ? state.draft.anchor.quote : 'Page comment'),
    composer(ta, sendButton(submit, 'Comment', false, ta), el('button', { class: 'link', onclick: cancelDraft, title: 'Esc' }, 'Cancel')),
  );
}

// In batch mode the button adds a draft; otherwise it sends to Claude right away
const SEND_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';

function sendButton(send, label, draftOnly = false, ta = null) {
  const batch = draftOnly || batchMode;
  const btn = batch
    ? el('button', { class: 'send batch', onclick: () => send({ batch }), title: 'Saved as a draft until you publish (⌘↵)' }, 'Add to batch')
    : el('button', { class: 'send', onclick: () => send({ batch }), title: `${label}: send to Claude now (⌘↵)`, 'aria-label': label, html: SEND_ICON });
  // Disabled until there's something to send
  if (ta) {
    const sync = () => (btn.disabled = !ta.value.trim());
    ta.addEventListener('input', sync);
    queueMicrotask(sync);
  }
  return btn;
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

function renderThreads() {
  if (!state.doc) return;
  const ranges = pluginState().ranges;
  const visible = state.doc.threads.filter((t) => t.status === 'open' || els.showResolved.checked);
  const open = state.doc.threads.filter((t) => t.status === 'open').length;
  els.threadCount.textContent = open || '';

  const focused = document.activeElement?.dataset?.draft;
  const caret = focused ? document.activeElement.selectionStart : 0;

  const cards = visible.map((t) => threadCard(t, ranges.has(t.id)));
  if (state.draft) cards.push(draftCard());
  els.threads.replaceChildren(...cards);
  if (!cards.length) els.threads.append(el('p', { class: 'small muted', style: 'margin: 4px 2px' }, 'Highlight text to comment. Claude picks comments up from here.'));

  if (focused) {
    const ta = els.threads.querySelector(`textarea[data-draft="${focused}"]`);
    ta?.focus();
    ta?.setSelectionRange(caret, caret);
  }
  els.threads.querySelectorAll('textarea').forEach(autoGrow);
  layoutThreads();
}

let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutThreads();
  });
}

// Place each card next to its highlight; push overlapping cards apart (active card wins its spot)
function layoutThreads() {
  if (!state.doc || narrow()) {
    els.threads.style.height = '';
    return;
  }
  const ranges = pluginState().ranges;
  const base = els.threads.getBoundingClientRect().top;
  const items = [...els.threads.querySelectorAll('.thread')].map((card) => {
    const id = card.dataset.id;
    const range = id === 'draft' ? state.draft?.range : ranges.get(id);
    let want = 0;
    if (range) {
      try {
        want = editor.view.coordsAtPos(range.from).top - base;
      } catch {}
    }
    return { card, id, want, h: card.offsetHeight, pinned: !range };
  });
  // Page-level and detached threads stack at the top, then anchored ones by position
  items.sort((a, b) => (a.pinned === b.pinned ? a.want - b.want : a.pinned ? -1 : 1));
  const GAP = 10;
  let y = 0;
  for (const it of items) {
    it.top = it.pinned ? y : Math.max(it.want, y);
    y = it.top + it.h + GAP;
  }
  // The active card sits exactly beside its highlight: cards below move down, cards above move up
  const ai = items.findIndex((it) => it.id === state.active && !it.pinned);
  if (ai > -1) {
    const floor = items.filter((it) => it.pinned).reduce((m, it) => Math.max(m, it.top + it.h + GAP), 0);
    items[ai].top = Math.max(items[ai].want, floor);
    for (let i = ai + 1; i < items.length; i++) items[i].top = Math.max(items[i].want, items[i - 1].top + items[i - 1].h + GAP);
    for (let i = ai - 1; i >= 0 && !items[i].pinned; i--) items[i].top = Math.max(floor, Math.min(items[i].want, items[i + 1].top - items[i].h - GAP));
  }
  let bottom = 0;
  for (const it of items) {
    it.card.style.top = `${it.top}px`;
    bottom = Math.max(bottom, it.top + it.h);
  }
  els.threads.style.height = `${bottom + 40}px`;
}

new ResizeObserver(scheduleLayout).observe(els.editor);
window.addEventListener('resize', () => {
  if (!narrow()) els.margin.classList.remove('open');
  renderThreads();
});
document.fonts?.ready.then(scheduleLayout);

els.showResolved.addEventListener('change', () => {
  setPlugin({ showResolved: els.showResolved.checked });
  renderThreads();
});
$('open-threads').addEventListener('click', () => els.margin.classList.toggle('open'));
$('open-sidebar').addEventListener('click', () => els.sidebar.classList.toggle('open'));
els.canvas.addEventListener('click', (e) => {
  // Click on empty canvas closes the active thread (wide layout)
  if (!narrow() && state.active && state.active !== 'draft' && !e.target.closest('.thread, .cm-hl, .bubble')) {
    state.active = null;
    setPlugin({ active: null });
    renderThreads();
  }
});

// ---------- History ----------

function renderVersions() {
  const d = state.doc;
  els.versions.replaceChildren(
    ...[...d.versions].reverse().map((v) =>
      el(
        'li',
        { onclick: () => openDiff(v.id) },
        avatar(v.author),
        el(
          'div',
          { class: 'meta' },
          el('div', { class: 'line1' }, el('span', { class: 'v' }, `v${v.id}`), el('span', {}, whoName(v.author)), el('span', { class: 'when' }, ago(v.at)), v.id === d.version ? el('span', { class: 'current' }, 'current') : null),
          v.message ? el('div', { class: 'msg' }, v.message) : null,
        ),
      ),
    ),
  );
}

$('open-history').addEventListener('click', () => {
  if (!state.doc) return;
  renderVersions();
  els.history.hidden = false;
});
$('close-history').addEventListener('click', () => (els.history.hidden = true));

const versionText = async (id) => (await api('GET', `/api/version?path=${encodeURIComponent(state.doc.path)}&id=${id}`)).content;

async function openDiff(id) {
  await flushSave();
  state.diffVersion = id;
  await renderDiff();
  if (!els.diffDialog.open) els.diffDialog.showModal();
}

async function renderDiff() {
  const id = state.diffVersion;
  const v = state.doc.versions.find((x) => x.id === id);
  let before;
  let after;
  if (els.diffVsCurrent.checked) {
    [before, after] = [await versionText(id), await versionText(state.doc.version)];
    els.diffTitle.textContent = `v${id} → current (v${state.doc.version})`;
  } else {
    after = await versionText(id);
    before = id > 1 ? await versionText(id - 1) : '';
    els.diffTitle.textContent = `v${id} · ${whoName(v.author)}${v.message ? ` · ${v.message}` : ''}`;
  }
  const rows = withContext(diffLines(before, after));
  els.diffBody.replaceChildren(...(rows.length ? rows.map((r) => el('div', { class: r.type }, r.text || ' ')) : [el('div', { class: 'skip' }, 'No changes')]));
  els.diffRestore.hidden = id === state.doc.version;
  els.diffRestore.textContent = `Restore v${id}`;
}

els.diffVsCurrent.addEventListener('change', renderDiff);
$('diff-close').addEventListener('click', () => els.diffDialog.close());
els.diffRestore.addEventListener('click', async () => {
  await restore(state.diffVersion);
  els.diffDialog.close();
});

async function restore(id) {
  await flushSave();
  await api('POST', '/api/revert', { path: state.doc.path, version_id: id });
  clearReview();
  await loadDoc(state.doc.path);
}

function clearReview() {
  state.review = null;
  setPlugin({ clearChanged: true });
  hideNotice('edit');
}

// Undo only Claude's changes (newest first), mapped through everything typed since
function undoClaude() {
  const r = state.review;
  if (!r) return;
  let failed = 0;
  for (const { step, at } of [...r.inverses].reverse()) {
    const mapped = step.map(r.trail.slice(at + 1));
    const tr = editor.state.tr;
    if (!mapped || tr.maybeStep(mapped).failed) {
      failed++;
      continue;
    }
    editor.view.dispatch(tr);
  }
  state.saveMessage = r.edits > 1 ? "Undid Claude's edits" : "Undid Claude's edit";
  clearReview();
  flushSave();
  if (failed) alert(`${failed} of Claude's changes overlapped your later edits and were kept. Use History to restore an older version.`);
}

// ---------- Presence ----------

function renderPresence() {
  const p = state.presence;
  const active = p.job || (p.last_claude_at && Date.now() - p.last_claude_at < 2 * 60_000);
  els.presence.className = `presence ${p.listening ? 'listening' : active ? 'active' : ''}`;
  els.presenceText.textContent = p.job ? 'Working' : p.listening ? 'Listening' : active ? 'Working' : 'Offline';
  els.presence.title = p.job
    ? `Claude is working on ${p.job.path}`
    : p.listening
      ? 'Claude is waiting for your comments'
      : active
        ? 'Claude is working on comments'
        : 'No Claude session for this repo. Run /collab-docs in Claude Code inside it.';
  renderLock();
}
setInterval(() => {
  renderPresence();
  renderPages(); // repo status dots age too
}, 15_000);

// ---------- Page lock: while Claude works on this page, it's the only writer ----------

const isLocked = () => Boolean(state.doc && state.presence.job?.path === state.doc.path);

function renderLock() {
  const locked = isLocked();
  if (editor.isEditable === locked) editor.setEditable(!locked);
  els.lock.hidden = !locked;
  if (!locked) return;
  const n = state.presence.job.threads;
  els.lock.replaceChildren(
    el('span', { class: 'spinner' }),
    el('span', { class: 'grow' }, el('b', {}, 'Claude is editing this page'), ` · ${n} comment${n === 1 ? '' : 's'}. You can keep commenting.`),
    el('button', { onclick: takeOver, title: 'Stop Claude working on this page' }, 'Take over'),
  );
}

async function takeOver() {
  if (!confirm('Take this page back from Claude? Its comments stay open; reply to one to send it to Claude again.')) return;
  await api('POST', '/api/jobs/release', { job_id: state.presence.job?.id }).catch((err) => alert(err.message));
}

// ---------- Live updates ----------

function showReviewNotice(ev) {
  const r = state.review;
  const by = r.author === 'claude' ? 'Claude' : 'Outside editor';
  const what = r.edits === 1 && ev?.message ? ` · ${ev.message}` : r.edits > 1 ? ` made ${r.edits} edits` : ' edited this page';
  showNotice(
    'edit',
    avatar(r.author === 'claude' ? 'claude' : 'external'),
    el('span', { class: 'grow' }, el('b', {}, r.edits === 1 && ev?.message ? `${by} edited this page` : by), what),
    el('button', { onclick: () => { els.diffVsCurrent.checked = true; openDiff(r.baseVersion); } }, 'View changes'),
    ev?.thread_id ? el('button', { onclick: () => { els.showResolved.checked = true; setPlugin({ showResolved: true }); setActive(ev.thread_id, { scrollDoc: true }); } }, 'Show comment') : null,
    el('button', { onclick: undoClaude }, r.edits > 1 ? 'Undo all' : 'Undo'),
  );
}

function connectEvents() {
  const es = new EventSource('/api/events');
  // Events from other repos only refresh the sidebar
  const here = (ev) => ev.workspace === state.wsId;
  es.addEventListener('presence', (e) => {
    const p = JSON.parse(e.data);
    state.presenceByWs[p.workspace] = p;
    renderPages();
    if (!here(p)) return;
    state.presence = p;
    renderPresence();
    if (state.doc) renderThreads();
  });
  es.addEventListener('workspaces_changed', () =>
    loadDocs().then(() => {
      // The open repo was unregistered (here or in another tab): fall back to the first one
      if (state.wsId && !state.workspaces.some((w) => w.id === state.wsId)) {
        state.wsId = null;
        state.doc = null;
      }
      if (!state.wsId) openFromHash();
    }),
  );
  es.addEventListener('docs_changed', () => loadDocs());
  es.addEventListener('threads_changed', async (e) => {
    const ev = JSON.parse(e.data);
    loadDocs();
    if (here(ev) && ev.path === state.doc?.path) await loadDoc(ev.path, { keepView: true });
  });
  es.addEventListener('job_done', async (e) => {
    const ev = JSON.parse(e.data);
    if (!here(ev) || ev.path !== state.doc?.path) return;
    state.presence.job = null;
    renderLock();
    if (state.dirty) flushSave(); // a save that was refused while locked
  });
  es.addEventListener('claude_waiting', (e) => {
    const ev = JSON.parse(e.data);
    if (!here(ev) || ev.path !== state.doc?.path) return;
    setSaveState('Claude will edit when you pause…');
  });
  es.addEventListener('doc_changed', async (e) => {
    const ev = JSON.parse(e.data);
    loadDocs();
    if (!here(ev) || ev.path !== state.doc?.path) return;
    if (ev.author === 'you' && (state.saving || ev.version <= state.doc.version)) return; // our own autosave
    await loadDoc(ev.path, { keepView: true });
  });
  es.onerror = () => {
    els.presence.className = 'presence';
    els.presenceText.textContent = 'Server offline';
  };
}

// ---------- New page ----------

$('new-page').addEventListener('click', async () => {
  if (!state.wsId) return alert('No repo yet. Run "docs serve <repo>" first.');
  let path = prompt('New page path (e.g. specs/feature.md):');
  if (!path) return;
  if (!/\.(md|markdown)$/i.test(path)) path += '.md';
  const name = path.split('/').pop().replace(/\.(md|markdown)$/i, '').replace(/[-_]/g, ' ');
  try {
    await api('PUT', '/api/doc', { path, content: `# ${name[0].toUpperCase()}${name.slice(1)}\n\n`, message: 'Created' });
    await loadDocs();
    navigate(path);
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Start ----------

setBatchMode(batchMode);

await loadDocs();
await openFromHash();
connectEvents();
renderPresence();
