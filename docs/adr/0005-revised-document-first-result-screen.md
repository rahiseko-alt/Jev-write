# Revised Document first, Revision Diff on demand

## Context
The result screen was built as a triage dashboard: a fixed two-column layout (comparison view plus a 384px inspection panel) defaulting to a side-by-side view, with no responsive breakpoints. On a phone the text column collapses to a sliver, so the user can only read the result in fragments. The product's value is fact-checking, repairing AI-tells, and getting both from a single paste — a screen that asks the user to hand-triage dozens of Findings works against the third.

## Decision
The result screen presents the **Revised Document** first, in the original paragraph structure, with a copy button in view. Findings are marked inline (fact corrections on the span, AI-tells on the sentence, unverified claims in a third style; distinguished by both colour and glyph, never colour alone). Selecting a mark opens that Finding's **Revision Diff** together with its evidence and its **Adoption** toggle — as a bottom sheet under 1024px, and in the retained inspection panel at or above it. Verified claims carry no mark, and the viewport is never scrolled on the user's behalf.

This supersedes the "multi-tab result dashboard" described in the Context of ADR-0002. The view tabs survive, but as a secondary control: phones offer 修正版 and 原文 only, while the side-by-side and inline-diff views remain for wide screens.

## Considered Options
- **Keep the dashboard, add breakpoints.** Rejected: it would make the triage workflow legible on a phone without questioning whether triage is the job. It is not — the user pastes an article and wants the corrected article back.
- **Drop the comparison views entirely.** Rejected: on a wide screen, reading the two versions against each other is genuinely useful, and the views already exist.
- **Drop per-Finding Adoption.** Rejected: the ability to refuse a machine's correction is the last safety valve in a tool whose whole premise is rewriting someone's text. Keeping it behind the diff costs the paste-and-go user nothing.

## Consequences
- Findings must be located within paragraphs rather than against a flat list of sentences, so the text is split by paragraph first and by sentence within. The copied text keeps the original paragraph breaks instead of one break per sentence.
- A Finding whose verdict is "unverified" has nothing to adopt, so its diff shows the reason and a prompt to check the source rather than a disabled control.
- Two pieces of sample-specific behaviour fall away with this rework: Finding titles were matched against iPhone-article keywords, and each Finding carried a fabricated "N分前" timestamp.
