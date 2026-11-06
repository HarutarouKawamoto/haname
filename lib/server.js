import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import { parseBlocks, splitLines, addQuestion, addFollowUp, stripAll, unanswered, bodyOf, mergeBody } from './qa.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const ALWAYS_SKIP = new Set(['node_modules', '.git', '.haname', '.mdview']);

// AI ツールの設定・指示のファイル。読む対象ではないので、初期設定では隠す（aiFiles: true で表示）
const AI_DIRS = new Set([
  '.claude', '.cursor', '.windsurf', '.codex', '.gemini', '.agents', '.clinerules',
  '.roo', '.continue', '.kiro', '.junie', '.amazonq', '.augment', '.opencode',
]);
const AI_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agent.md', 'gemini.md']);
const AI_GITHUB = new Set(['copilot-instructions.md', 'instructions', 'prompts', 'agents', 'chatmodes']);

/** AI ツールの設定・指示のファイル（またはそのフォルダ）か */
export function isAiPath(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => AI_DIRS.has(p))) return true;
  if (AI_FILES.has(parts.at(-1).toLowerCase())) return true;
  const gi = parts.indexOf('.github');
  return gi !== -1 && gi + 1 < parts.length && AI_GITHUB.has(parts[gi + 1]);
}
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

// すべての応答に付けるヘッダー（MIME 推測・参照元の送信・他サイトへの埋め込みを防ぐ）
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};
// 画面の CSP: 自分のサーバーのスクリプトだけを実行する。画像は .md が外部の画像を載せることがあるので許可
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ICONS = [
  'chevron-left', 'chevron-right', 'chevron-down', 'eye', 'eye-off', 'eraser',
  'clipboard-list', 'clipboard-copy', 'send', 'x', 'check', 'folder', 'folder-open',
  'file-text', 'link-2-off', 'message-circle-question-mark', 'lightbulb', 'corner-down-right',
  'sun', 'moon', 'pencil', 'save', 'panel-right-close', 'panel-right-open', 'undo-2', 'redo-2', 'table-of-contents',
  'code', 'workflow', 'triangle-alert', 'maximize-2', 'zoom-in', 'zoom-out', 'scan',
];

function pkgDir(name) {
  let dir = path.dirname(require.resolve(name));
  while (dir !== path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`package ${name} not found`);
}

/**
 * @param {string} root 表示するフォルダ
 * @param {{ aiFiles?: boolean }} [options] aiFiles: AI ツールの設定・指示のファイルも表示する
 */
export function createServer(root, options = {}) {
  const hideAi = !options.aiFiles;
  root = path.resolve(root);
  const stateDir = path.join(root, '.haname');
  // 旧名（.mdview）の作業フォルダがあれば、新しい名前へ引き継ぐ
  const legacyDir = path.join(root, '.mdview');
  if (!fs.existsSync(stateDir) && fs.existsSync(legacyDir)) {
    try { fs.renameSync(legacyDir, stateDir); } catch (e) { console.warn('.mdview を .haname へ移せませんでした:', e.message); }
  }
  const stateFile = path.join(stateDir, 'state.json');
  const ig = ignore();
  try { ig.add(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')); } catch {}

  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const realRoot = fs.realpathSync(root);
  const inside = (p, base) => p === base || p.startsWith(base + path.sep);
  // フォルダの外を指すパスは拒否する。
  // 「../」による脱出に加え、シンボリックリンク（ジャンクション）でフォルダの外を指すものも拒否する
  const toAbs = (rel) => {
    const abs = path.resolve(root, String(rel));
    if (!inside(abs, root)) throw httpError(400, 'outside root');
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { real = probe; }
    if (!inside(real, realRoot)) throw httpError(403, 'outside root (link)');
    return abs;
  };
  const isSkipped = (rel, isDir) => {
    const parts = rel.split('/');
    if (parts.some((p) => ALWAYS_SKIP.has(p))) return true;
    if (hideAi && rel !== '' && isAiPath(rel)) return true;
    return rel !== '' && ig.ignores(isDir ? rel + '/' : rel);
  };
  // 画面からの操作は、ツリーに出ているもの（除外フォルダ・.gitignore 対象以外）だけに限る
  const guard = (rel, isDir = false) => {
    let skipped;
    try { skipped = isSkipped(String(rel), isDir); } catch { throw httpError(400, 'bad path'); }
    if (skipped) throw httpError(403, 'ignored path');
  };

  // ---------- 既読状態 ----------
  let state = { seen: {} };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  state.seen ??= {};
  let saveTimer;
  const saveState = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(stateFile, JSON.stringify(state, null, 2));
    }, 100);
  };
  const markSeen = async (rel) => {
    const st = await fsp.stat(toAbs(rel));
    state.seen[rel] = st.mtimeMs;
    saveState();
  };

  // ---------- 未回答の質問（ファイルの更新時刻ごとにキャッシュ） ----------
  const pendingCache = new Map();
  async function unansweredOf(rel, abs, mtime) {
    const c = pendingCache.get(rel);
    if (c && c.mtime === mtime) return c.ids;
    let ids = [];
    try {
      const text = await fsp.readFile(abs, 'utf8');
      if (text.includes('[!ANSWER]')) ids = unanswered(parseBlocks(splitLines(text).lines));
    } catch {}
    pendingCache.set(rel, { mtime, ids });
    return ids;
  }

  // ---------- ファイル一覧 ----------
  async function walk(dirAbs, out, dirs) {
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return false; }
    let has = false;
    for (const e of entries) {
      const abs = path.join(dirAbs, e.name);
      const rel = toRel(abs);
      if (e.isDirectory()) {
        if (isSkipped(rel, true)) continue;
        if (await walk(abs, out, dirs)) { has = true; dirs.push(rel); }
      } else if (e.isFile() && /\.md$/i.test(e.name) && !isSkipped(rel, false)) {
        const st = await fsp.stat(abs);
        const seen = state.seen[rel];
        out.push({
          path: rel,
          mtime: st.mtimeMs,
          status: seen === undefined ? 'unread' : st.mtimeMs > seen + 1 ? 'updated' : 'read',
          unanswered: await unansweredOf(rel, abs, st.mtimeMs),
        });
        has = true;
      }
    }
    return has;
  }

  async function listFiles() {
    const files = [];
    const dirs = [];
    await walk(root, files, dirs);
    return { files, dirs };
  }

  // ---------- バックアップ（初回書き込み前に一度だけ） ----------
  async function backupOnce(rel) {
    const dest = path.join(stateDir, 'backup', ...rel.split('/'));
    if (fs.existsSync(dest)) return;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(toAbs(rel), dest);
  }

  async function readFile(rel) {
    const abs = toAbs(rel);
    const [text, st] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
    return { text, mtime: st.mtimeMs };
  }

  // ---------- 元に戻す / やり直す（ファイルごと、サーバーが動いている間だけ） ----------
  // HanaME が書き込むたびに「書く前」と「書いた後」を記録する。
  // 戻すときは、ファイルが「書いた後」のままのときだけ戻す（AI が後から書き込んだ内容を消さないため）。
  const history = new Map();
  const histOf = (rel) => {
    if (!history.has(rel)) history.set(rel, { undo: [], redo: [] });
    return history.get(rel);
  };

  async function writeChecked(rel, mtime, fn) {
    const cur = await readFile(rel);
    if (mtime !== undefined && Math.abs(cur.mtime - mtime) > 1) throw httpError(409, 'file changed');
    const next = fn(cur.text);
    const text = next.text ?? next;
    await backupOnce(rel);
    await fsp.writeFile(toAbs(rel), text);
    await markSeen(rel);
    if (text !== cur.text) {
      const h = histOf(rel);
      h.undo.push({ before: cur.text, after: text });
      if (h.undo.length > 50) h.undo.shift();
      h.redo = [];
    }
    return next;
  }

  async function stepHistory(rel, dir) {
    const h = histOf(rel);
    const [from, to] = dir === 'undo' ? [h.undo, h.redo] : [h.redo, h.undo];
    const step = from[from.length - 1];
    if (!step) throw httpError(409, 'nothing');
    const cur = await readFile(rel);
    const expect = dir === 'undo' ? step.after : step.before;
    if (cur.text !== expect) throw httpError(409, 'changed');
    from.pop();
    await fsp.writeFile(toAbs(rel), dir === 'undo' ? step.before : step.after);
    await markSeen(rel);
    to.push(step);
  }

  // ---------- リンク切れの検出 ----------
  const LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  async function brokenLinks(moving, destDir) {
    const { files } = await listFiles();
    const newPath = (rel) => (moving.has(rel) ? path.posix.join(destDir, path.posix.basename(rel)) : rel);
    let count = 0;
    for (const f of files) {
      const text = await fsp.readFile(toAbs(f.path), 'utf8');
      for (const m of text.matchAll(LINK_RE)) {
        const href = m[1];
        if (/^([a-z]+:|#|\/)/i.test(href)) continue;
        let target;
        try { target = decodeURI(href.split('#')[0]); } catch { continue; }
        if (!target) continue;
        const oldTarget = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), target));
        if (!fs.existsSync(path.join(root, oldTarget))) continue;
        if (!moving.has(f.path) && !moving.has(oldTarget)) continue;
        const after = path.posix.normalize(path.posix.join(path.posix.dirname(newPath(f.path)), target));
        if (after !== newPath(oldTarget)) count++;
      }
    }
    return count;
  }

  // ---------- 変更通知（SSE） ----------
  const clients = new Set();
  let pending = new Set();
  let flushTimer;
  const broadcast = (data) => {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  // 監視は listen() で始める（CLI のサブコマンドでは監視しない）
  let watcher = null;
  const startWatch = () => {
    try {
      watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const rel = name.split(path.sep).join('/');
        if (rel.split('/').some((p) => ALWAYS_SKIP.has(p))) return;
        if (hideAi && isAiPath(rel)) return;
        pending.add(rel);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => {
          const paths = [...pending];
          pending = new Set();
          broadcast({ paths });
        }, 150);
      });
    } catch (e) {
      console.warn('ファイル監視を開始できませんでした:', e.message);
    }
  };

  // ---------- CLI と共有する処理 ----------
  // 未回答の質問があるファイル（full なら中身も）
  async function pendingFiles(full) {
    const { files } = await listFiles();
    const out = [];
    for (const f of files) {
      if (!f.unanswered.length) continue;
      const item = { path: f.path, abs: toAbs(f.path), unanswered: f.unanswered };
      if (full) item.text = await fsp.readFile(toAbs(f.path), 'utf8');
      out.push(item);
    }
    return out;
  }
  // Q&A が残っているファイルと、その数。texts を渡すとその内容で判定する（git のステージ済みの内容など）
  async function filesWithQA(rels, texts) {
    const targets = rels ?? (await listFiles()).files.map((f) => f.path);
    const out = [];
    for (const rel of targets) {
      let text = texts?.get(rel);
      if (text === undefined) {
        try { text = await fsp.readFile(toAbs(rel), 'utf8'); } catch { continue; }
      }
      const n = text.includes('[!') ? parseBlocks(splitLines(text).lines).length : 0;
      if (n) out.push({ path: rel, count: n });
    }
    return out;
  }
  // Q&A をすべて取り除く（初回はバックアップを取る）
  async function cleanFiles(rels) {
    const done = [];
    for (const { path: rel, count } of await filesWithQA(rels)) {
      await writeChecked(rel, undefined, (t) => stripAll(t));
      done.push({ path: rel, count });
    }
    return done;
  }

  // 起動中のサーバーを CLI から見つけるための情報（.haname/server.json）
  const serverInfoFile = path.join(stateDir, 'server.json');
  const token = crypto.randomBytes(16).toString('hex');

  // ---------- HTTP ----------
  const mdDir = pkgDir('markdown-it');
  const hljsFile = require.resolve('@highlightjs/cdn-assets/highlight.min.js');
  const iconDir = path.join(pkgDir('lucide-static'), 'icons');
  const icons = Object.fromEntries(
    ICONS.map((n) => [n, fs.readFileSync(path.join(iconDir, `${n}.svg`), 'utf8').replace(/<!--[\s\S]*?-->/, '').trim()]),
  );
  const STATIC = {
    '/': [path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8'],
    '/app.js': [path.join(PUBLIC, 'app.js'), 'text/javascript; charset=utf-8'],
    '/boot.js': [path.join(PUBLIC, 'boot.js'), 'text/javascript; charset=utf-8'],
    '/style.css': [path.join(PUBLIC, 'style.css'), 'text/css; charset=utf-8'],
    '/prompt.js': [path.join(HERE, 'prompt.js'), 'text/javascript; charset=utf-8'],
    '/vendor/markdown-it.js': [path.join(mdDir, 'dist', 'browser', 'markdown-it.umd.min.js'), 'text/javascript; charset=utf-8'],
    '/vendor/highlight.js': [hljsFile, 'text/javascript; charset=utf-8'],
    // Mermaid は図があるページでだけ読み込む（約 3.5MB）。取り込み方は scripts/update-mermaid.mjs
    '/vendor/mermaid.js': [path.join(PUBLIC, 'vendor', 'mermaid.min.js'), 'text/javascript; charset=utf-8'],
  };

  let port = 0;
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  const server = http.createServer(async (req, res) => {
    try {
      // DNS リバインディング・他サイトからの書き込み対策
      if (!allowedHosts().includes(req.headers.host)) throw httpError(403, 'bad host');
      // CLI からの依頼は、server.json に書いたトークンで本人確認する
      const given = String(req.headers['x-haname-token'] ?? '');
      const fromCli = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (req.method !== 'GET' && !fromCli) {
        const origin = req.headers.origin;
        if (!origin || !allowedHosts().some((h) => origin === `http://${h}`)) throw httpError(403, 'bad origin');
      }
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const extra = url.pathname === '/' ? { 'content-security-policy': PAGE_CSP } : {};
        res.writeHead(200, { ...SEC_HEADERS, ...extra, 'content-type': type, 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { ...SEC_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      // ロゴ・アイコン画像（public/brand 内の png / webp だけ）
      const brand = url.pathname.match(/^\/brand\/([\w.-]+\.(png|webp))$/);
      if (req.method === 'GET' && brand) {
        const file = path.join(PUBLIC, 'brand', brand[1]);
        if (!fs.existsSync(file)) throw httpError(404, 'not found');
        res.writeHead(200, { ...SEC_HEADERS, 'content-type': brand[2] === 'png' ? 'image/png' : 'image/webp', 'cache-control': 'no-cache' });
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname === '/api/icons') return json(res, icons);
      if (url.pathname === '/api/raw') {
        const rel = url.searchParams.get('path') ?? '';
        const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
        if (!type) throw httpError(400, 'not image');
        guard(rel);
        const abs = toAbs(rel);
        await fsp.access(abs);
        res.writeHead(200, { ...SEC_HEADERS, 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
        return fs.createReadStream(abs).pipe(res);
      }
      if (url.pathname === '/api/tree') {
        const { files, dirs } = await listFiles();
        return json(res, { root, rootName: path.basename(root), sep: path.sep, files, dirs });
      }
      // 未回答の質問があるファイルをまとめて返す（AI へ一括で渡すため）。full=1 なら中身も付ける
      if (url.pathname === '/api/pending') {
        return json(res, { files: await pendingFiles(url.searchParams.get('full') === '1') });
      }
      if (url.pathname === '/api/file') {
        const rel = url.searchParams.get('path');
        if (!/\.md$/i.test(rel ?? '')) throw httpError(400, 'not md');
        guard(rel);
        const f = await readFile(rel);
        const blocks = parseBlocks(splitLines(f.text).lines);
        return json(res, { ...f, blocks, unanswered: unanswered(blocks), abs: toAbs(rel), body: bodyOf(f.text) });
      }

      if (req.method !== 'POST') throw httpError(404, 'not found');
      const body = await readBody(req);
      const rel = body.path;
      if (rel !== undefined) {
        if (typeof rel !== 'string' || !/\.md$/i.test(rel)) throw httpError(400, 'not md');
        guard(rel);
      }

      switch (url.pathname) {
        case '/api/open':
          // CLI（haname <ファイル>）から、開いている画面にそのファイルを開かせる
          if (!fromCli) throw httpError(403, 'cli only');
          toAbs(rel);
          broadcast({ open: rel });
          return json(res, { clients: clients.size });
        case '/api/seen':
          await markSeen(rel);
          return json(res, { ok: true });
        case '/api/question': {
          const r = await writeChecked(rel, body.mtime, (t) =>
            body.parentId
              ? addFollowUp(t, { parentId: body.parentId, sentence: body.sentence, question: body.question })
              : addQuestion(t, { blockEnd: body.blockEnd, headingLine: body.headingLine, sentence: body.sentence, question: body.question }),
          );
          return json(res, { id: r.id });
        }
        case '/api/edit': {
          // 本文だけを差し替え、Q&A は元の位置関係で戻す。
          // 編集中に AI が回答を書き込んでいても、本文が変わっていなければそのまま保存できる。
          const norm = (s) => s.replace(/\r\n/g, '\n');
          await writeChecked(rel, undefined, (t) => {
            if (norm(bodyOf(t)) !== norm(body.baseBody ?? '')) throw httpError(409, 'body changed');
            return mergeBody(t, body.body);
          });
          return json(res, { ok: true });
        }
        case '/api/undo':
        case '/api/redo':
          await stepHistory(rel, url.pathname === '/api/undo' ? 'undo' : 'redo');
          return json(res, { ok: true });
        case '/api/strip':
          {
            const ids = Array.isArray(body.ids) && body.ids.length
              ? body.ids.filter((id) => /^Q\d+(-\d+)*$/.test(id))
              : undefined;
            await writeChecked(rel, body.mtime, (t) => stripAll(t, ids));
          }
          return json(res, { ok: true });
        case '/api/move': {
          const dest = String(body.dest ?? '').replace(/^\/+|\/+$/g, '');
          // 移動できるのは .md だけ。除外フォルダへの出し入れはしない
          if (!Array.isArray(body.paths) || !body.paths.length) throw httpError(400, 'no paths');
          for (const p of body.paths) {
            if (typeof p !== 'string' || !/\.md$/i.test(p)) throw httpError(400, 'not md');
            guard(p);
            toAbs(p);
          }
          if (dest) guard(dest, true);
          const destAbs = toAbs(dest);
          if (!fs.statSync(destAbs).isDirectory()) throw httpError(400, 'dest not dir');
          const moving = new Set(body.paths.filter((p) => path.posix.dirname(p) !== (dest || '.')));
          for (const p of moving) {
            if (fs.existsSync(path.join(destAbs, path.posix.basename(p)))) throw httpError(409, `exists: ${path.posix.basename(p)}`);
          }
          if (body.dryRun) return json(res, { broken: await brokenLinks(moving, dest), count: moving.size });
          const moved = {};
          for (const p of moving) {
            const np = path.posix.join(dest, path.posix.basename(p));
            await fsp.rename(toAbs(p), toAbs(np));
            moved[p] = np;
            if (state.seen[p] !== undefined) { state.seen[np] = state.seen[p]; delete state.seen[p]; }
            const bOld = path.join(stateDir, 'backup', ...p.split('/'));
            if (fs.existsSync(bOld)) {
              const bNew = path.join(stateDir, 'backup', ...np.split('/'));
              await fsp.mkdir(path.dirname(bNew), { recursive: true });
              await fsp.rename(bOld, bNew);
            }
          }
          saveState();
          return json(res, { moved });
        }
      }
      throw httpError(404, 'not found');
    } catch (e) {
      const code = e.status ?? (e.code === 'ENOENT' ? 404 : 500);
      if (code === 500) console.error(e);
      if (!res.headersSent) json(res, { error: e.message }, code);
      else res.end();
    }
  });

  return {
    root,
    toRel,
    pendingFiles,
    filesWithQA,
    cleanFiles,
    listen(p) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => {
          port = server.address().port;
          startWatch();
          try {
            fs.mkdirSync(stateDir, { recursive: true });
            // トークン入りなので、本人だけが読めるようにする（Windows 以外で有効）
            fs.writeFileSync(serverInfoFile, JSON.stringify({ port, pid: process.pid, token }), { mode: 0o600 });
          } catch {}
          resolve(port);
        });
      });
    },
    // 終了時に server.json を消す（自分が書いたものだけ）
    // サーバーを止める（デスクトップ版でウィンドウを閉じたとき用）
    close() {
      try { watcher?.close(); } catch {}
      for (const c of clients) { try { c.end(); } catch {} }
      clients.clear();
      this.cleanup();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    cleanup() {
      try {
        const info = JSON.parse(fs.readFileSync(serverInfoFile, 'utf8'));
        if (info.token === token) fs.unlinkSync(serverInfoFile);
      } catch {}
    },
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, data, status = 200) {
  res.writeHead(status, { ...SEC_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      // 大きすぎる本文は、待たせ続けずに 413 で断る
      if (data.length > 5e6) {
        reject(httpError(413, 'too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'bad json')); }
    });
    req.on('error', reject);
  });
}
