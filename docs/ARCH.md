# ARCH — Product core, UI, data, DB, terminology

**When to read:** When defining product scope, UI approach, data model, or DB design.

---

## 1. Product core

STELA lets a user preview up to the earliest 20 posts of any public X account,
then intentionally excavate and unlock the earliest 1,000 without manual scrolling.

This is a **viewing product**, not an analytics product.

**Primary experience:**  
input username → shared earliest preview appears → excavate → earliest 1,000
posts become available in a stable X-like layout.

The system must be deterministic, fast, and low-cost.

**The product is NOT:**

- a timeline clone  
- a full scraper  
- an exhaustive crawler  
- an analytics dashboard (for MVP)

---

## 2. UI architecture rule (important)

The UI must be visually similar to X. Implementation must be **STELA-NATIVE**.

- Do NOT use X embeds  
- Do NOT mirror X DOM structure  
- Do NOT depend on X UI behavior  

Render posts using our own components and our own stored data.

**Goal:** lightweight, stable, fully controllable, future-extensible.  
Pixel-perfect cloning is NOT required.

---

## 3. Data scope (MVP)

**Per account store:**  
account_id, username, display_name, avatar_url  

**For each post:**  
post_id, created_at, full_text, media (if present), like_count, retweet_count, reply_count  

Only what is required for rendering.

---

## 4. Database strategy

- Product database: dedicated **PostgreSQL** selected by `STELA_IO_DATABASE_URL`.
- Public preview posts and coverage are shared cache; user unlock boundaries,
  requested acquisitions, and My Results reference a durable `users` row.
- Local `npm run dev` manages a PostgreSQL process with data persisted under
  `.local/io-postgres`; Ctrl+C stops the process without deleting its data.
- Production uses the same migrations with a dedicated Neon database and a
  separate Railway worker service. Legacy SQLite remains import/reference only.

---

## 5. Terminology (internal)

Use internal term: **"excavation"** — the bounded process of reaching the earliest region.  
This must NEVER become brute force.
