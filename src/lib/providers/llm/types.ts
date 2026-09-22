import { Claim, RewritePlan } from "@/types";

export interface RewriteInput {
  originalText: string;
  plan: RewritePlan;
  prompt?: string;
}

export interface SurgicalFixInput {
  text: string;
  issueDescription: string;
  targetSegment: string;
  expectedFact: string;
}

export interface LLMProvider {
  extractClaims(text: string): Promise<Claim[]>;
  generateSearchQueries(claim: Claim): Promise<string[]>;
  rewrite(input: RewriteInput): Promise<string>;
  surgicalFix?(input: SurgicalFixInput): Promise<string>;
}
