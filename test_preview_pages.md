# Preview Pages Testing Guide

## Test the implementation

### 1. Server-rendered routes
✅ Build confirms `/user/[username]` route is properly registered as server-rendered (ƒ)

### 2. Manual testing routes to try:
- `/user/naval` - Popular account
- `/user/testinvaliduser123456` - Should show not-found page
- `/user/elonmusk` - Popular account (but may be protected)

### 3. Integration testing:
- Visit main page at `/`
- Lookup an account like "naval"
- Click "Preview" button in account header
- Should navigate to `/user/naval` preview page
- Click "Excavate Earliest Posts" button
- Should return to main page with username pre-filled

### 4. SEO testing:
- View page source for `/user/naval`
- Should see proper meta tags with account name
- Should be fully server-rendered HTML
- No login required to view

### 5. Error handling:
- Try invalid username like `/user/thisaccountdoesnotexist`
- Should show not-found page with helpful message

## Expected behavior:
- Preview pages are crawlable and SEO-friendly
- Account information displayed clearly  
- Clear call-to-action for excavation
- Protected accounts show appropriate warning
- Seamless integration with existing lookup flow
- No automatic excavation starts