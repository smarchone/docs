// Line diff (LCS). Returns [{ type: 'same' | 'add' | 'del', text }].
export function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  // Trim common head/tail so the LCS table stays small
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a2 = A.slice(head, A.length - tail);
  const b2 = B.slice(head, B.length - tail);

  let middle;
  if (a2.length * b2.length > 4_000_000) {
    middle = [...a2.map((text) => ({ type: 'del', text })), ...b2.map((text) => ({ type: 'add', text }))];
  } else {
    const n = a2.length;
    const m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) middle.push({ type: 'same', text: a2[i++] }), j++;
      else if (dp[i + 1][j] >= dp[i][j + 1]) middle.push({ type: 'del', text: a2[i++] });
      else middle.push({ type: 'add', text: b2[j++] });
    }
    while (i < n) middle.push({ type: 'del', text: a2[i++] });
    while (j < m) middle.push({ type: 'add', text: b2[j++] });
  }
  return [
    ...A.slice(0, head).map((text) => ({ type: 'same', text })),
    ...middle,
    ...A.slice(A.length - tail).map((text) => ({ type: 'same', text })),
  ];
}

// Collapse long unchanged runs, keeping `context` lines around each change
export function withContext(diff, context = 3) {
  const keep = diff.map(() => false);
  diff.forEach((d, i) => {
    if (d.type === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: 'skip', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      out.push(d);
    } else skipped++;
  });
  if (skipped) out.push({ type: 'skip', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}
