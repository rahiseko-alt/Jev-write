import {
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVBatchRuleItemResult,
  JEVBatchRulesRequest,
  JEVBatchRulesResult,
  JEVChoice,
  JEVClient,
  JEVDeltaMeaningParams,
  JEVDeltaMeaningResult,
  JEVUnauthorizedChange,
} from "./types";
import { RatingVerdict } from "../google-factcheck/types";

export class MockJEVClient implements JEVClient {
  async evaluateAtomicJudgment(req: JEVAtomicJudgmentRequest): Promise<JEVAtomicJudgmentResult> {
    const { type, candidateText, evidenceText, state, instructions, criteria, mode } = req;

    // 1. Pipeline-specific: claim_match
    if (type === "claim_match") {
      const claimStr = String(req.claim?.normalizedText || req.claim?.originalText || req.claim || "").toLowerCase();
      const candStr = String(candidateText || "").toLowerCase();

      if (claimStr.includes("iphone 17") && candStr.includes("iphone 17")) {
        return {
          choice: "same",
          match: "same",
          confidence: 0.95,
          explanation: "Claims match identical core entity and factual topic.",
        };
      }

      const overlap = this.calculateKeywordOverlap(claimStr, candStr);
      if (overlap >= 0.7) {
        return {
          choice: "same",
          match: "same",
          confidence: 0.9,
          explanation: "Sufficient semantic overlap between claims.",
        };
      }
      if (overlap >= 0.4) {
        return {
          choice: "close_but_different",
          match: "close_but_different",
          confidence: 0.75,
          explanation: "Related claims with differing details.",
        };
      }

      return {
        choice: "different",
        match: "different",
        confidence: 0.9,
        explanation: "Distinct claims.",
      };
    }

    // 2. Pipeline-specific: rating_normalization
    if (type === "rating_normalization") {
      const rating = String(candidateText || "").toLowerCase();
      if (
        rating.includes("誤り") ||
        rating.includes("false") ||
        rating.includes("fake") ||
        rating.includes("incorrect")
      ) {
        return {
          choice: "contradicts",
          verdict: "contradicts" as RatingVerdict,
          confidence: 0.95,
          ratingMeaning: `FactCheck rating confirms claim is false: ${candidateText}`,
        };
      }
      if (
        rating.includes("正しい") ||
        rating.includes("true") ||
        rating.includes("accurate") ||
        rating.includes("verified")
      ) {
        return {
          choice: "supports",
          verdict: "supports" as RatingVerdict,
          confidence: 0.95,
          ratingMeaning: `FactCheck rating confirms claim is true: ${candidateText}`,
        };
      }
      return {
        choice: "says_nothing",
        verdict: "insufficient" as RatingVerdict,
        confidence: 0.8,
        ratingMeaning: `FactCheck rating unmapped: ${candidateText}`,
      };
    }

    // 3. Pipeline-specific: evidence_eval
    if (type === "evidence_eval") {
      const claimStr = String(req.claim?.normalizedText || req.claim || "").toLowerCase();
      const evStr = String(evidenceText || "").toLowerCase();

      if (claimStr.includes("iphone 17") && (evStr.includes("未発売") || evStr.includes("2026") || evStr.includes("iphone 16"))) {
        return {
          choice: "contradicts",
          relation: "contradicts",
          verdict: "contradicts" as RatingVerdict,
          confidence: 0.95,
          explanation: "Evidence contradicts the claim regarding iPhone 17 release timing.",
        };
      }

      const hasContradictionWords = /(?:誤り|デマ|事実無根|誤認|誤報|虚偽|否定|不正確|false|debunked|incorrect)/i.test(evStr);
      const overlap = this.calculateKeywordOverlap(claimStr, evStr);

      if (hasContradictionWords && overlap > 0.25) {
        return {
          choice: "contradicts",
          relation: "contradicts",
          verdict: "contradicts" as RatingVerdict,
          confidence: 0.92,
          explanation: "Evidence explicitly debunks the claim.",
        };
      }

      if (overlap > 0.3) {
        return {
          choice: "supports",
          relation: "supports",
          verdict: "supports" as RatingVerdict,
          confidence: 0.88,
          explanation: "Evidence supports the factual statement.",
        };
      }

      return {
        choice: "says_nothing",
        relation: "says_nothing",
        verdict: "insufficient" as RatingVerdict,
        confidence: 0.85,
        explanation: "Evidence does not address the claim.",
      };
    }

    // 4. Standard JEV Atomic Judgment: evidence vs claim in state
    if (state && (state.claim || state.claimA) && (state.evidence || state.claimB)) {
      if (state.claim && state.evidence) {
        const claimText = String(
          typeof state.claim === "string" ? state.claim : state.claim.normalizedText || state.claim.originalText || ""
        ).toLowerCase();
        const evText = String(
          typeof state.evidence === "string" ? state.evidence : state.evidence.excerpt || state.evidence.content || ""
        ).toLowerCase();

        if (claimText.includes("iphone 17") && (claimText.includes("2024") || claimText.includes("2025") || claimText.includes("発売"))) {
          if (
            evText.includes("未発売") ||
            evText.includes("2026") ||
            evText.includes("not released") ||
            evText.includes("false") ||
            evText.includes("誤り") ||
            evText.includes("まだ発売されていない")
          ) {
            return {
              choice: "contradicts",
              relation: "contradicts",
              verdict: "contradicts" as RatingVerdict,
              noul: 0,
              confidence: 0.96,
              explanation: "Evidence explicitly states iPhone 17 is unreleased or scheduled later.",
            };
          }
        }

        // Detect numerical, date, or specification conflicts between claim and evidence
        let hasGenericDateConflict = false;
        const claimDates = claimText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g) || [];
        for (const cd of claimDates) {
          const match = cd.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
          if (match) {
            const m = match[1];
            const d = match[2];
            const evMonthRegex = new RegExp(`${m}\\s*月\\s*(\\d{1,2})\\s*日`, "g");
            let mMatch: RegExpExecArray | null;
            while ((mMatch = evMonthRegex.exec(evText)) !== null) {
              if (mMatch[1] !== d) {
                hasGenericDateConflict = true;
                break;
              }
            }
          }
        }

        const hasDateConflict =
          hasGenericDateConflict ||
          (/13\s*日/.test(claimText) && /12\s*日/.test(evText)) ||
          (/2024\s*年/.test(claimText) && /2025\s*年/.test(evText)) ||
          (/2025\s*年\s*8\s*月/.test(claimText) && evText.includes("未発表"));

        // Generic numerical / unit specification conflict
        let hasGenericSpecConflict = false;
        const specUnits = ["円", "mm", "g", "インチ", "hz", "gb", "tb", "mah", "fps", "人", "倍", "mp", "gbps"];
        for (const unit of specUnits) {
          const unitRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
          let claimMatch: RegExpExecArray | null;
          while ((claimMatch = unitRegex.exec(claimText)) !== null) {
            const claimVal = claimMatch[1].replace(/,/g, "");
            let hasMatchingValue = false;
            let hasAnyValueInEv = false;
            const evUnitRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
            let evMatch: RegExpExecArray | null;
            while ((evMatch = evUnitRegex.exec(evText)) !== null) {
              hasAnyValueInEv = true;
              const evVal = evMatch[1].replace(/,/g, "");
              if (claimVal === evVal) {
                hasMatchingValue = true;
                break;
              }
            }
            if (hasAnyValueInEv && !hasMatchingValue) {
              hasGenericSpecConflict = true;
              break;
            }
          }
          if (hasGenericSpecConflict) break;
        }

        // Resolution conflict (e.g. 1920×1200 vs 1920×1080)
        const claimResMatch = claimText.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
        const evResMatch = evText.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
        if (claimResMatch && evResMatch) {
          if (claimResMatch[1] !== evResMatch[1] || claimResMatch[2] !== evResMatch[2]) {
            hasGenericSpecConflict = true;
          }
        }

        // Wi-Fi standard conflict (e.g. Wi-Fi 6E vs Wi-Fi 6, Wi-Fi 7 vs Wi-Fi 6E)
        const claimWifi = claimText.match(/wi-?fi\s*(\d+[a-z]*)/i);
        const evWifi = evText.match(/wi-?fi\s*(\d+[a-z]*)/i);
        if (claimWifi && evWifi && claimWifi[1].toLowerCase() !== evWifi[1].toLowerCase()) {
          hasGenericSpecConflict = true;
        }

        const hasSpecConflict =
          hasGenericSpecConflict ||
          (/20\s*mp/i.test(claimText) && /24\s*mp/i.test(evText)) ||
          (/6\s*倍/.test(claimText) && /5\s*倍/.test(evText)) ||
          (/20\s*gbps/i.test(claimText) && (/(?:10\s*gbps|10\s*gb\/s|10\s*ギガビット)/i.test(evText))) ||
          ((/2\s*倍/.test(claimText) || /約\s*2\s*倍/.test(claimText)) && (/3\s*倍/.test(evText) || /最大\s*3\s*倍/.test(evText))) ||
          ((/wi-?fi\s*7/i.test(claimText)) && (/wi-?fi\s*6e/i.test(evText)));

        if (hasDateConflict || hasSpecConflict) {
          return {
            choice: "contradicts",
            relation: "contradicts",
            verdict: "contradicts" as RatingVerdict,
            noul: 0,
            confidence: 0.98,
            explanation: hasDateConflict
              ? "日付の記述が一次ソース（公式発表日）と食い違っています。"
              : "ハードウェア仕様（解像度・倍率・転送速度・通信規格）の数値が公式スペックと矛盾しています。",
          };
        }

        const overlap = this.calculateKeywordOverlap(claimText, evText);

        // Resolution check: If claim has resolution (e.g. 1920×1200), evidence MUST contain resolution
        const claimRes = claimText.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
        if (claimRes) {
          const evRes = evText.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
          if (!evRes) {
            return {
              choice: "says_nothing",
              relation: "says_nothing",
              verdict: "insufficient" as RatingVerdict,
              noul: 0,
              confidence: 0.85,
              explanation: "証拠テキストに解像度の記述がありません。",
            };
          }
          if (claimRes[1] !== evRes[1] || claimRes[2] !== evRes[2]) {
            return {
              choice: "contradicts",
              relation: "contradicts",
              verdict: "contradicts" as RatingVerdict,
              noul: 0,
              confidence: 0.98,
              explanation: "解像度が公式スペックと矛盾しています。",
            };
          }
        }

        // Wi-Fi check: If claim asserts specific Wi-Fi version (e.g. Wi-Fi 7, Wi-Fi 6E), evidence MUST contain Wi-Fi spec
        const claimWifiMatch = claimText.match(/wi-?fi\s*(\d+[a-z]*)/i);
        if (claimWifiMatch) {
          const evWifiMatch = evText.match(/wi-?fi\s*(\d+[a-z]*)/i);
          if (!evWifiMatch) {
            return {
              choice: "says_nothing",
              relation: "says_nothing",
              verdict: "insufficient" as RatingVerdict,
              noul: 0,
              confidence: 0.85,
              explanation: "証拠テキストにWi-Fi規格の記述がありません。",
            };
          }
          if (claimWifiMatch[1].toLowerCase() !== evWifiMatch[1].toLowerCase()) {
            return {
              choice: "contradicts",
              relation: "contradicts",
              verdict: "contradicts" as RatingVerdict,
              noul: 0,
              confidence: 0.98,
              explanation: "Wi-Fi通信規格が公式スペックと矛盾しています。",
            };
          }
        }

        // 本体価格 check: If claim specifically asserts "本体価格", do not allow bundled/accessory total prices
        if (claimText.includes("本体価格")) {
          const hasExplicitHontaiPrice = /本体価格[^\d]*(\d+[\d,]*\s*円)/.test(evText);
          if (hasExplicitHontaiPrice) {
            const hontaiMatch = evText.match(/本体価格[^\d]*(\d+[\d,]*\s*円)/);
            if (hontaiMatch && !hontaiMatch[1].includes("59,980")) {
              return {
                choice: "contradicts",
                relation: "contradicts",
                verdict: "contradicts" as RatingVerdict,
                noul: 0,
                confidence: 0.98,
                explanation: "本体価格が公式発表の価格と矛盾しています。",
              };
            }
          } else if (!evText.includes("本体価格")) {
            return {
              choice: "says_nothing",
              relation: "says_nothing",
              verdict: "insufficient" as RatingVerdict,
              noul: 0,
              confidence: 0.85,
              explanation: "証拠テキストに本体価格（単体）の明確な記述がありません。",
            };
          }
        }

        // If the claim asserts specific numbers/specs with units, evidence MUST contain matching spec units
        for (const unit of specUnits) {
          const claimUnitRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
          if (claimUnitRegex.test(claimText)) {
            const evUnitRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
            if (!evUnitRegex.test(evText)) {
              return {
                choice: "says_nothing",
                relation: "says_nothing",
                verdict: "insufficient" as RatingVerdict,
                noul: 0,
                confidence: 0.85,
                explanation: `証拠テキストに対象スペック単位（${unit}）の記述がありません。`,
              };
            }
          }
        }

        // If the claim asserts a specific date (月 日), evidence MUST contain a date
        if (/(\d{1,2})\s*月\s*(\d{1,2})\s*日/.test(claimText)) {
          if (!/(\d{1,2})\s*月\s*(\d{1,2})\s*日/.test(evText)) {
            return {
              choice: "says_nothing",
              relation: "says_nothing",
              verdict: "insufficient" as RatingVerdict,
              noul: 0,
              confidence: 0.85,
              explanation: "証拠テキストに該当する日付の記述がありません。",
            };
          }
        }

        if (overlap > 0.25) {
          return {
            choice: "supports",
            relation: "supports",
            verdict: "supports" as RatingVerdict,
            noul: 1,
            confidence: 0.88,
            explanation: "Evidence supports the asserted claim.",
          };
        }

        return {
          choice: "says_nothing",
          relation: "says_nothing",
          verdict: "insufficient" as RatingVerdict,
          noul: 0,
          confidence: 0.85,
          explanation: "Evidence does not mention the facts in question.",
        };
      }

      // claimA vs claimB
      if (state.claimA && state.claimB) {
        const textA = String(state.claimA).trim().toLowerCase();
        const textB = String(state.claimB).trim().toLowerCase();

        if (textA === textB) {
          return {
            choice: "same",
            match: "same",
            noul: 1,
            confidence: 1.0,
            explanation: "Both claims are identical.",
          };
        }

        const overlap = this.calculateKeywordOverlap(textA, textB);
        if (overlap > 0.7) {
          return {
            choice: "close_but_different",
            match: "close_but_different",
            noul: 0,
            confidence: 0.85,
            explanation: "Claims share subject and entities but differ in specifics.",
          };
        }

        return {
          choice: "different",
          match: "different",
          noul: 0,
          confidence: 0.92,
          explanation: "Claims describe different facts.",
        };
      }
    }

    if (mode === "noul") {
      return {
        noul: 0,
        confidence: 0.8,
        explanation: "Default atomic noul evaluation.",
      };
    }

    const defaultChoice: JEVChoice = criteria && criteria.length > 0 ? (criteria[0] as JEVChoice) : "same";
    return {
      choice: defaultChoice,
      confidence: 0.8,
      explanation: "Default atomic choice evaluation.",
    };
  }

  async evaluateBatchRules(
    reqOrText: JEVBatchRulesRequest | string,
    maybeRules?: any[]
  ): Promise<any> {
    let text = "";
    let questions: Array<{ id: string; question: string }> = [];
    const isStyleRulesArrayCall = typeof reqOrText === "string" && Array.isArray(maybeRules);

    if (isStyleRulesArrayCall) {
      text = reqOrText;
      questions = (maybeRules || []).map((r) => ({
        id: r.id,
        question: r.jevQuestion || r.question || r.description || r.name,
      }));
    } else {
      const req = reqOrText as JEVBatchRulesRequest;
      text = req.text || "";
      questions = req.questions || [];
    }

    const results: Record<string, JEVBatchRuleItemResult> = {};
    for (const q of questions) {
      results[q.id] = this.checkStyleRule(q.id, q.question, text);
    }

    if (isStyleRulesArrayCall) {
      const arrayResult = questions.map((q) => {
        const item = results[q.id];
        return {
          ruleId: q.id,
          detected: item.detected,
          confidence: item.confidence,
          explanation: item.explanation,
          targetText: item.targetText || item.targetSnippet,
        };
      });
      (arrayResult as any).results = results;
      return arrayResult;
    }

    return { results };
  }

  async evaluateDeltaMeaningChange(
    originalClaimOrParams: string | JEVDeltaMeaningParams,
    revisedTextParam?: string,
    allowedChangesParam?: string[]
  ): Promise<JEVDeltaMeaningResult> {
    let original = "";
    let revised = "";
    let allowed: string[] = [];

    if (typeof originalClaimOrParams === "object") {
      original = originalClaimOrParams.originalText || originalClaimOrParams.originalClaim || "";
      revised = originalClaimOrParams.revisedText || "";
      allowed = originalClaimOrParams.authorizedChanges || originalClaimOrParams.allowedChanges || [];
    } else {
      original = originalClaimOrParams || "";
      revised = revisedTextParam || "";
      allowed = allowedChangesParam || [];
    }

    const unauthorizedChanges: JEVUnauthorizedChange[] = [];

    // 1. Numerical hallucination check
    const originalNumbers: string[] = original.match(/\d+[\d,]*(?:ドル|円|%|人|個|GB|MB|kg|km)?/g) || [];
    const revisedNumbers: string[] = revised.match(/\d+[\d,]*(?:ドル|円|%|人|個|GB|MB|kg|km)?/g) || [];

    for (const revNum of revisedNumbers) {
      const inOriginal = originalNumbers.includes(revNum);
      const inAllowed = allowed.some((a) => a.includes(revNum));

      if (!inOriginal && !inAllowed) {
        const expectedFact = originalNumbers[0] || original;
        unauthorizedChanges.push({
          segment: revNum,
          reason: `数値「${revNum}」は原文に存在せず、Fact Ledgerでの変更も承認されていません。`,
          expectedFact,
        });
      }
    }

    // 2. Exact match check
    if (revised.includes(original)) {
      if (unauthorizedChanges.length > 0) {
        return {
          hasUnauthorizedChange: true,
          unauthorizedChangeDetected: true,
          unauthorizedChanges,
          explanation: "Unauthorized numerical modification detected.",
          authorized: false,
          reason: "Unauthorized numerical modification detected.",
        };
      }
      return {
        hasUnauthorizedChange: false,
        unauthorizedChangeDetected: false,
        unauthorizedChanges: [],
        explanation: "Original text is preserved verbatim.",
        authorized: true,
      };
    }

    // 3. Authorized correction check
    const isCoveredByAuthorized = allowed.some((auth) => {
      const cleanAuth = auth.trim().toLowerCase();
      return cleanAuth.length > 0 && revised.toLowerCase().includes(cleanAuth);
    });

    if (isCoveredByAuthorized && unauthorizedChanges.length === 0) {
      return {
        hasUnauthorizedChange: false,
        unauthorizedChangeDetected: false,
        unauthorizedChanges: [],
        explanation: "Modifications correspond to authorized corrections in Fact Ledger.",
        authorized: true,
      };
    }

    // 4. Report the changes actually found.
    //
    // A rewrite that says the same facts in better words is the whole point of
    // the rewrite; only a fact that moved without authorization is a finding
    // here. Treating every reworded sentence as unauthorized threw away every
    // style repair in an article that needed no factual correction.
    if (unauthorizedChanges.length > 0) {
      return {
        hasUnauthorizedChange: true,
        unauthorizedChangeDetected: true,
        unauthorizedChanges,
        explanation: `Unauthorized modification detected for "${original}".`,
        authorized: false,
        reason: `Unauthorized modification detected for "${original}".`,
      };
    }

    return {
      hasUnauthorizedChange: false,
      unauthorizedChangeDetected: false,
      unauthorizedChanges: [],
      explanation: "No unauthorized semantic changes detected.",
      authorized: true,
    };
  }

  private checkStyleRule(
    ruleId: string,
    question: string,
    text: string
  ): JEVBatchRuleItemResult {
    const id = ruleId.toUpperCase();

    // AI001: 意味の重複・結論反復
    if (id === "AI001" || /意味の重複|結論反復/i.test(question)) {
      const match = text.match(/(?:要するに[、\s][^。！？\n]+[。！？]?|結論として[、\s][^。！？\n]+[。！？]?|まとめとして[、\s][^。！？\n]+[。！？]?|画期的な性能)/);
      if (match || text.includes("要するに") || text.includes("結論として") || text.includes("まとめとして")) {
        const snippet = match ? match[0] : "要するに、AIは不可欠なのです。";
        return {
          ruleId: "AI001",
          detected: true,
          confidence: 0.9,
          explanation: "結論の同義重複が検出されました。",
          targetSnippet: snippet,
          targetText: snippet,
        };
      }
    }

    // AI002: 「単なる〜ではない」の過剰な対比
    if (id === "AI002" || /単なる.*ではない|単に.*だけでなく|対比構文/i.test(question)) {
      const match = text.match(/(?:単なる[^、。\n]{1,30}に(?:とどまらず|すぎず)|単に[^、。\n]{1,30}だけでなく|単なる[^、。\n]{1,30}ではない)/);
      if (match) {
        return {
          ruleId: "AI002",
          detected: true,
          confidence: 0.95,
          explanation: "「単なる〜にとどまらず」等の陳腐化した対比構文が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI003: 内容のない汎用導入
    if (id === "AI003" || /汎用導入|近年[、\s]|現代社会において/i.test(question)) {
      const match = text.match(/(?:近年[、\s]+[^。！？\n]{4,40}(?:目覚まし|進歩|進化|注目|発展)|現代社会において[^。！？\n]{4,40}(?:不可欠|ツール))/);
      if (match) {
        return {
          ruleId: "AI003",
          detected: true,
          confidence: 0.95,
          explanation: "具体性のない紋切り型の汎用導入文が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI004: 抽象的な大げさ表現
    if (id === "AI004" || /誇大表現|パラダイムシフト|常識を覆す|画期的/i.test(question)) {
      const match = text.match(/(?:常識を覆す|新時代を切り拓く|画期的な性能|根本から再定義する|従来の限界を遥かに超越)/);
      if (match) {
        return {
          ruleId: "AI004",
          detected: true,
          confidence: 0.92,
          explanation: "客観的根拠に乏しい誇大な抽象表現が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI005: 必要以上の箇条書き化
    if (id === "AI005" || /箇条書き|リスト/i.test(question)) {
      const bulletMatches = text.match(/^[・\-\*]\s*.+$/gm);
      if (bulletMatches && bulletMatches.length >= 4) {
        return {
          ruleId: "AI005",
          detected: true,
          confidence: 0.88,
          explanation: "過度な箇条書きによる文脈の分断が検出されました。",
          targetSnippet: bulletMatches[0],
          targetText: bulletMatches[0],
        };
      }
    }

    // AI006: 同型文の連続
    if (id === "AI006" || /同じ文末|同型文/i.test(question)) {
      const match = text.match(/(?:です[。！？][^。！？\n]*){3,}|(?:ます[。！？][^。！？\n]*){3,}/);
      if (match) {
        return {
          ruleId: "AI006",
          detected: true,
          confidence: 0.9,
          explanation: "同じ文末が連続して単調になっています。",
          targetSnippet: match[0].slice(0, 50),
          targetText: match[0].slice(0, 50),
        };
      }
    }

    // AI007: 機械的な接続語
    if (id === "AI007" || /機械的.*接続語|まず第一に|要するに/i.test(question)) {
      const match = text.match(/(?:まず第一に[、\s]|要するに[、\s]|最後に[、\s]|次に[、\s])/);
      if (match) {
        return {
          ruleId: "AI007",
          detected: true,
          confidence: 0.92,
          explanation: "定型的で機械的な接続詞が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI008: 説明→まとめ→再まとめの反復
    if (id === "AI008" || /多重要約|まとめとして.*結論として/i.test(question)) {
      const match = text.match(/(?:まとめとして[、\s][^。！？\n]+(?:結論として|最後に))/);
      if (match) {
        return {
          ruleId: "AI008",
          detected: true,
          confidence: 0.93,
          explanation: "多重に要約が反復される構造が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI009: 根拠なしの一般論
    if (id === "AI009" || /主語の一般化|すべての人々にとって|多くの専門家/i.test(question)) {
      const match = text.match(/(?:すべての人々にとって|多くの専門家が指摘|一般的に知られているように)/);
      if (match) {
        return {
          ruleId: "AI009",
          detected: true,
          confidence: 0.88,
          explanation: "出典のない漠然とした一般化が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI010: 不自然なCTA
    if (id === "AI010" || /行動喚起|CTA|ぜひ試して/i.test(question)) {
      const match = text.match(/(?:ぜひ試してみてください|検討してみてはいかがでしょうか)/);
      if (match) {
        return {
          ruleId: "AI010",
          detected: true,
          confidence: 0.91,
          explanation: "解説記事末尾の不自然な営業的呼びかけが検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI011: 形式的な両論併記
    if (id === "AI011" || /両論併記|メリットもあるが課題もある/i.test(question)) {
      const match = text.match(/(?:メリットもあるが[、\s]?課題もある|一概には言えないが)/);
      if (match) {
        return {
          ruleId: "AI011",
          detected: true,
          confidence: 0.89,
          explanation: "形式的で中身のない両論併記が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    // AI012: 紋切り型の結びの言葉
    if (id === "AI012" || /目が離せません|期待が寄せられて|結びの言葉/i.test(question)) {
      const match = text.match(/(?:今後の動向から(?:も)?目が離せ(?:ない|ません)|今後の発展に期待が寄せられて(?:いる|います))/);
      if (match) {
        return {
          ruleId: "AI012",
          detected: true,
          confidence: 0.95,
          explanation: "「今後の動向から目が離せません」等の定型結び文句が検出されました。",
          targetSnippet: match[0],
          targetText: match[0],
        };
      }
    }

    return {
      ruleId: id,
      detected: false,
      confidence: 0.9,
    };
  }

  private calculateKeywordOverlap(a: string, b: string): number {
    const setA = new Set(this.extractKeywords(a));
    const setB = new Set(this.extractKeywords(b));
    if (setA.size === 0 || setB.size === 0) return 0;

    let matchCount = 0;
    for (const word of setA) {
      if (setB.has(word)) matchCount++;
    }

    return matchCount / Math.min(setA.size, setB.size);
  }

  private extractKeywords(str: string): string[] {
    return (
      str
        .toLowerCase()
        .match(/[a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]{2,}/g) || []
    );
  }
}
