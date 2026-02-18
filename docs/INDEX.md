# STELA docs — Index

**Read this first.** Then open only the doc/sections you need. Do not read everything "just in case."

- **What to do now:** [CURRENT_TASK.md](CURRENT_TASK.md)  
- **Rules & constraints:** [RULES.md](RULES.md)  
- **Product, UI, data, DB:** [ARCH.md](ARCH.md)  
- **Phases & execution:** [PHASES.md](PHASES.md)  

---

## When to read what

| Need | Doc | Section (anchor) |
|------|-----|------------------|
| Current work, next actions | [CURRENT_TASK.md](CURRENT_TASK.md) | — |
| Non-negotiable rules, UX, failure, cost | [RULES.md](RULES.md) | [#1-non-negotiable-rules](RULES.md#1-non-negotiable-rules), [#2-business-model](RULES.md#2-business-model-do-not-implement-yet), [#3-core-ux-rules](RULES.md#3-core-ux-rules), [#4-rate--cost-control](RULES.md#4-rate--cost-control), [#5-failure-handling](RULES.md#5-failure-handling) |
| Product scope, what STELA is/is not | [ARCH.md](ARCH.md) | [#1-product-core](ARCH.md#1-product-core) |
| UI rule (STELA-native, no X embeds) | [ARCH.md](ARCH.md) | [#2-ui-architecture-rule-important](ARCH.md#2-ui-architecture-rule-important) |
| Data fields (account, post) | [ARCH.md](ARCH.md) | [#3-data-scope-mvp](ARCH.md#3-data-scope-mvp) |
| DB strategy (SQLite, migration path) | [ARCH.md](ARCH.md) | [#4-database-strategy](ARCH.md#4-database-strategy) |
| Term "excavation" | [ARCH.md](ARCH.md) | [#5-terminology-internal](ARCH.md#5-terminology-internal) |
| Phase list, global rules | [PHASES.md](PHASES.md) | [Global rules](PHASES.md#global-rules-all-phases) |
| Phase 1 (scaffold) | [PHASES.md](PHASES.md) | [Phase 1](PHASES.md#phase-1--scaffold-mvp-skeleton) |
| Phase 2–7 | [PHASES.md](PHASES.md) | [Phase 2](PHASES.md#phase-2--async-job-system--polling-no-x-yet) … [Phase 7](PHASES.md#phase-7--export-hooks--hardening-minimal) |
| How to run phases (agent) | [PHASES.md](PHASES.md) | [Execution instructions](PHASES.md#execution-instructions-for-the-agent) |

---

## Rules for reading (TPM/429)

- **First** read only this INDEX (or INDEX + CURRENT_TASK).
- **Other docs:** only the sections/headings you need — do not load whole files.
- **Max 400 lines** per single read. Need more → narrow by section.
- **Forbidden:** "read everything just in case."

---

## File summaries

### [CURRENT_TASK.md](CURRENT_TASK.md) (~70 lines)

Current phase, deliverables, do-not list, priority, next actions, exit criteria.  
**Read when:** Starting work or checking "what now."

### [RULES.md](RULES.md)

Non-negotiable rules (data acquisition, sources, unlock, cache, architecture); business model (design only); core UX; rate & cost control; failure handling.  
**Read when:** Before implementing any feature; when checking policy.

### [ARCH.md](ARCH.md)

Product core; UI architecture (STELA-native); data scope (MVP); database strategy; terminology.  
**Read when:** Defining scope, UI, data model, or DB.

### [PHASES.md](PHASES.md)

Global phase rules; Phase 1–7 (goal, deliverables, exit criteria, do-not); execution instructions for the agent.  
**Read when:** Starting/finishing a phase or checking exit criteria.

---

## Migration memo (SPEC.md → docs/)

| Former SPEC section | Now in |
|---------------------|--------|
| 0. Product core | ARCH.md §1 |
| 1. Non-negotiable rules | RULES.md §1 |
| 2. Business model | RULES.md §2 |
| 3. Core UX rules | RULES.md §3 |
| 4. UI architecture rule | ARCH.md §2 |
| 5. Data scope (MVP) | ARCH.md §3 |
| 6. Database strategy | ARCH.md §4 |
| 7. Rate & cost control | RULES.md §4 |
| 8. Failure handling | RULES.md §5 |
| 9. Terminology | ARCH.md §5 |
| 10. Current task | CURRENT_TASK.md (+ PHASES.md Phase 1) |
| 11. Development phases | PHASES.md |
| 12. Execution instructions | PHASES.md (end) |

Canonical reference: **docs/INDEX.md**. SPEC.md is a pointer only; full content lives in docs/.
