# Separate LLM Generation and JEV Atomic Judgment

## Context
In this document quality assurance system, we need to verify facts, evaluate evidence, detect AI-specific stylistic mannerisms ("AI-tells"), and rewrite text naturally without introducing false modifications.

## Decision
We strictly separate LLM generation from JEV judgment:
- **JEV** handles only narrow, closed-ended "Atomic Judgments" (choice/noul evaluations on specific states, such as claim identity, evidence support/contradiction, rule presence, and unauthorized semantic delta). JEV never generates open-ended text.
- **LLMs** handle generative tasks (extracting claims from prose, query formulation, and prose rewriting under strict fact constraints).

## Consequences
- JEV is not burdened with prose generation, keeping its evaluations predictable, deterministic, and highly parallelizable.
- The rewriting LLM cannot hallucinate new facts freely because it is constrained by a pre-computed Fact Ledger and strictly checked post-rewrite by JEV Delta Check.
