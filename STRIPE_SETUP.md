# FLUX SPARTA — Stripe Shop Setup

This wires "THEMES & SKINS" to real Stripe checkout for two skins: Toxic and
Cosmic, $1.99 each (change the price anytime in Stripe — the game code
doesn't hardcode amounts, only Stripe Price IDs).

How it works: the game (index.html) never touches your Stripe secret key.
It calls two small serverless functions that live in `functions/api/` —
these run on Cloudflare, not in the player's browser, so the secret key
stays private. This is the same zip/folder structure you've already been
deploying, just with a `functions/` folder added — Cloudflare Pages picks
those up automatically.

## 1. Stripe account setup (one-time)
1. Create a Stripe account if you don't have one: stripe.com
2. Dashboard > Products > Add product. Create two products:
   - "FLUX — Toxic Skin", price $1.99, one-time (not subscription)
   - "FLUX — Cosmic Skin", price $1.99, one-time
3. For each, copy the **Price ID** (starts with `price_...`) — not the
   Product ID. You'll need both.
4. Dashboard > Developers > API keys. Copy your **Secret key**
   (`sk_test_...` while testing — switch to `sk_live_...` only once you're
   ready to take real money).

Stay in **Test mode** (toggle top-right of the Stripe dashboard) until
you've clicked all the way through a purchase yourself. Test mode uses fake
card `4242 4242 4242 4242`, any future expiry, any CVC.

## 2. Cloudflare Pages environment variables
In your Cloudflare Pages project: Settings > Environment variables > Add.
Add these (do this for both "Production" and "Preview" environments):

| Name | Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` | Mark as **Secret**, not plain text |
| `STRIPE_PRICE_TOXIC` | `price_...` | From step 1 |
| `STRIPE_PRICE_COSMIC` | `price_...` | From step 1 |
| `SITE_URL` | `https://your-project.pages.dev` | Your actual deployed URL |

After adding variables, redeploy (Cloudflare Pages needs a fresh deploy to
pick up new environment variables — re-uploading this zip does that).

## 3. Deploy
Upload this whole folder (including `functions/`) to Cloudflare Pages the
same way you did before. Cloudflare auto-detects the `functions/api/*.js`
files and turns them into live endpoints at `/api/create-checkout-session`
and `/api/verify-session` — no separate server needed.

## 4. Test it yourself before telling anyone it's live
1. Open your deployed URL, tap THEMES & SKINS, tap BUY on Toxic
2. You should land on a real Stripe Checkout page
3. Pay with the test card above
4. You should be redirected back into the game with a "PURCHASE COMPLETE"
   popup, and Toxic should now show EQUIP instead of BUY
5. Only after that works, flip Stripe to **Live mode**, replace
   `STRIPE_SECRET_KEY` and the two price IDs with their live-mode versions
   (test and live Price IDs are different, even for the "same" product),
   and redeploy

## What this does and doesn't do yet
- Unlocks are stored in `localStorage` on that device — same model the rest
  of the game already uses for best score/level. If someone reinstalls or
  switches devices, they'd need to re-verify a purchase manually; there's
  no account system to sync ownership across devices.
- There's no Stripe webhook yet. Right now, the unlock happens when the
  player is redirected back and the page calls `/api/verify-session`. If
  someone closes the tab mid-redirect after paying, the charge would go
  through but the unlock might not register. This is rare, and worth
  living with for an MVP — if it becomes a real support headache once
  you have paying players, the fix is adding a Stripe webhook + Cloudflare
  KV storage so the unlock is recorded server-side regardless of what the
  browser does. Say the word if you want that built once you're at that
  stage.
- I could not test any of this against a live Stripe account — I have no
  network access in this environment. The code follows Stripe's documented
  API exactly, but you are the first to actually run it. Test mode first,
  always.

## 5. Global leaderboard setup (one-time)
Two more functions ship in this zip: `functions/api/submit-score.js` and
`functions/api/leaderboard.js`. They need a Cloudflare KV namespace to
store scores in (KV is Cloudflare's simple key-value database — free tier
covers this easily).

1. In the Cloudflare dashboard: **Storage & Databases > KV** > Create a
   namespace. Name it anything, e.g. `flux-leaderboard`.
2. Go to your Pages project > **Settings > Functions > KV namespace
   bindings** > Add binding.
   - Variable name: `LEADERBOARD` (must match exactly, all caps)
   - KV namespace: the one you just created
3. Redeploy (same as with the Stripe env vars — a fresh deploy is needed
   to pick up the new binding).

That's it — no other config. Once bound:
- Every game-over run silently reports the player's best score to
  `/api/submit-score`.
- **Country is never taken from the player's device or their profile
  dropdown.** Cloudflare stamps each request with the country its IP
  address resolves to, server-side, and that's the only value stored —
  so nobody can fake their flag on the board.
- **Display name is whatever the player has set in their profile.**
  There's one stored row per player (keyed to a random ID saved on their
  device, not their IP), so renaming in their profile immediately updates
  their name everywhere on the board going forward, without creating a
  duplicate entry or losing their score history.
- Tapping GLOBAL LEADERBOARD now shows the real top 25 scores and which
  country is currently leading, instead of the old "coming soon" message.

Same caveat as the Stripe code: I couldn't test this against a live
Cloudflare KV store from here. Deploy it, play a round, and confirm your
own run shows up on the board before treating it as launch-ready.
