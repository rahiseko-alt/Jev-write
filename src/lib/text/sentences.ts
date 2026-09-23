/**
 * Where an article's sentences begin and end, decided by code (ADR-0020).
 *
 * The generation never chooses or cuts the sentences it judges: it is handed
 * them already numbered. The same text is cut the same way every time, so a
 * sentence cannot be one claim on one run and two on the next because its
 * edges moved.
 *
 * The rule, in this order:
 * 1. The text is read line by line.
 * 2. A line is a heading when it does not end the way a sentence ends
 *    (。！？, then any closing brackets) and either starts with a heading
 *    mark (#…######, ■ □ ◆ ◇ ● ▼ ▽ 【) or is the title: the first line, at
 *    most TITLE_MAX_CHARS long, with more text after it. A heading is shown
 *    to the generation as context and never judged.
 * 3. Every other line is cut after each run of 。！？ that stands outside
 *    brackets (「」『』（）()【】〔〕［］[]〈〉《》“”‘’), so a quotation keeps
 *    its own full stops. Whatever follows the last cut is a sentence too.
 *    A line whose brackets never close is cut at every 。！？ instead.
 * 4. Each sentence is trimmed of the spaces around it; an empty one is none.
 * 5. The sentences are numbered s1, s2, … in reading order.
 */

export type ArticleSentence = {
  /** s1, s2, … in reading order. */
  id: string;
  /** The sentence as written, without the spaces around it. */
  text: string;
  /** The line of the text it stands on, counting from 0. */
  line: number;
};

export type ArticleHeading = {
  text: string;
  line: number;
};

export type SplitArticle = {
  sentences: ArticleSentence[];
  /** Lines taken as headings: context for the generation, never judged. */
  headings: ArticleHeading[];
};

const TERMINATORS = "。！？";
const OPENING = "「『（(【〔［[〈《“‘";
const CLOSING = "」』）)】〕］]〉》”’";
const HEADING_MARK = /^(#{1,6}\s|[■□◆◇●▼▽【])/;
const SENTENCE_END = /[。！？][」』）)】〕］\]〉》”’]*$/;

/** How long a line may be and still be taken as the title. */
export const TITLE_MAX_CHARS = 60;

export function splitArticle(text: string): SplitArticle {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  const titleHasText = first >= 0 && lines.slice(first + 1).some((line) => line.trim() !== "");

  const sentences: ArticleSentence[] = [];
  const headings: ArticleHeading[] = [];

  lines.forEach((raw, line) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const isTitle =
      line === first && titleHasText && Array.from(trimmed).length <= TITLE_MAX_CHARS;
    if (isHeading(trimmed, isTitle)) {
      headings.push({ text: trimmed, line });
      return;
    }
    for (const sentence of cutLine(trimmed)) {
      sentences.push({ id: `s${sentences.length + 1}`, text: sentence, line });
    }
  });

  return { sentences, headings };
}

function isHeading(line: string, isTitle: boolean): boolean {
  if (SENTENCE_END.test(line)) return false;
  return HEADING_MARK.test(line) || isTitle;
}

function cutLine(line: string): string[] {
  return cut(line, true) ?? cut(line, false) ?? [line];
}

/**
 * The line cut after each run of 。！？. With brackets tracked, a stop inside
 * them does not cut, and a line that ends inside a bracket gives null.
 */
function cut(line: string, trackBrackets: boolean): string[] | null {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (trackBrackets && OPENING.includes(ch)) depth++;
    else if (trackBrackets && CLOSING.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && TERMINATORS.includes(ch)) {
      let end = i + 1;
      while (end < line.length && TERMINATORS.includes(line[end])) end++;
      pieces.push(line.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (trackBrackets && depth > 0) return null;
  pieces.push(line.slice(start));

  return pieces.map((piece) => piece.trim()).filter((piece) => piece.length > 0);
}
