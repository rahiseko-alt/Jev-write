import {
  FactCheckSearchResult,
  GoogleFactCheckClaim,
  GoogleFactCheckClient,
} from "./types";

export class MockGoogleFactCheckClient implements GoogleFactCheckClient {
  private mockDatabase: GoogleFactCheckClaim[] = [
    {
      text: "iPhone 17は2024年9月に発売された",
      claim: "iPhone 17は2024年9月に発売された",
      claimant: "SNSユーザー / まとめサイト",
      claimDate: "2024-09-15T00:00:00Z",
      claimReview: [
        {
          publisher: {
            name: "日本ファクトチェックセンター (JFC)",
            site: "factcheckcenter.jp",
          },
          url: "https://factcheckcenter.jp/fact-checks/iphone-17-release-date",
          title: "「iPhone 17が2024年9月に発売された」は誤り。2024年9月に発売されたのはiPhone 16",
          reviewDate: "2024-09-18T10:00:00Z",
          textualRating: "誤り / False",
          languageCode: "ja",
        },
      ],
    },
    {
      text: "iPhone 17は2025年9月に発売された",
      claim: "iPhone 17は2025年9月に発売された",
      claimant: "SNSユーザー / まとめサイト",
      claimDate: "2025-09-15T00:00:00Z",
      claimReview: [
        {
          publisher: {
            name: "日本ファクトチェックセンター (JFC)",
            site: "factcheckcenter.jp",
          },
          url: "https://factcheckcenter.jp/fact-checks/iphone-17-release-date",
          title: "「iPhone 17が2025年9月に発売された」は誤り。未発売であり、2026年秋の発売が予想されている",
          reviewDate: "2025-09-18T10:00:00Z",
          textualRating: "誤り / False",
          languageCode: "ja",
        },
      ],
    },
    {
      text: "COVID-19ワクチンを接種するとDNAが改変される",
      claim: "COVID-19ワクチンを接種するとDNAが改変される",
      claimant: "ソーシャルメディア投稿",
      claimDate: "2021-03-01T00:00:00Z",
      claimReview: [
        {
          publisher: {
            name: "AFP Fact Check",
            site: "factcheck.afp.com",
          },
          url: "https://factcheck.afp.com/covid-vaccine-dna-alteration-false",
          title: "COVID-19 mRNA vaccines do not alter human DNA",
          reviewDate: "2021-03-10T00:00:00Z",
          textualRating: "False / 誤り",
          languageCode: "ja",
        },
      ],
    },
    {
      text: "東京オリンピックは1960年に第1回が開催された",
      claim: "東京オリンピックは1960年に第1回が開催された",
      claimant: "ブログ記事",
      claimDate: "2023-01-10T00:00:00Z",
      claimReview: [
        {
          publisher: {
            name: "FactCheck History",
            site: "historyfactcheck.org",
          },
          url: "https://historyfactcheck.org/tokyo-1964",
          title: "アジア初となる東京オリンピックの開催年は1964年（昭和39年）である",
          reviewDate: "2023-01-15T00:00:00Z",
          textualRating: "誤り / False",
          languageCode: "ja",
        },
      ],
    },
  ];

  async searchClaims(query: string, languageCode?: string): Promise<FactCheckSearchResult> {
    const claims = await this.search(query, languageCode);
    return { claims };
  }

  async search(query: string, languageCode?: string): Promise<GoogleFactCheckClaim[]> {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) {
      return [];
    }

    // Heuristic: If query specifically mentions iPhone 17
    if (/iphone\s*17/i.test(normalizedQuery)) {
      if (normalizedQuery.includes("2024")) {
        return [this.mockDatabase[0]];
      }
      return [this.mockDatabase[1]];
    }

    // Filter matching claims from database
    const matched = this.mockDatabase.filter((item) => {
      const textMatch =
        item.text.toLowerCase().includes(normalizedQuery) ||
        normalizedQuery.includes(item.text.toLowerCase());
      if (textMatch) return true;

      const keywords = normalizedQuery.match(/[a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]{2,}/g) || [];
      const matchCount = keywords.filter((kw) => item.text.toLowerCase().includes(kw)).length;
      return matchCount >= 2;
    });

    return matched;
  }
}
