import { FetchedPage, FetchOptions, FetchProvider } from "./types";

export class MockFetchProvider implements FetchProvider {
  /** A stand-in, and it says so, so the reader is never shown its output as a real check. */
  readonly servedByFallback = true;

  private mockPages: Record<string, Partial<FetchedPage>> = {
    "https://factcheckcenter.jp/fact-checks/iphone-17-release-date": {
      title: "「iPhone 17が2025年9月に発売された」は誤り。未発売であり、2026年秋の発売が予想されている",
      content:
        "【言説】\n「iPhone 17は2025年9月に発売された」\n【判定】\n誤り（False）\n【ファクトチェック概要】\n2025年9月時点でAppleが発表・発売したのはiPhone 16シリーズであり、iPhone 17は発表されておらず未発売です。サプライチェーン情報筋によると、iPhone 17のリリースは2026年9月が見込まれています。",
      publishedAt: "2025-09-18T10:00:00Z",
      author: "日本ファクトチェックセンター取材班",
      siteName: "日本ファクトチェックセンター (JFC)",
      statusCode: 200,
    },
    "https://techfactcheck.org/claims/iphone-17-launch": {
      title: "Fact Check: iPhone 17 was NOT released in September 2025",
      content:
        "Claim: Apple launched the iPhone 17 in September 2025.\nVerdict: False.\nDetails: Apple's current production line is focused on the iPhone 16 series. The iPhone 17 has not been announced and is not available on the market.",
      publishedAt: "2025-09-17T12:00:00Z",
      author: "TechFactCheck Team",
      siteName: "TechFactCheck",
      statusCode: 200,
    },
    "https://www.itmedia.co.jp/mobile/articles/2509/iphone17-rumors.html": {
      title: "iPhone 17の発売日・新機能・デザインの噂まとめ - ITmedia Mobile",
      content:
        "ITmedia Mobileによる最新スマートフォン速報。\n現在発売されている最新型iPhoneはiPhone 16シリーズです。iPhone 17シリーズについては、2026年秋のスペシャルイベントでの発表が有力視されています。2024年または2025年9月発売という情報は誤認です。",
      publishedAt: "2025-09-16T08:00:00Z",
      author: "ITmedia Mobile編集部",
      siteName: "ITmedia Mobile",
      statusCode: 200,
    },
    "https://www.apple.com/jp/newsroom/2023/09/apple-unveils-iphone-15-pro-and-iphone-15-pro-max/": {
      title: "Apple、iPhone 15 ProとiPhone 15 Pro Maxを発表 - Apple (日本)",
      content:
        "2023年9月12日、カリフォルニア州クパティーノ、Appleは本日、iPhone 15 ProとiPhone 15 Pro Maxを発表しました。航空宇宙産業レベルのチタニウムを採用し、A17 Proと新しいアクションボタンを搭載。メインカメラは48MPで、通常撮影では24MPをデフォルトとします。iPhone 15 Pro Maxには最大5倍の光学ズーム望遠カメラを搭載。USB-C端子はUSB 3に対応し最大10Gbpsでデータ転送可能。第2世代の超広帯域無線チップによって通信範囲は従来の最大3倍に拡大。Wi-Fi 6Eに対応。",
      publishedAt: "2023-09-12T17:00:00Z",
      author: "Apple Newsroom",
      siteName: "Apple (日本)",
      statusCode: 200,
    },
    "https://www.apple.com/jp/newsroom/2024/09/apple-introduces-iphone-16/": {
      title: "Apple、iPhone 16を発表 - Apple (日本)",
      content:
        "Appleは本日、まったく新しいA18チップ、カメラコントロール、48MP Fusionカメラを搭載したiPhone 16を発表しました。",
      publishedAt: "2024-09-10T17:00:00Z",
      author: "Apple Newsroom",
      siteName: "Apple (日本)",
      statusCode: 200,
    },
    "https://www.nintendo.co.jp/corporate/release/2025/250402.html": {
      title: "ニュースリリース : 2025年4月2日 後継機種「Nintendo Switch 2」に関するお知らせ - 任天堂",
      content:
        "任天堂株式会社は、2025年4月2日、Nintendo Switchの後継機種となる『Nintendo Switch 2』の詳細を発表いたしました。発売日は2025年6月5日（木）を予定しております。本体価格は49,980円（税込）、多言語版は69,980円（税込）。本体サイズは横幅272mm、重量約534g、7.9インチ1920×1080解像度・120Hzディスプレイを搭載。内蔵ストレージは256GB、Wi-Fi 6対応、4K・60fps映像出力対応。バッテリー容量は本体5220mAh、Joy-Con各500mAhです。グループチャットは最大12人、画面映像共有は最大4人に対応。microSDカードは最大2TB以下に対応します。",
      publishedAt: "2025-04-02T10:00:00Z",
      author: "任天堂株式会社 企業広報部",
      siteName: "任天堂ホームページ",
      statusCode: 200,
    },
    "https://openai.com/index/announcing-latest-models/": {
      title: "OpenAI Announces Latest AI Models and Roadmap - OpenAI",
      content:
        "OpenAIは次世代フロンティアモデルを発表しました。より高い推論能力と事実精度を備えています。",
      publishedAt: "2025-08-07T10:00:00Z",
      author: "OpenAI",
      siteName: "OpenAI",
      statusCode: 200,
    },
    "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/vaccine_qa.html": {
      title: "新型コロナワクチンQ&A - 厚生労働省",
      content:
        "Q: mRNAワクチンで遺伝情報（DNA）が書き換えられることはありますか？\nA: そのような事実はありません。mRNAワクチンは人のDNAに影響を与えることはなく、体内で一定期間後に分解されます。",
      publishedAt: "2023-08-15T00:00:00Z",
      author: "厚生労働省 健康局",
      siteName: "厚生労働省",
      statusCode: 200,
    },
  };

  async fetchUrl(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
    const cleanUrl = url.trim();

    // Check exact mock match
    if (this.mockPages[cleanUrl]) {
      const page = this.mockPages[cleanUrl];
      const content = page.content || "";
      return {
        url: cleanUrl,
        title: page.title || "Mock Page Title",
        content,
        text: content,
        publishedAt: page.publishedAt,
        author: page.author,
        siteName: page.siteName || "Mock Site",
        statusCode: page.statusCode || 200,
      };
    }

    // Check partial URL matches
    for (const [mockUrl, page] of Object.entries(this.mockPages)) {
      if (cleanUrl.includes("iphone") && mockUrl.includes("iphone")) {
        const content = page.content || "";
        return {
          url: cleanUrl,
          title: page.title || "iPhone 17 検証記事",
          content,
          text: content,
          publishedAt: page.publishedAt,
          author: page.author,
          siteName: page.siteName || "Mock News",
          statusCode: 200,
        };
      }
    }

    // Generic fallback for any arbitrary URL
    let hostname = "example.com";
    try {
      hostname = new URL(cleanUrl).hostname;
    } catch {}

    const defaultContent = `URL (${cleanUrl}) から取得したテキストデータです。本文の要約と事実関係が記載されています。`;
    return {
      url: cleanUrl,
      title: `${hostname} - 記事アーカイブ`,
      content: defaultContent,
      text: defaultContent,
      publishedAt: "2025-01-01T00:00:00Z",
      author: `${hostname} 記者`,
      siteName: hostname,
      statusCode: 200,
    };
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
    return this.fetchUrl(url, options);
  }
}
