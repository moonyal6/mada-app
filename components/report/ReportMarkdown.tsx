import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  isSectionLabel,
  parseMarkdown,
  type InlineToken,
  type MdBlock,
} from "@/lib/markdown";

/** Reading view for the report draft. Matches the editor's type scale so
 *  switching between تحرير and معاينة doesn't reflow the panel. */

function inline(tokens: InlineToken[]): ReactNode {
  return tokens.map((token, i) => {
    if (token.strong)
      return (
        <strong key={i} className="font-semibold text-brand-dark">
          {token.text}
        </strong>
      );
    if (token.em) return <em key={i}>{token.text}</em>;
    return <Fragment key={i}>{token.text}</Fragment>;
  });
}

function lines(rows: InlineToken[][]): ReactNode {
  return rows.map((row, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {inline(row)}
    </Fragment>
  ));
}

function Block({ block }: { block: MdBlock }) {
  if (block.kind === "rule")
    return <hr className="my-5 border-0 border-t border-line-2" />;

  if (block.kind === "heading")
    return (
      <h4
        className={cn(
          "mt-5 mb-1.5 font-semibold text-brand-dark first:mt-0",
          block.level <= 2 ? "text-[17px]" : "text-[15px]",
        )}
      >
        {inline(block.content)}
      </h4>
    );

  if (block.kind === "list") {
    const items = block.items.map((item, i) => (
      <li key={i} className="mb-1">
        {inline(item)}
      </li>
    ));
    // ps-* is padding-inline-start: markers sit on the right under dir="rtl".
    // arabic-indic keeps the counters as ١. ٢. — the app renders every other
    // number that way (toAr), so list-decimal's 1. 2. would read as foreign.
    return block.ordered ? (
      <ol className="mb-3 ps-5 [list-style-type:arabic-indic]">{items}</ol>
    ) : (
      <ul className="mb-3 list-disc ps-5">{items}</ul>
    );
  }

  if (isSectionLabel(block))
    return (
      <h4 className="mt-5 mb-1.5 text-[17px] font-semibold text-brand-dark first:mt-0">
        {block.lines[0][0].text}
      </h4>
    );

  return <p className="mb-3">{lines(block.lines)}</p>;
}

export function ReportMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks = parseMarkdown(text);

  return (
    <div
      className={cn(
        "px-[22px] py-5 text-[14.5px] leading-[1.9] [&>*:last-child]:mb-0",
        className,
      )}
    >
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
