"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attentionOf,
  isUnplaced,
  type Finding,
  type MarkKind,
} from "@/lib/revised-document";

type Props = {
  /** The document body. Shares its top edge with this column inside a common relative parent. */
  bodyRef: React.RefObject<HTMLElement>;
  findings: Finding[];
  /** Open Finding ids, in the order they were opened. */
  openIds: string[];
  onToggle: (id: string) => void;
  renderCard: (finding: Finding) => React.ReactNode;
  narrow: boolean;
};

type Layout = {
  /** Finding id -> top offset (px) from this column's top edge. */
  tops: Record<string, number>;
  /** Distance (px) from this column's left edge to the body's right edge. */
  bodyRight: number;
};

/** Marks whose tops differ by at most this much share a row. */
const SAME_ROW_PX = 6;

/**
 * Width (px) kept clear for the arrows, next to the body. A note opens beside
 * the arrows rather than over them, so every arrow stays in reach.
 */
const ARROW_STRIP_PX = { wide: 76, narrow: 40 };

const TONE: Record<MarkKind, { idle: string; open: string }> = {
  fact: {
    idle: "border-red-300 bg-white text-red-700 hover:bg-red-50",
    open: "border-red-600 bg-red-600 text-white",
  },
  unverified: {
    idle: "border-amber-300 bg-white text-amber-700 hover:bg-amber-50",
    open: "border-amber-500 bg-amber-500 text-white",
  },
  style: {
    idle: "border-violet-300 bg-white text-violet-700 hover:bg-violet-50",
    open: "border-violet-600 bg-violet-600 text-white",
  },
};

function percentOf(finding: Finding): string {
  const attention = attentionOf(finding);
  return attention === null ? "—" : `${Math.round(attention * 100)}%`;
}

function findMark(body: HTMLElement, id: string): HTMLElement | null {
  const marks = body.querySelectorAll<HTMLElement>("[data-finding-ids]");
  for (const mark of Array.from(marks)) {
    const ids = (mark.getAttribute("data-finding-ids") ?? "").split(/\s+/);
    if (ids.includes(id)) return mark;
  }
  return null;
}

export function MarginNotes({
  bodyRef,
  findings,
  openIds,
  onToggle,
  renderCard,
  narrow,
}: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const unplacedRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [layout, setLayout] = useState<Layout>({ tops: {}, bodyRight: 0 });

  const unplaced = useMemo(() => findings.filter(isUnplaced), [findings]);
  const placed = useMemo(
    () => findings.filter((f) => f.markKind !== null && !isUnplaced(f)),
    [findings]
  );

  const measure = useCallback(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const tops: Record<string, number> = {};
    for (const finding of unplaced) {
      const button = unplacedRefs.current[finding.id];
      if (button) tops[finding.id] = button.getBoundingClientRect().top - rootRect.top;
    }
    if (body) {
      for (const finding of placed) {
        const mark = findMark(body, finding.id);
        if (mark) tops[finding.id] = mark.getBoundingClientRect().top - rootRect.top;
      }
    }
    const bodyRight = body ? body.getBoundingClientRect().right - rootRect.left : rootRect.width;
    setLayout((prev) => {
      const same =
        prev.bodyRight === bodyRight &&
        Object.keys(prev.tops).length === Object.keys(tops).length &&
        Object.entries(tops).every(([id, top]) => prev.tops[id] === top);
      return same ? prev : { tops, bodyRight };
    });
  }, [bodyRef, placed, unplaced]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = window.requestAnimationFrame(measure);
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (observer) {
      if (rootRef.current) observer.observe(rootRef.current);
      if (bodyRef.current) observer.observe(bodyRef.current);
    }
    window.addEventListener("resize", schedule);
    let alive = true;
    document.fonts?.ready.then(() => {
      if (alive) schedule();
    });
    return () => {
      alive = false;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [bodyRef, measure, narrow]);

  // Placed findings grouped into rows by their measured top.
  const rows = useMemo(() => {
    const measured = placed
      .filter((f) => layout.tops[f.id] !== undefined)
      .sort((a, b) => layout.tops[a.id] - layout.tops[b.id]);
    const result: Array<{ top: number; items: Finding[] }> = [];
    for (const finding of measured) {
      const top = layout.tops[finding.id];
      const last = result[result.length - 1];
      if (last && top - last.top <= SAME_ROW_PX) last.items.push(finding);
      else result.push({ top, items: [finding] });
    }
    return result;
  }, [placed, layout.tops]);

  // Rank in document order: higher in the document stacks in front.
  const rank = useMemo(() => {
    const order: Record<string, number> = {};
    [...unplaced, ...rows.flatMap((row) => row.items)].forEach((f, i) => {
      order[f.id] = i;
    });
    return order;
  }, [unplaced, rows]);

  const byId = useMemo(() => {
    const map: Record<string, Finding> = {};
    for (const f of findings) map[f.id] = f;
    return map;
  }, [findings]);

  const lastTop = rows.length > 0 ? rows[rows.length - 1].top : 0;

  const renderButton = (finding: Finding, ref?: (el: HTMLButtonElement | null) => void) => {
    const open = openIds.includes(finding.id);
    const tone = TONE[finding.markKind ?? "unverified"];
    return (
      <button
        key={finding.id}
        ref={ref}
        type="button"
        aria-expanded={open}
        aria-label={finding.title}
        title={finding.title}
        onClick={() => onToggle(finding.id)}
        className={`flex shrink-0 items-center rounded border font-medium leading-none transition-colors ${
          narrow ? "h-7 w-7 flex-col justify-center gap-0.5 text-[10px]" : "h-6 gap-1 px-1.5 text-xs"
        } ${open ? tone.open : tone.idle}`}
      >
        <span aria-hidden="true">▶</span>
        <span className={narrow ? "text-[8px]" : ""}>{percentOf(finding)}</span>
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className={`relative overflow-visible ${narrow ? "w-9" : "w-full"}`}
      style={{ minHeight: lastTop + 40 }}
    >
      {unplaced.length > 0 && (
        <div className="relative z-0 mb-2 flex flex-col items-end gap-1">
          <div className={`font-medium text-gray-500 ${narrow ? "text-[9px] leading-tight" : "text-xs"}`}>
            場所不明
          </div>
          {unplaced.map((f) =>
            renderButton(f, (el) => {
              unplacedRefs.current[f.id] = el;
            })
          )}
        </div>
      )}

      {rows.map((row) => (
        <div
          key={row.items[0].id}
          className={`absolute right-0 z-0 flex gap-1 ${narrow ? "flex-col" : "flex-row flex-wrap justify-end"}`}
          style={{ top: row.top }}
        >
          {row.items.map((f) => renderButton(f))}
        </div>
      ))}

      {openIds.map((id) => {
        const finding = byId[id];
        const top = layout.tops[id];
        if (!finding || top === undefined) return null;
        return (
          <div
            key={id}
            role="dialog"
            aria-label={finding.title}
            className="absolute rounded-lg border border-gray-200 bg-white p-3 pr-8 shadow-lg"
            style={
              narrow
                ? {
                    top,
                    left: ARROW_STRIP_PX.narrow,
                    width: Math.max(layout.bodyRight - ARROW_STRIP_PX.narrow, 200),
                    zIndex: 100 - (rank[id] ?? 0),
                  }
                : {
                    top,
                    left: 0,
                    right: ARROW_STRIP_PX.wide,
                    zIndex: 100 - (rank[id] ?? 0),
                  }
            }
          >
            <button
              type="button"
              aria-label="閉じる"
              onClick={() => onToggle(id)}
              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            >
              ×
            </button>
            {renderCard(finding)}
          </div>
        );
      })}
    </div>
  );
}
