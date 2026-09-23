# article-05 事実確認（llm-05-b）

- 対象: `docs/benchmark/article-05.txt`（この1ファイルのみ読んだ）
- 確認日: 2026-09-23
- 文の区切り: 本文を「。」で区切り、■で始まる見出し行を除いた。1行目「ふるさと納税のしくみをやさしく解説」は記事の表題（本文ではなく「。」もない）なので番号を付けていない。全26文。
- 信頼度: 集めた資料でその文の内容が裏付けられている確率（0〜100）。正誤判定ではない。意見・感想・助言の文は「対象外」。
- 資料: 総務省・国税庁・e-Gov法令・自治体（福井県・石川県・名古屋市・御殿場市・熊野市・佐倉市・輪島市）・内閣府を優先。民間は1件（ふるさとチョイスの災害支援ページ、件数・金額の補強用）。

| 番号 | 文（先頭40字） | 信頼度 | 理由 | 根拠URL |
|---|---|---|---|---|
| 1 | ふるさと納税は、自分が選んだ都道府県や市区町村に寄附をすると、その寄附額に応じて | 95 | 総務省・国税庁の制度説明と一致（選んだ自治体への寄附の2,000円超部分を所得税・住民税から控除） | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/about.html<br>https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm |
| 2 | 「納税」という名前がついていますが、実際には自治体への「寄附」であり、生まれ故郷 | 93 | 総務省「よくわかる」に「納税」とつくが実際は「寄附」、生まれ故郷に限らずどの自治体にもできる、と明記 | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/about/<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/ |
| 3 | この制度は2011年度（平成23年度）の税制改正で創設され、生まれ育った故郷や応 | 3 | 創設は平成20年度（2008年）の地方税法改正（平成20年4月30日）で、受入実績もH20年度からある。2011年度（平成23年度）創設は誤り | https://info.pref.fukui.lg.jp/furusatonouzei/110_subject/detail01.html<br>https://www.city.gotemba.lg.jp/gyousei/g-12/g-12-1/2245.html<br>https://www.soumu.go.jp/main_content/001084951.pdf |
| 4 | ふるさと納税の大きな特徴は、寄附額のうち2,000円を超える部分が所得税と住民税 | 94 | 総務省・国税庁とも「寄附額のうち2,000円を超える部分を所得税と住民税から控除」と説明（一定の上限あり） | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/about.html<br>https://www.nta.go.jp/taxes/shiraberu/shinkoku/tokushu/keisubetsu/furusato.htm |
| 5 | 寄附額がいくらであっても、自己負担は2,000円だけで済みます。 | 3 | 控除には上限があり、特例分の上限を超えると実質負担が2,000円を超えると総務省が明記。「いくらであっても」は誤り | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/<br>https://www.soumu.go.jp/main_content/001070694.pdf |
| 6 | 控除は、所得税の寄附金控除、住民税の基本分、住民税の特例分という三つの部分で構成 | 95 | 総務省の計算式が所得税・住民税基本分・住民税特例分の3区分で、特例分は住民税所得割額の2割が上限 | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html<br>https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm<br>https://www.soumu.go.jp/main_content/000125481.pdf |
| 7 | 控除の対象となるのは、その年の1月1日から12月31日までに行った寄附です。 | 90 | 総務省FAQに税の軽減は「1月〜12月」の年単位、当年1〜12月の寄附を翌年に申告とある | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/<br>https://www.city.gotemba.lg.jp/gyousei/g-12/g-12-1/2245.html |
| 8 | 多くの自治体は、寄附へのお礼として地域の特産品などを「返礼品」として送っています | 85 | 総務省現況調査で返礼品調達費は令和7年度3,528億円（受入額の26.5%）。自治体数そのものの統計は未確認 | https://www.soumu.go.jp/main_content/001084951.pdf<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/ |
| 9 | ただし、返礼品競争の過熱を受けて、2019年6月からは総務大臣が自治体を指定する | 95 | 総務省資料に「返礼品競争の過熱」を受け令和元年6月1日施行で総務大臣が対象団体を指定する制度を創設とある | https://www.soumu.go.jp/main_content/001070694.pdf<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20190401.html |
| 10 | 指定を受けるには、返礼品の調達費用を寄附額の3割以下とすること、返礼品を地場産品 | 85 | 返礼割合3割以下・地場産品（地方税法）と募集費用5割以下（告示179号第2条第2号）は現行基準。ただし令和8年10月1日から5割基準は削除され寄附金活用可能額の基準に移行予定 | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/file/report20190401_03.pdf<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20190401.html<br>https://www.soumu.go.jp/main_content/001070694.pdf |
| 11 | なお、自分が住んでいる自治体に寄附をしても控除は受けられますが、その自治体から返 | 95 | 告示179号が区域内住所者への返礼品提供を禁止。名古屋市も市内在住者は返礼品不可・税控除は可と明記 | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/file/report20190401_03.pdf<br>https://www.city.nagoya.jp/shisei/furusatonozei/1003652/1003653.html |
| 12 | 控除を受けるための手続きは、大きく分けて二つあります。 | 92 | 総務省の流れの説明はワンストップ特例を申請するか（確定申告するか）で2通りに分かれる | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html<br>https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm |
| 13 | 一つは確定申告で、寄附先の自治体から送られてくる受領証明書などをもとに申告します | 93 | 確定申告には寄附先自治体が発行する受領証明書（寄附の証明書・受領書）が必要と総務省が説明 | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/080430_3_kojin.html |
| 14 | もう一つが「ワンストップ特例制度」で、確定申告が必要な個人事業主も含め、誰でも利 | 3 | ワンストップ特例は確定申告の不要な給与所得者等に限られる（地方税法附則7条・国税庁・総務省）。確定申告が必要な個人事業主は使えず「誰でも」は誤り | https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html<br>https://laws.e-gov.go.jp/law/325AC0000000226 |
| 15 | 寄附先が1年間で5団体以内であれば、寄附のたびに申請書を寄附先の自治体へ提出する | 85 | 5団体以内・寄附の際に各寄附先へ申請書提出で確定申告不要、は総務省・国税庁と一致。ただし確定申告不要な給与所得者等という条件が抜けている | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html<br>https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm<br>https://www.city.kumano.lg.jp/administration/?content=71 |
| 16 | 申請書の提出期限は、寄附した翌年の1月10日です。 | 90 | 自治体FAQが「寄附日の翌年の1月10日必着」と明記。総務省も変更届の期限を翌年1月10日としている | https://www.city.kumano.lg.jp/administration/?content=71<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html<br>https://www.city.sakura.lg.jp/soshiki/shiminzeika/236/kojin/17845.html |
| 17 | ワンストップ特例を利用した場合、控除は所得税からの還付と翌年度の住民税の減額の二 | 3 | ワンストップ特例では所得税からの控除（還付）は行われず、その分も含め全額が翌年度住民税から控除されると総務省・国税庁が明記 | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/procedure.html<br>https://www.nta.go.jp/taxes/shiraberu/shinkoku/tokushu/keisubetsu/furusato.htm<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/ |
| 18 | なお、ワンストップ特例を申請していても、後から確定申告を行うと特例の申請は無効に | 96 | 東京国税局・国税庁が、確定申告をするとワンストップ特例の申請は無効となり申請分も含めて申告が必要と明記 | https://www.nta.go.jp/about/organization/tokyo/topics/furusato_nozei_onestop/index.htm<br>https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1155.htm<br>https://www.city.sakura.lg.jp/soshiki/shiminzeika/236/kojin/17845.html |
| 19 | ふるさと納税では、多くの自治体が「子育て支援」「教育」「環境保全」「災害復興」な | 93 | 総務省現況調査で使途を選択できる団体が98.2%。分野に子ども・子育て、教育、環境・衛生、災害支援・復興などがある | https://www.soumu.go.jp/main_content/001084951.pdf<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/about/ |
| 20 | 大きな災害が起きた際には、被災した自治体を応援するために返礼品を求めずに寄附する | 82 | 石川県・輪島市が返礼品なしの災害支援寄附を受付。ふるさとチョイス経由の能登町分だけでお礼の品なし寄付が約9,080万円・2,505件。「少なくない」の全国規模は未確認 | https://www.pref.ishikawa.lg.jp/kenmin/furusatonouzei/r6notohantouzisinkifu.html<br>https://www.city.wajima.ishikawa.jp/article/2024010700079/<br>https://www.furusato-tax.jp/saigai/detail/1617 |
| 21 | また、個人向けのふるさと納税とは別に、企業が地方公共団体の地方創生事業に寄附する | 92 | 内閣府が、国認定の地域再生計画の地方創生事業への企業の寄附について法人関係税を税額控除する制度と説明 | https://www.cao.go.jp/press/new_wave/20240822.html |
| 22 | 返礼品だけでなく、寄附がどのように地域で活かされるかにも目を向けると、制度本来の | 対象外 | 意見・助言 | — |
| 23 | 控除上限額は、年収や家族構成、ほかの控除の有無によって人それぞれ異なります。 | 90 | 総務省が控除上限（ふるさと納税枠）は本人の収入や他の控除で異なるとし、家族構成を前提にした例（扶養家族が配偶者のみ）を示している | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/faq/<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/about.html |
| 24 | 上限を超えて寄附した分は控除されず、純粋な自己負担になるため、総務省のふるさと納 | 60 | 上限超過で負担が2,000円を超えるのは裏付けあり。ただし超過分も所得税・住民税基本分の控除は残る（総務省）ので「控除されず、純粋な自己負担」は言い過ぎ | https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/mechanism/deduction.html<br>https://www.soumu.go.jp/main_content/001070694.pdf<br>https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/topics/20150401.html |
| 25 | また、2025年10月からは、寄附に伴ってポイントを付与する仲介サイトを通じた募 | 95 | 総務省報道資料（令和6年6月28日）でポイント等を付与する者を通じた募集の禁止を令和7年10月1日から適用と公表 | https://www.soumu.go.jp/menu_news/s-news/01zeimu04_02000126.html |
| 26 | 制度は毎年のように見直されているため、最新の情報を確認しながら上手に活用しましょ | 対象外 | 助言（前提の「毎年のように見直し」は2019・2024・2025・2026年の改正と整合） | — |

## まとめ

- 信頼度80以下: 3（3）、5（3）、14（3）、17（3）、24（60）
- 対象外: 2件（22、26）
- 注記: 10は今日時点では正しいが、2026年10月1日から募集費用の5割基準がなくなり「寄附金活用可能額（令和8年指定は52.5%以上）」の基準に替わる（総務省 令和8年3月24日資料）。

## かかった時間の目安

- 約14分（2026-09-23 17:12〜17:26頃。資料集め約10分、表の作成約4分）
