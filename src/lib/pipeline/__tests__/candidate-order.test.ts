import { describe, it, expect } from "vitest";
import { OrderedPage, interleave, judgingOrder } from "@/lib/pipeline/candidate-order";

/**
 * ADR-0022: the order JEV judges the candidates in. Read off the addresses,
 * the searches and the origins; never a score; every candidate once.
 */

const page = (id: number, origin: string, primary = false): OrderedPage => ({ id, origin, primary });

describe("judgingOrder", () => {
  it("この主張のファクトチェックの結果→一次資料→残りの順。それぞれの中は渡された順（検索の順・順位）", () => {
    const own = [page(10, "factcheck.example")];
    const ranked = [page(1, "a.example"), page(2, "b.go.jp", true), page(3, "c.example"), page(4, "d.lg.jp", true)];

    expect(judgingOrder(own, ranked)).toEqual([10, 2, 4, 1, 3]);
  });

  it("同じ出所のページは、最初の1件の場所にまとめる（転載は元の近くで判定する）", () => {
    const ranked = [
      page(1, "blog.example"),
      page(2, "example.net、mhlw.go.jp", true),
      page(3, "other.example"),
      page(4, "blog.example"),
      page(5, "example.net、mhlw.go.jp"),
    ];

    expect(judgingOrder([], ranked)).toEqual([2, 5, 1, 4, 3]);
  });

  it("渡したページはどれも1回だけ入る", () => {
    const ranked = [page(3, "x"), page(1, "y"), page(2, "x"), page(0, "z", true)];

    const order = judgingOrder([], ranked);

    expect(order.slice().sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("interleave", () => {
  it("主張が順番に1件ずつ取る。ほかの主張が取った候補は飛ばす", () => {
    const orders = [
      ["a1", "a2", "doc", "b1"],
      ["b1", "b2", "doc"],
      ["c1", "doc", "a1"],
    ];

    expect(interleave(orders)).toEqual(["a1", "b1", "c1", "a2", "b2", "doc"]);
  });

  it("候補はどれも1回だけ。空の主張があっても止まらない", () => {
    expect(interleave([[], ["x", "y"], ["y", "z"]])).toEqual(["x", "y", "z"]);
    expect(interleave([])).toEqual([]);
  });
});
