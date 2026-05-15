# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

Phone-first static **PWA** for turning a photo of a Serbian fiscal fuel receipt into a
signed one-page A4 statement (ИЗЈАВА) in PDF, for reimbursement of commuting fuel
costs. **100% client-side, no backend.** Deployed to
`https://acosonic.github.io/fiskalac/` via GitHub Pages — `main` branch is the live
target. Also served locally at `https://acop.local/fiskalac/` (Apache, self-signed
cert) for development.

UI is **Serbian (Cyrillic)** (`lang="sr"`). Keep it that way. Comments and this
doc are English.

## Layout (the parts that matter)

- `index.html` — UI shell: 3-step flow (Рачун → Провера → PDF). Single page, no
  routing. All JS lives in `app.js`. Header has the install button + logo.
- `app.js` — all the logic. Sections (grep `── ──` separators):
  - Profile + localStorage (`fisk_ime`, `fisk_firma`, `fisk_grad`, `fisk_email`,
    `fisk_potpis`) — nothing hardcoded, user enters everything once, saved per
    origin.
  - Image helpers (`canvasToGray`, `blurCanvas`, `floatToCanvas`, `normalize` with
    **percentile-clip** — crucial for QR decode to work).
  - `flattenGray(src, maxDim)` — grayscale + divide-by-blurred-copy + clip-normalize.
    The foundation for both `cleanReceipt` and `processSignature`.
  - `cleanReceipt(src)` — receipt for the PDF: flatten → adaptive threshold →
    `autoCrop` → white border.
  - `processSignature(file)` — signature from a paper photo: flatten →
    connected-components (`inkComponents`) → largest blob + nearby parts →
    crop → ink opaque + paper transparent. **Don't replace with a simple
    luminance threshold** — that fails on blue ink and paper shadows.
  - QR: `decodeReceiptQR(src)` — tries zbar-wasm at several downscales
    (`[1600, 1200, 2000, 1000, 1400, 1800, 1100]`). `biFromVl(vl)` parses the
    Serbian SUF QR binary header: version byte must be 3, БИ is `u32 LE @ offset 17`.
  - PDF: `buildIzjavaCanvas({ime, firma, grad, bi, datum, mesec, godina, danas,
    receipt, potpis})` composes a 1654×2339 A4 canvas (Cyrillic justified text,
    signature placed above the line). jsPDF wraps it as a single JPEG-in-PDF page.
  - `shareOrMail` — `navigator.share` with the PDF file (Web Share API);
    fallback to download + `mailto`. Needs HTTPS secure context.
  - PWA: `beforeinstallprompt` + manual-instructions fallback (iOS/desktop).
    SW registered on `load`.
- `style.css` — visual layer. Variables in `:root` (`--accent: #0f766e`, etc.).
- `manifest.json` — PWA manifest. Theme `#0f766e`, relative icon paths.
- `service-worker.js` — network-first for HTML, stale-while-revalidate for
  same-origin static. **Bump `CACHE_VERSION` after every shell change**
  (it's the one signal users get on reload).
- `vendor_js/` — `zbar-wasm.js` + `zbar.wasm` + `jspdf.umd.min.js`. Vendored,
  no CDN.
- Icons: `favicon.svg` (= `icon-source.svg`), `favicon.ico`, `favicon-96x96.png`,
  `apple-touch-icon.png` (180), `web-app-manifest-192x192.png`,
  `web-app-manifest-512x512.png`. Icon design: Serbian flag (wavy tricolor) +
  car + stylized QR.

## GitHub workflow

- Repo: **github.com/acosonic/fiskalac** (public). `gh` is authed as `acosonic`.
- Deploy: `git push origin main` → GitHub Pages rebuilds in ~30–60 s. Check
  status with `gh api repos/acosonic/fiskalac/pages --jq '.status'` (`built` when
  done) or just `curl https://acosonic.github.io/fiskalac/`.
- Pages "About" homepage is set to the live URL; footer in `index.html` links
  back to the repo.
- **Don't push `_old/` or `up/`** — both are in `.gitignore`. `_old/` has the
  original vulnerable PHP app + the user's real historical receipt images.
  `up/` is the local debug-upload helper.

## Local dev

- App: `https://acop.local/fiskalac/` (Apache vhost, self-signed cert).
- HTTPS is required to test the **camera, Web Share, PWA install** — they all
  need a secure context. `http://` won't do.
- Headless Chrome for tests: pass `--ignore-certificate-errors` for `acop.local`
  (self-signed). Don't use `--virtual-time-budget` alone — it doesn't wait for
  async without an action flag. Reliable pattern: background Chrome with
  `--user-data-dir=/tmp/...`, poll for a result file, kill by PID. See past
  transcripts for examples.
- Apache here uses **mod_php** (not php-fpm). `.htaccess` `php_value` works.
  This matters only for `up/index.php` which raises `upload_max_filesize` to
  25M (default is 2M, smaller than a phone photo).

## up/ — local upload helper (gitignored)

`up/index.php` is a tiny "send a photo from my phone to this machine" tool. Open
`https://acop.local/fiskalac/up/` on the phone, tap the camera button, the
photo lands in `up/` for inspection (useful when iterating on image processing).
**Not part of the PWA, not deployed to Pages, not committed to GitHub.**

## Image-processing gotchas (learned the hard way)

- **JS QR libraries (jsQR, zxing-js) are too weak** for these dense Serbian
  fiscal QR codes. Only zbar-class decoders work. Use **zbar-wasm**.
- **zbar-wasm is scale-sensitive** — the same QR decodes at one downscale and
  not another. `decodeReceiptQR` retries several scales; one always hits for
  reasonable phone photos.
- **`flattenGray`'s `normalize` must be percentile-clip** (drops top/bottom
  ~0.6%), not min/max stretch. Min/max leaves the QR modules gray on a faint
  scan and the JS decoders fail. (zbar-wasm with percentile-clip works.)
- For **the signature**: do **not** use a fixed luminance threshold for
  paper-vs-ink. Blue ink luminance is mid-range, and paper has shadows that
  beat the threshold. Use `flattenGray` + `inkComponents` (connected components)
  + largest-blob-and-nearby. The faraway speck or shadow smudge stays out of
  the bbox.
- **Date is not in the QR binary** in plain form (verified by scanning for
  .NET ticks / Unix timestamps — nothing matches the receipt date). We used to
  proxy the PURS verification page through `purs.php` to get the exact date,
  but that was dropped — date now defaults to today and the user can edit.

## Service worker

- `CACHE_VERSION` is the only thing users see updated. Bump it on every shell
  change (HTML / app.js / style.css / icons / manifest).
- Strategy: network-first for navigations, stale-while-revalidate for static,
  cross-origin untouched. No CDNs — everything is `vendor_js/` self-hosted.
- `.htaccess` sets `Cache-Control: no-cache, no-store, must-revalidate` on
  `service-worker.js` so the browser always fetches the latest SW. GitHub
  Pages doesn't honor `.htaccess` but it caches the SW for ~10 min anyway,
  which is fine.

## Icon regeneration

`icon-source.svg` is the only icon file edited by hand. To regen all PNGs/ICO
derivatives from it, follow the recipe in `~/websites/qrpay/ikonica.md` —
**read that file before touching any icon**. Short version:

```bash
chromium --headless --no-sandbox --hide-scrollbars \
  --window-size=1024,1024 --default-background-color=00000000 \
  --screenshot="$(pwd)/_master.png" "file://$(pwd)/icon-source.svg"
magick _master.png -crop 512x512+0+0 +repage _m512.png && rm _master.png
magick _m512.png -filter Lanczos -resize 512x512 web-app-manifest-512x512.png
magick _m512.png -filter Lanczos -resize 192x192 web-app-manifest-192x192.png
magick _m512.png -filter Lanczos -resize 180x180 apple-touch-icon.png
magick _m512.png -filter Lanczos -resize 96x96  favicon-96x96.png
magick _m512.png -filter Lanczos -resize 32x32  _f32.png
magick _m512.png -filter Lanczos -resize 16x16  _f16.png
magick _f16.png _f32.png favicon-96x96.png favicon.ico
rm -f _f16.png _f32.png _m512.png
```

Then bump `CACHE_VERSION`.

## Privacy stance

The receipt photo, signature, and personal fields stay in the browser —
nothing is uploaded anywhere. `localStorage` for the profile; canvases for
processing; `navigator.share` for the PDF (the OS share sheet handles where
it goes after). No analytics, no third-party scripts, no fonts from Google.
If you add a feature, keep it that way.

## Common edits

- **Tune the QR decode scales** — `decodeReceiptQR` in `app.js`. If a real
  phone photo doesn't decode at any of the listed scales, add one. Watch out
  for `--virtual-time-budget`; test reliably.
- **Adjust signature alpha mapping** — in `processSignature`, the line
  `lum >= 170 ? 0 : lum <= 95 ? 255 : ...`. Lower the cutoff if faint pencil;
  raise it if shadows still bleed through.
- **Receipt cleanup** — `cleanReceipt` uses `lat-style` adaptive threshold via
  flatten + local mean. `autoCrop` uses projection profile with hardcoded
  density thresholds; raise if you see big white borders, lower if it crops
  into text.
- **Layout / izjava text** — `buildIzjavaCanvas` in `app.js`. The A4 canvas is
  1654×2339 (≈200 dpi). Adjust constants (`M` margin, `lineH`, etc.) carefully —
  the receipt's `availH = H - M - ry` is what stops it from overflowing.
- **Add a new profile field** — append to `PROFILE_KEYS` and add the input to
  `index.html` (just before signature). `loadProfile`/`saveProfile` handle the
  rest automatically.

## Memory

Project-related memory lives in
`~/.claude/projects/-home-acop-Desktop/memory/` (and is symlinked from the
fiskalac project folder so `--resume` and memory access both work from
`~/websites/fiskalac/`).

Notable entries:
- `user-identity.md` — who the user is.
- `izjava-workflow.md` — the broader workflow (CLI `izjava.sh` + this web app).
