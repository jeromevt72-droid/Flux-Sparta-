# FLUX Sparta — source code (RC2.8.7)

Free, no-signup, country-vs-country arcade game. Runs as one Cloudflare Worker
(`flux-sparta-3`) with a Durable Object for scores and purchases, and static
pages for the Gateway, the game and the admin panel.

**Live:** https://flux-sparta-3.jeromevt72.workers.dev · game: `/play/` · admin: `/admin.html`
**Deploys from:** GitHub `jeromevt72-droid/Flux-Sparta-` (branch `main`) → Cloudflare Workers Builds.

## What is in this folder

| Path | What it is |
|---|---|
| `FLUX-Sparta/worker.js` | The server: scores, leaderboard, World Grid, restore check, admin actions, Stripe checkout/webhook (store closed) |
| `FLUX-Sparta/wrangler.jsonc` | Cloudflare settings: worker name, static files, Durable Object, cron, KV, Stripe price IDs |
| `FLUX-Sparta/STRIPE_SETUP.md` | How the (closed) store is wired to Stripe |
| `FLUX-Sparta/public/index.html` | The Gateway (planets, World Grid, Top Scorers, install steps, FAQ) |
| `FLUX-Sparta/public/play/index.html` | The game |
| `FLUX-Sparta/public/admin.html` | Owner admin: find a player, remove score, restrict, issue restore code, privacy delete, purchase lookup |
| `FLUX-Sparta/public/sw.js` | Offline support (the game works without a connection) |
| `FLUX-Sparta/public/robots.txt`, `sitemap.xml`, `og-image.jpg` | Google search setup and the link-preview card |
| `FLUX-Sparta/public/google5415e96c084db88e.html` | **Google Search Console ownership file. Never delete it** or Google verification is lost. |
| `FLUX-Sparta/public/privacy.html`, `terms.html` | Legal pages |
| `FLUX-Gateway-Redirect/` | The old `flux-gateway` address — only redirects to the live site |
| `test-*.mjs`, `regression-suite.py`, `fuzz.mjs`, `run-all-tests.mjs` | The release gate (33 suites) |
| `level-rule.mjs` | RC2.8.7: the score-to-level rule, shared by the server test fixtures |
| `RC2.8.x-RELEASE-NOTES.md` | What changed in each release |

## Secrets (NOT in this folder — set in Cloudflare → flux-sparta-3 → Settings → Variables)
`ADMIN_TOKEN` (admin password), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
Never put these in GitHub.

## Updating the live site
1. Record the rollback point: Cloudflare → flux-sparta-3 → Deployments → Active version ID.
2. Upload changed files to GitHub, **server (`worker.js`) first**, then `public/`, then `public/play/`.
3. Check the commit count went up by the number of commits you made.
4. Wait for the green ✓ + ~3 minutes, then test on the iPhone Home Screen app.
5. If anything is wrong: Deployments → the version from step 1 → ⋯ → Rollback.

## Running the tests (on a computer with Node 20+ and Python 3)
`node run-all-tests.mjs` — must print **RELEASE GATE PASSED: all 33 suites passed**.
`test-d35-browser.mjs`, `test-rc287-browser.mjs` and `test-level-banner-browser.mjs` are extra (they need a Chromium browser via Playwright) and are not in the gate.

In the GitHub repo these files live in `tests/`, and `tests/FLUX-Sparta` is a symlink to the repo root (`ln -s .. tests/FLUX-Sparta`).
Run from the repo root: `node tests/run-all-tests.mjs`.

## Key facts to remember
- A pilot lives in the storage of the place it was created. Safari, each Home Screen icon,
  and TikTok/Instagram's in-app browsers are separate places. The **restore code**
  (EDIT → 🔑 RESTORE CODE, or admin → ISSUE RESTORE CODE) moves a pilot between them.
- Skins belong to the pilot's secret ID on the server, so a restored pilot gets its skins back.
- **The store is closed** (`STORE_OPEN = false`). Before opening it: a real test purchase,
  move that pilot to another device with its restore code, confirm the skin follows.
- Changing the site address (e.g. buying a domain) creates new, empty storage for every
  player. Build the one-time hand-off first.

## Open items (not in this build)
- Replace admin pop-up boxes with text boxes on the card.
- iPhone: suggest "Add to Home Screen" in Safari before a pilot is created.
- Decide on separate Easy / Medium / Hard leaderboards.
- Before the store opens: restore-code reminder after purchase; email/receipt restore vs. App Store.
- Real-device tests of the TikTok/Instagram banner.
