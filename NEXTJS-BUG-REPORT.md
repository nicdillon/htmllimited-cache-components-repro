# Next.js bug: `cacheComponents` + `<Suspense>` body + dynamic `generateMetadata` ships rejected-Suspense prerender to bot UAs

**Next version:** 16.2.6
**Repro repo:** https://github.com/nicdillon/htmllimited-cache-components-repro
**Live bug-active deployment:** https://htmllimited-cache-components-repro.vercel.app/item/abc123
**Related (not duplicates):** [discussion #85560](https://github.com/vercel/next.js/discussions/85560), [issue #79313](https://github.com/vercel/next.js/issues/79313)

## TL;DR

With `cacheComponents: true`, an `async generateMetadata` that reads route params, and a `<Suspense>`-wrapped page body, Next ships a broken prerender for any bot UA that takes the blocking-in-head render path. The metadata Suspense boundary rejects, the body falls back to its `Loading…` placeholder, and dynamic `<title>` / `<meta>` never reach `<head>`. On Vercel the broken shell gets edge-cached and served indefinitely, and the cache key isn't strictly per-UA so one broken render poisons subsequent requests from other UAs. AhrefsBot additionally surfaces as HTTP 500 on Vercel only.

## Reproduction

Four ingredients:

1. `cacheComponents: true` in `next.config.ts`
2. `app/item/[id]/page.tsx` with `async generateMetadata` that awaits `params`
3. The page body wrapped in `<Suspense fallback={…}>` and awaiting `params` inside
4. A request from a bot UA classified as HTML-limited or DOM-bot

The minimum repro is ~50 lines in the linked repo. Run `npm install && npm run build && npx next start -p 3001`, then hit `/item/abc123` with the test UAs (any of Twitterbot, Bingbot, Googlebot, AhrefsBot, PerplexityBot).

## Symptom fingerprint

Broken responses contain React's rejected-Suspense signal and a hidden content div:

```html
<head>… (no dynamic <title>, <meta og:|twitter:|description>) …</head>
<body>
  <p>Loading…</p>
  …
  <script>$RX("B:0","<error-digest>")</script>
  <div hidden id="S:1"><main>… correct per-id content …</main></div>
</body>
```

The content was rendered correctly (so the fetch/render pipeline ran to completion), but ends up in a `hidden` div that only client-side JS would unhide. Crawlers don't run that JS, so they see `Loading…` and no metadata.

## Diagnosis

Next has three independent UA classifiers in `packages/next/src/...`:

1. `HTML_LIMITED_BOT_UA_RE` — built-in default list (Twitterbot, Bingbot, applebot, Slackbot, facebookexternalhit, LinkedInBot, Discordbot, etc.). In `shared/lib/router/utils/html-bots`.
2. `HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i` — DOM bots; only Googlebot. In `shared/lib/router/utils/is-bot`.
3. User's `htmlLimitedBots` config — replaces (1) **only inside** `shouldServeStreamingMetadata()`, **not inside** `isHtmlBotRequest()`. In `server/lib/streaming-metadata`.

`shouldServeStreamingMetadata(userAgent, htmlLimitedBots)` falls back to `htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING`. `isHtmlBotRequest()` calls `getBotType()` against the built-in regexes directly. The two predicates can therefore disagree about whether a given request needs blocking-in-head metadata.

But the classifier asymmetry is **only one of three failure paths we observed**. The underlying issue is that the blocking-in-head render path fails to reconcile with the deferred `<Suspense>` body produced by `cacheComponents` — regardless of which classifier brought a request there. The metadata Suspense rejects, the body falls back to `Loading…`, and the prerender ships with empty head + hidden content + `$RX` signal.

## Evidence: three distinct paths produce the same rejected-Suspense result

Fresh Vercel deployment with `cacheComponents: true`, `<Suspense>` body, async `generateMetadata`, and `htmlLimitedBots: /Googlebot|AhrefsBot|PerplexityBot/i`:

| UA | Path Next takes | Status | `<head>` meta | `$RX` in body |
|----|-----------------|--------|---------------|---------------|
| Chrome | Streaming | 200 | absent (streamed to body, client reorders) | No |
| Twitterbot / Bingbot | Built-in default list | 200 | absent | **Yes** (see cache section) |
| Googlebot | DOM-bot path | 200 | **absent** | **Yes** |
| AhrefsBot (in user override) | User override | **500** Vercel only | — | — |
| PerplexityBot (in user override) | User override | 200 | **absent** | **Yes** |
| GPTBot / ClaudeBot / SemrushBot (no list) | Streaming | 200 | absent (streamed to body) | No |

Same matrix locally with `next start`: only the user-override path (AhrefsBot, PerplexityBot) fails locally with empty 200s. The DOM-bot path (Googlebot) and built-in path (Twitterbot, Bingbot) render correctly with `next start`. They fail on Vercel — but at least some of those failures are caused by edge-cache poisoning rather than the path itself (see below).

## Vercel-specific amplification: edge cache poisoning across UAs

Broken PPR shells on Vercel get edge-cached (`x-vercel-cache: HIT`, `x-nextjs-prerender: 1`). On the bug-active deployment, Twitterbot, Bingbot, and Googlebot all returned the same broken shell with `age: ~2146s` — identical age across UAs suggests they HIT the **same** cached entry, originally populated by a broken render through one of the failing paths.

On a fresh deployment without `htmlLimitedBots`, **Twitterbot and Bingbot render correctly through the built-in path** (verified: 6 in-head meta tags, no `$RX`, `cache-control: private, no-cache, no-store`, `x-vercel-cache: BYPASS`). Their "failure" on the bug-active deployment was cache pollution, not a path failure.

Two observations:

- **Vercel's edge cache key for prerenders is not strictly per-UA.** A broken render through any failing path (user override or DOM-bot) can poison the cache for UAs whose own path would have rendered correctly.
- **Next emits `cache-control: private, no-cache, no-store` on responses through the working blocking-in-head path** (verified on fresh deployment via the middleware workaround), but **does not emit those headers on the broken-path responses**, so the broken responses are cacheable. The broken responses also contain `$RX("B:` — a Suspense rejection escaping into a cache-stable crawler response.

## Independent confirmation: the path classifier determines the failure

Rewriting at-risk UAs to `Twitterbot/1.0` in `middleware.ts` (and removing `htmlLimitedBots` from `next.config.ts`) routes every crawler through the built-in default-list path. On a fresh Vercel deployment every rewritten UA then returns:

- `HTTP 200`
- 6 dynamic `<meta>` tags in `<head>`
- No `$RX("B:` signal
- `cache-control: private, no-cache, no-store, must-revalidate`
- `x-vercel-cache: BYPASS`

This rules out the bug being inherent to `cacheComponents` + `<Suspense>` body + async `generateMetadata`. The built-in default-list path **can** produce a correct prerender for that combination. The user-override and DOM-bot paths **cannot**, even though they share the same input.

## Open questions for the Next.js team

1. **Why does the user-override path fail when the built-in default-list path — which receives effectively the same classification — succeeds?** The asymmetry between `shouldServeStreamingMetadata` (sees override) and `isHtmlBotRequest` (doesn't) is the obvious suspect, but we haven't traced it through the renderer to confirm.

2. **Why does the DOM-bot path (Googlebot) produce the same rejected-Suspense outcome as the user-override path, given it's a completely separate predicate?** Both paths fail at the same observable step but reach it through entirely different classifiers.

3. **Why does AhrefsBot 500 on Vercel while PerplexityBot returns an empty 200, given both hit the user-override path with the same regex match and same config?** Same code path, different fingerprints — but only on Vercel. Locally both produce empty 200s. The 500 has `x-matched-path: /500`, `content-disposition: inline; filename="500"`, and `x-vercel-cache: MISS`, suggesting the failure surfaces late in the edge response pipeline rather than at the renderer level.

4. **Should the renderer ever emit a cacheable response (no `private, no-store` headers) containing `$RX("B:`?** That signal indicates a Suspense boundary rejected during the prerender, which seems incompatible with the response being a cache-stable artifact served to crawlers.

## Workaround currently deployed for the customer

Middleware rewrites at-risk crawler UAs (AhrefsBot, SemrushBot, GPTBot, ClaudeBot, OAI-SearchBot, PerplexityBot, Bytespider, **and Googlebot**) to `Twitterbot/1.0`; `htmlLimitedBots` is removed from `next.config.ts`. Forces every crawler through the working built-in default-list path. Verified end-to-end on a fresh Vercel deployment. Documented as a stopgap pending the upstream fix.

The full workaround diff lives on the `middleware-fix` branch of the repro repo.
