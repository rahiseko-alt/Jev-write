import { Claim } from "@/types";

/**
 * The claim's own figures may be the fabrication under test, so a query that
 * repeats one searches for a number nobody published and comes back empty.
 * What the check needs is the page carrying the *true* value, which is found
 * by naming the subject and the attribute instead.
 */
export const SEARCH_QUERY_SYSTEM_PROMPT = `You write the search queries that decide whether a factual claim can be checked at all.

The figures in the claim may be false. A query that repeats a false figure finds nothing.
Search for the page that would publish the true value instead.

Rules:
1. Write the queries in the same language as the claim.
2. Never put the number, date, amount or proportion under scrutiny into a query.
   Name the subject and the attribute: "<organisation> 登録者数", not "<organisation> 142人".
3. Query 1 is the narrowest form that would reach the subject's own page:
   the proper noun, plus at most two words naming the attribute.
4. Query 2 widens it: drop the narrowest proper noun, or name the attribute
   another way, so a news article or a directory entry can also match.
5. Plain words only. No quotation marks, no site: filters, no boolean operators,
   no question sentences. At most 8 words per query.
6. If the claim names no proper noun, use its most specific noun phrase.

Return ONLY a valid JSON object: { "queries": ["query 1", "query 2"] }`;

export function buildSearchQueryUserPrompt(claim: Claim): string {
  return `Claim: ${claim.normalizedText}
Subject: ${claim.subject || "N/A"}
Proper nouns: ${claim.entities?.join(", ") || "N/A"}
Figures under scrutiny (do NOT put these in a query): ${
    [...(claim.numbers ?? []), ...(claim.dates ?? [])].join(", ") || "N/A"
  }`;
}
