# Extend Result API Documentation

## Overview

The tweets API now supports both **normal view mode** and **extend-result mode** to properly handle additional excavation results.

## API Endpoints

### GET `/api/tweets/[accountId]`

**Normal Mode** (default):
```
GET /api/tweets/account123
```
- Returns full unlocked range for the requesting user
- Applies user boundary limits (never shows more than user unlocked)
- Never exposes cached total
- Example: User has 200 unlocked → returns posts 1-200

**Extend-Result Mode** (with range parameters):
```
GET /api/tweets/account123?rangeStart=101&rangeEnd=200
```
- Returns only the specified range
- Used for displaying newly unlocked posts after extend
- Can go beyond user boundary (for extend result display)
- Example: Returns only posts 101-200

## Response Formats

### Normal Mode Response
```json
{
  "tweets": [/* array of tweets 1-N based on user boundary */],
  "totalUnlocked": 200,
  "mode": "normal"
}
```

### Range Mode Response  
```json
{
  "tweets": [/* array of tweets in specified range */],
  "range": {
    "start": 101,
    "end": 200,
    "count": 100,
    "mode": "extend-result"
  }
}
```

## Extend Flow Integration

### 1. Cache-Hit Extend
```javascript
// POST /api/unlock/extend returns immediate results
const response = await fetch('/api/unlock/extend', {
  method: 'POST',
  body: JSON.stringify({ username: 'someuser' })
});

const result = await response.json();
if (result.strategy === 'cache-hit') {
  // Posts included directly in response
  displayExtendResults(result.posts, result.range);
}
```

### 2. Excavation Extend  
```javascript
// POST /api/unlock/extend returns job info
const response = await fetch('/api/unlock/extend', { /* ... */ });
const result = await response.json();

if (result.strategy === 'excavation') {
  // Poll job until complete
  await waitForJob(result.jobId);
  
  // Then fetch newly unlocked posts using range info
  const tweetsResponse = await fetch(
    `/api/tweets/${result.accountId}?rangeStart=${result.range.start}&rangeEnd=${result.range.end}`
  );
  
  const tweetsData = await tweetsResponse.json();
  displayExtendResults(tweetsData.tweets, tweetsData.range);
}
```

## Key Differences

### Normal Views
- **Account page revisit:** Shows full unlocked range (1-200)
- **My Unlocks page:** Shows full unlocked range per account
- **General browsing:** Always respects user boundary

### Extend Result Views
- **Immediate after extend:** Shows only newly unlocked block (101-200)
- **Range-specific:** Uses range parameters for precise control
- **Delta display:** Never shows full 1-200, only the new posts

## User Boundary Enforcement

The API automatically applies user unlock boundaries for BOTH normal and range modes:
- Uses `calculateUnlockedBoundary(userId, accountId)` from unlock planning
- Returns 0 tweets if user hasn't unlocked the account
- Never exposes cached total (internal planning use only)
- **Range queries ENFORCE boundary limits** - users can only request ranges within their unlocked posts

### Security Validation
Range queries validate permissions:
- `rangeStart >= 1` 
- `rangeStart <= rangeEnd`
- `rangeEnd <= userUnlockedBoundary` ← **Critical security check**

If range exceeds user boundary, returns 403 error:
```json
{
  "error": "Range access denied. Requested posts 201-300 but only 200 posts unlocked",
  "unlocked": 200,
  "requested": { "start": 201, "end": 300 }
}
```

## Migration Notes

- Legacy `getTweetsByAccount()` function preserved for backwards compatibility
- New code should use `getTweetsByAccountForUser()` for user-aware queries
- Frontend updates needed to support range parameters
- Extend button implementation needs to handle both cache-hit and excavation flows