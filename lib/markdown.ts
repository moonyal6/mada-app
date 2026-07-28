/**
 * A deliberately small Markdown subset — enough for the clinical report the
 * writing step produces (headings, emphasis, bullet and numbered lists,
 * rules) and nothing more.
 *
 * Parsing returns plain data; rendering happens in ReportMarkdown.tsx as
 * React elements, never as an HTML string. Model output must not be able to
 * inject markup, so there is no dangerouslySetInnerHTML anywhere in this path.
 *
 * Two deviations from CommonMark, both chosen for this content:
 * - A single newline is a hard line break, not a paragraph join. The report's
 *   mandated structure puts each section label on its own line with no blank
 *   line after it; joining those lines would run the label into its body.
 * - Anything unrecognised stays literal text. A stray asterisk renders as an
 *   asterisk rather than being silently swallowed.
 */

export type InlineToken = {
  text: string;
  strong?: boolean;
  em?: boolean;
};

export type MdBlock =
  | { kind: "heading"; level: number; content: InlineToken[] }
  /** Lines within one paragraph; each is rendered on its own row. */
  | { kind: "paragraph"; lines: InlineToken[][] }
  | { kind: "list"; ordered: boolean; items: InlineToken[][] }
  | { kind: "rule" };

/**
 * `**strong**` and `*emphasis*`. Underscores are left alone — they show up
 * inside URLs far more often than as emphasis in Arabic prose.
 *
 * The run excludes `*` outright rather than lazily matching any character:
 * a lazy inner group backtracks straight past the closing delimiter, so
 * "**أ** و **ب**" comes back as one bold run instead of two. Content must
 * also begin and end on a non-space, which keeps arithmetic like "٥ * ٣ * ٢"
 * literal.
 */
const EMPHASIS =
  /\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*|\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;

export function parseInline(raw: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of raw.matchAll(EMPHASIS)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ text: raw.slice(last, at) });
    if (match[1] !== undefined) tokens.push({ text: match[1], strong: true });
    else tokens.push({ text: match[2], em: true });
    last = at + match[0].length;
  }
  if (last < raw.length) tokens.push({ text: raw.slice(last) });
  return tokens.filter((token) => token.text !== "");
}

const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^[-*+]\s+(.+)$/;
const NUMBERED = /^\d+[.)]\s+(.+)$/;

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: InlineToken[][] = [];
  let list: { ordered: boolean; items: InlineToken[][] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      flushAll();
      continue;
    }
    // Before bullets: "---" is a rule, not a list item.
    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        content: parseInline(heading[2].trim()),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const item = parseInline((bullet ?? numbered)![1]);
      flushParagraph();
      if (list && list.ordered === ordered) list.items.push(item);
      else {
        flushList();
        list = { ordered, items: [item] };
      }
      continue;
    }

    flushList();
    paragraph.push(parseInline(line));
  }

  flushAll();
  return blocks;
}

/**
 * True when a paragraph is nothing but one bold line — how the writing step
 * usually marks the report's mandated section labels ("**التشخيص:**") when it
 * doesn't use "#". Rendered as a section title; the text itself is untouched.
 */
export function isSectionLabel(block: MdBlock): boolean {
  return (
    block.kind === "paragraph" &&
    block.lines.length === 1 &&
    block.lines[0].length === 1 &&
    block.lines[0][0].strong === true
  );
}
