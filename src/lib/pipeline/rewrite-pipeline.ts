import {
  FactLedgerItem,
  RewritePlan,
  StyleIssue,
} from "@/types";
import { LLMProvider, getLLMProvider } from "@/lib/providers";

export interface RewritePipelineOptions {
  llm?: LLMProvider;
  onProgress?: (progress: {
    percent: number;
    message: string;
  }) => void;
}

export interface RewritePipelineOutput {
  revisedText: string;
  plan: RewritePlan;
}

/**
 * Execute Rewrite Pipeline (Sections 22-25 of specification)
 * Compiles RewritePlan and performs strict fact-preserving, AI-tell repairing rewrite.
 */
export async function runRewritePipeline(
  originalText: string,
  factLedger: FactLedgerItem[],
  styleIssues: StyleIssue[],
  options?: RewritePipelineOptions
): Promise<RewritePipelineOutput> {
  const llm = options?.llm ?? getLLMProvider();
  const onProgress = options?.onProgress;

  onProgress?.({
    percent: 65,
    message: "修正計画（RewritePlan）の策定中...",
  });

  // 1. Build RewritePlan
  const plan = buildRewritePlan(originalText, factLedger, styleIssues);

  onProgress?.({
    percent: 75,
    message: "文章の自然なリライトを実行中...",
  });

  // 2. Build strict rewrite prompt
  const prompt = buildRewritePrompt(originalText, plan);

  // 3. Call LLM rewrite
  let revisedText: string;
  try {
    revisedText = await llm.rewrite({
      originalText,
      plan,
      prompt,
    });
  } catch (err) {
    console.warn("LLM rewrite failed, using original text as fallback:", err);
    revisedText = originalText;
  }

  onProgress?.({
    percent: 85,
    message: "リライト完了、再検証（Delta Check）へ移行中...",
  });

  return {
    revisedText,
    plan,
  };
}

/**
 * Compile Fact Ledger and Style Issues into a structured RewritePlan
 */
export function buildRewritePlan(
  text: string,
  factLedger: FactLedgerItem[],
  styleIssues: StyleIssue[]
): RewritePlan {
  // Filter corrections: Contradicted facts with explicit corrections
  const corrections = factLedger.filter(
    (item) => item.verdict === "CONTRADICTED" && !!item.correctedClaim
  );

  // Collect locked facts from SUPPORTED claims
  const immutableFactsSet = new Set<string>();
  for (const item of factLedger) {
    if (item.verdict === "SUPPORTED") {
      item.lockedFacts.forEach((fact) => immutableFactsSet.add(fact));
    }
  }

  // Extract protected quotes (「...」, 『...』, "...")
  const quoteMatches = text.match(/「[^」]+」|『[^』]+』|"[^"]+"/g) || [];
  const protectedQuotes = Array.from(new Set(quoteMatches));

  // Extract protected proper names / entities
  const protectedNamesSet = new Set<string>();
  const properNameMatches = text.match(/[A-Z][A-Za-z0-9]+|アップル|Apple|OpenAI|iPhone\s*\d+/g) || [];
  properNameMatches.forEach((name) => protectedNamesSet.add(name));

  return {
    corrections,
    styleIssues,
    immutableFacts: Array.from(immutableFactsSet),
    protectedQuotes,
    protectedNames: Array.from(protectedNamesSet),
  };
}

/**
 * Compile strict prompt instructions enforcing the 5 golden rewrite rules
 */
export function buildRewritePrompt(text: string, plan: RewritePlan): string {
  const instructions: string[] = [
    "【文章校正・リライト指示書】",
    "あなたは高度な日本語編集者です。以下の厳格な5原則を遵守して文章をリライトしてください。",
    "",
    "■ 厳格な校正5原則：",
    "1. 事実保持（Immutable Facts）：検証済みの真実として指定された事実・数値・固有名詞を勝手に変更・削除しないこと。",
    "2. 誤謬の修正（Fact Corrections）：ファクト台帳で矛盾（CONTRADICTED）と判定された誤った記述は、提供された訂正内容に従って正確に修正すること。",
    "3. 新規創作の禁止（No Hallucination）：未検証の事項について推測で新しい数値や事実を創作しないこと。",
    "4. AI表現癖の解消（Repair AI-tells）：検出されたAI特有の紋切り型表現（意味重複、誇大表現、陳腐な対比、不要なまとめなど）を修復指示に従って自然なジャーナリスティックな散文に直すこと。",
    "5. 文脈とトーンの維持（Tone & Context）：筆者の意図と自然な日本語のリズムを保ち、過剰な改変を避けること。",
  ];

  if (plan.corrections.length > 0) {
    instructions.push("\n■ 修正すべき事実誤認（Fact Corrections）:");
    plan.corrections.forEach((c, idx) => {
      instructions.push(
        `  ${idx + 1}. [元主張] ${c.originalClaim} -> [訂正] ${c.correctedClaim} (理由: ${c.correctionReason || "外部検証による"})`
      );
    });
  }

  if (plan.immutableFacts.length > 0) {
    instructions.push("\n■ 改変禁止の確定事実（Immutable Facts）:");
    plan.immutableFacts.forEach((f) => instructions.push(`  - ${f}`));
  }

  if (plan.styleIssues.length > 0) {
    instructions.push("\n■ 改善すべきAI表現癖（Style Issues to Repair）:");
    plan.styleIssues.forEach((issue, idx) => {
      instructions.push(
        `  ${idx + 1}. [${issue.ruleId}: ${issue.ruleName}] 対象: "${issue.targetText || ""}" -> 指示: ${issue.repairInstruction}`
      );
    });
  }

  if (plan.protectedQuotes.length > 0) {
    instructions.push("\n■ 保護すべき引用句:");
    plan.protectedQuotes.forEach((q) => instructions.push(`  - ${q}`));
  }

  instructions.push("\n■ 原文:\n" + text);
  instructions.push("\n修正後の文章のみを出力してください。");

  return instructions.join("\n");
}
