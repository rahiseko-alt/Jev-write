import { StyleRule } from "@/types";

export const STYLE_RULES: StyleRule[] = [
  {
    id: "AI001",
    name: "意味の重複・結論反復",
    description: "同じ結論や意味内容を、別の言い回しで何度も反復して冗長にする表現",
    jevQuestion:
      "この文章には、既に述べられた結論や同じ意味内容が不必要に繰り返されている箇所がありますか？",
    severity: "medium",
    repairInstruction:
      "重複している冗長な文や言い換えを削除し、結論を一箇所に簡潔にまとめます。",
    enabled: true,
  },
  {
    id: "AI002",
    name: "「単なる〜ではない」の過剰な対比",
    description:
      "「単なる〜にとどまらず」「単に〜だけでなく」など、陳腐化した大げさな対比パターン",
    jevQuestion:
      "「単なる〜ではない」「単に〜にとどまらず」などの定型的な対比構文が使われていますか？",
    severity: "high",
    repairInstruction:
      "陳腐な対比構文（単なる〜ではない等）を取り除き、伝えたい事実や価値を直接平易に述べる表現に改めます。",
    enabled: true,
  },
  {
    id: "AI003",
    name: "内容のない汎用導入",
    description:
      "「近年、〜の進歩は著しく」「現代社会において〜」など、具体性のない汎用的で前置きだけの導入文",
    jevQuestion:
      "文頭に具体性のない紋切り型の時代背景や汎用的な前置き（「近年、〜」「現代社会において〜」等）が存在しますか？",
    severity: "medium",
    repairInstruction:
      "陳腐な一般論の導入を削除し、記事の具体的な本題や核となる事実から直接書き始めます。",
    enabled: true,
  },
  {
    id: "AI004",
    name: "抽象的な大げさ表現",
    description:
      "「革新的なパラダイムシフト」「常識を覆す」「未来を再定義する」など、根拠なく誇張された抽象表現",
    jevQuestion:
      "客観的な根拠を伴わずに「パラダイムシフト」「常識を覆す」「革新的」「根本から再定義」などの誇大表現が多用されていますか？",
    severity: "high",
    repairInstruction:
      "誇大な形容詞やバズワードを排除し、具体的な数値や客観的事実に基づいた平易な説明に置き換えます。",
    enabled: true,
  },
  {
    id: "AI005",
    name: "必要以上の箇条書き化",
    description:
      "文脈として連続して読むべき地の文を、機械的に短い箇条書きに分解して文脈を分断する表現",
    jevQuestion:
      "本来自然な文章で説明すべき文脈が、不必要に機械的な箇条書きで細切れに列挙されていますか？",
    severity: "low",
    repairInstruction:
      "細切れの箇条書きを統合し、自然な接続詞と論理の流れを持つまとまった散文段落に再構成します。",
    enabled: true,
  },
  {
    id: "AI006",
    name: "同型文の連続",
    description:
      "「〜である。〜である。」「〜といえます。〜といえます。」など、文末や構文パターンが単調に連続する表現",
    jevQuestion:
      "同じ文末（「〜である」「〜です」「〜と言えるでしょう」等）や同じ構文が連続して文章のリズムを損ねていますか？",
    severity: "medium",
    repairInstruction:
      "文末表現（体言止め、疑問文、複文など）に変化をつけ、文章のリズムと抑揚を自然に整えます。",
    enabled: true,
  },
  {
    id: "AI007",
    name: "機械的な接続語",
    description:
      "「まず第一に」「次に」「最後に」「要するに」などのプレゼン発表のような機械的・紋切り型の接続詞",
    jevQuestion:
      "「まず第一に」「次に」「最後に」「要するに」といった機械的で定型的な接続語が機械的に配置されていますか？",
    severity: "medium",
    repairInstruction:
      "機械的な接続詞を削除または文脈に応じた自然な論理展開の言葉に差し替え、文章のつなぎを滑らかにします。",
    enabled: true,
  },
  {
    id: "AI008",
    name: "説明→まとめ→再まとめの反復",
    description:
      "短い段落ごとに「まとめると」「結論として」と再要約を挟み、全体の要約と局所要約が多重化する構造",
    jevQuestion:
      "説明の直後にまとめが入り、さらにその直後に再まとめが続く多重要約の構造が見られますか？",
    severity: "high",
    repairInstruction:
      "重複する小まとめ・中間まとめを削り、説明から結論へスムーズに流れるストレートな論理構造に整理します。",
    enabled: true,
  },
  {
    id: "AI009",
    name: "根拠なしの一般論",
    description:
      "「多くの専門家が指摘している」「一般的に知られているように」など、主語や出典のない漠然とした一般化",
    jevQuestion:
      "具体的な調査や出典を示さずに「一般的に〜と言われている」「多くの人々にとって」と断定する記述がありますか？",
    severity: "medium",
    repairInstruction:
      "根拠のない主語の一般化を避け、具体的な主語やデータを示すか、断定を避けて控えめな表現に改めます。",
    enabled: true,
  },
  {
    id: "AI010",
    name: "不自然なCTA",
    description:
      "中立的な解説記事の末尾に、急に「ぜひ試してみてください」「検討してみてはいかがでしょうか」と営業的な呼びかけを挿入する癖",
    jevQuestion:
      "中立的な解説・解説記事の文末に、不自然で唐突な呼びかけや行動喚起（CTA）が付加されていますか？",
    severity: "medium",
    repairInstruction:
      "読者に対する唐突な営業的・行動喚起表現を削除し、客観的な事実や考察で静かに文章を締めくくります。",
    enabled: true,
  },
  {
    id: "AI011",
    name: "形式的な両論併記",
    description:
      "「一方でメリットもあるが、他方で課題もある」といった、中身のない形式的・中立装飾のバランス取り文",
    jevQuestion:
      "具体的な比較や根拠を伴わず、表面的な「メリットもあるが課題もある」といった形式的な両論併記で濁していますか？",
    severity: "low",
    repairInstruction:
      "形式だけの浅い両論併記をやめ、具体的な課題やトレードオフの要因を明記するか、焦点を絞った明快な記述にします。",
    enabled: true,
  },
  {
    id: "AI012",
    name: "紋切り型の結びの言葉",
    description:
      "「今後の動向に目が離せません」「今後の発展に期待が寄せられています」など、思考停止した定型結び文句",
    jevQuestion:
      "文末が「今後の動向に目が離せません」「今後の発展に期待が寄せられています」などの陳腐な定型句で終わっていますか？",
    severity: "high",
    repairInstruction:
      "定型の結び文句を削除し、本文の要点や具体的な今後の課題・展望を自身の言葉で簡潔に記述して結びます。",
    enabled: true,
  },
  {
    id: "AI013",
    name: "感情の過剰な擬似共感",
    description:
      "「いかがでしたでしょうか」「〜にお悩みの方も多いのではないでしょうか」といった機械的な共感誘発表現",
    jevQuestion:
      "「いかがでしたでしょうか」「お悩みの方も多いのではないでしょうか」などの読者への過剰な擬似共感表現が含まれていますか？",
    severity: "medium",
    repairInstruction:
      "読者への過剰な語りかけや擬似共感を削除し、客観的で信頼性の高いトーンに統一します。",
    enabled: true,
  },
  {
    id: "AI014",
    name: "過剰な受動態・ぼかし表現",
    description:
      "「〜されることが期待されています」「〜と考えられています」など、行為主体を曖昧にする無責任なぼかし表現",
    jevQuestion:
      "責任や主語を曖昧にした「〜が期待されている」「〜と考えられている」という受動態・伝聞表現が多用されていますか？",
    severity: "low",
    repairInstruction:
      "主体を明確にした能動態に書き直すか、判断の根拠を具体的に示します。",
    enabled: true,
  },
];

/**
 * 有効化されているスタイル規則の一覧を取得する
 */
export function getEnabledStyleRules(): StyleRule[] {
  return STYLE_RULES.filter((rule) => rule.enabled);
}

/**
 * ID指定でスタイル規則を取得する
 */
export function getStyleRuleById(id: string): StyleRule | undefined {
  return STYLE_RULES.find((rule) => rule.id === id);
}
