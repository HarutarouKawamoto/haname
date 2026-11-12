// 紹介サイト（site/）のスクリーンショットとループ動画を撮る。
//
//   cd site/tools && npm install && node capture.mjs
//   SCENES=stills node capture.mjs   … 静止画だけ
//   SCENES=loops  node capture.mjs   … ループ動画だけ
//
// site/demo/komorebi-reserve（架空の喫茶店の席予約 API の .md）を一時フォルダにコピーして HanaME を起動し、
// Playwright（Microsoft Edge）で操作しながら撮る。AI の回答は、AI が書き込むのと同じ形でこのスクリプトが書き込む。
// 出力: site/images/*.webp（静止画）と site/images/*.mp4（無音のループ）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createServer } from '../../lib/server.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..');
const OUT = path.join(SITE, 'images');
const W = 1280;
const H = 800;
const MAIN = 'reviews/2026-11-08_reservation-api-review.md';
const FLOW = 'plans/02_reservation-flow.md';
const SCENES = process.env.SCENES ?? 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haname-site-'));

// ---------- 回答（AI が書き込む内容） ----------
const ANSWERS = {
  Q1: [
    'アプリのロックは、そのサーバーの中でしか効きません。サーバーが 2 台になると、別々のサーバーに来た予約どうしは止められません。',
    'データベースの制約なら、どの経路から来た保存でも、最後に必ずデータベースで止まります。',
  ],
  Q2: [
    '「この条件で重なる行を 2 つ置かない」と、データベースに約束させる制約です。',
    'ここでは「同じ席」かつ「時間帯が重なる」行を禁止します。違反する保存はエラー（23P01）になり、行は入りません。',
  ],
  Q3: [
    '2 つの区間が重ならないのは、「a が b より前に終わる」か「b が a より前に終わる」ときだけです。',
    'その否定が `a.from < b.to && b.from < a.to` なので、この 2 つの比較で、重なる場合をすべて拾えます。',
  ],
  Q4: [
    '空きの確認と保存のあいだに、別のお客さんの予約が入ることがあるからです。',
    '空きの確認は「早めに断る」ための目安で、重なりを最後に止めるのは保存のときの排他制約です。',
  ],
};

// ---------- 演出用のスクリプト（文字の位置を調べる・カーソルを描く） ----------
const INIT = () => {
  const CURSOR = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2 L4 20 L9 15.5 L12.5 22.5 L15.5 21 L12 14 L19 14 Z" fill="#fff" stroke="#2a2730" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.addEventListener('DOMContentLoaded', () => {
    const cursor = Object.assign(document.createElement('div'), { id: 'cap-cursor', innerHTML: CURSOR });
    cursor.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));display:none';
    document.body.append(cursor);
    addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`; }, true);
  });
  const textNodes = (root) => {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
    return out;
  };
  window.__cap = {
    cursor(on) { document.getElementById('cap-cursor').style.display = on ? 'block' : 'none'; },
    rect(needle, rootSel = '#doc') {
      const root = document.querySelector(rootSel);
      const nodes = textNodes(root);
      const full = nodes.map((n) => n.data).join('');
      const i = full.indexOf(needle);
      if (i < 0) return null;
      const r = document.createRange();
      let acc = 0;
      let started = false;
      for (const n of nodes) {
        const len = n.data.length;
        if (!started && i < acc + len) { r.setStart(n, i - acc); started = true; }
        if (started && i + needle.length <= acc + len) { r.setEnd(n, i + needle.length - acc); break; }
        acc += len;
      }
      const rs = [...r.getClientRects()].filter((b) => b.width > 0);
      const b = rs[0];
      const e = rs.at(-1);
      return b && { x: b.left, y: b.top, w: b.width, h: b.height, ex: e.right, ey: e.top + e.height / 2 };
    },
    // 見出しや段落を、画面の上端から offset px の位置に置く
    scrollTo(needle, offset = 70) {
      const root = document.querySelector('#doc');
      const target = [...root.querySelectorAll('p, li, pre, h1, h2, h3, .qa, .mmd')].find((e) => e.textContent.includes(needle));
      if (!target) return false;
      const sc = document.querySelector('#scroller');
      sc.scrollTop += target.getBoundingClientRect().top - offset;
      return true;
    },
  };
};

// ---------- HanaME を起動するページを用意する ----------
async function open({ scheme = 'light', video = null, work = null } = {}) {
  if (!work) {
    work = path.join(fs.mkdtempSync(path.join(tmp, 'w-')), 'komorebi-reserve');
    fs.cpSync(path.join(SITE, 'demo', 'komorebi-reserve'), work, { recursive: true });
  }
  const app = createServer(work);
  const port = await app.listen(0);
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: video ? 1 : 2,
    colorScheme: scheme,
    locale: 'ja-JP',
    ...(video ? { recordVideo: { dir: video, size: { width: W, height: H } } } : {}),
  });
  await context.addInitScript(([theme]) => {
    try {
      localStorage.setItem('haname:theme', JSON.stringify(theme));
      localStorage.setItem('haname:sideClosed', 'false');
    } catch {}
  }, [scheme]);
  await context.addInitScript(INIT);
  const page = await context.newPage();

  const rect = async (needle, root) => {
    const r = await page.evaluate(([n, s]) => window.__cap.rect(n, s), [needle, root]);
    if (!r) throw new Error(`not found: ${needle}`);
    return r;
  };
  const p = {
    page, work, base, context,
    async go(file, h1) {
      await page.goto(base + '#' + encodeURIComponent(file));
      await page.waitForFunction((s) => document.querySelector('#doc h1')?.textContent.includes(s), h1);
      await sleep(700);
    },
    rect,
    move: (x, y, steps = 18) => page.mouse.move(x, y, { steps }),
    async hover(needle, ratio = 0.4, steps) { const r = await rect(needle); await p.move(r.x + r.w * ratio, r.y + r.h / 2, steps); return r; },
    async clickText(needle, ratio = 0.4) { await p.hover(needle, ratio); await sleep(200); await page.mouse.down(); await page.mouse.up(); await sleep(400); },
    async scrollTo(needle, offset) { await page.evaluate(([n, o]) => window.__cap.scrollTo(n, o), [needle, offset]); await sleep(500); },
    type: (text, delay = 60) => page.keyboard.type(text, { delay }),
    async submit() { await page.keyboard.press('Control+Enter'); await sleep(900); },
    cursor: (on) => page.evaluate((v) => window.__cap.cursor(v), on),
    // 本文の列（左端のツリーを除く）を、要素 sel の above px 上から below px 下まで切り抜く
    async clipAround(sel, above, below = 28) {
      const b = await page.locator(sel).first().boundingBox();
      const y = Math.max(48, b.y - above);
      return { x: 0, y, width: 990, height: Math.min(H - 64, b.y + b.height + below) - y };
    },
    // AI の回答を書き込む（回答欄の空の引用に本文を入れる）
    answer(file, id, lines) {
      const f = path.join(work, file);
      const text = fs.readFileSync(f, 'utf8');
      const body = lines.map((l) => (l ? `> ${l}` : '>')).join('\n');
      const next = text.replace(new RegExp(`> \\[!ANSWER\\] ${id}\\r?\\n>\\r?\\n`), `> [!ANSWER] ${id}\n${body}\n`);
      if (next === text) throw new Error(`回答欄が見つかりません: ${id}`);
      fs.writeFileSync(f, next);
    },
    async close() { await context.close(); await browser.close(); await app.close(); },
  };
  return p;
}

// ---------- 保存 ----------
async function still(page, name, clip) {
  const png = path.join(tmp, `${name}.png`);
  await page.screenshot({ path: png, ...(clip ? { clip } : {}) });
  const dest = path.join(OUT, `${name}.webp`);
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', png, '-c:v', 'libwebp', '-quality', '86', '-compression_level', '6', dest]);
  console.log(`images/${name}.webp`);
}

function loop(raw, name, { from = 0, length }) {
  const dest = path.join(OUT, `${name}.mp4`);
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(from), '-i', raw, '-t', String(length),
    '-an', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', dest]);
  // 最初のフレームをポスター画像にする（動画を読み込む前・動きを減らす設定のとき）
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(from + length - 0.1), '-i', raw, '-frames:v', '1',
    '-c:v', 'libwebp', '-quality', '86', path.join(OUT, `${name}-poster.webp`)]);
  console.log(`images/${name}.mp4`);
}

// ================= 静止画 =================
async function stills() {
  const p = await open({ scheme: 'light' });
  const { page } = p;

  // ツリー（未読の ● が並ぶ）と、レビューの .md
  await p.go(MAIN, '席予約 API');
  await p.scrollTo('席予約 API レビュー結果', 40);

  // 文にマウスを乗せる → 1 文だけハイライト
  await p.hover('空きの確認と保存が、別々の問い合わせ', 0.5);
  await sleep(500);
  await still(page, 'hover', { x: 0, y: 0, width: 990, height: 560 });

  // 文をクリックして質問を書く
  await p.clickText('保存の時点で、データベースに重なりを拒ませてください', 0.5);
  await p.type('アプリ側でロックするのではだめ？', 0);
  await sleep(300);
  await p.move(1100, 700);
  await still(page, 'compose', await p.clipAround('.composer', 300));
  await p.submit();

  // 言葉をなぞる →「〇〇」とは？ の下書き
  const t = await p.rect('排他制約');
  await p.move(t.x + 1, t.y + t.h / 2);
  await page.mouse.down();
  await page.mouse.move(t.ex - 1, t.ey, { steps: 10 });
  await page.mouse.up();
  await sleep(600);
  if (!(await page.locator('.composer').count())) await p.clickText('排他制約', 0.5);
  await p.move(1100, 700);
  await sleep(300);
  await still(page, 'term', await p.clipAround('.composer', 190));
  await p.submit();

  // コードの 1 行に質問
  await p.scrollTo('時間帯の重なりを、開始時刻だけで判定している', 80);
  await p.clickText('return a.from < b.to && b.from < a.to;', 0.3);
  await p.type('なぜこの 2 つの比較だけで重なりが分かるの？', 0);
  await p.move(1100, 700);
  await sleep(300);
  await still(page, 'code', await p.clipAround('.composer', 330));
  await p.submit();

  // 下のバー（未回答の数のバッジ・指示文をコピー）
  await p.move(1100, 300);
  await sleep(400);
  await still(page, 'dock', { x: 0, y: H - 64, width: 990, height: 64 });

  // 回答が届く
  for (const id of ['Q1', 'Q2', 'Q3']) { p.answer(MAIN, id, ANSWERS[id]); await sleep(300); }
  await sleep(1800);
  await p.scrollTo('同時に来た予約が、同じ席に入ってしまう', 60);
  await sleep(400);
  await still(page, 'answered');

  // 図の部品に質問
  await p.go(FLOW, '予約の流れ');
  await page.waitForSelector('.mmd-view svg', { timeout: 15000 });
  await sleep(800);
  await p.scrollTo('予約の作成は', 50);
  const node = page.locator('.mmd-view g.node', { hasText: '空きの確認' }).first();
  const nb = await node.boundingBox();
  await p.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await sleep(200);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(400);
  await p.type('ここで確認しているのに、なぜ保存でもう一度確かめるの？', 0);
  await p.submit();
  await p.move(1100, 700);
  await sleep(400);
  await still(page, 'diagram');
  p.answer(FLOW, 'Q1', ANSWERS.Q4);
  await sleep(1500);
  await p.close();

  // 夜桜（夜の配色）。同じフォルダ（質問と回答が入った状態）を、夜の配色で開き直す
  const n = await open({ scheme: 'dark', work: p.work });
  await n.go(MAIN, '席予約 API');
  await n.scrollTo('時間帯の重なりを、開始時刻だけで判定している', 60);
  await n.move(1100, 700);
  await sleep(600);
  await still(n.page, 'night');
  await n.go(FLOW, '予約の流れ');
  await n.page.waitForSelector('.mmd-view svg', { timeout: 15000 });
  await sleep(800);
  await n.scrollTo('予約の作成は', 50);
  await sleep(400);
  await still(n.page, 'night-diagram');
  await n.close();
}

// ================= ループ動画 =================
async function loops() {
  // 1. 文をクリックして質問を書き、回答が本文の中に届く
  const dir = fs.mkdtempSync(path.join(tmp, 'v-'));
  const p = await open({ scheme: 'light', video: dir });
  const { page } = p;
  await p.go(MAIN, '席予約 API');
  await p.cursor(true);
  await p.scrollTo('同時に来た予約が、同じ席に入ってしまう', 60);
  await p.move(820, 520, 1);
  const t0 = Date.now();
  await sleep(500);
  await p.hover('空きの確認と保存が、別々の問い合わせ', 0.3, 14);
  await sleep(450);
  await p.hover('2 人がほぼ同時に同じ席を予約すると', 0.5, 14);
  await sleep(450);
  await p.clickText('保存の時点で、データベースに重なりを拒ませてください', 0.45);
  await p.type('アプリ側でロックするのではだめ？', 70);
  await sleep(400);
  await p.submit();
  await p.move(1120, 640, 16);
  await sleep(700);
  p.answer(MAIN, 'Q1', ANSWERS.Q1);
  await sleep(2600);
  const length = (Date.now() - t0) / 1000;
  const video = page.video();
  await p.close();
  const raw = await video.path();
  // 録画の頭（読み込み中）を除き、操作の部分だけを残す
  loop(raw, 'loop-ask', { from: Math.max(0, duration(raw) - length), length });
}

// WebM には長さの情報がないことがあるので、最後まで読んで測る
function duration(file) {
  const log = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

try {
  if (SCENES === 'all' || SCENES === 'stills') await stills();
  if (SCENES === 'all' || SCENES === 'loops') await loops();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
