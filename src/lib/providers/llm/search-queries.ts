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

/**
 * A checked article is mostly about one subject, so the pages that can speak
 * to it are largely the same for every sentence. These queries are written
 * once for the whole text and their pages serve every claim in it.
 */
export const DOCUMENT_QUERY_SYSTEM_PROMPT = `You write the handful of search queries that will gather the reference pages for a whole article.

Every sentence in the article will be checked against the pages these queries find, so cover the article's subjects and the kinds of fact it states (who runs it, where it is, prices and fees, membership numbers, events, plans).

Rules:
1. Write the queries in the same language as the article.
2. Never put a number, date, amount or proportion from the article into a query.
   The article's figures may be false; search for where the true ones are published.
3. Write 4 to 6 queries. The first reaches the subject's own site; the rest widen
   to its official notices, news coverage and directory entries.
4. Plain words only. No quotation marks, no site: filters, no boolean operators,
   no question sentences. At most 8 words per query.

Return ONLY a valid JSON object: { "queries": ["query 1", "query 2", ...] }`;

// The whole article goes in, never a leading slice of it: queries written from
// the first part alone leave the subjects of the rest without pages (ADR-0007).
export function buildDocumentQueryUserPrompt(text: string): string {
  return `Article:
${text}`;
}
