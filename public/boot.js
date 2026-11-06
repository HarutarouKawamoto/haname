// 画面の描画前に読み込む起動スクリプト（CSP でページ内のスクリプトを禁止しているため、別ファイルにしている）

// 旧名（mdview:）で保存された設定を新しい名前（haname:）へ引き継ぐ
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('mdview:')) continue;
    const nk = 'haname:' + k.slice(7);
    if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch {}

// 読み込み直後のちらつきを防ぐため、保存済みのテーマとサイドバーの開閉を先に当てる
try {
  const t = JSON.parse(localStorage.getItem('haname:theme'));
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
try {
  if (JSON.parse(localStorage.getItem('haname:sideClosed'))) document.documentElement.classList.add('side-closed');
} catch {}
