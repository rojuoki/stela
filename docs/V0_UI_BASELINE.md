# v0 UI baseline — 2026-09-23

This branch is a reviewable snapshot of the working STELA IO product before
exploring a new results-workspace layout in v0.

## Purpose

- Give v0 the current product UI and data boundaries as repository context.
- Explore layout and interaction changes without editing the production result
  page directly.
- Return any useful v0 proposal as a separate pull request for review.

## Current result UI

- Product result route: `src/app/io/[username]/page.tsx`
- Result composition: `src/components/dashboard/saved-timeline.tsx`
- Timeline and media: `src/components/dashboard/timeline.tsx` and
  `src/components/dashboard/media-grid.tsx`
- Current chart: `src/components/dashboard/engagement-chart.tsx`
- Alternate chart experiment: `src/components/dashboard/engagement-chart-v2.tsx`
- UX notes: `docs/UX_DRAFT.md`

The current chart remains the default. The alternate experiment can be viewed
locally with `NEXT_PUBLIC_STELA_ENGAGEMENT_CHART=v2 npm run dev`.

## Intended v0 scope

Create an isolated prototype route and dedicated components. Do not change API,
authentication, database, billing, unlock, acquisition-worker, or existing
production-route behavior while exploring the layout.

The design direction under consideration is:

- a compact account header;
- sticky search and one-dimensional time-position navigation;
- a wider tweet-reading workspace with media and top-post context;
- a collapsible or full-screen analysis graph in the lower panel;
- additional-unlock actions at the acquired timeline boundary.

## Excluded local data

`prototype/`, `results/`, Python caches, environment files, and local
screenshots are intentionally excluded from Git. They are generated artifacts,
acquisition output, or machine-local data and are not needed by v0.
