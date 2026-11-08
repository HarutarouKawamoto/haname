// HanaME（花見）クライアント
import { buildPrompt } from '/prompt.js';

// 壊れた %エンコードが混ざっていても画面ごと止まらないようにする
const safeDecode = (s, fn = decodeURI) => { try { return fn(s); } catch { return s; } };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let ICONS = {};
const icon = (name) => ICONS[name] ?? '';
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
};
const iconEl = (name, cls) => h('span', { class: cls, html: icon(name) });

const store = {
  get(k, d) { try { const v = localStorage.getItem('haname:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('haname:' + k, JSON.stringify(v)); } catch {} },
};

const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw Object.assign(new Error((await r.json()).error), { status: r.status });
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
    return data;
  },
};

// ---------- 状態 ----------
const S = {
  tree: null,       // /api/tree の結果
  order: [],        // ページ順のファイル一覧
  current: null,    // 開いているファイルのパス
  file: null,       // /api/file の結果
  selection: new Set(),
  anchor: null,     // shift 選択の起点
  collapsed: new Set(store.get('collapsed', [])),
  folded: new Set(),
  stripSel: new Set(), // 削除モードで選んだ Q&A の番号
  pendingReload: false,
};

// ---------- Markdown ----------
// コードブロックの色分け（言語名が書いてあり、highlight.js が知っている言語だけ。結果はエスケープ済みの HTML）
function highlight(code, lang) {
  const hljs = window.hljs;
  const name = (lang || '').trim().toLowerCase();
  if (!hljs || !name || !hljs.getLanguage(name)) return '';
  try { return hljs.highlight(code, { language: name, ignoreIllegals: true }).value; } catch { return ''; }
}
// 生の HTML は描画しない。ただし折りたたみ（<details> / <summary>）だけは使えるようにする。
// タグはそのまま通さず、こちらで組み立て直す（属性は details の open だけ）。それ以外は文字として表示し、
// HTML のコメントは GitHub と同じく表示しない。
const SAFE_TAG = /<(\/?)(details|summary)\b([^>]*)>|<!--[\s\S]*?(?:-->|$)/gi;
const escapeHtml = window.markdownit().utils.escapeHtml;
function safeHtml(src) {
  const esc = escapeHtml;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(SAFE_TAG)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    const [, close, name, attrs] = m;
    const tag = name.toLowerCase();
    const open = !close && tag === 'details' && /(^|\s)open(\s|=|$)/i.test(attrs) ? ' open' : '';
    out += `<${close}${tag}${open}>`;
  }
  return out + esc(src.slice(last));
}
// 「HTML のかたまり」として扱う行は、折りたたみのタグだけの行と HTML のコメントに限る。
// markdown-it の標準では <div> などで始まる行から次の空行までが丸ごと HTML になり、
// 中の Markdown が描画されなくなるため。折りたたみのタグの行は 1 行ずつ区切るので、
// <summary> の直後に空行がなくても、続く行は Markdown として描画される。
const FOLD_PART = String.raw`(?:<\/?(?:details|summary)\b[^>]*>|<summary\b[^>]*>[^<\n]*<\/summary>)`;
const FOLD_LINE = new RegExp(String.raw`^${FOLD_PART}(?:[ \t]*${FOLD_PART})*[ \t]*$`, 'i');
function foldTagLines(original) {
  return (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const lineAt = (n) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
    const first = lineAt(startLine);
    if (!first.startsWith('<')) return false;
    if (first.startsWith('<!--')) return original(state, startLine, endLine, silent);
    if (!FOLD_LINE.test(first)) return false;
    if (silent) return true;
    let next = startLine + 1;
    while (next < endLine && state.sCount[next] - state.blkIndent < 4 && FOLD_LINE.test(lineAt(next))) next++;
    const token = state.push('html_block', '', 0);
    token.map = [startLine, next];
    token.content = state.getLines(startLine, next, state.blkIndent, true);
    state.line = next;
    return true;
  };
}
function allowFolding(m) {
  const original = m.block.ruler.__rules__.find((r) => r.name === 'html_block').fn;
  m.block.ruler.at('html_block', foldTagLines(original), { alt: ['paragraph', 'reference', 'blockquote'] });
  m.renderer.rules.html_block = (tokens, i) => safeHtml(tokens[i].content);
  m.renderer.rules.html_inline = (tokens, i) => safeHtml(tokens[i].content);
  return m;
}
const md = allowFolding(window.markdownit({ html: true, linkify: true, highlight }));
md.core.ruler.push('mdv_srcline', (state) => {
  for (const t of state.tokens) {
    if (t.map && t.level === 0 && t.nesting !== -1) {
      t.attrSet('data-line', String(t.map[0]));
      t.attrSet('data-end', String(t.map[1]));
    }
  }
});
const mdPlain = allowFolding(window.markdownit({ html: true, linkify: true, highlight }));

// ---------- Mermaid ----------
// ```mermaid のコードブロックを図にする。Mermaid（約 3.5MB）は図があるページで初めて読み込む。
// securityLevel: 'strict' で、図の中の HTML・スクリプト・クリック動作を無効にする。
// 図とコードは右上のボタンで切り替えられる（コードの表示では、これまでどおり 1 行ずつ質問できる）。
let mermaidLoading = null;
function loadMermaid() {
  mermaidLoading ??= new Promise((resolve, reject) => {
    const s = h('script', { src: '/vendor/mermaid.js' });
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid')));
    s.onerror = () => { mermaidLoading = null; reject(new Error('mermaid')); };
    document.head.append(s);
  });
  return mermaidLoading;
}
const isDarkTheme = () =>
  (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';

function setMmdSource(box, on) {
  box.classList.toggle('show-src', on);
  const btn = box.querySelector('.mmd-toggle');
  btn.innerHTML = icon(on ? 'workflow' : 'code');
  btn.setAttribute('aria-label', on ? '図を表示' : 'コードを表示');
}

let mmdSeq = 0;
async function renderMermaid(root = $('#doc')) {
  // 図の枠を作る（コードブロックは枠の中に残し、図と切り替える）
  for (const code of $$('pre > code.language-mermaid', root)) {
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains('mmd')) continue;
    const box = h('div', { class: 'mmd' });
    const toggle = h('button', { class: 'icon-btn mmd-toggle' });
    toggle.onclick = () => setMmdSource(box, !box.classList.contains('show-src'));
    const zoom = h('button', { class: 'icon-btn zoom-btn', 'aria-label': '拡大して見る', html: icon('maximize-2') });
    zoom.onclick = () => openZoom(box.classList.contains('show-src') ? pre : box.querySelector('.mmd-view svg') ?? pre);
    pre.before(box);
    box.append(h('div', { class: 'mmd-tools' }, zoom, toggle), h('div', { class: 'mmd-view' }), pre);
    setMmdSource(box, false);
  }
  const boxes = $$('.mmd', root);
  if (!boxes.length) return;
  const fail = (box, msg) => {
    box.querySelector('.mmd-view').replaceChildren(h('div', { class: 'mmd-error' }, iconEl('triangle-alert'), h('span', {}, msg)));
    setMmdSource(box, true);
  };
  let mermaid;
  try { mermaid = await loadMermaid(); } catch { boxes.forEach((b) => fail(b, '図を表示できませんでした')); return; }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDarkTheme() ? 'dark' : 'neutral',
    fontFamily: getComputedStyle(document.body).fontFamily,
  });
  for (const box of boxes) {
    if (!box.isConnected) continue;
    const id = `mmd-${++mmdSeq}`;
    try {
      const { svg } = await mermaid.render(id, box.querySelector('pre code').textContent);
      if (!box.isConnected) continue;
      const view = box.querySelector('.mmd-view');
      view.innerHTML = svg;
      // 念のため、図の中のリンク先はすべて外す（strict でも click 指定の枠に <a> が残るため）
      for (const a of view.querySelectorAll('a')) {
        a.removeAttribute('href');
        a.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
      }
      // 図に付いた質問の印。図の上で見つからない質問（設定の行など）だけなら、コードの表示にする
      const asked = mmdQuestions(box);
      if (asked.length && !markMmdAsked(box, asked)) setMmdSource(box, true);
    } catch {
      document.getElementById('d' + id)?.remove(); // 失敗したときに Mermaid が残す一時的な要素
      if (box.isConnected) fail(box, '図の書き方に誤りがあります');
    }
  }
}

// ---------- 図への質問 ----------
// 図の部品（箱・矢印のラベル・登場人物など）をクリックすると、その文字を含むコードの行を対象に質問する。
// 何もないところをクリックしたときは、図全体（コードの 1 行目）が対象。質問はコードブロックの直後に入る。
const MMD_PART = 'g.node, g.edgeLabel, g.cluster, text';
const mmdLabel = (el) => el.textContent.replace(/\s+/g, ' ').trim();
function mmdPartAt(target, view) {
  let el = target.closest(MMD_PART);
  if (!el || !view.contains(el)) {
    // 四角などの図形をクリックしたとき: 同じグループの短い文字を部品とみなす（シーケンス図の登場人物など）
    const g = target.closest('g');
    el = g && view.contains(g) && !g.querySelector('g.node') && mmdLabel(g).length <= 60 ? g : null;
  }
  return el && mmdLabel(el) ? el : null;
}
const mmdLines = (box) => box.querySelector('pre code').textContent.split('\n').map((l) => l.trim()).filter(Boolean);
function mmdSourceLine(box, label) {
  const lines = mmdLines(box);
  if (!label) return lines[0] ?? '';
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 箱の定義（A[ラベル]、B{ラベル} など）は、その部分だけを対象にする
  const shape = new RegExp(String.raw`[\w-]+\s*[\[({>]+\s*"?${esc}"?\s*[\])}]+`);
  for (const l of lines) { const m = l.match(shape); if (m) return m[0]; }
  // 矢印のラベル（-- ラベル -->、-->|ラベル|）も、その部分だけ
  const edge = new RegExp(String.raw`(--|==|-\.)\s*${esc}\s*(-->|==>|\.->|---|--)|\|\s*${esc}\s*\|`);
  for (const l of lines) { const m = l.match(edge); if (m) return m[0]; }
  // 矢印のラベル（-- ラベル -->、|ラベル|）や登場人物（participant X as ラベル）は、その行
  const defines = new RegExp(String.raw`(--\s*|\|\s*|\bas\s+|^(participant|actor)\s+|:\s*)${esc}`);
  return lines.find((l) => defines.test(l)) ?? lines.find((l) => l.includes(label))
    ?? lines.find((l) => label.split(' ').every((w) => l.includes(w))) ?? label;
}
// この図に付いている質問の対象（図の直後に並ぶ質問）
function mmdQuestions(box) {
  const out = [];
  for (let el = box.nextElementSibling; el?.classList.contains('qa'); el = el.nextElementSibling) {
    const t = el.classList.contains('qa-q') && el.querySelector('.qa-target')?.textContent;
    if (t) out.push(t);
  }
  return out;
}
function markMmdAsked(box, targets) {
  const view = box.querySelector('.mmd-view');
  const first = mmdLines(box)[0];
  let found = false;
  if (targets.includes(first)) { view.classList.add('mmd-asked-all'); found = true; }
  const parts = [...view.querySelectorAll(MMD_PART)].map((el) => ({ el, label: mmdLabel(el) })).filter((p) => p.label);
  for (const t of targets) {
    if (t === first) continue;
    // 対象に含まれる部品のうち、もっと長い部品の一部になっているもの（「在庫はある?」の中の「ある」など）は除く
    const hits = parts.filter((p) => t.includes(p.label));
    for (const p of hits) {
      if (hits.some((o) => o.label.length > p.label.length && o.label.includes(p.label))) continue;
      p.el.classList.add('mmd-asked');
      found = true;
    }
  }
  return found;
}
let mmdHover = null;
function setMmdHover(el) {
  if (mmdHover === el) return;
  mmdHover?.classList.remove('mmd-hover');
  mmdHover = el;
  el?.classList.add('mmd-hover');
}
function askAboutDiagram(box, part) {
  const sentence = mmdSourceLine(box, part ? mmdLabel(part) : '');
  const answerCard = box.closest('.qa-a');
  if (answerCard) openComposer(answerCard, null, { sentence, draft: '', parentId: answerCard.dataset.id });
  else {
    const code = box.querySelector('pre code');
    openComposer(box, null, { sentence, draft: '', blockEnd: Number(code.dataset.end), headingLine: headingLineFor(Number(code.dataset.line)) });
  }
  // 質問中の部品を示す（質問欄を開くと印が消えるので、開いた後に付ける）
  (part ?? box.querySelector('.mmd-view')).classList.add('mmd-target');
}

// ---------- 拡大表示（表・図・画像） ----------
// 右上のボタンで、画面いっぱいに拡大して見る。ホイールで拡大・縮小、ドラッグで移動、Esc で閉じる。
function setupZoomables(root) {
  const add = (el, inline) => {
    if (el.parentElement?.classList.contains('zoom-wrap')) return;
    const btn = h('button', { class: 'icon-btn zoom-btn', 'aria-label': '拡大して見る', html: icon('maximize-2') });
    btn.onclick = () => openZoom(el);
    const wrap = h(inline ? 'span' : 'div', { class: 'zoom-wrap' + (inline ? ' inline' : '') });
    el.before(wrap);
    wrap.append(el, btn);
  };
  for (const t of $$('table', root)) add(t, false);
  for (const img of $$('img', root)) if (!img.closest('a, .zoom-wrap')) add(img, true);
}

const Z = { el: null, s: 1, x: 0, y: 0, fit: 1, drag: null };
function zoomApply() {
  Z.el.querySelector('.zoom-content').style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
}
function zoomTo(s, cx = innerWidth / 2, cy = innerHeight / 2) {
  const next = Math.min(12, Math.max(0.1, s));
  Z.x = cx - (cx - Z.x) * (next / Z.s);
  Z.y = cy - (cy - Z.y) * (next / Z.s);
  Z.s = next;
  zoomApply();
}
function zoomFit() {
  const c = Z.el.querySelector('.zoom-content');
  const w = c.offsetWidth;
  const hgt = c.offsetHeight;
  Z.s = Z.fit;
  Z.x = (innerWidth - w * Z.s) / 2;
  Z.y = (innerHeight - 64 - hgt * Z.s) / 2;
  zoomApply();
}
const isZoomOpen = () => !!Z.el && !Z.el.hidden;
function closeZoom() { if (Z.el) { Z.el.hidden = true; Z.el.querySelector('.zoom-content').replaceChildren(); } }
function openZoom(src) {
  if (!Z.el) {
    const content = h('div', { class: 'zoom-content doc' });
    const btn = (name, label, fn) => { const b = h('button', { class: 'icon-btn', 'aria-label': label, html: icon(name) }); b.onclick = fn; return b; };
    const bar = h('div', { class: 'zoom-bar' },
      btn('zoom-out', '縮小', () => zoomTo(Z.s / 1.25)),
      btn('scan', '画面に合わせる', zoomFit),
      btn('zoom-in', '拡大', () => zoomTo(Z.s * 1.25)),
      btn('x', '閉じる', closeZoom));
    Z.el = h('div', { class: 'zoom', hidden: true }, content, bar);
    document.body.append(Z.el);
    Z.el.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(Z.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY); }, { passive: false });
    Z.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.zoom-bar')) return;
      Z.drag = { x: e.clientX, y: e.clientY, ox: Z.x, oy: Z.y, moved: false };
      Z.el.setPointerCapture(e.pointerId);
    });
    Z.el.addEventListener('pointermove', (e) => {
      if (!Z.drag) return;
      const dx = e.clientX - Z.drag.x;
      const dy = e.clientY - Z.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) Z.drag.moved = true;
      Z.x = Z.drag.ox + dx;
      Z.y = Z.drag.oy + dy;
      zoomApply();
    });
    Z.el.addEventListener('pointerup', (e) => {
      const d = Z.drag;
      Z.drag = null;
      // 動かさずに背景をクリックしたら閉じる
      if (d && !d.moved && !e.target.closest('.zoom-content, .zoom-bar')) closeZoom();
    });
  }
  const c = Z.el.querySelector('.zoom-content');
  const clone = src.cloneNode(true);
  if (clone.tagName === 'svg') {
    // 図は元の大きさ（viewBox）で置き、拡大はまとめて行う
    const vb = src.viewBox?.baseVal;
    clone.removeAttribute('style');
    if (vb?.width) { clone.setAttribute('width', vb.width); clone.setAttribute('height', vb.height); }
  }
  c.replaceChildren(clone);
  Z.el.hidden = false;
  Z.s = 1; Z.x = 0; Z.y = 0;
  zoomApply();
  const w = c.offsetWidth;
  const hgt = c.offsetHeight;
  // 画面に収まる倍率。小さな表や画像は大きくしすぎない
  const max = clone.tagName === 'svg' ? 4 : 2;
  Z.fit = Math.min(max, (innerWidth - 80) / w, (innerHeight - 140) / hgt);
  zoomFit();
}

// その行より前で一番近い見出しの行（なければ -1）
function headingLineFor(blockLine) {
  const lines = $$('h1[data-line], h2[data-line], h3[data-line], h4[data-line], h5[data-line], h6[data-line]', $('#doc'))
    .map((x) => Number(x.dataset.line))
    .filter((l) => l <= blockLine);
  return lines.length ? Math.max(...lines) : -1;
}

// 閉じた折りたたみの中へ移動するときは、先に開く
function revealInFolds(el) {
  for (let d = el.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) d.open = true;
}

const posix = {
  dirname: (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''),
  join(...parts) {
    const out = [];
    for (const seg of parts.join('/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop(); else out.push(seg);
    }
    return out.join('/');
  },
};

// ---------- 起動 ----------
async function init() {
  ICONS = await api.get('/api/icons');
  for (const b of $$('[data-icon]')) b.insertAdjacentHTML('afterbegin', icon(b.dataset.icon));
  if (store.get('hideQA', false)) setHideQA(true);

  // ページ移動ボタンはツリーの上と画面下部の2か所にある
  $$('.js-prev').forEach((b) => { b.onclick = () => turn(-1); });
  $$('.js-next').forEach((b) => { b.onclick = () => turn(1); });
  $('#toggle-qa').onclick = () => setHideQA(!document.body.classList.contains('hide-qa'));
  setupTheme();
  setupSide();
  setupDesktop();
  $('#edit').onclick = enterEdit;
  $('#edit-save').onclick = saveEdit;
  $('#edit-cancel').onclick = cancelEdit;
  $('#strip').onclick = onStrip;
  $('#copy-prompt').onclick = () => copyPrompt(false);
  $('#copy-full').onclick = () => copyPrompt(true);
  document.addEventListener('keydown', onKey);
  setupDoc();

  await loadTree();
  const fromHash = safeDecode(location.hash.replace(/^#/, ''), decodeURIComponent);
  const first = S.order.includes(fromHash) ? fromHash : S.order[0];
  if (first) await openFile(first);
  else renderEmpty();

  window.addEventListener('hashchange', () => {
    const p = safeDecode(location.hash.replace(/^#/, ''), decodeURIComponent);
    if (p && p !== S.current && S.order.includes(p)) openFile(p);
  });

  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    // CLI（haname <ファイル>）から「このファイルを開いて」と頼まれた
    if (data.open) return openFile(data.open);
    onFsChange(data.paths);
  };
  // 変更の通知は取りこぼすことがある（監視の取りこぼし、スリープなどでの接続切れ、つながるまでの間の変更）。
  // そのため、つながったとき・ウィンドウに戻ったとき・一定の間隔でも、ファイルの状態を確かめ直す
  es.onopen = refresh;
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
}

// 昼（Sakura Hanami）と夜（夜桜）。未選択なら OS の設定に従う
function setupTheme() {
  const btn = $('#theme');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const current = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
  // 今が昼なら月、夜なら太陽（押すと切り替わる先）を表示する
  const paint = () => { btn.innerHTML = icon(current() === 'dark' ? 'sun' : 'moon'); };
  btn.onclick = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    paint();
    renderMermaid(); // 図の配色も切り替える
  };
  media.addEventListener('change', () => { paint(); renderMermaid(); });
  paint();
}

// ページ移動ボタンを含むファイル一覧（右パネル）の開閉。閉じても ← → でめくれる
// デスクトップ版（HanaME Desktop）の中で動いているときだけ、ロゴを「起動画面に戻る」ボタンにする
function setupDesktop() {
  const desk = window.hanameDesktop;
  if (!desk) return;
  const brand = $('.brand');
  brand.classList.add('is-button');
  brand.setAttribute('role', 'button');
  brand.setAttribute('tabindex', '0');
  brand.setAttribute('aria-label', '起動画面に戻る');
  brand.onclick = () => desk.showLauncher();
  brand.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); desk.showLauncher(); } };
}

function setupSide() {
  const btn = $('#toggle-side');
  const root = document.documentElement;
  const paint = () => {
    btn.innerHTML = icon(root.classList.contains('side-closed') ? 'panel-right-open' : 'panel-right-close');
  };
  btn.onclick = () => {
    const closed = root.classList.toggle('side-closed');
    store.set('sideClosed', closed);
    paint();
    if (!closed) $$('.row-item.active').forEach((r) => r.scrollIntoView({ block: 'nearest' }));
  };
  paint();
}

function setHideQA(on) {
  document.body.classList.toggle('hide-qa', on);
  $('#toggle-qa').innerHTML = icon(on ? 'eye-off' : 'eye');
  store.set('hideQA', on);
}

// ---------- ツリー ----------
// 読み込みは 1 つずつ順に行う（同時に走らせると、古い結果が後から届いて新しい結果を上書きすることがある）
let treeChain = Promise.resolve();
let treeJson = '';
function loadTree() {
  const run = treeChain.then(async () => {
    const tree = await api.get('/api/tree');
    const json = JSON.stringify(tree);
    const changed = json !== treeJson;
    treeJson = json;
    S.tree = tree;
    S.order = flatten(buildTree(S.tree)).map((n) => n.path);
    // 開いているファイルについては、表示中の内容のほうが新しければそちらを使う
    if (S.file) patchTree(S.current, S.file);
    if (changed) renderTree();
    updateNav();
  });
  treeChain = run.catch(() => {});
  return run;
}

// 一覧の中の 1 ファイルの情報を、読み込んだファイルの内容で更新する（新しいほうを残す）
function patchTree(p, file) {
  const f = S.tree?.files.find((x) => x.path === p);
  if (f && file.mtime >= f.mtime) { f.mtime = file.mtime; f.unanswered = file.unanswered; }
}

const cmp = (a, b) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });

function buildTree({ files, dirs }) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  const dirNode = (p) => {
    let node = root;
    let acc = '';
    for (const seg of p.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, path: acc, dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    return node;
  };
  for (const d of dirs) dirNode(d);
  for (const f of files) dirNode(posix.dirname(f.path)).files.push({ ...f, name: f.path.split('/').pop() });
  return root;
}

function flatten(node) {
  const out = [];
  for (const d of [...node.dirs.values()].sort((a, b) => cmp(a.name, b.name))) out.push(...flatten(d));
  out.push(...node.files.sort((a, b) => cmp(a.name, b.name)));
  return out;
}

function renderTree() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  const root = buildTree(S.tree);
  const rootRow = h('div', { class: 'row-item root-row', title: S.tree.root },
    iconEl('folder-open'), h('span', { class: 'name' }, S.tree.rootName));
  makeDropTarget(rootRow, '');
  tree.append(rootRow);

  const walk = (node, depth) => {
    for (const d of [...node.dirs.values()].sort((a, b) => cmp(a.name, b.name))) {
      const collapsed = S.collapsed.has(d.path);
      const row = h('div', { class: 'row-item' + (collapsed ? ' collapsed' : ''), style: `padding-left:${depth * 14 + 4}px` },
        iconEl('chevron-down', 'chev'), iconEl(collapsed ? 'folder' : 'folder-open'), h('span', { class: 'name' }, d.name));
      row.onclick = () => {
        if (S.collapsed.has(d.path)) S.collapsed.delete(d.path); else S.collapsed.add(d.path);
        store.set('collapsed', [...S.collapsed]);
        renderTree();
      };
      makeDropTarget(row, d.path);
      tree.append(row);
      if (!collapsed) walk(d, depth + 1);
    }
    for (const f of node.files.sort((a, b) => cmp(a.name, b.name))) {
      const cls = ['row-item'];
      if (f.path === S.current) cls.push('active');
      if (S.selection.has(f.path) && S.selection.size > 1) cls.push('selected');
      const dot = f.status === 'unread' ? h('span', { class: 'dot unread' }) : f.status === 'updated' ? h('span', { class: 'dot updated' }) : null;
      const row = h('div', { class: cls.join(' '), style: `padding-left:${depth * 14 + 22}px`, draggable: 'true', title: f.path },
        iconEl('file-text'), h('span', { class: 'name' }, f.name.replace(/\.md$/i, '')), dot);
      row.onclick = (e) => onFileClick(e, f.path);
      row.ondragstart = (e) => {
        if (!S.selection.has(f.path)) { S.selection = new Set([f.path]); }
        e.dataTransfer.setData('text/x-haname', JSON.stringify([...S.selection]));
        e.dataTransfer.effectAllowed = 'move';
      };
      tree.append(row);
    }
  };
  walk(root, 0);
  tree.scrollTop = scroll;
}

function onFileClick(e, p) {
  if (e.ctrlKey || e.metaKey) {
    if (S.selection.has(p)) S.selection.delete(p); else S.selection.add(p);
    if (!S.selection.size && S.current) S.selection.add(S.current);
    S.anchor = p;
    return renderTree();
  }
  if (e.shiftKey && S.anchor) {
    const a = S.order.indexOf(S.anchor);
    const b = S.order.indexOf(p);
    S.selection = new Set(S.order.slice(Math.min(a, b), Math.max(a, b) + 1));
    return renderTree();
  }
  S.anchor = p;
  S.selection = new Set([p]);
  openFile(p);
}

function makeDropTarget(row, dirPath) {
  row.ondragover = (e) => {
    if (!e.dataTransfer.types.includes('text/x-haname')) return;
    e.preventDefault();
    row.classList.add('drop');
  };
  row.ondragleave = () => row.classList.remove('drop');
  row.ondrop = async (e) => {
    e.preventDefault();
    row.classList.remove('drop');
    const paths = JSON.parse(e.dataTransfer.getData('text/x-haname') || '[]');
    if (paths.length) await moveFiles(paths, dirPath, row);
  };
}

async function moveFiles(paths, dest, anchorEl) {
  let check;
  try {
    check = await api.post('/api/move', { paths, dest, dryRun: true });
  } catch (e) {
    return toast('x', e.message.replace(/^exists: /, ''));
  }
  if (!check.count) return;
  const go = async () => {
    const { moved } = await api.post('/api/move', { paths, dest });
    if (moved[S.current]) { S.current = moved[S.current]; location.hash = encodeURIComponent(S.current); }
    S.selection = new Set(Object.values(moved));
    await loadTree();
    toast('folder-open', dest || S.tree.rootName);
  };
  if (!check.broken) return go();
  confirmPop(anchorEl, h('span', { class: 'warn' }, iconEl('link-2-off'), String(check.broken)), go);
}

// ---------- ファイル表示 ----------
let openSeq = 0;
async function openFile(p, { keepScroll = false } = {}) {
  if (p !== S.current && stripArmed()) disarmStrip();
  if (S.editing) {
    // 編集中は表示を差し替えない。未保存の変更があれば移動もしない
    if (p === S.current) return;
    if (isDirty()) return nudge('#edit-save');
    leaveEdit();
  }
  // 続けて開いたときは、最後に頼んだものだけを表示する（先に頼んだ結果が後から届いても使わない）
  const seq = ++openSeq;
  let file;
  try {
    file = await api.get('/api/file?path=' + encodeURIComponent(p));
  } catch (e) {
    if (seq !== openSeq) return;
    if (e.status === 404) {
      await loadTree();
      if (seq !== openSeq) return;
      if (S.order[0]) return openFile(S.order[0]);
      return renderEmpty();
    }
    throw e;
  }
  if (seq !== openSeq) return;
  const prevDir = S.current ? posix.dirname(S.current) : null;
  const scroller = $('#scroller');
  const scroll = scroller.scrollTop;
  const changedFile = S.current !== p;
  S.current = p;
  S.file = file;
  patchTree(p, file);
  if (changedFile) { S.folded = new Set(); S.selection = new Set([p]); }
  location.hash = encodeURIComponent(p);
  renderDoc();
  scroller.scrollTop = keepScroll ? scroll : 0;

  api.post('/api/seen', { path: p }).catch(() => {});
  const f = S.tree.files.find((x) => x.path === p);
  if (f) f.status = 'read';
  renderTree();
  updateNav();
  $$('.row-item.active').forEach((r) => r.scrollIntoView({ block: 'nearest' }));

  const dir = posix.dirname(p);
  if (prevDir !== null && changedFile && dir !== prevDir) toast('folder-open', dir || S.tree.rootName);
}

function renderEmpty() {
  S.current = null;
  S.file = null;
  $('#doc').innerHTML = '';
  $('#doc').append(h('div', { class: 'empty', html: icon('file-text') }));
  clearToc();
  updateNav();
}

function updateNav() {
  const i = S.order.indexOf(S.current);
  $$('.js-prev').forEach((b) => { b.disabled = i <= 0; });
  $$('.js-next').forEach((b) => { b.disabled = i < 0 || i >= S.order.length - 1; });
  $$('.js-page').forEach((p) => { p.textContent = i >= 0 ? `${i + 1} / ${S.order.length}` : ''; });
  $('#filename').textContent = S.current ?? '';
  // バッジはフォルダ全体の未回答の数。
  // 開いているファイルは、表示中の内容と一覧のうち新しいほうを使う
  // （質問を書きかけの間や編集モードの間は表示を読み直さないので、一覧のほうが新しいことがある）
  const n = (S.tree?.files ?? []).reduce((sum, f) => {
    const own = f.path === S.current && S.file && S.file.mtime >= f.mtime;
    return sum + (own ? S.file.unanswered.length : (f.unanswered?.length ?? 0));
  }, 0);
  const badge = $('#badge');
  badge.hidden = !n;
  badge.textContent = n;
  $('#copy-prompt').disabled = !n;
  $('#copy-full').disabled = !n;
  $('#strip').disabled = !S.file?.blocks.length;
}

function turn(delta) {
  const i = S.order.indexOf(S.current);
  const next = S.order[i + delta];
  if (next) openFile(next);
}

function onKey(e) {
  // 拡大表示の間は、ページ送りなどを止めて拡大表示の操作だけにする
  if (isZoomOpen()) {
    if (e.key === 'Escape') closeZoom();
    else if (e.key === '+' || e.key === '=') zoomTo(Z.s * 1.25);
    else if (e.key === '-') zoomTo(Z.s / 1.25);
    else if (e.key === '0') zoomFit();
    else return;
    return e.preventDefault();
  }
  if (e.key === 'Escape' && stripArmed()) return disarmStrip();
  if (S.editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); return saveEdit(); }
  // 入力欄の中では、ブラウザ標準の元に戻す（文字単位）を使う
  if (e.target.closest?.('textarea, input')) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !S.editing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); return undoRedo('undo'); }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); return undoRedo('redo'); }
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
}

// Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y）: 開いているファイルへの HanaME の書き込み（質問・削除・編集の保存）を戻す / やり直す
let historyBusy = false;
async function undoRedo(dir) {
  if (!S.current || historyBusy) return;
  historyBusy = true;
  try {
    if (stripArmed()) disarmStrip();
    removeComposer();
    await api.post(`/api/${dir}`, { path: S.current });
    await openFile(S.current, { keepScroll: true });
    toast(dir === 'undo' ? 'undo-2' : 'redo-2', '');
  } catch (e) {
    // 戻せるものがない、または AI などが後から書き換えたので戻さない
    toast('x', '');
  } finally {
    historyBusy = false;
  }
}

function renderDoc() {
  const doc = $('#doc');
  const { text, blocks } = S.file;
  hl('mdv-target', []);
  doc.innerHTML = md.render(text);

  // Q&A ブロックをカードに差し替える
  const ids = new Set(blocks.map((b) => b.id));
  for (const b of blocks) {
    const el = doc.querySelector(`blockquote[data-line="${b.start}"]`);
    if (!el) continue;
    const depth = b.id.split('-').length - 1;
    const isQ = b.kind === 'question';
    const card = h('div', {
      class: `qa ${isQ ? 'qa-q' : 'qa-a'}${!isQ && !b.body ? ' empty-a' : ''}`,
      'data-id': b.id, 'data-kind': b.kind, 'data-depth': String(depth),
      'data-thread': b.id.split('-')[0], 'data-line': String(b.start), 'data-end': String(b.end),
    });
    const jump = h('button', { class: 'qa-jump', 'aria-label': isQ ? '回答へ移動' : '質問へ移動' },
      iconEl(isQ ? 'message-circle-question-mark' : 'lightbulb'), h('span', {}, b.id));
    jump.onclick = () => { if (!stripArmed()) jumpTo(b.id, isQ ? 'answer' : 'question'); };
    const head = h('div', { class: 'qa-head' }, jump);
    if (!isQ && depth === 0 && [...ids].some((id) => id.startsWith(b.id + '-'))) {
      const fold = h('button', { class: 'icon-btn qa-fold' + (S.folded.has(b.id) ? ' folded' : ''), 'aria-label': 'スレッドを折りたたむ', html: icon('chevron-down') });
      fold.onclick = () => { if (stripArmed()) return; if (S.folded.has(b.id)) S.folded.delete(b.id); else S.folded.add(b.id); applyFold(); };
      head.append(fold);
    }
    card.append(head);
    if (isQ && b.target) card.append(h('div', { class: 'qa-target' }, b.target));
    card.append(h('div', { class: 'qa-body', html: b.body ? mdPlain.render(b.body) : '' }));
    el.replaceWith(card);
  }
  // 相対リンク・画像（Q&A のカードの中も対象にするため、カードを作った後に処理する）
  const base = posix.dirname(S.current);
  for (const a of $$('a[href]', doc)) {
    const href = a.getAttribute('href');
    if (/^[a-z]+:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; continue; }
    if (href.startsWith('#')) continue;
    const target = posix.join(base, safeDecode(href.split('#')[0]));
    if (/\.md$/i.test(target)) a.onclick = (e) => { e.preventDefault(); openFile(target); };
  }
  for (const img of $$('img[src]', doc)) {
    const src = img.getAttribute('src');
    if (!/^[a-z]+:/i.test(src)) img.src = '/api/raw?path=' + encodeURIComponent(posix.join(base, safeDecode(src)));
  }

  setupZoomables(doc);
  applyFold();
  markAsked();
  paintStrip();
  buildToc();
  renderMermaid(doc);
}

// ---------- 目次 ----------
// 本文の見出し（Q&A の中の見出しは除く）を並べ、クリックでその見出しへ移動する。
// 読んでいる位置の見出しを目次側でも強調する。
let tocEntries = [];
function buildToc() {
  const list = $('#toc-list');
  list.innerHTML = '';
  tocEntries = [];
  const heads = $$('h1, h2, h3, h4, h5, h6', $('#doc')).filter((el) => !el.closest('.qa'));
  if (!heads.length) {
    list.append(h('div', { class: 'toc-empty', html: icon('table-of-contents') }));
    return;
  }
  const top = Math.min(...heads.map((el) => Number(el.tagName[1])));
  for (const el of heads) {
    const lv = Number(el.tagName[1]) - top + 1;
    const item = h('button', { class: `toc-item lv${lv}`, style: `padding-left:${(lv - 1) * 14 + 8}px`, title: el.textContent }, el.textContent);
    item.onclick = () => { revealInFolds(el); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    list.append(item);
    tocEntries.push({ el, item });
  }
  updateTocActive();
}

function clearToc() {
  $('#toc-list').innerHTML = '';
  tocEntries = [];
}

function updateTocActive() {
  if (!tocEntries.length) return;
  const limit = $('#scroller').getBoundingClientRect().top + 80;
  let active = tocEntries[0];
  for (const e of tocEntries) {
    if (!e.el.getClientRects().length) continue; // 閉じた折りたたみの中の見出し
    if (e.el.getBoundingClientRect().top <= limit) active = e;
    else break;
  }
  for (const e of tocEntries) {
    const on = e === active;
    if (on !== e.item.classList.contains('active')) {
      e.item.classList.toggle('active', on);
      if (on) e.item.scrollIntoView({ block: 'nearest' });
    }
  }
}

function applyFold() {
  for (const c of $$('.qa', $('#doc'))) {
    const top = c.dataset.thread;
    c.classList.toggle('hidden-thread', c.dataset.id !== top && S.folded.has(top));
  }
  for (const f of $$('.qa-fold')) f.classList.toggle('folded', S.folded.has(f.closest('.qa').dataset.id));
}

function jumpTo(id, kind) {
  const el = $(`.qa[data-id="${id}"][data-kind="${kind}"]`);
  if (!el) return;
  if (el.classList.contains('hidden-thread')) { S.folded.delete(el.dataset.thread); applyFold(); }
  revealInFolds(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------- 文の検出 ----------
const CONTAINER = 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre, dt, dd';

function containerOf(node) {
  const el = node?.nodeType === 3 ? node.parentElement : node;
  const c = el?.closest?.(CONTAINER);
  if (!c || !$('#doc').contains(c) || c.closest('.composer, .qa-q, .qa-head, .qa-target, .mmd-view')) return null;
  return c;
}

function textNodes(container) {
  const out = [];
  const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.parentElement.closest(CONTAINER) === container) out.push(n);
  }
  return out;
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r && { node: r.startContainer, offset: r.startOffset };
}

const END_CHARS = '。！？!?';
const CLOSERS = '」』）)】"\'”’';

function sentenceRange(container, node, offset) {
  const nodes = textNodes(container);
  let full = '';
  let pos = -1;
  for (const n of nodes) {
    if (n === node) pos = full.length + offset;
    full += n.data;
  }
  if (pos < 0 || !full.trim()) return null;
  const code = container.tagName === 'PRE';
  const isEnd = (i) => {
    const c = full[i];
    if (c === '\n') return true;
    if (code) return false;
    if (END_CHARS.includes(c)) return true;
    return c === '.' && (i + 1 >= full.length || /\s/.test(full[i + 1]));
  };
  let s = pos;
  while (s > 0 && !isEnd(s - 1)) s--;
  // クリック位置が文末記号の直後なら、その文を対象にする
  if (s === pos && pos > 0 && isEnd(pos - 1) && (pos >= full.length || full[pos] === '\n')) {
    s = pos - 1;
    while (s > 0 && !isEnd(s - 1)) s--;
  }
  let e = s;
  while (e < full.length && !isEnd(e)) e++;
  if (e < full.length && full[e] !== '\n') e++;
  while (e < full.length && CLOSERS.includes(full[e])) e++;
  while (s < e && /\s/.test(full[s])) s++;
  while (e > s && /\s/.test(full[e - 1])) e--;
  if (s >= e) return null;
  return { text: full.slice(s, e), range: rangeFromOffsets(nodes, s, e) };
}

function rangeFromOffsets(nodes, s, e) {
  const r = document.createRange();
  let acc = 0;
  let started = false;
  for (const n of nodes) {
    const len = n.data.length;
    if (!started && s <= acc + len) { r.setStart(n, s - acc); started = true; }
    if (started && e <= acc + len) { r.setEnd(n, e - acc); return r; }
    acc += len;
  }
  return r;
}

function findInContainer(container, needle) {
  const nodes = textNodes(container);
  const full = nodes.map((n) => n.data).join('');
  const i = full.indexOf(needle);
  return i < 0 ? null : rangeFromOffsets(nodes, i, i + needle.length);
}

const hl = (name, ranges) => {
  if (!window.CSS?.highlights) return;
  if (!ranges.length) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...ranges));
};

function markAsked() {
  const ranges = [];
  for (const q of $$('.qa-q', $('#doc'))) {
    const target = q.querySelector('.qa-target')?.textContent;
    if (!target) continue;
    let scope = [];
    if (q.dataset.depth !== '0') {
      // 回答への追加の質問 → 直前の回答カードの中
      let p = q.previousElementSibling;
      while (p && !(p.classList.contains('qa-a') && q.dataset.id.startsWith(p.dataset.id + '-'))) p = p.previousElementSibling;
      if (p) scope = [p];
    } else {
      let p = q.previousElementSibling;
      while (p && p.classList.contains('qa')) p = p.previousElementSibling;
      if (p) scope = [p];
    }
    for (const el of scope) {
      const containers = el.matches(CONTAINER) ? [el] : $$(CONTAINER, el);
      for (const c of containers) {
        const r = findInContainer(c, target);
        if (r) { ranges.push(r); break; }
      }
    }
  }
  hl('mdv-asked', ranges);
}

// ---------- 質問の入力 ----------
// マウス位置の文を返す。文字の上にないとき（行末の右側や余白）は null
function sentenceAtPoint(x, y) {
  const c = caretAt(x, y);
  const container = c && containerOf(c.node);
  const s = container && sentenceRange(container, c.node, c.offset);
  if (!s) return null;
  const hit = [...s.range.getClientRects()].some(
    (r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2,
  );
  return hit ? { ...s, container } : null;
}

function setupDoc() {
  const doc = $('#doc');
  let raf = 0;
  doc.addEventListener('mousemove', (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (stripArmed() || !window.getSelection().isCollapsed) return hl('mdv-hover', []);
      const s = sentenceAtPoint(e.clientX, e.clientY);
      hl('mdv-hover', s ? [s.range] : []);
    });
  });
  doc.addEventListener('mouseleave', () => { hl('mdv-hover', []); setMmdHover(null); });
  // 図の上では、指している部品を光らせる
  doc.addEventListener('mouseover', (e) => {
    const view = e.target.closest?.('.mmd-view');
    setMmdHover(view && !stripArmed() && !view.querySelector('.mmd-error') ? mmdPartAt(e.target, view) : null);
  });
  let tocRaf = 0;
  $('#scroller').addEventListener('scroll', () => {
    if (tocRaf) return;
    tocRaf = requestAnimationFrame(() => { tocRaf = 0; updateTocActive(); });
  }, { passive: true });
  // 本文の左右の余白も「何もないところ」に含めるため、スクロール領域全体で受ける
  $('#scroller').addEventListener('click', onDocClick);
}

// 何もないところをクリック → 文の選択を外す（書きかけの質問は消さない）
function deselect() {
  const box = $('.composer');
  if (!box) return;
  const ta = box.querySelector('textarea');
  if (ta.value.trim() && ta.value !== box.dataset.draft) return;
  closeComposer();
}

function onDocClick(e) {
  // 削除モード中: Q&A の枠を選ぶだけ。質問欄やジャンプは動かさない
  if (stripArmed()) {
    const card = e.target.closest('.qa');
    if (card) { e.preventDefault(); toggleStripPick(card); }
    return;
  }
  if (e.target.closest('button, .composer, textarea')) return;
  // 図の上: 部品（または図全体）への質問
  const view = e.target.closest('.mmd-view');
  if (view) {
    if (!view.querySelector('.mmd-error') && window.getSelection().isCollapsed) askAboutDiagram(view.closest('.mmd'), mmdPartAt(e.target, view));
    return;
  }
  if (e.target.closest('a')) return;
  const sel = window.getSelection();
  let container;
  let sentence;
  let range;
  let draft = '';
  if (!sel.isCollapsed && sel.rangeCount) {
    const term = sel.toString().trim();
    let { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
    if (node.nodeType !== 3) {
      const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      node = w.nextNode() ?? node;
      offset = 0;
    }
    container = containerOf(node);
    if (!container || !term) return deselect();
    const s = sentenceRange(container, node, offset);
    sentence = s?.text ?? term;
    range = s?.range ?? sel.getRangeAt(0).cloneRange();
    draft = `「${term}」とは？`;
  } else {
    const s = sentenceAtPoint(e.clientX, e.clientY);
    if (!s) return deselect();
    container = s.container;
    sentence = s.text;
    range = s.range;
  }

  const answerCard = container.closest('.qa-a');
  if (answerCard) {
    if (!answerCard.querySelector('.qa-body').textContent.trim()) return deselect();
    openComposer(answerCard, range, { sentence, draft, parentId: answerCard.dataset.id });
    return;
  }
  // コードブロックは <pre><code data-line> の形で、行番号の印が内側の <code> に付く
  const top = container.closest('[data-line]') ?? container.querySelector(':scope > [data-line]');
  if (!top || top.closest('.qa')) return deselect();
  const blockLine = Number(top.dataset.line);
  // 図のコードの行なら、質問欄は図の枠の後ろに出す
  const after = top.closest('.mmd') ?? top.closest('pre') ?? top;
  openComposer(after, range, { sentence, draft, blockEnd: Number(top.dataset.end), headingLine: headingLineFor(blockLine) });
}

// 質問欄を閉じる（対象の文のハイライトも消す）
function removeComposer() {
  $('.composer')?.remove();
  hl('mdv-target', []);
  $$('.mmd-target').forEach((el) => el.classList.remove('mmd-target'));
}

function closeComposer() {
  removeComposer();
  if (S.pendingReload) { S.pendingReload = false; openFile(S.current, { keepScroll: true }); }
}

function openComposer(afterEl, range, ctx) {
  removeComposer();
  const ta = h('textarea', { rows: '2', 'aria-label': '質問' });
  ta.value = ctx.draft;
  const send = h('button', { class: 'icon-btn', 'aria-label': '質問を書き込む', html: icon('send') });
  const cancel = h('button', { class: 'icon-btn', 'aria-label': 'やめる', html: icon('x') });
  const box = h('div', { class: 'composer', 'data-draft': ctx.draft }, ta, h('div', { class: 'row' }, cancel, send));
  // 欄のどこをクリックしても入力できるようにする
  box.addEventListener('mousedown', (e) => {
    if (e.target === ta || e.target.closest('button')) return;
    e.preventDefault();
    ta.focus();
  });
  afterEl.after(box);
  // 対象の文は欄の中に書かず、本文のハイライトを残して示す
  hl('mdv-target', range ? [range] : []);
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeComposer();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  cancel.onclick = closeComposer;
  send.onclick = submit;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  fit();
  window.getSelection().removeAllRanges();

  async function submit() {
    const question = ta.value.trim();
    if (!question) return ta.focus();
    send.disabled = true;
    try {
      const { id } = await api.post('/api/question', { path: S.current, mtime: S.file.mtime, question, ...ctx });
      removeComposer();
      S.pendingReload = false;
      await openFile(S.current, { keepScroll: true });
      const q = $(`.qa[data-id="${id}"][data-kind="question"]`);
      if (q) { q.classList.add('flash'); q.scrollIntoView({ block: 'nearest' }); }
    } catch (e) {
      send.disabled = false;
      if (e.status === 409) {
        // AI が書き換え中などで行番号がずれた → 最新を読み直してから再入力
        const keep = ta.value;
        removeComposer();
        await openFile(S.current, { keepScroll: true });
        navigator.clipboard?.writeText(keep).catch(() => {});
        toast('clipboard-copy', '');
      } else toast('x', e.message);
    }
  }
}

// ---------- 編集モード ----------
// 本文だけを編集する。Q&A は表示しない。保存時にサーバーが Q&A を元の位置関係で戻す。
const norm = (s) => s.replace(/\r\n/g, '\n');
const editorEl = () => $('#doc .editor');
const isDirty = () => !!S.editing && editorEl()?.value !== S.editing.base;

function nudge(sel) {
  const el = $(sel);
  el.classList.remove('nudge');
  void el.offsetWidth;
  el.classList.add('nudge');
}

function enterEdit() {
  if (!S.file || S.editing) return;
  removeComposer();
  hl('mdv-hover', []);
  hl('mdv-asked', []);
  S.editing = { base: norm(S.file.body) };
  const ta = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': '本文' });
  ta.value = S.editing.base;
  const doc = $('#doc');
  const ratio = $('#scroller').scrollTop / Math.max(1, $('#scroller').scrollHeight);
  doc.innerHTML = '';
  doc.append(ta);
  clearToc();
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', () => { fit(); $('#edit-save').classList.toggle('dirty', isDirty()); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    if (e.key === 'Escape' && !isDirty()) cancelEdit();
  });
  document.body.classList.add('editing');
  fit();
  $('#scroller').scrollTop = ratio * $('#scroller').scrollHeight;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(0, 0);
  updateNav();
}

function leaveEdit() {
  S.editing = null;
  document.body.classList.remove('editing');
  $('#edit-save').classList.remove('dirty');
  disarm('#edit-cancel', 'x');
}

async function saveEdit() {
  if (!S.editing) return;
  if (!isDirty()) { leaveEdit(); return openFile(S.current, { keepScroll: true }); }
  const btn = $('#edit-save');
  btn.disabled = true;
  try {
    await api.post('/api/edit', { path: S.current, baseBody: S.editing.base, body: editorEl().value });
    leaveEdit();
    await openFile(S.current, { keepScroll: true });
    toast('save', '');
  } catch (e) {
    // 編集中に本文そのものが書き換えられた → 上書きせず、編集内容は残す
    toast('x', e.status === 409 ? '' : e.message);
    nudge('#edit-save');
  } finally {
    btn.disabled = false;
  }
}

let cancelTimer;
function disarm(sel, iconName) {
  const b = $(sel);
  b.classList.remove('armed');
  b.innerHTML = icon(iconName);
}
function cancelEdit() {
  if (!S.editing) return;
  const btn = $('#edit-cancel');
  if (isDirty() && !btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.innerHTML = icon('check');
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => disarm('#edit-cancel', 'x'), 3000);
    return;
  }
  clearTimeout(cancelTimer);
  leaveEdit();
  openFile(S.current, { keepScroll: true });
}

// ---------- 片付け ----------
// 1回目で削除モード。そのまま2回目 → すべて削除。
// 削除モード中に Q&A の枠をクリックして選ぶと、2回目でその組（質問と回答）とスレッドだけ削除。
let stripTimer;
const stripArmed = () => document.body.classList.contains('strip-mode');
const inThread = (id, roots) => roots.some((r) => id === r || id.startsWith(r + '-'));

function paintStrip() {
  const btn = $('#strip');
  const armed = stripArmed();
  btn.classList.toggle('armed', armed);
  btn.innerHTML = icon(armed ? 'check' : 'eraser');
  if (armed && S.stripSel.size) btn.append(h('span', { class: 'badge' }, String(S.stripSel.size)));
  const roots = [...S.stripSel];
  for (const c of $$('.qa', $('#doc'))) c.classList.toggle('strip-picked', inThread(c.dataset.id, roots));
}

function armTimeout() {
  clearTimeout(stripTimer);
  // 何も選んでいないまま放っておくと解除する。選び始めたら解除しない
  if (!S.stripSel.size) stripTimer = setTimeout(disarmStrip, 5000);
}

function disarmStrip() {
  clearTimeout(stripTimer);
  document.body.classList.remove('strip-mode');
  S.stripSel = new Set();
  paintStrip();
}

function toggleStripPick(card) {
  const id = card.dataset.id;
  // 親のスレッドごと選ばれている場合は、親の選択を外す
  const parent = [...S.stripSel].find((r) => id !== r && id.startsWith(r + '-'));
  if (S.stripSel.has(id)) S.stripSel.delete(id);
  else if (parent) S.stripSel.delete(parent);
  else {
    for (const r of [...S.stripSel]) if (r.startsWith(id + '-')) S.stripSel.delete(r);
    S.stripSel.add(id);
  }
  paintStrip();
  armTimeout();
}

async function onStrip() {
  if (!stripArmed()) {
    removeComposer();
    S.stripSel = new Set();
    document.body.classList.add('strip-mode');
    paintStrip();
    armTimeout();
    return;
  }
  const ids = [...S.stripSel];
  disarmStrip();
  await api.post('/api/strip', { path: S.current, mtime: S.file.mtime, ...(ids.length ? { ids } : {}) });
  await openFile(S.current, { keepScroll: true });
}

// ---------- AI への受け渡し ----------
// 指示文の組み立ては lib/prompt.js（CLI の haname prompt と共通）
async function promptText(full) {
  const { files } = await api.get('/api/pending' + (full ? '?full=1' : ''));
  if (!files.length) throw new Error('nothing');
  return buildPrompt(files, full);
}

async function copyPrompt(full) {
  const btn = $(full ? '#copy-full' : '#copy-prompt');
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      // 読み込みを待つ間もクリック操作の扱いを保つため、内容は Promise で渡す
      const blob = promptText(full).then((t) => new Blob([t], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await navigator.clipboard.writeText(await promptText(full));
    }
  } catch {
    refresh();
    return toast('x', '');
  }
  // コピーした内容（その時点のファイル）とバッジをそろえる
  refresh();
  const prev = btn.querySelector('svg').outerHTML;
  btn.querySelector('svg').outerHTML = icon('check');
  btn.classList.add('done');
  setTimeout(() => { btn.querySelector('svg').outerHTML = prev; btn.classList.remove('done'); }, 1200);
}

// ---------- ファイルの変更 ----------
// 通知は少し待ってまとめる。待つ間に届いた通知のファイルも、すべて対象に残す
let fsTimer;
let fsPaths = new Set();
function onFsChange(paths) {
  for (const p of paths) fsPaths.add(p);
  clearTimeout(fsTimer);
  fsTimer = setTimeout(syncFs, 120);
}

// 通知がなくても、ファイルの状態を確かめ直す（変わっていなければ何もしない）
const refresh = () => onFsChange([]);

async function syncFs() {
  const paths = fsPaths;
  fsPaths = new Set();
  try { await loadTree(); } catch { return; }
  if (!S.current) { if (S.order[0]) openFile(S.order[0]); return; }
  // 通知に含まれていなくても、開いているファイルの更新時刻が変わっていれば（消えていれば）読み直す
  const f = S.tree.files.find((x) => x.path === S.current);
  if (!paths.has(S.current) && f && S.file && f.mtime === S.file.mtime) return;
  if (S.editing) return; // 編集中は表示を差し替えない（バッジは一覧の新しい数で出る）
  const ta = $('.composer textarea');
  if (ta && ta.value.trim()) { S.pendingReload = true; return; }
  removeComposer();
  openFile(S.current, { keepScroll: true });
}

// ---------- トースト・確認 ----------
let toastTimer;
function toast(iconName, text) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(iconEl(iconName));
  if (text) t.append(h('span', {}, text));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

function confirmPop(anchorEl, content, onOk) {
  const pop = $('#pop');
  pop.innerHTML = '';
  const ok = h('button', { class: 'icon-btn', 'aria-label': '移動する', html: icon('check') });
  const no = h('button', { class: 'icon-btn', 'aria-label': 'やめる', html: icon('x') });
  const close = () => { pop.hidden = true; document.removeEventListener('mousedown', outside); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  ok.onclick = async () => { close(); await onOk(); };
  no.onclick = close;
  pop.append(content, no, ok);
  pop.hidden = false;
  const r = anchorEl.getBoundingClientRect();
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  setTimeout(() => document.addEventListener('mousedown', outside));
}

init();
