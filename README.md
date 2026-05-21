# Repro: `htmlLimitedBots` + `cacheComponents` + `<Suspense>` body breaks metadata rendering in prod

Minimal reproduction for an interaction bug in Next.js 16 with App Router, Cache Components, and `<Suspense>`-wrapped page bodies. UAs matched by a user-specified `htmlLimitedBots` regex — but not also matched by Next's built-in default bot lists — cause the metadata Suspense boundary to fail in production builds, dropping all dynamic `<meta>` tags from the response.

**Reproduces on:** Next.js 16.0.1 (per [discussion #85560](https://github.com/vercel/next.js/discussions/85560)) and Next.js 16.2.6 (this repo).
**Mode:** Production build only (`next build` + `next start`). `next dev` works correctly.
**Related:** [#85560](https://github.com/vercel/next.js/discussions/85560), [#79313](https://github.com/vercel/next.js/issues/79313)

---

## Setup

```bash
npm install
npm run build
npm start
```

The route under test is `/item/[id]`. It uses `cacheComponents: true`, async `generateMetadata` (cached via `'use cache: remote'`), and wraps the body in `<Suspense>` — exactly the shape described in the [streaming-metadata-with-cache-components docs](https://nextjs.org/docs/app/api-reference/functions/generate-metadata#with-cache-components).

`next.config.ts` contains a toggle for the bug:

```ts
const config: NextConfig = {
  cacheComponents: true,
  htmlLimitedBots: /Googlebot|AhrefsBot|PerplexityBot/i, // remove this line to disable
};
```

---

## Observation 1 — documented behavior (not a bug)

With `htmlLimitedBots` removed and any ordinary browser UA, `generateMetadata` output renders inside `<body>`, not `<head>`:

```bash
URL="http://localhost:3000/item/abc123"
curl -sL -A "Mozilla/5.0 Chrome" "$URL" | python3 -c "
import re, sys
html = sys.stdin.read()
head = re.search(r'<head[^>]*>(.*?)</head>', html, re.DOTALL).group(1)
body = re.search(r'<body[^>]*>(.*)</body>', html, re.DOTALL).group(1)
print('HEAD og/twitter/desc:', len(re.findall(r'<meta[^>]*(?:og:|twitter:|description)', head)))
print('BODY og/twitter/desc:', len(re.findall(r'<meta[^>]*(?:og:|twitter:|description)', body)))"
```

Output:

```
HEAD og/twitter/desc: 0
BODY og/twitter/desc: 6
```

This is expected: `params` is request-time data, so the metadata-resolving Suspense streams alongside the deferred body. React 19 hoists the tags client-side, which works for JS-running browsers but not for non-JS crawlers.

---

## Observation 2 — the bug

With `htmlLimitedBots: /Googlebot|AhrefsBot|PerplexityBot/i` enabled, three distinct outcomes appear depending on which classification path a UA hits:

| UA | Matched by user override? | Matched by built-in default list? | Matched by DOM-bot regex? | Result |
|----|---|---|---|---|
| `Twitterbot/1.0` | no | yes | no | **HEAD meta=6** — works via default-list path |
| `Bingbot/2.0` | no | yes | no | **HEAD meta=6** — works via default-list path |
| `Googlebot/2.1` | yes | no | **yes** | **HEAD meta=6** — works via DOM-bot path |
| `AhrefsBot/7.0` | yes | no | no | **HEAD meta=0, BODY meta=0** — broken |
| `PerplexityBot/1.0` | yes | no | no | **HEAD meta=0, BODY meta=0** — broken |
| `GPTBot/1.0` | no | no | no | meta in BODY (default streaming) |
| `Mozilla/5.0 Chrome` | no | no | no | meta in BODY (default streaming) |

The two "broken" responses are still HTTP 200 on `next start`, but contain no dynamic metadata anywhere and emit React's rejected-Suspense signal in the body:

```
$RX("B:0","3849737756")
```

The body falls back to the `Loading…` Suspense fallback; the actual page content is rendered into a hidden `<div hidden id="S:1">` instead of the streamed slot. Response headers include `x-nextjs-postponed: 1`.

Under Vercel's edge proxy this same malformed response is reported as **HTTP 500** with `content-disposition: inline; filename="500"` (see [#85560](https://github.com/vercel/next.js/discussions/85560)).

### Verification command

```bash
URL="http://localhost:3000/item/abc123"
for UA in \
  "Twitterbot/1.0" \
  "Mozilla/5.0 (compatible; Bingbot/2.0)" \
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" \
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)" \
  "PerplexityBot/1.0" \
  "GPTBot/1.0"
do
  echo "=== $UA ==="
  curl -sL -A "$UA" "$URL" | python3 -c "
import re, sys
html = sys.stdin.read()
head_m = re.search(r'<head[^>]*>(.*?)</head>', html, re.DOTALL)
body_m = re.search(r'<body[^>]*>(.*)</body>', html, re.DOTALL)
head = head_m.group(1) if head_m else ''
body = body_m.group(1) if body_m else ''
print('  HEAD meta:', len(re.findall(r'<meta[^>]*(?:og:|twitter:|description)', head)))
print('  BODY meta:', len(re.findall(r'<meta[^>]*(?:og:|twitter:|description)', body)))
print('  rejected suspense in body:', '\$RX' in html)"
done
```

---

## Why the asymmetry exists

Next.js maintains three independent UA classification regexes:

1. **`HTML_LIMITED_BOT_UA_RE`** — built-in default list. Source: [`packages/next/src/shared/lib/router/utils/html-bots.ts`](https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/html-bots.ts). Covers Twitterbot, Bingbot, applebot, Slackbot, facebookexternalhit, LinkedInBot, Discordbot, etc.

2. **`HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i`** — DOM-bot path. Only matches Googlebot. Source: `packages/next/src/shared/lib/router/utils/is-bot.ts`.

3. **`htmlLimitedBots` config** — user override.

`shouldServeStreamingMetadata(userAgent, htmlLimitedBots)` uses `htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING`, so a user-specified config replaces #1 *for that function*. However, `isHtmlBotRequest(req)` calls `getBotType(ua)` directly against the built-in regexes, ignoring the user override.

The empirical effect: default-list bots (Twitterbot, Bingbot, ...) and Googlebot receive blocking-in-head metadata through a code path that handles cacheComponents + Suspense correctly. UAs that match *only* the user override go through a different code path that fails to reconcile the metadata Suspense boundary with the deferred body Suspense, rejecting the boundary and dropping metadata.

This means most SEO/AI crawlers users would plausibly add to `htmlLimitedBots` — GPTBot, ClaudeBot, OAI-SearchBot, AhrefsBot, SemrushBot, PerplexityBot, Bytespider — all sit in the broken class.

---

## Repro shape

```
app/
  item/
    [id]/
      page.tsx       # cacheComponents page: cached generateMetadata + <Suspense>body
  layout.tsx
  page.tsx
next.config.ts        # cacheComponents: true, htmlLimitedBots toggle
```

The route component pushes `params` resolution inside the Suspense boundary to satisfy Next 16.2.x's stricter prerender rules. The original shape that worked on 16.0.1 (`await props.params` directly in the page component) fails the build on 16.2.x with:

> Route "/item/[id]": Uncached data was accessed outside of `<Suspense>`. This delays the entire page from rendering, resulting in a slow user experience.

---

## Environment

- Next.js: **16.2.6**
- React: **19.2.4**
- Node: **22.x**
- OS: Linux

## License

MIT
