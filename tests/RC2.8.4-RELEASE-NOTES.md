# FLUX RC2.8.4 — Google search setup, in-app browser banner, admin search
## Store stays closed · no live keys · builds on RC2.8.3 (live)

| ID | Change |
|---|---|
| D-38 | **Search:** `robots.txt` and `sitemap.xml` (new), page titles "FLUX Sparta — Free Country vs Country Arcade Game" / "Play FLUX Sparta — Free Arcade Game", descriptions, canonical addresses, and a 1200×630 link-preview image (`og-image.jpg`, new) so shared links show a card. Admin stays out of search. |
| D-38 | **In-app browser banner:** inside TikTok, Instagram, Facebook, Messenger, Snapchat or LINE, the Gateway and game show "Tap ⋯ → Open in browser" with COPY LINK. Dismissible, disappears when a run starts, never touches pilot data. |
| D-38 | **Admin search** accepts "FLUX #3CA7WGN" (name + tag), as well as name or tag alone. |

The full site address now appears in exactly one kind of place — search and
preview tags, which crawlers require — and the tests enforce that no link or
script hard-codes it (the same code also runs on flux-sparta and flux-sparta-app).

## Verification
- Release gate: 29/29 suites pass. New `test-d38.mjs`: 47 checks + 10 negative controls, all caught.
- Real Chromium with a TikTok user agent: banner shows on both pages, clears on START, no page errors.
- Not run: real TikTok/Instagram apps on a phone, Google indexing (takes days).

## Files (vs RC2.8.3)
Changed: `worker.js`, `public/index.html`, `public/play/index.html`.
New: `public/robots.txt`, `public/sitemap.xml`, `public/og-image.jpg`.
