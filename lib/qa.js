// Q&A ブロックの読み取り・書き込み（純粋関数）
//
// 書式:
//   > [!ANSWER] Q1            … 見出しの直下に積み重なる
//   > 回答本文
//
//   > [!QUESTION] Q1 対象:「文」 … 対象ブロックの直後
//   > 質問本文

const HEAD_RE = /^>\s?\[!(QUESTION|ANSWER)\]\s+(Q\d+(?:-\d+)*)\b(.*)$/;
const TARGET_RE = /対象:「(.*)」\s*$/;

export function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol };
}

const isBlank = (l) => l === undefined || l.trim() === '';

/** すべての Q&A ブロックを返す。start/end は行番号（end は含まない）。 */
export function parseBlocks(lines) {
  const blocks = [];
  let inFence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) inFence = fence[1][0];
      else if (fence[1][0] === inFence) inFence = null;
      continue;
    }
    if (inFence) continue;
    const m = line.match(HEAD_RE);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && /^>/.test(lines[end])) end++;
    const t = m[3].match(TARGET_RE);
    const body = lines
      .slice(i + 1, end)
      .map((l) => l.replace(/^>\s?/, ''))
      .join('\n')
      .trim();
    blocks.push({
      kind: m[1] === 'QUESTION' ? 'question' : 'answer',
      id: m[2],
      target: t ? t[1] : null,
      body,
      start: i,
      end,
    });
    i = end - 1;
  }
  return blocks;
}

function blockAt(blocks, line) {
  return blocks.find((b) => b.start === line);
}

/** idx から、空行と Q&A ブロック（filter に合うもの）を飛ばした位置を返す */
function skipQA(lines, blocks, idx, filter = () => true) {
  let pos = idx;
  let j = idx;
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    const b = blockAt(blocks, j);
    if (b && filter(b)) { pos = b.end; j = b.end; continue; }
    break;
  }
  return pos;
}

function quoteLines(text) {
  return text.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>'));
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function insertAt(lines, idx, chunk) {
  const out = [''].concat(chunk);
  if (idx < lines.length && !isBlank(lines[idx])) out.push('');
  lines.splice(idx, 0, ...out);
}

function frontMatterEnd(lines) {
  if (lines[0] !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') return i + 1;
  return 0;
}

export function nextTopId(blocks) {
  let max = 0;
  for (const b of blocks) {
    const m = b.id.match(/^Q(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Q${max + 1}`;
}

export function nextChildId(blocks, parentId) {
  let max = 0;
  const re = new RegExp(`^${parentId}-(\\d+)$`);
  for (const b of blocks) {
    const m = b.id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${parentId}-${max + 1}`;
}

/**
 * 本文への質問を追加する。
 * @param {string} text
 * @param {{blockEnd:number, headingLine:number, sentence:string, question:string}} o
 *   blockEnd   … 対象ブロックの終了行（含まない）
 *   headingLine… 対象より上で一番近い見出しの行。なければ -1
 */
export function addQuestion(text, o) {
  const { lines, eol } = splitLines(text);
  const blocks = parseBlocks(lines);
  const id = nextTopId(blocks);

  const qChunk = [`> [!QUESTION] ${id} 対象:「${oneLine(o.sentence)}」`, ...quoteLines(o.question.trim())];
  const aChunk = [`> [!ANSWER] ${id}`, '>'];

  // 質問: 対象ブロックの直後（既にある質問の後ろ）
  const qPos = skipQA(lines, blocks, o.blockEnd);
  // 回答: 見出しの直下（既にある回答スタックの後ろ）
  const anchor = o.headingLine >= 0 ? o.headingLine + 1 : frontMatterEnd(lines);
  const aPos = skipQA(lines, blocks, anchor);

  // 下から挿入して行番号のずれを防ぐ
  if (qPos >= aPos) {
    insertAt(lines, qPos, qChunk);
    insertAt(lines, aPos, aChunk);
  } else {
    insertAt(lines, aPos, aChunk);
    insertAt(lines, qPos, qChunk);
  }
  return { text: lines.join(eol), id };
}

/** 回答への追加の質問（スレッド）を追加する */
export function addFollowUp(text, o) {
  const { lines, eol } = splitLines(text);
  const blocks = parseBlocks(lines);
  const parent = blocks.find((b) => b.kind === 'answer' && b.id === o.parentId);
  if (!parent) throw new Error(`answer ${o.parentId} not found`);
  const id = nextChildId(blocks, o.parentId);
  const prefix = `${o.parentId}-`;
  const pos = skipQA(lines, blocks, parent.end, (b) => b.id.startsWith(prefix));
  insertAt(lines, pos, [
    `> [!QUESTION] ${id} 対象:「${oneLine(o.sentence)}」`,
    ...quoteLines(o.question.trim()),
    '',
    `> [!ANSWER] ${id}`,
    '>',
  ]);
  return { text: lines.join(eol), id };
}

/** 選んだ Q&A の組と、そこから派生した追加の質問（スレッド）を含めた判定 */
export function inThread(id, roots) {
  return roots.some((r) => id === r || id.startsWith(r + '-'));
}

/** Q&A を取り除く。ids を渡すとその組（質問と回答）とスレッドだけ、省略するとすべて */
export function stripAll(text, ids) {
  const { lines, eol } = splitLines(text);
  const blocks = parseBlocks(lines).filter((b) => !ids || inThread(b.id, ids));
  for (const b of [...blocks].reverse()) {
    let start = b.start;
    if (start > 0 && isBlank(lines[start - 1])) start--;
    lines.splice(start, b.end - start);
    // 挿入時に足した空行が二重に残らないようにする
    if (start > 0 && isBlank(lines[start - 1]) && start < lines.length && isBlank(lines[start])) {
      lines.splice(start, 1);
    }
  }
  return lines.join(eol);
}

export function unanswered(blocks) {
  return blocks.filter((b) => b.kind === 'answer' && !b.body).map((b) => b.id);
}

// ---------- 編集モード: 本文と Q&A の分離・再合成 ----------

/**
 * 本文と Q&A を分ける。
 * runs[i].after … その Q&A の塊の前にある本文の行数（= 本文の何行目の後ろに付いているか）
 */
export function segment(text) {
  const { lines, eol } = splitLines(text);
  const blocks = parseBlocks(lines);
  const removed = new Array(lines.length).fill(false);
  for (const b of blocks) {
    for (let i = b.start; i < b.end; i++) removed[i] = true;
    if (b.start > 0 && isBlank(lines[b.start - 1]) && !removed[b.start - 1]) removed[b.start - 1] = true;
  }
  // 取り除いた塊の前後が両方空行なら、後ろの空行も塊に含める（空行が二重に残らないように）
  for (let i = 0; i < lines.length; i++) {
    if (!removed[i]) continue;
    let j = i;
    while (j < lines.length && removed[j]) j++;
    let p = i - 1;
    if (p >= 0 && j < lines.length && isBlank(lines[p]) && isBlank(lines[j])) removed[j] = true;
    i = j;
  }
  const body = [];
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!removed[i]) { body.push(lines[i]); continue; }
    const last = runs[runs.length - 1];
    if (last && last.after === body.length && last.end === i) { last.lines.push(lines[i]); last.end = i + 1; }
    else runs.push({ after: body.length, lines: [lines[i]], end: i + 1 });
  }
  return { body, runs, eol };
}

/** 旧本文の各行 → 新本文の行番号（消えた行は -1） */
function matchLines(a, b) {
  const map = new Array(a.length).fill(-1);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) { map[pre] = pre; pre++; }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    map[a.length - 1 - suf] = b.length - 1 - suf;
    suf++;
  }
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length || !B.length) return map;
  if (A.length * B.length > 4e6) return map; // 大きすぎる差分は前後の一致だけで位置を決める
  // LCS（最長共通部分列）
  const n = A.length, m = B.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = A[i] === B[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { map[pre + i] = pre + j; i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return map;
}

/** 編集後の本文に、元の Q&A を元の位置関係で戻す */
export function mergeBody(oldText, newBody) {
  const { body: oldBody, runs, eol } = segment(oldText);
  const newLines = newBody.split(/\r?\n/);
  const map = matchLines(oldBody, newLines);

  const anchorOf = (after) => {
    if (after === 0) return { at: 0, moved: false };
    const k = after - 1; // この行の直後に付いていた
    if (map[k] >= 0) return { at: map[k] + 1, moved: false };
    // 書き換え・削除された行 → 書き換え後の範囲の終わり（次に一致する行の手前）に置く
    let r = k + 1;
    while (r < oldBody.length && map[r] < 0) r++;
    return { at: r < oldBody.length ? map[r] : newLines.length, moved: true };
  };

  const at = new Map();
  for (const run of runs) {
    const { at: a, moved } = anchorOf(run.after);
    if (!at.has(a)) at.set(a, { lines: [], moved: false });
    const slot = at.get(a);
    slot.lines.push(...run.lines);
    slot.moved ||= moved;
  }
  const out = [];
  for (let i = 0; i <= newLines.length; i++) {
    const slot = at.get(i);
    if (slot) {
      if (slot.moved && out.length && !isBlank(out[out.length - 1]) && !isBlank(slot.lines[0])) out.push("");
      out.push(...slot.lines);
      // 引用ブロックの直後に本文が続くと、本文が引用に吸い込まれるので空行を挟む
      if (slot.moved && i < newLines.length && !isBlank(newLines[i]) && !isBlank(slot.lines[slot.lines.length - 1])) out.push("");
    }
    if (i < newLines.length) out.push(newLines[i]);
  }
  return out.join(eol);
}

export function bodyOf(text) {
  const { body, eol } = segment(text);
  return body.join(eol);
}
