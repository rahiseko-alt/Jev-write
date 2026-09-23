/**
 * Where a page comes from (ADR-0016). Two things are read off a page here,
 * and nothing else: which origin it belongs to, and whether its address is
 * that of a primary source. Neither is a score. Which pages matter is JEV's
 * call, made on the attributes given to it (ADR-0007).
 */

/** A page as far as this module is concerned. */
export type OriginInput = { url: string; text: string };

/** What is known about one page's origin. */
export type Origin = {
  /** The origin as a name: its site, or the sites of pages that carry the same text. */
  origin: string;
  /** Whether the address is that of a primary source. */
  primary: boolean;
  /** Which kind of primary source, when it is one. */
  primaryKind?: string;
};

/**
 * Second-level labels under a two-letter country code that are not
 * themselves a site (example.co.jp is the site, not co.jp).
 */
const SECOND_LEVEL = new Set(["co", "or", "ne", "ac", "go", "gr", "ed", "lg", "ad", "com", "net", "org", "gov", "edu"]);

/** Prefecture labels under .jp (city.toyota.aichi.jp is a site of its own). */
const PREFECTURES = new Set(
  (
    "hokkaido aomori iwate miyagi akita yamagata fukushima ibaraki tochigi gunma saitama chiba tokyo " +
    "kanagawa niigata toyama ishikawa fukui yamanashi nagano gifu shizuoka aichi mie shiga kyoto osaka " +
    "hyogo nara wakayama tottori shimane okayama hiroshima yamaguchi tokushima kagawa ehime kochi " +
    "fukuoka saga nagasaki kumamoto oita miyazaki kagoshima okinawa"
  ).split(" ")
);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * The site a URL belongs to: its domain, without `www.` and without the
 * sub-domains of one organisation (news.example.com and example.com are one
 * site). An address that cannot be read is its own site.
 */
export function siteOf(url: string): string {
  const host = hostOf(url);
  if (!host) return url;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const countryLevel =
    tld.length === 2 && (SECOND_LEVEL.has(second) || (tld === "jp" && PREFECTURES.has(second)));
  return labels.slice(countryLevel ? -3 : -2).join(".");
}

/**
 * Whether a URL is that of a primary source, and which kind: the ministries
 * and agencies, the law (e-Gov), local government, academic institutions and
 * papers, and international bodies. Read from the address only; a company's
 * or a proposer's own site cannot be told apart this way and is not named.
 */
export function primaryKindOf(url: string): string | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {}

  if (/(^|\.)e-gov\.go\.jp$/.test(host) || /(^|\.)kanpou\.npb\.go\.jp$/.test(host)) return "法令・官報";
  if (host === "doi.org" || host === "dx.doi.org" || /\/10\.\d{4,9}\//.test(path)) return "学術論文（DOI）";
  if (/(^|\.)arxiv\.org$/.test(host) || /(^|\.)jstage\.jst\.go\.jp$/.test(host)) return "学術論文";
  if (host.endsWith(".go.jp")) return "官公庁";
  if (host.endsWith(".lg.jp") || /^(pref|city|town|vill)\.[a-z-]+(\.[a-z-]+)?\.jp$/.test(host)) {
    return "地方公共団体";
  }
  if (host.endsWith(".ac.jp") || /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(host)) return "学術機関";
  if (/\.(gov|gov\.[a-z]{2}|go\.[a-z]{2}|gc\.ca|int)$/.test(host) || host.endsWith("europa.eu")) {
    return "政府・国際機関";
  }
  return undefined;
}

/** How long a run of characters is compared, and what share of runs is kept. */
const SHINGLE = 8;
const SAMPLE_EVERY = 4;
/** Shorter than this, a text is too short to call a copy of anything. */
const MIN_COPY_CHARS = 200;
/**
 * The share of the shorter text found in the longer one at which the two are
 * the same text: a reprint, or a copy with a different frame around it.
 */
export const REPRINT_CONTAINMENT = 0.8;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A sample of the text's character runs, the same sample for the same run wherever it appears. */
function fingerprint(text: string): Set<number> | undefined {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < MIN_COPY_CHARS) return undefined;
  const kept = new Set<number>();
  for (let i = 0; i + SHINGLE <= compact.length; i++) {
    const hash = fnv1a(compact.slice(i, i + SHINGLE));
    if (hash % SAMPLE_EVERY === 0) kept.add(hash);
  }
  return kept.size > 0 ? kept : undefined;
}

/** Whether one text is, for the most part, the other. */
export function isReprint(a: string, b: string): boolean {
  return sameText(fingerprint(a), fingerprint(b));
}

function sameText(fa?: Set<number>, fb?: Set<number>): boolean {
  if (!fa || !fb) return false;
  const [small, large] = fa.size <= fb.size ? [fa, fb] : [fb, fa];
  let shared = 0;
  for (const hash of small) if (large.has(hash)) shared++;
  return shared / small.size >= REPRINT_CONTAINMENT;
}

/**
 * Each page's origin. Pages on the same site are one origin; so are pages on
 * different sites that carry the same text (a reprint is not a second
 * source). The result does not depend on the order the pages were given in.
 */
export function originsOf(pages: OriginInput[]): Origin[] {
  const parent = pages.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const sites = pages.map((page) => siteOf(page.url));
  const fingerprints = pages.map((page) => fingerprint(page.text));
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (sites[i] === sites[j]) {
        join(i, j);
        continue;
      }
      if (find(i) !== find(j) && sameText(fingerprints[i], fingerprints[j])) join(i, j);
    }
  }

  const members = new Map<number, Set<string>>();
  pages.forEach((_, i) => {
    const root = find(i);
    const set = members.get(root) ?? new Set<string>();
    set.add(sites[i]);
    members.set(root, set);
  });

  return pages.map((page, i) => {
    const primaryKind = primaryKindOf(page.url);
    return {
      origin: [...(members.get(find(i)) ?? [])].sort().join("、"),
      primary: primaryKind !== undefined,
      ...(primaryKind ? { primaryKind } : {}),
    };
  });
}
