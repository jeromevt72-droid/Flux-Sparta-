# FLUX RC2.8.2 — D-35 Pilot restore code
## Store stays closed · no live keys · not device-tested yet

### The defect
Owner-observed (iPhone, Sept 22): the Home Screen icon asked for a new FLUX ID
while Safari on the same phone still had pilot TITAN. On iOS, Safari and each
installed icon keep separate storage; a pilot lived only where it was created,
and nothing could bring it back.

Audit of RC2.7 vs RC2.8.1 (game, Gateway, worker, service worker, welcome
redirect): **no code in either version erases a pilot.** The Gateway already sat
at "/" in RC2.7, so the RC2.8.1 update did not move anything. Most likely cause:
the icon was installed on a build before RC2.7 (Gateway at /welcome/), so the
pilot was saved in a different storage context. Not provable from code alone;
the fix covers every cause (icon vs Safari, iOS clearing storage, new phone).

### The fix
- Menu → RESTORE CODE: `FX1-<playerId>-<CHECK>`, hidden until SHOW CODE, Copy and
  Save/Send, privacy warning. Whether the pilot is restorable is asked of the
  server (older builds never saved the tag locally).
- Name screen → HAVE A RESTORE CODE?
- `POST /api/restore-check` (new, read-only, no-store): answers only for the exact
  secret id; returns name, tag, country, bests, skins. Unknown code changes nothing.
- Confirm screen shows both pilots and the current pilot's own code first.
- Every key changes through one journal written before anything else; the next
  launch finishes an interrupted restore, a storage failure rolls everything back.
- Personal bests are replaced by the restored pilot's server bests (audit find:
  otherwise one pilot's best could be uploaded under another pilot).
- Refused during a run and while a purchase is being completed.
- Wording aligned: Gateway FAQ and "Works offline" card, shop note, Privacy
  Policy, Terms.

### Verification
- Release gate: **27/27 suites pass** (`node run-all-tests.mjs`).
- New `test-d35-restore.mjs`: 117 checks on the real worker and real game page,
  plus **12 negative controls, all caught** (each must fail on its own named check).
  Fails on RC2.8.1, as it should.
- New `test-d35-browser.mjs`: real Chromium, separate "Safari" and "icon" storage,
  the exact reported case, phone and iPad sizes, zero page errors.
- **Not run:** real iPhone, real iPad, Cloudflare deployment, legal review of wording.

### Accepted limits
The restore code works like a key: anyone holding it can play as that pilot.
Player IDs published before A-1 cannot be revoked. If both the code and the
device data are lost, the pilot cannot be restored.

### Files changed from RC2.8.1
`worker.js`, `public/play/index.html`, `public/index.html`, `public/privacy.html`,
`public/terms.html`. `sw.js`, `wrangler.jsonc`, `admin.html` unchanged.
