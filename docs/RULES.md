# RULES — Non-negotiable and constraints

**When to read:** Before implementing any feature; when checking data/unlock/UX/cost/failure policy.

---

## 1. Non-negotiable rules

Do not reinterpret. Follow all.

### Data acquisition

1. NEVER perform exhaustive paging from newest to oldest.
2. NEVER crawl entire timelines.
3. Use time-window jump toward the oldest side.
4. Fetch minimal data required to reach the earliest region.
5. Cost per account must remain bounded and size-independent.

### Data sources

6. DO NOT use Wayback Machine.
7. DO NOT import external datasets.
8. DO NOT pre-seed bulk accounts.

### Unlock logic

9. Credits are consumed ONLY after a successful unlock.
10. 0 posts → no credit consumption.
11. Any failure → no credit consumption.

### Cache rule

12. Once data is stored, NEVER re-fetch for display.

### Architecture

13. All long operations must be asynchronous.
14. Use job + polling model.
15. System must be safe under concurrent unlocks.

---

## 2. Business model (do not implement yet)

This section is for data model design only.

- Plan: Basic  
  price: $9/month  
  credits: 3 per month  
  extra credits purchasable
- Unlock consumes 1 credit when successful.
- Same user unlocking same account again: no additional credit.
- No free tier.
- **Do NOT build billing logic in MVP.**

---

## 3. Core UX rules

- Unlock must always feel intentional.
- Even when data already exists: show a 0.5–1.0 second artificial delay.
- Language in UI must use: **"Unlock"**, **"View"** — NOT "Analyze".

---

## 4. Rate & cost control

System must:

- detect locked/private accounts before excavation
- avoid starting jobs that cannot succeed
- prevent retry storms
- enforce per-account acquisition bounds

---

## 5. Failure handling

If:

- account is private  
- account has no posts  
- API error  
- timeout  
- internal exception  

Then:

- unlock = failed  
- credit = not consumed  

Failures must be observable in logs.
