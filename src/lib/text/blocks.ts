/**
 * Cutting an article into pieces one run can finish.
 *
 * A run has a time limit, and a long article does not fit inside it. Rather
 * than refuse the article — or accept it and time out — the text is cut into
 * blocks that are checked one after another, each within the limit, and the
 * results are put back together in order.
 *
 * The cuts are made where a reader would make them: between paragraphs first,
 * then at the end of a sentence. A block never begins mid-sentence unless the
 * sentence itself is longer than a block.
 */

/** The size a block aims for: around 500 characters finishes well inside the limit. */
const TARGET = 500;

/** No block goes past this, whatever the punctuation does. */
const MAX = 700;

const SENTENCE_END = /[。！？]/;

/** Where to cut, searching back from the far end for the best boundary. */
function cutAt(text: string): number {
  if (text.length <= MAX) return text.length;

  const window = text.slice(0, MAX);

  // A paragraph break at or after the target is the cleanest cut.
  const paragraph = window.lastIndexOf("\n\n", MAX);
  if (paragraph >= TARGET / 2) {
    return paragraph + 2;
  }

  // Otherwise the last sentence end inside the window.
  for (let i = window.length - 1; i >= TARGET / 2; i--) {
    if (SENTENCE_END.test(window[i])) {
      // Take any closing quotes or newlines that belong with it.
      let end = i + 1;
      while (end < text.length && /[」』）)\n]/.test(text[end])) end++;
      return end;
    }
  }

  // A single sentence longer than a block: cut it, rather than stop.
  return MAX;
}

export function splitIntoBlocks(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  const blocks: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    const at = cutAt(rest);
    blocks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }

  return blocks;
}
