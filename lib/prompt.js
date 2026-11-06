// AI への指示文を作る（画面のコピーボタンと `haname prompt` で共有）。
// ブラウザでもそのまま読み込めるよう、Node の機能は使わない。

/** Q&A の書式ルール（指示文と `haname init` で書き込むルールで共通） */
export const RULES = [
  '「> [!QUESTION] Q番号」のブロックが質問です。1行目の 対象:「…」 は、質問の対象になっている本文の文です。',
  '回答は、同じファイルの同じ番号の「> [!ANSWER] Q番号」ブロックに書いてください。ブロックはすでに用意してあります。',
  '回答の各行は「> 」で始めてください（引用ブロックの中に書きます）。',
  '本文・見出し・[!QUESTION]・回答済みの [!ANSWER] は変更しないでください。',
  '読み手は前提知識が少ない前提で、専門用語はかみ砕いて説明してください。',
];

/**
 * @param {{path:string, abs:string, unanswered:string[], text?:string}[]} files 未回答の質問があるファイル
 * @param {boolean} full true ならファイルの中身も含める（ブラウザのチャット向け）
 */
export function buildPrompt(files, full) {
  const many = files.length > 1;
  const lines = [
    many
      ? `次の${files.length}つのMarkdownファイルにある、未回答の質問にすべて回答してください。`
      : '次のMarkdownファイルにある、未回答の質問に回答してください。',
    '',
  ];
  if (!full) {
    for (const f of files) lines.push(`- ${f.abs}（未回答: ${f.unanswered.join(', ')}）`);
    lines.push('');
  }
  lines.push('ルール:', ...RULES.map((r) => `- ${r}`));
  if (full) {
    lines.push(
      many
        ? '- 回答を書き込んだ後の各ファイルの全体を、ファイル名の見出しを付けて、そのまま上書き保存できる形で返してください。'
        : '- 回答を書き込んだ後のファイル全体を、そのまま上書き保存できる形で返してください。',
    );
    for (const f of files) {
      const text = f.text ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      lines.push('', `### ${f.path}（未回答: ${f.unanswered.join(', ')}）`, '', `${fence}markdown`, text, fence);
    }
  }
  return lines.join('\n');
}
