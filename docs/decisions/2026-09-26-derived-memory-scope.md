# Derived memories inherit the restricted scope of their sources

Date: 2026-09-26
Status: accepted
Links: ROADMAP.md EI2; CONTEXT.md "Access"; src/recall-scope.ts; PR #247

## Context
EI2 asks that a memory built from restricted sources never reaches a caller who lacks the
grant. Before this, consolidation, DAG, extract, auto-promote and supersede all wrote their
output with no scope, so private channel text reached every caller through default recall.

## Constraints and evidence
- Provenance: the EI2 slice-1 brief ("a memory derived from restricted sources inherits the
  most restrictive grant"). Claude chose the rule below under that delegation; merging PR #247
  is Keith's confirmation.
- Scopes are free-form strings with no order between them, so "most restrictive" of two
  different restricted scopes has no answer the store can compute.
- Codex found that sleep's dedupe, run after the merge, deleted the readable copy in favour of
  a private one; any producer that compares memories must share the same partition.

## Decision
Every producer that derives or compares memories partitions by `derivationPartitionKey`
(tenant plus restricted scope, unrestricted scopes collapse to one bucket) and stamps the
bucket's scope on its output. A derivation whose sources span two restricted scopes, or a
restricted and an unrestricted one, is not built (auto-promote skips and counts it).

## Alternatives considered
- A scope lattice ranking restricted scopes: needs connector knowledge hippo does not have.
- Stamp the union of scopes: one row would need two grants, which recall cannot express.
- Build mixed derivations and mark them admin-only: loses them for every member for good.

## Consequences
- A new producer that skips the partition reopens the leak; tests/derived-memory-scope.test.ts
  covers each producer that exists today.
- Rows written before v47 keep their old scope; back-filling them is an EI2 follow-up.

## Reconsider when
- Connectors ship a real access hierarchy, or users ask for cross-scope summaries.
