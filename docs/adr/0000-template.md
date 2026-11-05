# NNNN. Title in plain business words

- **Status**: proposed | accepted | superseded by `NNNN` | deprecated
- **Date**: YYYY-MM-DD
- **Spec**: link to the governing spec, if any

## Context

What forces are at play: the need, the constraints, and the options considered. State facts a new
developer cannot see in the code.

## Decision

What was chosen, in one or two sentences, starting "We will ...".

## Consequences

What becomes easier, what becomes harder, and what must now be kept true. Name follow up work.

---

## How to use this template

- **Numbering**: copy this file to `docs/adr/NNNN-short-title.md`, where `NNNN` is the next free
  four digit number (the highest in this folder plus one). Numbers are never reused or changed.
- **When to write one**: a decision that is costly to reverse or that a module README's
  `## Decisions` section should point at: a module boundary, a library choice, a data rule, a
  deploy shape. A choice that only affects one function belongs in a code comment instead.
- **Changing a decision**: never edit an accepted ADR's decision. Write a new one, mark the old
  one `superseded by`, and update the READMEs that link it.
- **Linking**: add the ADR to the `## Decisions` section of every module README it governs, and
  to the index in [README.md](README.md).
