#!/usr/bin/env node
// HanaME（花見）コマンド
//
//   haname [フォルダ | ファイル.md]   ビューアを起動（起動済みならそれを使う）
//   haname prompt [--full] [フォルダ]  未回答の質問をまとめた AI への指示文を出力
//   haname init [フォルダ]             .gitignore・CLAUDE.md / AGENTS.md・AI 用スキルを準備
//   haname clean [ファイル…] [--dry-run]  Q&A を取り除く
//   haname check [ファイル…] [--staged]   Q&A が残っていたら失敗で終わる
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../lib/server.js';
import { buildPrompt, RULES } from '../lib/prompt.js';

const HELP = `HanaME（花見）— AI が書いた .md を読み、まとめて壁打ちするローカルビューア

使い方:
  haname [フォルダ | ファイル.md]      ビューアを起動する（起動済みならそのまま使う）
      --port <番号>                    ポート番号（初期値 4747）
      --no-open                        ブラウザを開かない
      --ai-files                       AI ツールの設定・指示のファイル（.claude/ や CLAUDE.md など）も表示する
  haname prompt [--full] [フォルダ]    未回答の質問をまとめた AI への指示文を出力する
                                       --full でファイルの中身も含める（ブラウザのチャット向け）
  haname init [フォルダ]               .gitignore に .haname/ を追加し、
                                       CLAUDE.md / AGENTS.md に Q&A のルールを書き足し、
                                       .claude/skills/ に質問に回答するスキルを置く
  haname clean [ファイル…] [--dry-run]  Q&A を取り除く（省略時はフォルダ内すべて）
  haname check [ファイル…] [--staged]   Q&A が残っている .md があれば知らせて失敗で終わる
                                       --staged で git のステージ済みの内容を調べる`;

// ---------- Node.js のバージョン確認 ----------
// Node2Shell（CVE-2026-111497, Brotli 展開の脆弱性）が修正された版より古い Node.js では起動しない。
// 修正版: 22.23.4 / 24.22.1 / 26.12.1。それ以外の系列（奇数版・23/25・21以前）はサポート終了のため対象外
{
  const FIXED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
  const cur = process.versions.node.split('.').map(Number);
  const min = FIXED[cur[0]] ?? (cur[0] > 26 ? [cur[0], 0, 0] : null);
  const older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (!min || older(cur, min) < 0) {
    console.error(
      `Node.js ${process.versions.node} では起動できません。\n` +
      'Node2Shell（CVE-2026-111497）が修正された Node.js 22.23.4 / 24.22.1 / 26.12.1 以降に更新してください。',
    );
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const commands = new Set(['prompt', 'init', 'clean', 'check']);
const command = commands.has(args[0]) ? args[0] : null;

if (flags.has('--help') || flags.has('-h')) {
  console.log(HELP);
  process.exit(0);
}


// ---------- 共通 ----------

/** オプション（--port 4747 のような値付きも含む）を除いた引数 */
function positionals(from) {
  const out = [];
  for (let i = from; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') { i++; continue; }
    if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}

function dirArg(from) {
  const dir = path.resolve(positionals(from)[0] ?? '.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`フォルダが見つかりません: ${dir}`);
  return dir;
}

/** cwd からの相対パス（複数可）を、root からの相対パスに直す */
function toRels(root, files) {
  return files.map((f) => {
    const abs = path.resolve(f);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`フォルダの外のファイルです: ${f}`);
    if (!/\.md$/i.test(abs)) throw new Error(`.md ファイルではありません: ${f}`);
    return rel.split(path.sep).join('/');
  });
}

function openBrowser(url) {
  // 自分のサーバーの URL 以外は開かない（ファイル名が URL に入るため、念のため形を確かめる）
  if (!/^http:\/\/localhost:\d{1,5}\/(#[A-Za-z0-9%._~!*'()-]*)?$/.test(url)) return;
  // Windows では cmd.exe を通さずに開く（cmd の記号の解釈によるコマンド実行を避ける）
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

const samePath = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** dir より上の階層も含めて、起動中の HanaME を探す。見つかれば { root, port, token } */
async function findRunning(dir) {
  let d = path.resolve(dir);
  while (true) {
    const info = path.join(d, '.haname', 'server.json');
    if (fs.existsSync(info)) {
      try {
        const { port, token } = JSON.parse(fs.readFileSync(info, 'utf8'));
        const res = await fetch(`http://127.0.0.1:${port}/api/tree`, { signal: AbortSignal.timeout(1500) });
        const tree = await res.json();
        if (samePath(tree.root, d)) return { root: d, port, token };
      } catch {}
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// ---------- haname [フォルダ | ファイル.md] ----------
async function cmdStart() {
  let port = 4747;
  const pi = args.findIndex((a) => a === '--port' || a === '-p');
  if (pi >= 0) port = Number(args[pi + 1]);
  const open = !flags.has('--no-open');

  const target = path.resolve(positionals(0)[0] ?? '.');
  if (!fs.existsSync(target)) throw new Error(`見つかりません: ${target}`);
  const isFile = fs.statSync(target).isFile();
  if (isFile && !/\.md$/i.test(target)) throw new Error(`.md ファイルではありません: ${target}`);

  // 1) 起動済みの HanaME があれば、それを使う
  const running = await findRunning(isFile ? path.dirname(target) : target);
  if (running && (isFile || samePath(running.root, target))) {
    const url = `http://localhost:${running.port}/`;
    const rel = isFile ? path.relative(running.root, target).split(path.sep).join('/') : null;
    let shown = false;
    if (rel) {
      try {
        const res = await fetch(`http://127.0.0.1:${running.port}/api/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-haname-token': running.token },
          body: JSON.stringify({ path: rel }),
        });
        shown = (await res.json()).clients > 0;
      } catch {}
    }
    console.log(`HanaME（花見）は起動済みです: ${running.root}`);
    console.log(`  → ${url}${rel ? `  （${rel} を開きました）` : ''}`);
    if (!shown && open) openBrowser(url + (rel ? `#${encodeURIComponent(rel)}` : ''));
    return;
  }

  // 2) 新しく起動する。ファイル指定のときは、今いるフォルダ（ファイルが外にあればそのフォルダ）を起点にする
  let root = target;
  if (isFile) {
    const cwd = process.cwd();
    const inside = !path.relative(cwd, target).startsWith('..');
    root = inside ? cwd : path.dirname(target);
  }
  const app = createServer(root, { aiFiles: flags.has('--ai-files') });
  let actual;
  for (let p = port; p < port + 20; p++) {
    try {
      actual = await app.listen(p);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!actual) throw new Error('空いているポートが見つかりませんでした');

  const bye = () => { app.cleanup(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('exit', () => app.cleanup());

  const url = `http://localhost:${actual}/`;
  const rel = isFile ? path.relative(root, target).split(path.sep).join('/') : null;
  console.log(`HanaME（花見）: ${root}`);
  console.log(`  → ${url}`);
  if (open) openBrowser(url + (rel ? `#${encodeURIComponent(rel)}` : ''));
}

// ---------- haname prompt ----------
async function cmdPrompt() {
  const root = dirArg(1);
  const files = await createServer(root).pendingFiles(flags.has('--full'));
  if (!files.length) {
    console.error('未回答の質問はありません。');
    return;
  }
  process.stdout.write(buildPrompt(files, flags.has('--full')) + '\n');
}

// ---------- haname init ----------
const MARK_START = '<!-- haname:start -->';
const MARK_END = '<!-- haname:end -->';

function rulesBlock() {
  return [
    MARK_START,
    '## HanaME（.md の質問と回答）',
    '',
    'このリポジトリの .md には、HanaME で書き込まれた質問（`> [!QUESTION]`）と回答欄（`> [!ANSWER]`）があります。',
    '',
    // npx は使わせない: npm に未公開のため、同じ名前の別パッケージを実行してしまうおそれがある
    '- 「質問に答えて」と頼まれたら、haname-answer スキルがあればそれを使ってください。無ければ `haname prompt` を実行し、出力された指示に従ってください（`npx haname` は使わないでください）。',
    ...RULES.map((r) => `- ${r}`),
    '- 頼まれない限り、`> [!QUESTION]` と `> [!ANSWER]` のブロックを削除・移動しないでください。',
    MARK_END,
  ].join('\n');
}

const SKILL_SRC = new URL('../skills/haname-answer/SKILL.md', import.meta.url);
const SKILL_DEST = path.join('.claude', 'skills', 'haname-answer', 'SKILL.md');
const MANAGED = '<!-- haname:managed';

/** AI 用のスキル（Claude Code 向け）を置く。自分で書き換えたもの（印が無いもの）は上書きしない */
function installSkill(root) {
  const dest = path.join(root, SKILL_DEST);
  const src = fs.readFileSync(SKILL_SRC, 'utf8');
  const label = SKILL_DEST.replaceAll('\\', '/');
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
    return `${label}: 質問に回答するスキルを置きました`;
  }
  const cur = fs.readFileSync(dest, 'utf8');
  if (!cur.includes(MANAGED)) return `${label}: 書き換えられているため、そのままにしました`;
  if (cur === src) return `${label}: すでに最新です`;
  fs.writeFileSync(dest, src);
  return `${label}: 最新にしました`;
}

async function cmdInit() {
  const root = dirArg(1);
  const done = [];

  // .gitignore
  const gi = path.join(root, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (/^\/?\.haname\/?\s*$/m.test(giText)) done.push('.gitignore: すでに .haname/ があります');
  else {
    const sep = giText && !giText.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gi, `${giText}${sep}# HanaME（花見）の作業フォルダ\n.haname/\n`);
    done.push('.gitignore: .haname/ を追加しました');
  }

  // CLAUDE.md / AGENTS.md（あるものすべて。どちらもなければ CLAUDE.md を作る）
  let targets = ['CLAUDE.md', 'AGENTS.md'].filter((n) => fs.existsSync(path.join(root, n)));
  if (!targets.length) targets = ['CLAUDE.md'];
  const warn = [];
  for (const name of targets) {
    const file = path.join(root, name);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // 元のファイルの改行コードに合わせる
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = rulesBlock().replaceAll('\n', eol);
    const s = text.indexOf(MARK_START);
    const e = text.indexOf(MARK_END);
    const count = (m) => text.split(m).length - 1;
    let next;
    if (s === -1 && e === -1) {
      next = text ? `${text.replace(/\s*$/, '')}${eol}${eol}${block}${eol}` : `${block}${eol}`;
      done.push(`${name}: HanaME のルールを${text ? '書き足しました' : '書いて作成しました'}`);
    } else if (s !== -1 && e > s && count(MARK_START) === 1 && count(MARK_END) === 1) {
      next = text.slice(0, s) + block + text.slice(e + MARK_END.length);
      done.push(`${name}: HanaME のルールを最新にしました`);
    } else {
      // 印が片方だけ・順番が逆・複数ある: どこまでが HanaME の部分か分からないので触らない
      warn.push(`${name}: ${MARK_START} と ${MARK_END} の組が崩れているため、変更しませんでした。印を1組に直すか、両方消してからもう一度実行してください`);
      continue;
    }
    fs.writeFileSync(file, next);
  }

  done.push(installSkill(root));
  console.log(done.map((d) => `✓ ${d}`).join('\n'));
  if (warn.length) {
    console.error(warn.map((w) => `! ${w}`).join('\n'));
    process.exitCode = 1;
  }
}

// ---------- haname clean ----------
async function cmdClean() {
  const root = process.cwd();
  const app = createServer(root);
  const files = positionals(1);
  const rels = files.length ? toRels(root, files) : undefined;
  if (flags.has('--dry-run')) {
    const found = await app.filesWithQA(rels);
    if (!found.length) return console.log('Q&A のあるファイルはありません。');
    for (const f of found) console.log(`  ${f.path}（${f.count} ブロック）`);
    console.log(`${found.length} ファイルの Q&A を取り除けます（--dry-run のため変更していません）。`);
    return;
  }
  const done = await app.cleanFiles(rels);
  if (!done.length) return console.log('Q&A のあるファイルはありません。');
  for (const f of done) console.log(`  ✓ ${f.path}（${f.count} ブロック）`);
  console.log(`${done.length} ファイルの Q&A を取り除きました。元の内容は .haname/backup/ にあります。`);
}

// ---------- haname check ----------
async function cmdCheck() {
  let root = process.cwd();
  let rels;
  let texts;
  if (flags.has('--staged')) {
    // git のステージ済みの内容を調べる（コミット前チェック向け）
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
    root = git('rev-parse', '--show-toplevel').trim();
    rels = git('-c', 'core.quotepath=off', 'diff', '--cached', '--name-only', '--diff-filter=ACMR')
      .split('\n').map((l) => l.trim()).filter((l) => /\.md$/i.test(l));
    texts = new Map(rels.map((r) => [r, execFileSync('git', ['show', `:${r}`], { cwd: root, encoding: 'utf8' })]));
  } else {
    const files = positionals(1);
    rels = files.length ? toRels(root, files) : undefined;
  }
  const found = await createServer(root).filesWithQA(rels, texts);
  if (!found.length) {
    console.log('✓ Q&A は残っていません。');
    return;
  }
  console.error('Q&A が残っている .md があります:');
  for (const f of found) console.error(`  ${f.path}（${f.count} ブロック）`);
  const list = found.map((f) => f.path).join(' ');
  if (flags.has('--staged')) console.error(`片付けるには: haname clean ${list} && git add ${list}`);
  else console.error('片付けるには: haname clean' + (rels ? ` ${list}` : ''));
  process.exit(1);
}

// ---------- 実行（定数・関数がすべて定義された後に動かす） ----------
try {
  if (command === 'prompt') await cmdPrompt();
  else if (command === 'init') await cmdInit();
  else if (command === 'clean') await cmdClean();
  else if (command === 'check') await cmdCheck();
  else await cmdStart();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
