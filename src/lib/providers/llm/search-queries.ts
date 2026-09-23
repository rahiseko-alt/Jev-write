import { Claim } from "@/types";

/**
 * What a checker asks the web about one claim (ADR-0015, north star ②).
 *
 * The claim's own sentence is not a search: it finds pages that repeat it,
 * and a fabricated figure in it finds nothing. What is searched is the
 * question that would settle the claim — first where the fact originates
 * (the primary source), then what could show it wrong or overstated.
 *
 * All claims are asked for in one generation, never one call per claim.
 */
export const CLAIM_QUERY_SYSTEM_PROMPT = `You are a fact-checker. For each claim of an article, you write the web searches that would settle it.
You do not search the claim's sentence. You search the questions a checker would ask about it.

## Procedure (do these steps in this order, for every claim)
1. Identify the central matter the claim states, and who or what it is about.
2. Identify the primary source that publishes or defines that matter: the organisation or person
   that proposed the term or model, the ministry or agency in charge, the statute or official
   guideline by its name, the original study or statistics, or the subject's own site.
3. Write query 1: it reaches that primary source. Name the source and the matter.
4. Write query 2: it checks the claim's qualifiers and conditions (all, always, only, scope,
   requirements, exceptions, the definition), where a contrary or narrower statement would be found.
   If the claim has nothing left to check this way, write query 1 only.

## Guidelines (do this)
- Write the queries in the same language as the claim.
- Use the claim's proper nouns exactly as the claim spells them.
- Always make query 1 aim at the primary source.
- Name things: put the entity in place of pronouns and vague words.
- Plain words, at most 8 words per query.

## Prohibitions (never do this)
- Never use the claim's sentence, or a long stretch of it, as a query.
- Never put a number, date, amount or proportion under scrutiny into a query. These figures may
  be false; name the subject and the attribute instead ("<organisation> 設立年", not "<organisation> 2004年").
- Never invent a domain or an organisation's name. Name a source only when you know it exists;
  otherwise name the kind of source (所管官庁, 公式サイト, 原典).
- Never put two matters into one query.
- No quotation marks, no site: filters, no boolean operators, no question sentences.

## Example
Claim: 改正健康増進法により、飲食店は2020年4月から原則屋内禁煙となった。
Figures under scrutiny: 2020年4月
→ { "id": "claim-1", "queries": ["改正健康増進法 受動喫煙対策 厚生労働省", "改正健康増進法 飲食店 屋内禁煙 例外"] }

## Output (fixed format)
Return ONLY a valid JSON object with exactly one entry per claim given, using the ids given, nothing else:
{ "claims": [ { "id": "claim-1", "queries": ["query 1", "query 2"] } ] }`;

export function buildClaimQueryUserPrompt(claims: Claim[]): string {
  return claims
    .map(
      (claim) => `id: ${claim.id}
Claim: ${claim.normalizedText || claim.originalText}
Subject: ${claim.subject || "N/A"}
Proper nouns: ${claim.entities?.join(", ") || "N/A"}
Figures under scrutiny (do NOT put these in a query): ${figuresOf(claim).join(", ") || "N/A"}`
    )
    .join("\n\n");
}

/** How many queries one claim may search with (ADR-0015). */
export const QUERIES_PER_CLAIM = 2;

function figuresOf(claim: Claim): string[] {
  return [...(claim.numbers ?? []), ...(claim.dates ?? [])]
    .map((figure) => String(figure).trim())
    .filter(Boolean);
}

/**
 * Reads the generation's answer into each claim's queries, keyed by claim id.
 * A claim the answer skipped gets none: it is still checked against the pages
 * the article's own queries found.
 */
export function readClaimQueries(parsed: unknown, claims: Claim[]): Map<string, string[]> {
  const entries: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.claims)
      ? (parsed as any).claims
      : [];

  const byId = new Map<string, string[]>();
  for (const claim of claims) {
    const entry = entries.find((item) => item && String(item.id) === claim.id);
    const raw: unknown[] = Array.isArray(entry?.queries) ? entry.queries : [];
    byId.set(claim.id, cleanClaimQueries(claim, raw.map(String)));
  }
  return byId;
}

/**
 * The two rules a query must keep, held by code as well as asked for:
 * no figure under scrutiny (#31: a false figure finds nothing), and not the
 * claim's own sentence (the direction the north star calls wrong).
 */
export function cleanClaimQueries(claim: Claim, queries: string[]): string[] {
  const figures = figuresOf(claim).sort((a, b) => b.length - a.length);
  const sentences = [claim.originalText, claim.normalizedText]
    .map((text) => compact(text ?? ""))
    .filter(Boolean);

  const cleaned: string[] = [];
  for (const query of queries) {
    let text = query;
    for (const figure of figures) text = text.split(figure).join(" ");
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (sentences.some((sentence) => compact(text) === sentence)) continue;
    if (cleaned.includes(text)) continue;
    cleaned.push(text);
  }
  return cleaned.slice(0, QUERIES_PER_CLAIM);
}

function compact(text: string): string {
  return text.replace(/[\s。．.、,]/g, "");
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
