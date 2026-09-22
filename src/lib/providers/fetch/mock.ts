import { FetchedPage, FetchOptions, FetchProvider } from "./types";

export class MockFetchProvider implements FetchProvider {
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
    "https://www.apple.com/jp/newsroom/2024/09/apple-introduces-iphone-16/": {
      title: "Apple、iPhone 16を発表 - Apple (日本)",
      content:
        "Appleは本日、まったく新しいA18チップ、カメラコントロール、48MP Fusionカメラを搭載したiPhone 16を発表しました。",
      publishedAt: "2024-09-10T17:00:00Z",
      author: "Apple Newsroom",
      siteName: "Apple (日本)",
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
