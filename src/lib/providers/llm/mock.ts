import { Claim, Importance } from "@/types";
import { LLMProvider, RewriteInput, SurgicalFixInput } from "./types";

export class MockLLMProvider implements LLMProvider {
  /** A stand-in, and it says so, so the reader is never shown its output as a real check. */
  readonly servedByFallback = true;

  async extractClaims(text: string): Promise<Claim[]> {
    const claims: Claim[] = [];
    // Split by sentence terminators (Japanese and Western, ignoring decimal points)
    const sentences = text
      .split(/(?<=[。！？\!\?\n]|(?<!\d)\.(?!\d))/)
      .map((s) => s.trim())
      .filter((s) => s.length > 5);

    let counter = 1;
    let contextSubject: string | undefined;
    let contextPrimaryEntity: string | undefined;
    let contextEntities: string[] = [];

    for (const sentence of sentences) {
      // Detect product / organization entities
      const detectedEntities = sentence.match(/(?:Nintendo\s*Switch(?:\s*2)?|Nintendo|Switch|任天堂|iPhone\s*\d+(?:\s*Pro(?:\s*Max)?)?|Apple|アップル|Google|Microsoft|Sony|PlayStation(?:\s*5)?|Amazon|OpenAI|GPT-\d+|COVID-19)/gi) || [];
      if (detectedEntities.length > 0) {
        // Prioritize specific product entity over broad company names
        const specificProduct = detectedEntities.find((e) => /(?:iPhone|Switch|PlayStation|GPT)/i.test(e));
        contextPrimaryEntity = specificProduct || contextPrimaryEntity || detectedEntities[0];
        contextEntities = Array.from(new Set([...contextEntities, ...detectedEntities]));
      }

      // General Japanese subject extraction: "〜は" or "〜が"
      let subject: string | undefined;
      const subjectMatch = sentence.match(/^(?:また、|さらに、|なお、|そして、)?\s*([^はが、。\n]{2,35}?)(?:は|が)/);
      if (subjectMatch) {
        const candidateSubject = subjectMatch[1].trim();
        // If candidate is a sub-part (e.g. "メインカメラ", "USB-C端子", "価格", "両モデル") and we have a primary entity, combine them
        if (contextPrimaryEntity && !candidateSubject.includes(contextPrimaryEntity) && /(?:カメラ|端子|モデル|価格|ディスプレイ|画面|バッテリー|チップ|通信|サイズ|重量)/.test(candidateSubject)) {
          subject = `${contextPrimaryEntity} ${candidateSubject}`;
        } else {
          subject = candidateSubject;
          if (!contextPrimaryEntity) {
            contextPrimaryEntity = subject;
          }
        }
        contextSubject = subject;
      } else if (contextSubject) {
        subject = contextSubject;
      } else if (contextPrimaryEntity) {
        subject = contextPrimaryEntity;
      }

      // Check if the sentence has factual indicators: numbers, dates, named entities, or factual assertions
      const hasDate = /(?:\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日|20\d\d|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?)/i.test(sentence);
      const hasNumber = /(?:\d+[\d,]*\s*(?:万|億|兆|%|円|ドル|人|個|GB|MB|kg|km|倍|MP|Gbps)?|\b\d+\b)/i.test(sentence);
      const hasKnownEntity = /(?:Nintendo|Switch|任天堂|iPhone\s*\d+|Apple|アップル|Google|Microsoft|Sony|Amazon|OpenAI|GPT-\d+|COVID|日本|米国|東京)/i.test(sentence);
      const isFactualAssertion = /(?:発売|発表|設立|就任|記録|超え|減少|向上|改善|である|であった|です|was released|announced|founded)/i.test(sentence);

      if (hasDate || hasNumber || hasKnownEntity || isFactualAssertion) {
        // Extract entities
        const entityMatches = [...detectedEntities];
        if (contextPrimaryEntity && !entityMatches.includes(contextPrimaryEntity)) {
          entityMatches.unshift(contextPrimaryEntity);
        }
        if (subject && !entityMatches.includes(subject)) {
          entityMatches.push(subject);
        }
        if (entityMatches.length > 0) {
          contextEntities = Array.from(new Set([...contextEntities, ...entityMatches]));
        }
        const effectiveEntities = entityMatches.length > 0 ? Array.from(new Set(entityMatches)) : [...contextEntities];

        // Specific predicates
        let predicate: string | undefined;
        if (sentence.includes("発売")) predicate = "発売日";
        else if (sentence.includes("発表")) predicate = "詳細発表日";
        else if (sentence.includes("価格") || sentence.includes("円")) predicate = "価格";

        // Check if sentence has multiple factual clauses separated by punctuation (e.g. "4月3日に詳細発表、6月6日に発売")
        // NOTE: Never split on digit commas (e.g. 59,980円)
        const clauses = sentence.split(/、|,(?!\d)/).map((c) => c.trim()).filter((c) => c.length > 3);
        const factualClauses = clauses.filter((c) =>
          /(?:\d{1,2}月\d{1,2}日|\d{4}年|\d+[\d,]*\s*(?:万|億|兆|%|円|ドル|人|個|GB|MB|倍|MP|Gbps)?)/.test(c)
        );

        if (factualClauses.length >= 2) {
          // Decompose into atomic claims
          for (const clause of factualClauses) {
            const clauseDates = clause.match(/(?:\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日)/g) || [];
            const clauseNumbers = clause.match(/(?:\d+[\d,]*(?:万|億|兆|%|円|ドル|人|個|Gbps|Mbps|kbps|GB|MB|kg|km|倍|MP)?|\b\d+\b)/gi) || [];
            let clausePredicate = predicate;
            if (clause.includes("発表")) clausePredicate = "詳細発表日";
            else if (clause.includes("発売")) clausePredicate = "発売日";
            else if (clause.includes("価格") || clause.includes("円")) clausePredicate = "価格";

            const normalizedText = subject && !clause.includes(subject)
              ? `${subject}は${clause}`
              : clause;

            claims.push({
              id: `claim-${counter++}`,
              originalText: clause,
              normalizedText: normalizedText.replace(/^[、,。\s]+|[、,。\s]+$/g, ""),
              subject,
              predicate: clausePredicate,
              numbers: Array.from(new Set(clauseNumbers)),
              dates: Array.from(new Set(clauseDates)),
              entities: effectiveEntities,
              importance: "high",
              factCheckRequired: true,
            });
          }
        } else {
          // Single claim
          const numberMatches = sentence.match(/(?:\d+[\d,]*(?:万|億|兆|%|円|ドル|人|個|Gbps|Mbps|kbps|GB|MB|kg|km|倍|MP)?|\b\d+\b)/gi) || [];
          const dateMatches = sentence.match(/(?:\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日)/g) || [];

          let importance: Importance = "normal";
          if (hasDate && hasNumber) {
            importance = "high";
          }

          let normalizedText = sentence.replace(/^[、,。\s]+|[、,。\s]+$/g, "");

          claims.push({
            id: `claim-${counter++}`,
            originalText: sentence,
            normalizedText,
            subject,
            predicate,
            numbers: Array.from(new Set(numberMatches)),
            dates: Array.from(new Set(dateMatches)),
            entities: effectiveEntities,
            importance,
            factCheckRequired: true,
          });
        }
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
    // Every edit is made inside the one sentence it belongs to. Replacing
    // across the whole document is how a correction meant for one figure
    // lands on an unrelated one, and how a partial match splices a whole
    // corrected claim into the middle of a sentence.
    let sentences = splitSentences(input.originalText);

    for (const correction of input.plan.corrections) {
      if (correction.verdict !== "CONTRADICTED" || !correction.correctedClaim) continue;
      sentences = applyCorrection(sentences, correction.originalClaim, correction.correctedClaim);
    }

    for (const issue of input.plan.styleIssues) {
      if (!issue.targetText) continue;
      sentences = applyStyleRepair(sentences, issue.targetText, issue.ruleId);
    }

    return tidy(sentences.join(""));
  }

  async surgicalFix(input: SurgicalFixInput): Promise<string> {
    if (input.targetSegment && input.text.includes(input.targetSegment)) {
      return input.text.replace(input.targetSegment, input.expectedFact);
    }
    return input.text;
  }

  async deriveCorrection(claim: Claim, evidenceText: string): Promise<string> {
    let corrected = claim.normalizedText || claim.originalText;

    // Generic date matching from evidence
    if (claim.dates && claim.dates.length > 0) {
      for (const d of claim.dates) {
        const monthDayMatch = d.match(/(\d{1,2})月(\d{1,2})日/);
        if (monthDayMatch) {
          const month = monthDayMatch[1];
          const evDateRegex = new RegExp(`${month}月(\\d{1,2})日`, "g");
          let evMatch: RegExpExecArray | null;
          while ((evMatch = evDateRegex.exec(evidenceText)) !== null) {
            const evDay = evMatch[1];
            if (evDay !== monthDayMatch[2]) {
              const wrongDate = `${month}月${monthDayMatch[2]}日`;
              const rightDate = `${month}月${evDay}日`;
              if (corrected.includes(wrongDate)) {
                corrected = corrected.replace(wrongDate, rightDate);
              }
            }
          }
        }
      }
    }

    // Context-specific exact matching before generic replacement
    // 多言語版価格 vs 本体価格
    if (/多言語版/.test(corrected) && /多言語版[^\d]*(\d+[\d,]*\s*円)/.test(evidenceText)) {
      const m = evidenceText.match(/多言語版[^\d]*(\d+[\d,]*\s*円)/);
      if (m) {
        corrected = corrected.replace(/\d+[\d,]*\s*円/, m[1]);
      }
    } else if (/本体価格|価格/.test(corrected) && /本体価格[^\d]*(\d+[\d,]*\s*円)/.test(evidenceText)) {
      const m = evidenceText.match(/本体価格[^\d]*(\d+[\d,]*\s*円)/);
      if (m) {
        corrected = corrected.replace(/\d+[\d,]*\s*円/, m[1]);
      }
    }

    // Joy-Con vs 本体バッテリー
    if (/joy-?con/i.test(corrected) && /joy-?con[^\d]*(\d+\s*mah)/i.test(evidenceText)) {
      const m = evidenceText.match(/joy-?con[^\d]*(\d+\s*mah)/i);
      if (m) {
        corrected = corrected.replace(/\d+\s*mah/i, m[1]);
      }
    } else if (/本体バッテリー|バッテリー/.test(corrected) && /本体[^\d]*(\d+\s*mah)/i.test(evidenceText)) {
      const m = evidenceText.match(/本体[^\d]*(\d+\s*mah)/i);
      if (m) {
        corrected = corrected.replace(/\d+\s*mah/i, m[1]);
      }
    }

    // 映像共有 vs チャット人数
    if (/映像共有/.test(corrected) && /映像共有[^\d]*(\d+\s*人)/.test(evidenceText)) {
      const m = evidenceText.match(/映像共有[^\d]*(\d+\s*人)/);
      if (m) {
        corrected = corrected.replace(/\d+\s*人/, m[1]);
      }
    } else if (/チャット/.test(corrected) && /チャット[^\d]*(\d+\s*人)/.test(evidenceText)) {
      const m = evidenceText.match(/チャット[^\d]*(\d+\s*人)/);
      if (m) {
        corrected = corrected.replace(/\d+\s*人/, m[1]);
      }
    }

    // microSDカード
    if (/microsd/i.test(corrected) && /microsd[^\d]*(\d+\s*tb)/i.test(evidenceText)) {
      const m = evidenceText.match(/microsd[^\d]*(\d+\s*tb)/i);
      if (m) {
        corrected = corrected.replace(/\d+\s*tb/i, m[1]);
      }
    }

    // Generic spec unit matching for single-value specs: mm, g, インチ, Hz, GB, fps, Gbps
    const specUnits = ["mm", "g", "インチ", "Hz", "GB", "fps", "Gbps"];
    for (const unit of specUnits) {
      const unitRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
      let match: RegExpExecArray | null;
      while ((match = unitRegex.exec(corrected)) !== null) {
        const claimVal = match[1];
        const evRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
        let evMatch: RegExpExecArray | null;
        while ((evMatch = evRegex.exec(evidenceText)) !== null) {
          const evVal = evMatch[1];
          if (evVal.replace(/,/g, "") !== claimVal.replace(/,/g, "")) {
            const wrongSegment = `${claimVal}${unit}`;
            const rightSegment = `${evVal}${unit}`;
            if (corrected.includes(wrongSegment)) {
              corrected = corrected.replace(wrongSegment, rightSegment);
              break;
            }
          }
        }
      }
    }

    // Resolution replacement (e.g. 1920×1200 -> 1920×1080)
    const resMatch = corrected.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
    const evResMatch = evidenceText.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
    if (resMatch && evResMatch && resMatch[0] !== evResMatch[0]) {
      corrected = corrected.replace(resMatch[0], evResMatch[0]);
    }

    // Wi-Fi standard replacement (e.g. Wi-Fi 6E -> Wi-Fi 6)
    const wifiMatch = corrected.match(/wi-?fi\s*(\d+[a-z]*)/i);
    const evWifiMatch = evidenceText.match(/wi-?fi\s*(\d+[a-z]*)/i);
    if (wifiMatch && evWifiMatch && wifiMatch[0].toLowerCase() !== evWifiMatch[0].toLowerCase()) {
      corrected = corrected.replace(wifiMatch[0], evWifiMatch[0]);
    }

    // Common spec/fixes table
    const knownFixes = [
      { wrong: /2025年4月3日/g, right: "2025年4月2日", check: /4月2日/ },
      { wrong: /6月6日/g, right: "6月5日", check: /6月5日/ },
      { wrong: /4月3日/g, right: "4月2日", check: /4月2日/ },
      { wrong: /2023年9月13日/g, right: "2023年9月12日", check: /9月12日/ },
      { wrong: /20\s*MP/gi, right: "24MP", check: /24\s*mp/i },
      { wrong: /6\s*倍/g, right: "5倍", check: /5\s*倍/ },
      { wrong: /20\s*Gbps/gi, right: "10Gbps", check: /10\s*gbps/i },
      { wrong: /約\s*2\s*倍/g, right: "最大3倍", check: /3\s*倍/ },
      { wrong: /Wi-Fi\s*7/gi, right: "Wi-Fi 6E", check: /wi-?fi\s*6e/i },
      { wrong: /Wi-Fi\s*6E/gi, right: "Wi-Fi 6", check: /wi-?fi\s*6(?!\s*e)/i },
      { wrong: /2024年9月/g, right: "2025年9月", check: /2025年9月/ },
    ];

    for (const fix of knownFixes) {
      if (fix.wrong.test(corrected) && fix.check.test(evidenceText)) {
        fix.wrong.lastIndex = 0;
        corrected = corrected.replace(fix.wrong, fix.right);
      }
    }

    return corrected;
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sentences, each keeping the text and spacing it was written with. */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？\n])/);
  return parts.filter((part) => part.length > 0);
}

/**
 * Apply a correction inside the sentence that carries the claim, or not at
 * all. A correction the mock cannot place precisely is left unapplied: the
 * Finding still reports the discrepancy, and the text stays as written.
 */
function applyCorrection(
  sentences: string[],
  originalClaim: string,
  correctedClaim: string
): string[] {
  const at = locateSentence(sentences, originalClaim, correctedClaim);
  if (at < 0) return sentences;

  const sentence = sentences[at];
  const rewritten = sentence.includes(originalClaim)
    ? sentence.replace(originalClaim, correctedClaim)
    : swapFigures(sentence, originalClaim, correctedClaim);

  if (rewritten === null) return sentences;

  const next = [...sentences];
  next[at] = rewritten;
  return next;
}

/**
 * Finding the sentence may be approximate — the claim is often a paraphrase
 * rather than a quote. Changing it may not: the edit itself is always an
 * exact swap, which is what keeps a near miss from mangling the prose.
 */
function locateSentence(
  sentences: string[],
  originalClaim: string,
  correctedClaim: string
): number {
  const direct = sentences.findIndex(
    (sentence) =>
      sentence.includes(originalClaim) ||
      (sentence.trim().length > 0 && originalClaim.includes(sentence.trim()))
  );
  if (direct >= 0) return direct;

  // The figure this correction changes is the most telling thing about it.
  const before = originalClaim.match(FIGURE) ?? [];
  const after = correctedClaim.match(FIGURE) ?? [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    const byFigure = sentences.findIndex((sentence) => sentence.includes(before[i]));
    if (byFigure >= 0) return byFigure;
  }

  // Otherwise the sentence sharing the longest stretch of the claim's wording.
  const fragments = originalClaim
    .split(/[、,。\s]+/)
    .filter((part) => part.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const fragment of fragments) {
    const byFragment = sentences.findIndex((sentence) => sentence.includes(fragment));
    if (byFragment >= 0) return byFragment;
  }

  return -1;
}

const FIGURE =
  /(?:\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|Wi-Fi\s*\w+|\d+(?:\.\d+)?[\d,]*(?:万|億|%|円|ドル|人|個|GB|MB|倍|MP|Gbps|インチ|mm|g|Hz|mAh|fps)?)/gi;

/**
 * Swap the figures the correction changed, matching them by the unit they
 * carry rather than by position, so a percentage is never replaced by a
 * length. Returns null when the two sides do not line up.
 */
function swapFigures(
  sentence: string,
  originalClaim: string,
  correctedClaim: string
): string | null {
  const before = originalClaim.match(FIGURE) ?? [];
  const after = correctedClaim.match(FIGURE) ?? [];
  if (before.length === 0 || before.length !== after.length) return null;

  let rewritten = sentence;
  let changed = false;

  for (let i = 0; i < before.length; i++) {
    const from = before[i];
    const to = after[i];
    if (from === to) continue;
    if (unitOf(from) !== unitOf(to)) return null;
    if (!rewritten.includes(from)) return null;
    rewritten = rewritten.replace(from, to);
    changed = true;
  }

  return changed ? rewritten : null;
}

/**
 * What kind of thing a figure is, so a percentage is never swapped for a
 * length. Most figures are named by the unit that trails them; a standard
 * like "Wi-Fi 7" is named by the label that leads it instead.
 */
function unitOf(figure: string): string {
  const label = figure.match(/^[A-Za-z][A-Za-z-]*/);
  if (label && /[A-Za-z]/.test(label[0]) && /\s|-/.test(figure)) {
    return label[0].toLowerCase();
  }
  const unit = figure.match(/[^\d.,\s]+$/);
  return unit ? unit[0].toLowerCase() : "";
}

/** Style repairs are scoped to their own sentence for the same reason. */
function applyStyleRepair(
  sentences: string[],
  targetText: string,
  ruleId: string
): string[] {
  const at = sentences.findIndex((sentence) => sentence.includes(targetText));
  if (at < 0) return sentences;

  const replacement = targetText.includes("その一方で") && ruleId === "AI002" ? "また、" : "";
  const next = [...sentences];
  next[at] = sentences[at].replace(targetText, replacement);
  return next;
}

function tidy(text: string): string {
  // Nothing is deleted here on a hunch: a phrase that reads as an AI-tell is
  // rule AI012's to find, so it comes with a Finding the reader can refuse.
  // A silent deletion would change the document at a span carrying no mark.
  return text
    .replace(/([。！？])\1+/g, "$1")
    .replace(/^[、,。\s]+/, "")
    .replace(/[、,]\s*[。！？]/g, "。")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
