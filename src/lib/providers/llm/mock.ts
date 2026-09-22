import { Claim, Importance } from "@/types";
import { LLMProvider, RewriteInput, SurgicalFixInput } from "./types";

export class MockLLMProvider implements LLMProvider {
  async extractClaims(text: string): Promise<Claim[]> {
    const claims: Claim[] = [];
    // Split by sentence terminators (Japanese and Western)
    const sentences = text
      .split(/(?<=[。！？\.\!\?\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 5);

    let counter = 1;
    let contextSubject: string | undefined;
    let contextEntities: string[] = [];

    for (const sentence of sentences) {
      // Check if the sentence has factual indicators: numbers, dates, named entities, or factual assertions
      const hasDate = /(?:\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日|20\d\d|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?)/i.test(sentence);
      const hasNumber = /(?:\d+[\d,]*\s*(?:万|億|兆|%|円|ドル|人|個|GB|MB|kg|km|倍|MP|Gbps)?|\b\d+\b)/i.test(sentence);
      const hasKnownEntity = /(?:iPhone\s*\d+|Apple|アップル|Google|Microsoft|Sony|Amazon|OpenAI|GPT-\d+|COVID|日本|米国|東京)/i.test(sentence);
      const isFactualAssertion = /(?:発売された|発売されました|発表された|発表しました|設立された|就任した|記録した|超えた|減少した|向上した|改善します|である|であった|です|was released|announced|founded)/i.test(sentence);

      if (hasDate || hasNumber || hasKnownEntity || isFactualAssertion) {
        // Extract numbers
        const numberMatches = sentence.match(/(?:\d+[\d,]*(?:万|億|兆|%|円|ドル|人|個|Gbps|Mbps|kbps|GB|MB|kg|km|倍|MP)?|\b\d+\b)/gi) || [];
        // Extract dates
        const dateMatches = sentence.match(/(?:\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日)/g) || [];
        // Extract entities
        const entityMatches = sentence.match(/(?:iPhone\s*\d+(?:\s*Pro|\s*Max)?|Apple|アップル|Google|Microsoft|Sony|Amazon|OpenAI|GPT-\d+|COVID-19)/gi) || [];

        let subject: string | undefined;
        let predicate: string | undefined;

        if (/iPhone\s*\d+/i.test(sentence)) {
          const match = sentence.match(/iPhone\s*\d+(?:\s*Pro(?:\s*Max)?)?/i);
          subject = match ? match[0] : "iPhone";
          predicate = sentence.includes("発売") ? "発売日" : sentence.includes("価格") ? "価格" : "仕様";
          contextSubject = subject;
        } else if (/GPT-\d+/i.test(sentence)) {
          subject = "GPT-5";
          predicate = "発表";
          contextSubject = subject;
        }

        if (entityMatches.length > 0) {
          contextEntities = Array.from(new Set([...contextEntities, ...entityMatches]));
        }

        // Inherit context subject/entities if not present in this sentence
        const effectiveSubject = subject || contextSubject;
        const effectiveEntities = entityMatches.length > 0 ? Array.from(new Set(entityMatches)) : [...contextEntities];

        let importance: Importance = "normal";
        if (sentence.includes("iPhone 17") || sentence.includes("死亡") || sentence.includes("重大")) {
          importance = "high";
        } else if (hasDate && hasNumber) {
          importance = "high";
        }

        // Clean up normalized claim text
        let normalizedText = sentence.replace(/^[、,。\s]+|[、,。\s]+$/g, "");

        claims.push({
          id: `claim-${counter++}`,
          originalText: sentence,
          normalizedText,
          subject: effectiveSubject,
          predicate,
          numbers: Array.from(new Set(numberMatches)),
          dates: Array.from(new Set(dateMatches)),
          entities: effectiveEntities,
          importance,
          factCheckRequired: true,
        });
      }
    }

    // Fallback if no specific factual patterns triggered: treat first non-empty sentence as a claim
    if (claims.length === 0 && sentences.length > 0) {
      claims.push({
        id: `claim-1`,
        originalText: sentences[0],
        normalizedText: sentences[0],
        importance: "normal",
        factCheckRequired: true,
      });
    }

    return claims;
  }

  async generateSearchQueries(claim: Claim): Promise<string[]> {
    const queries: string[] = [];

    // Specific domain heuristics for common mock scenarios
    if (/iPhone\s*17/i.test(claim.normalizedText)) {
      if (claim.dates?.some((d) => d.includes("2024"))) {
        queries.push("iPhone 17 2024年9月 発売");
      }
      queries.push("iPhone 17 発売日 Apple 公式");
      queries.push("iPhone 17 release date rumor");
      return queries;
    }

    // Heuristics based on claim metadata
    if (claim.entities && claim.entities.length > 0) {
      const entityStr = claim.entities.join(" ");
      if (claim.dates && claim.dates.length > 0) {
        queries.push(`${entityStr} ${claim.dates.join(" ")}`);
      }
      if (claim.numbers && claim.numbers.length > 0) {
        queries.push(`${entityStr} ${claim.numbers.join(" ")}`);
      }
      if (claim.predicate) {
        queries.push(`${entityStr} ${claim.predicate}`);
      }
    }

    // Always include normalized text trimmed to reasonable query length
    const cleanQuery = claim.normalizedText
      .replace(/[、。！？\(\)（）「」『』]/g, " ")
      .trim()
      .slice(0, 80);
    queries.push(cleanQuery);

    return Array.from(new Set(queries)).slice(0, 4);
  }

  async rewrite(input: RewriteInput): Promise<string> {
    let revised = input.originalText;

    // 1. Apply fact ledger corrections
    for (const correction of input.plan.corrections) {
      if (correction.verdict === "CONTRADICTED" && correction.correctedClaim) {
        // Look for exact originalClaim
        if (revised.includes(correction.originalClaim)) {
          revised = revised.replace(correction.originalClaim, correction.correctedClaim);
        } else {
          // If originalClaim was slightly different or partitioned, try matching key parts
          const parts = correction.originalClaim.split(/[、,。\s]+/).filter((p) => p.length >= 4);
          let replaced = false;
          for (const part of parts) {
            if (revised.includes(part)) {
              const sentenceRegex = new RegExp(`[^。！？\n]*${escapeRegExp(part)}[^。！？\n]*[。！？\n]?`);
              const match = revised.match(sentenceRegex);
              if (match) {
                revised = revised.replace(match[0], correction.correctedClaim + "。");
                replaced = true;
                break;
              }
            }
          }

          // Direct pattern replacement for iPhone 17 2024 or 2025 release claim
          if (!replaced && /iPhone\s*17.*202[45]年.*発売/i.test(revised)) {
            revised = revised.replace(
              /iPhone\s*17[^\n。！？]*202[45]年[^\n。！？]*発売[^\n。！？]*[。！？]?/i,
              correction.correctedClaim + "。"
            );
          }
        }
      }
    }

    // 2. Apply style repairs
    for (const issue of input.plan.styleIssues) {
      if (issue.targetText && revised.includes(issue.targetText)) {
        if (issue.ruleId === "AI001" || issue.ruleId === "AI003" || issue.ruleId === "AI008" || issue.ruleId === "AI012") {
          revised = revised.replace(issue.targetText, "");
        } else if (issue.ruleId === "AI002") {
          // 単なる〜ではない / 常套句の対比
          if (issue.targetText === "その一方で、" || issue.targetText.includes("その一方で")) {
            revised = revised.replace(issue.targetText, "また、");
          } else {
            revised = revised.replace(issue.targetText, "");
          }
        } else if (issue.ruleId === "AI007") {
          // 機械的な接続語
          revised = revised.replace(issue.targetText, "");
        } else {
          revised = revised.replace(issue.targetText, "");
        }
      }
    }

    // Clean up any remaining typical style tell patterns if still present
    revised = revised
      .replace(/今後の動向からも目が離せません[。！？]?/g, "")
      .replace(/今後の動向から目が離せません[。！？]?/g, "")
      .replace(/近年、モバイルテクノロジーの急速な進化は目覚ましく、私たちの生活様式を一変させています[。！？]?/g, "")
      .replace(/現代社会においてスマートフォンは不可欠なツールであり、その進化の波は留まるところを知りません[。！？]?/g, "")
      .replace(/([。！？])\1+/g, "$1")
      .replace(/^[、,。\s]+/, "")
      .replace(/[、,]\s*[。！？]/g, "。")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return revised;
  }

  async surgicalFix(input: SurgicalFixInput): Promise<string> {
    if (input.targetSegment && input.text.includes(input.targetSegment)) {
      return input.text.replace(input.targetSegment, input.expectedFact);
    }
    return input.text;
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
