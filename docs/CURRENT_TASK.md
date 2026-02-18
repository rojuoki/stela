# CURRENT TASK — Only do this now

**When to read:** Start of session or when unsure what to do next. Prefer this + [INDEX](INDEX.md) over reading full spec.

---

## Active task: Phase 1 — Scaffold the MVP codebase

**Goal:** Project runs locally with dev server, DB, minimal UI. No X API, no credits, no excavation.

**Stack:** Next.js, TypeScript, Tailwind, SQLite.

---

## Deliverables

- [ ] Working dev server  
- [ ] Homepage: username input, Unlock button, empty results list  
- [ ] Database schema  
- [ ] Minimal repository layer  

---

## Do NOT (Phase 1)

- Call X API  
- Implement credits  
- Implement billing  
- Implement excavation logic  

---

## Priority

1. Get `npm run dev` running.  
2. Add SQLite + schema + minimal repo.  
3. Add UI shell (input, button, results area, status).  
4. Document in README: how to run, file structure.

---

## Next actions

- If not started: create Next.js app (TypeScript, Tailwind), add SQLite (e.g. better-sqlite3 or similar), define schema, add one repo module.  
- If running: add UI (username input, Unlock button, empty list, status).  
- When done: report what was created, how to run, file structure. Stop after project runs locally.

---

## Exit criteria (from [PHASES.md](PHASES.md#phase-1--scaffold-mvp-skeleton))

- `npm run dev` works, page renders without errors  
- DB file can be created locally (e.g. ./stela.sqlite)  
- Schema can be applied from code  
- Basic lint/typecheck passes  
- README documents how to run and folder structure  
