---
name: Milestone Tracker
about: Track one plan milestone (M0–M8) from docs/IMPLEMENTATION_PLAN.md §8.
title: "M{n} · {short name}"
labels: []
assignees: []
---

<!--
  Template for AssetMesh milestone issues. Replace every {…} placeholder, then
  delete this comment block.
  Milestone specs and acceptance live in docs/IMPLEMENTATION_PLAN.md §8.
  Commit convention: type(scope): subject with "Closes #<this issue>" under the
  title, where scope = m{n}. Never commit/PR milestone work unless asked.
-->

## Objective
{One line: what this milestone builds, why.}

## Link to the plan
{docs/IMPLEMENTATION_PLAN.md §8 — the milestone section}

## Tasks
- [ ] {task 1 — files touched}
- [ ] {task 2 — files touched}
- [ ] …

## Acceptance criteria
- [ ] {check 1 — how it is verified (curl / tests)}
- [ ] {check 2}
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all green

## Notes
- {risks, open questions, decisions to confirm, deps to ask about before adding}