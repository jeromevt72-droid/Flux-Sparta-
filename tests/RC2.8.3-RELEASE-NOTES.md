# FLUX RC2.8.3 — restore code inside EDIT, Mode label, admin restore codes
## Store stays closed · no live keys · builds on RC2.8.2 (live)

| ID | Change |
|---|---|
| D-36 | Restore code removed from the main menu (back to two buttons). It lives behind EDIT: the link under the name editor reads "🔑 RESTORE CODE" for an existing pilot and "HAVE A RESTORE CODE?" for a new one. Found while testing: tapping EDIT made the confirm screen call the current pilot "NEW PILOT"; it now reads the saved pilot. |
| D-36 | Game-over "Mode:" label was never set, so it always read MEDIUM. It now shows the run's difficulty. |
| D-37 | Admin → find a player → ISSUE RESTORE CODE. Safeguards: admin password (checked twice), a written reason is required, the issue is logged (time, tag, name, reason) BEFORE the code is returned — if the log can't be saved, no code; the log never holds the code or playerId; response never cached; code shown once. Log appears under Check Exceptions, keeps the newest 500, and privacy deletion erases the name and reason from it. |

**Before issuing a code:** be sure the person owns the pilot. For a pilot with
purchases, their Stripe receipt must match (Advanced → purchase lookup).

## Verification
- Release gate: 28/28 suites pass.
- New `test-d36-d37.mjs`: 62 checks + 12 negative controls, all caught; fails on RC2.8.2.
- `test-d35-browser.mjs` (real Chromium): EDIT flow, admin issues a code, a fresh
  device restores with it, log shown without the code; no page errors.
- Not run: real iPhone/iPad, Cloudflare deployment.

## Files changed from RC2.8.2
`worker.js`, `public/play/index.html`, `public/index.html`, `public/admin.html`.
