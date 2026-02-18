# ARCH — Product core, UI, data, DB, terminology

**When to read:** When defining product scope, UI approach, data model, or DB design.

---

## 1. Product core

STELA lets a user instantly unlock and view the earliest 100 posts of any public X account without manual scrolling.

This is a **viewing product**, not an analytics product.

**Primary experience:**  
input username → unlock → earliest 100 posts appear in a stable X-like layout.

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

- MVP database: **SQLite**
- Design MUST allow future migration to PostgreSQL without schema rewrite.
- Use normalized tables.
- Must support: user unlock history, credit eligibility check, account cache reuse.

---

## 5. Terminology (internal)

Use internal term: **"excavation"** — the bounded process of reaching the earliest region.  
This must NEVER become brute force.
