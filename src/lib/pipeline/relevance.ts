import type { Claim } from "@/types";

/**
 * Whether a page is about the thing the Claim is about.
 *
 * A page that never names the Claim's subject cannot support or contradict it,
 * however well its numbers happen to line up. An English school's price page
 * says "入会金1万円" too; read against a claim about a freelancer community it
 * produced a confident contradiction about a company it had never heard of.
 *
 * The check is on the text of the page, not on its address: a name is a fact
 * about the content, while a domain is a guess about the owner.
 */

/** Same text, compared the way a reader would: case and width do not matter. */
function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** The names this Claim is about, most specific first. */
function namesOf(claim: Claim): string[] {
  const names = [claim.subject, ...(claim.entities ?? [])]
    .map((name) => (name ?? "").trim())
    .filter((name) => name.length > 0);

  return Array.from(new Set(names));
}

export function isAboutSubject(pageText: string, claim: Claim): boolean {
  const names = namesOf(claim);

  // Nothing to check against. Dropping the page here would throw away every
  // claim whose subject the extraction did not name.
  if (names.length === 0) return true;

  const text = normalize(pageText);
  if (text.trim().length === 0) return false;

  // The subject is named first, so a page carrying it is enough; failing that,
  // any other name the claim carries will do. A name is matched whole: "ノバ"
  // is not "フリノバ", and a page about one is not evidence about the other.
  return names.some((name) => text.includes(normalize(name)));
}
