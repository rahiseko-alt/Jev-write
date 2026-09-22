import { SearchOptions, SearchProvider, SearchResponse, SearchResultItem } from "./types";

function createSearchResponse(query: string, results: SearchResultItem[]): SearchResponse {
  const response = Object.assign(
    {
      query,
      results,
      length: results.length,
      [Symbol.iterator]() {
        return results[Symbol.iterator]();
      },
    },
    results
  ) as SearchResponse;

  return response;
}

export class MockSearchProvider implements SearchProvider {
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const normalizedQuery = query.toLowerCase().trim();
    const maxResults = options.maxResults || 5;

    // iPhone 15 Pro announcement scenario
    if (/iphone\s*15|apple.*発表|2023年9月|48mp|20mp|24mp|10gbps|20gbps|望遠|wi-fi/i.test(normalizedQuery)) {
      const results: SearchResultItem[] = [
        {
          title: "Apple、iPhone 15 ProとiPhone 15 Pro Maxを発表 - Apple (日本)",
          url: "https://www.apple.com/jp/newsroom/2023/09/apple-unveils-iphone-15-pro-and-iphone-15-pro-max/",
          content:
            "2023年9月12日、カリフォルニア州クパティーノ、Appleは本日、iPhone 15 ProとiPhone 15 Pro Maxを発表しました。軽量で耐久性の高い航空宇宙産業レベルのチタニウムを採用。メインカメラは48MP、通常撮影のデフォルト解像度は24MP。iPhone 15 Pro Maxは5倍光学ズームの望遠カメラを搭載。USB-C端子はUSB 3に対応し最大10Gbpsでデータ転送可能。第2世代の超広帯域無線チップによって通信範囲は従来の最大3倍に拡大。Wi-Fi 6Eに対応。",
          score: 0.99,
          publishedDate: "2023-09-12",
          sourceType: "official",
        },
      ];
      return createSearchResponse(query, results);
    }

    // iPhone 17 scenario
    if (/iphone\s*17/i.test(normalizedQuery)) {
      const results: SearchResultItem[] = [
        {
          title: "iPhone 17の発売日・新機能・デザインの噂まとめ - ITmedia Mobile",
          url: "https://www.itmedia.co.jp/mobile/articles/2509/iphone17-rumors.html",
          content:
            "Appleの次期スマートフォン「iPhone 17」シリーズは、2026年秋の発表が有力視されています。2024年9月に発売されたのはiPhone 16シリーズであり、iPhone 17は未発売です。極薄モデル『iPhone 17 Air（仮称）』の登場が噂されています。",
          score: 0.98,
          publishedDate: "2025-09-16",
          sourceType: "secondary",
        },
        {
          title: "Apple Official Newsroom - iPhoneラインナップと最新情報",
          url: "https://www.apple.com/jp/newsroom/2024/09/apple-introduces-iphone-16/",
          content:
            "Appleは最新のiPhone 16を発表。A18チップとApple Intelligenceを搭載。次期モデルについては公式発表は行われておらず、製品ロードマップに関する憶測に対してコメントしていません。",
          score: 0.95,
          publishedDate: "2024-09-10",
          sourceType: "official",
        },
        {
          title: "iPhone 17 Release Date Rumors and Feature Wishlist - MacRumors",
          url: "https://www.macrumors.com/roundup/iphone-17/",
          content:
            "We expect Apple to unveil the iPhone 17 lineup in September 2026. Contrary to online claims, no iPhone 17 was released in 2024 or 2025.",
          score: 0.92,
          publishedDate: "2025-09-12",
          sourceType: "research",
        },
      ];

      return createSearchResponse(query, results.slice(0, maxResults));
    }

    // COVID-19 scenario
    if (/covid|ワクチン|vaccine/i.test(normalizedQuery)) {
      const results: SearchResultItem[] = [
        {
          title: "厚生労働省：新型コロナワクチンQ&A",
          url: "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/vaccine_qa.html",
          content:
            "mRNAワクチンがヒトのDNAに組み込まれることは科学的にありません。mRNAは短時間で分解され、遺伝情報に影響を与えることはありません。",
          score: 0.97,
          publishedDate: "2023-08-15",
          sourceType: "official",
        },
        {
          title: "WHO: COVID-19 Vaccine Facts and Safety",
          url: "https://www.who.int/emergencies/diseases/novel-coronavirus-2019/covid-19-vaccines/advice",
          content:
            "Rigorous testing has shown COVID-19 vaccines to be safe and effective. They do not alter human DNA.",
          score: 0.94,
          publishedDate: "2023-06-20",
          sourceType: "official",
        },
      ];
      return createSearchResponse(query, results.slice(0, maxResults));
    }

    // Default generic fallback result based on query words
    const defaultResults: SearchResultItem[] = [
      {
        title: `${query} に関する検証情報・公式発表`,
        url: `https://example.org/facts/${encodeURIComponent(query.slice(0, 20))}`,
        content: `「${query}」に関する一次情報および公式記録です。最新の公開データに基づく客観的な検証結果が記載されています。`,
        score: 0.85,
        publishedDate: "2025-01-01",
        sourceType: "secondary",
      },
      {
        title: `${query} - 百科事典・アーカイブ`,
        url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(query.slice(0, 20))}`,
        content: `概要：${query}に関する歴史的経緯と公式記録の要約。信頼できる外部参照文献を含む。`,
        score: 0.8,
        publishedDate: "2024-12-01",
        sourceType: "research",
      },
    ];

    return createSearchResponse(query, defaultResults.slice(0, maxResults));
  }
}
