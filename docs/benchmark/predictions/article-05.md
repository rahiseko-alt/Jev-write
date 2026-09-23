# 記事05（ふるさと納税）理論上の予測

- 作成: 2026-09-23（本番で測る前）
- 対象: `docs/benchmark/article-05.txt`（本文26文。表題と「■」の見出しは文ではないので除く）
- 仕込み: `docs/benchmark/article-05.errors.json`（E1＝文3、E2＝文5、E3＝文14、E4＝文17）
- 本番の道具は使っていない。`src/` は読んでいない。一次資料は 2026-09-23 に Web で確認した。

## この予測が数値にしているもの

- 信頼度は、集めた資料でその文（原文の文 `claim.original`）が裏付けられている確率（ADR-0011）。正誤を決める道具ではない（ADR-0009・0012）。
- 信頼度が 80% 以下の文には▶が付く。仕込んだ文は低く出るはずで、低く出れば成功、高く出れば改善の余地（ADR-0012）。
- JEV には原文の文と、JEV が関連ありと判定した資料の節だけが渡る。記事の前後の文は渡らない（ADR-0014）。
- 予測の区分:
  - **低**: 80% 以下の見込み。公的な一次資料が文と違う内容を書いている。
  - **高**: 80% を超える見込み。公的な一次資料が文と同じ内容を書いている。
  - **どちらとも**: どの資料が集まるかに左右される。一次資料が少ない、または時期によって資料の中身が変わる。
  - **対象外（主張として取り出されない見込み）**: 意見・感想・助言の文（ADR-0017 手順①で除かれる）。

## 内訳

| 予測 | 件数 | 文の番号 |
| --- | --- | --- |
| 低 | 4 | 3（E1）、5（E2）、14（E3）、17（E4） |
| 高 | 17 | 1、2、4、6、7、8、9、11、12、13、15、16、18、19、21、23、25 |
| どちらとも | 3 | 10、20、24 |
| 対象外 | 2 | 22、26 |

仕込んだ4か所は、4か所とも「低」の見込みである。一次資料（総務省・国税庁・地方税法）が、4か所とも文と違う内容をはっきり書いている。

## 予測

| 番号 | 文（先頭40字） | 仕込み | 予測 | 理由 | 根拠URL |
| --- | --- | --- | --- | --- | --- |
| 1 | ふるさと納税は、自分が選んだ都道府県や市区町村に寄附をすると、その寄附額に応じて |  | 高 | 総務省と国税庁が「自分の選んだ自治体に寄附…所得税と住民税から控除される制度」と同じ内容を書いている | [総務省 ふるさと納税の概要](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/about.html)<br>[国税庁 No.1155](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm) |
| 2 | 「納税」という名前がついていますが、実際には自治体への「寄附」であり、生まれ故郷 |  | 高 | 総務省が「『納税』という言葉がついている…実際には…『寄附』」「生まれ故郷に限らず、どの自治体にでも」とほぼ同じ文を書き、FAQ も「自治体には制限はありません」 | [総務省 よくわかる！ふるさと納税](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/about/)<br>[総務省 よくある質問 Q2](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/) |
| 3 | この制度は2011年度（平成23年度）の税制改正で創設され、生まれ育った故郷や応 | E1 | 低 | 一次資料は創設を平成20年（2008年）と書く（福井県「平成20年4月30日地方税法の改正により…制度創設」、総務省の受入額の統計も平成20年度から）。違う内容 | [福井県 ふるさと納税とは](https://info.pref.fukui.lg.jp/furusatonouzei/110_subject/detail01.html)<br>[総務省 現況調査（令和8年度）p.2](https://www.soumu.go.jp/main_content/001085011.pdf)<br>[群馬県 個人住民税の寄附金税制](https://www.pref.gunma.jp/site/tax/5407.html) |
| 4 | ふるさと納税の大きな特徴は、寄附額のうち2,000円を超える部分が所得税と住民税 |  | 高 | 総務省と国税庁が「寄附額のうち2,000円を超える部分について、所得税と住民税から控除」と同じ内容を書いている（総務省は「一定の上限はあります」と添える） | [総務省 ふるさと納税の概要](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/about.html)<br>[国税庁 No.1155](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm) |
| 5 | 寄附額がいくらであっても、自己負担は2,000円だけで済みます。 | E2 | 低 | 総務省は「一定の上限はあります」「特例分が所得割額の2割を超える場合…実質負担額は2,000円を超えます」と書く。寄附額によらず2,000円とは書いていない。違う内容 | [総務省 ふるさと納税の概要](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/about.html)<br>[総務省 税金の控除について](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html) |
| 6 | 控除は、所得税の寄附金控除、住民税の基本分、住民税の特例分という三つの部分で構成 |  | 高 | 総務省と国税庁が、所得税・住民税（基本分）・住民税（特例分）の3つの計算と「特例分は所得割額の2割（20％）を限度」を明記。同じ内容 | [総務省 税金の控除について](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html)<br>[国税庁 No.1155](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm) |
| 7 | 控除の対象となるのは、その年の1月1日から12月31日までに行った寄附です。 |  | 高 | 総務省 FAQ が「税の軽減については『1月〜12月』の年単位」「1年間（1月〜12月）の寄附金総額」と同じ内容を書いている | [総務省 よくある質問 Q3・Q4](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/) |
| 8 | 多くの自治体は、寄附へのお礼として地域の特産品などを「返礼品」として送っています |  | 高 | 総務省 FAQ が「寄附者へのお礼として特産品を送る場合」を説明し、現況調査では返礼品の調達費が受入額の26.5%（令和7年度 3,528億円）。「多くの」を団体数で示す一次資料は無いが、向きは同じ | [総務省 よくある質問 Q12](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/)<br>[総務省 現況調査（令和8年度）p.5](https://www.soumu.go.jp/main_content/001085011.pdf) |
| 9 | ただし、返礼品競争の過熱を受けて、2019年6月からは総務大臣が自治体を指定する |  | 高 | 総務省資料が「返礼品競争の過熱」→「令和元年6月1日施行…ふるさと納税の対象となる地方団体を総務大臣が指定」と同じ内容を書いている | [総務省 指定制度について（2019年4月1日）](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20190401.html)<br>[総務省 ふるさと納税制度とは p.3](https://www.soumu.go.jp/main_content/000816463.pdf) |
| 10 | 指定を受けるには、返礼品の調達費用を寄附額の3割以下とすること、返礼品を地場産品 |  | どちらとも | 3割（地方税法）・地場産品・経費総額5割以下（告示）は総務省資料と同じ。ただし5割の基準は令和8年10月1日適用の告示で削られ、「寄附金活用可能額」（52.5%以上から段階的に60%以上）に置き換わる。改正の資料が集まると下がりうる | [総務省 ふるさと納税制度とは p.3](https://www.soumu.go.jp/main_content/000816463.pdf)<br>[告示第179号（令和8年10月1日適用）](https://www.soumu.go.jp/main_content/001065165.pdf)<br>[総務省 告示改正資料（令和8年3月24日）p.14](https://www.soumu.go.jp/main_content/001070694.pdf) |
| 11 | なお、自分が住んでいる自治体に寄附をしても控除は受けられますが、その自治体から返 |  | 高 | 告示第179号が「区域内に住所を有する者に対する返礼品等の提供」を行わないことを指定の基準にしており、寄附先の自治体には制限がない（FAQ Q2）。同じ内容 | [告示第179号（制定時）第2条第1号ニ](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/file/report20190401_03.pdf)<br>[告示第179号（令和8年10月1日適用）第3条第1号ホ](https://www.soumu.go.jp/main_content/001065165.pdf)<br>[総務省 よくある質問 Q2](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/) |
| 12 | 控除を受けるための手続きは、大きく分けて二つあります。 |  | 高 | 総務省「ふるさと納税の流れ」が、ワンストップ特例を申請しない場合（確定申告）と申請する場合の2つに分けて説明している | [総務省 ふるさと納税の流れ](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html) |
| 13 | 一つは確定申告で、寄附先の自治体から送られてくる受領証明書などをもとに申告します |  | 高 | 総務省が「寄附を証明する書類（受領書）が発行されます」「確定申告を行う際には…受領書を添付」と同じ内容を書いている | [総務省 ふるさと納税の流れ](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html)<br>[総務省 税金の控除について](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html) |
| 14 | もう一つが「ワンストップ特例制度」で、確定申告が必要な個人事業主も含め、誰でも利 | E3 | 低 | 総務省・国税庁・地方税法附則第7条第1項は「確定申告の不要な給与所得者等」に限ると書く。確定申告が必要な人は使えない。違う内容 | [総務省 ふるさと納税の流れ](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html)<br>[国税庁 No.1155](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm)<br>[地方税法（e-Gov）附則第7条](https://laws.e-gov.go.jp/law/325AC0000000226) |
| 15 | 寄附先が1年間で5団体以内であれば、寄附のたびに申請書を寄附先の自治体へ提出する |  | 高 | 総務省が「5団体以内であれば、控除に必要な確定申告が不要」「ふるさと納税を行う際に…申請書を提出」と同じ内容を書いている（給与所得者等の条件は文に無いが、総務省の見出しも同じ言い方） | [総務省 制度改正（2015年4月1日）](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html)<br>[総務省 ふるさと納税の流れ](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html) |
| 16 | 申請書の提出期限は、寄附した翌年の1月10日です。 |  | 高 | 自治体の公式ページが「令和7年中の寄附は令和8年1月10日（必着）」と同じ内容を書いている。総務省ページと地方税法附則第7条第4項の1月10日は変更届出の期限 | [東広島市 ワンストップ特例制度](https://www.city.higashihiroshima.lg.jp/soshiki/sangyo/12/5/4266.html)<br>[総務省 制度改正（2015年4月1日）](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html) |
| 17 | ワンストップ特例を利用した場合、控除は所得税からの還付と翌年度の住民税の減額の二 | E4 | 低 | 総務省が「所得税からの控除は行われず、その分も含めた控除額の全額が…翌年度の住民税の減額という形で控除」と書く。所得税と住民税に分かれるのは確定申告の場合。違う内容 | [総務省 ふるさと納税の流れ](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html)<br>[総務省 税金の控除について](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html)<br>[総務省 ふるさと納税制度について p.3](https://www.soumu.go.jp/main_content/000254924.pdf) |
| 18 | なお、ワンストップ特例を申請していても、後から確定申告を行うと特例の申請は無効に |  | 高 | 国税庁が「確定申告を行う方は、ワンストップ特例の申請が無効となるため、申請をした分も含めて寄附金控除額を計算する必要」とほぼ同じ文を書き、地方税法附則第7条第6項も「なかつたものとみなす」 | [国税庁 No.1155](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm)<br>[地方税法（e-Gov）附則第7条](https://laws.e-gov.go.jp/law/325AC0000000226) |
| 19 | ふるさと納税では、多くの自治体が「子育て支援」「教育」「環境保全」「災害復興」な |  | 高 | 総務省の現況調査で、使途を選択できる団体が98.2%（1,749団体）、選べる分野に子ども・子育て、教育・人づくり、環境・衛生、災害支援・復興がある。同じ内容 | [総務省 現況調査（令和8年度）p.4・p.12](https://www.soumu.go.jp/main_content/001085011.pdf)<br>[総務省 よくわかる！ふるさと納税](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/about/) |
| 20 | 大きな災害が起きた際には、被災した自治体を応援するために返礼品を求めずに寄附する |  | どちらとも | 一次資料は「災害支援・復興」を使途に選んだ寄附の額（令和7年度 約77億円・約39万件）までで、返礼品を求めない寄附の多さは書いていない。報道やポータルサイトの災害支援の記事が集まるかに左右される | [総務省 現況調査（令和8年度）p.12](https://www.soumu.go.jp/main_content/001085011.pdf)<br>[総務省 関連資料（災害義援金等）](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/archive/) |
| 21 | また、個人向けのふるさと納税とは別に、企業が地方公共団体の地方創生事業に寄附する |  | 高 | 内閣府が「認定した地域再生計画に位置付けられた事業に…企業が寄附…法人関係税（法人住民税、法人事業税、法人税）に係る税額控除」と同じ内容を書いている（令和9年度まで延長） | [内閣府 企業版ふるさと納税の延長](https://www.chisou.go.jp/tiiki/tiikisaisei/portal/pdf/R7zeikai.pdf) |
| 22 | 返礼品だけでなく、寄附がどのように地域で活かされるかにも目を向けると、制度本来の |  | 対象外（主張として取り出されない見込み） | 意見・助言の文（「目を向けると…つながります」） | — |
| 23 | 控除上限額は、年収や家族構成、ほかの控除の有無によって人それぞれ異なります。 |  | 高 | 総務省が「実際のふるさと納税枠は、寄附される本人の収入や他の控除によって異なります」と書き、給与収入×家族構成の目安表も出している。同じ内容 | [総務省 制度改正（2015年4月1日）](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html)<br>[総務省 ふるさと納税制度とは p.2](https://www.soumu.go.jp/main_content/000816463.pdf)<br>[総務省 よくある質問 Q5](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/) |
| 24 | 上限を超えて寄附した分は控除されず、純粋な自己負担になるため、総務省のふるさと納 |  | どちらとも | 事実の部分について、総務省は「全額が控除されず、実質負担額は2,000円を超えます」と書くだけで、計算式では超えた分にも所得税と住民税基本分の控除が残る。民間サイトの「超えた分は自己負担」が集まれば高く出る。後半の助言は対象外 | [総務省 税金の控除について](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html)<br>[総務省 告示改正資料（令和8年3月24日）p.8](https://www.soumu.go.jp/main_content/001070694.pdf) |
| 25 | また、2025年10月からは、寄附に伴ってポイントを付与する仲介サイトを通じた募 |  | 高 | 総務省の報道資料（2024年6月28日）が「寄附に伴いポイント等の付与を行う者を通じた募集を禁止…【令和7年10月1日から適用】」と同じ内容を書いている | [総務省 報道資料（2024年6月28日）](https://www.soumu.go.jp/menu_news/s-news/01zeimu04_02000126.html)<br>[告示第179号（令和8年10月1日適用）第3条第1号ロ](https://www.soumu.go.jp/main_content/001065165.pdf) |
| 26 | 制度は毎年のように見直されているため、最新の情報を確認しながら上手に活用しましょ |  | 対象外（主張として取り出されない見込み） | 助言の文（「上手に活用しましょう」）。前半の「毎年のように見直されている」だけが主張として取り出された場合は、総務省の告示改正の一覧（ほぼ毎年）が集まるかに左右される | [総務省 ふるさと納税ポータル（お知らせ一覧）](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/080430_2_kojin.html) |

## 予測と実測がずれうる所

1. **1つの文から主張が複数取り出される場合**（ADR-0017）。E1 の後半（故郷や応援したい地域に貢献できる仕組み）や、E3 の前半（もう一つがワンストップ特例制度）だけが別の主張になると、その主張は高く出うる。表の予測は、仕込んだ部分を含む主張についてのもの。文10も、3割・地場産品だけの主張なら高く出る見込み。
2. **主語が省かれた文**。JEV には原文の文だけが渡る（ADR-0014）。文3「この制度は」、文7・12・16（ふるさと納税・ワンストップ特例の語が無い）は、関連の判定で資料の節が落ちると資料0件と同じ扱いになり、「高」の予測でも低く出うる。
3. **文10は測る日で結果が変わりうる**。2026年10月1日から「募集費用5割以下」の基準は告示から削られる。10月1日以降に測る場合、文10は改正前の内容になる。
4. **E1 の年は別の改正の年と重なる**。平成23年（2011年）は、住民税の寄附金控除の下限額が5,000円から2,000円に下がった改正の年でもある（群馬県のページ）。この改正を書いた資料が集まると、年の部分だけが一致して見え、E1 が予測ほど下がらない恐れがある。
5. **文24は仕込みではないが、一次資料と書き方が違う**。上限を超えた分にも所得税と住民税基本分の控除は残る。低く出ても、資料どおりの結果である。

本番で測ったら、この表の予測と実測の差、同じ記事を複数回流したときの揺れ幅を並べる（ADR-0012）。
