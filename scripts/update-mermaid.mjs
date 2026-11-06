// Mermaid のブラウザ用ファイルを public/vendor/ に取り込む（版を上げるときに使う）。
//
//   node scripts/update-mermaid.mjs 11.17.2
//
// mermaid の npm パッケージは依存を含めると 140MB を超えるため、依存には入れず、
// 自己完結した dist/mermaid.min.js（約 3.5MB）だけを取り込む。
// このファイルには mermaid が使う部品（d3、DOMPurify など）が丸ごと入っているので、
// それらのライセンス表示もまとめて public/vendor/mermaid.LICENSES.txt に書き出す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('使い方: node scripts/update-mermaid.mjs <版>（例: 11.17.2）');
  process.exit(1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haname-mermaid-'));

try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"private":true}');
  execFileSync(npm, ['install', `mermaid@${version}`, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32',
  });
  const nm = path.join(tmp, 'node_modules');

  fs.mkdirSync(VENDOR, { recursive: true });
  fs.copyFileSync(path.join(nm, 'mermaid', 'dist', 'mermaid.min.js'), path.join(VENDOR, 'mermaid.min.js'));

  // ライセンス表示を集める（mermaid 本体と、取り込まれている部品すべて）
  const pkgs = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (name.startsWith('@')) { walk(p); continue; }
      const pj = path.join(p, 'package.json');
      if (!fs.existsSync(pj)) continue;
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const file = fs.readdirSync(p).find((f) => /^(licen[sc]e|copying)(\..*)?$/i.test(f));
      const license = typeof j.license === 'string' ? j.license : j.license?.type ?? '(see text)';
      pkgs.push({ name: j.name, version: j.version, license, text: file ? fs.readFileSync(path.join(p, file), 'utf8').trim() : '' });
      if (fs.existsSync(path.join(p, 'node_modules'))) walk(path.join(p, 'node_modules'));
    }
  };
  walk(nm);
  pkgs.sort((a, b) => (a.name === 'mermaid' ? -1 : b.name === 'mermaid' ? 1 : a.name.localeCompare(b.name)));
  const out = [
    `mermaid.min.js は Mermaid ${version}（https://github.com/mermaid-js/mermaid）のブラウザ用ファイルです。`,
    'このファイルには次の部品が含まれています。それぞれのライセンス表示を以下に掲載します。',
    '',
    ...pkgs.map((p) => `- ${p.name}@${p.version}（${p.license}）`),
    '',
    ...pkgs.flatMap((p) => ['='.repeat(72), `${p.name}@${p.version}（${p.license}）`, '='.repeat(72), p.text || `（ライセンス本文のファイルなし。ライセンス: ${p.license}）`, '']),
  ];
  fs.writeFileSync(path.join(VENDOR, 'mermaid.LICENSES.txt'), out.join('\n'));
  console.log(`✓ public/vendor/mermaid.min.js（Mermaid ${version}）と mermaid.LICENSES.txt（${pkgs.length} 部品）を更新しました`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
