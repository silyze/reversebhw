# reversebhw

A headless TypeScript SDK for [BlackHatWorld](https://www.blackhatworld.com)'s XenForo 2 web API.

Built on [Bun](https://bun.sh), [wreq-js](https://www.npmjs.com/package/wreq-js) (browser-grade TLS impersonation), and [cheerio](https://cheerio.js.org). Everything — WAF clearance, Turnstile, registration timers, pagination — is handled inside the SDK; you just call methods.

## Features

- **Account lifecycle** — register, email confirmation, login, username validation
- **Reading** — "What's new" feed, thread pages, full pagination support
- **Posting** — reply, drafts, reactions, quotes, edit, delete, report
- **Cloudflare WAF** — interstitials are solved and retried transparently per request
- **Turnstile** — solved via a pluggable, captcha-agnostic solver interface
- **Anti-bot defenses mapped** — submission timer, honeypot traps, obfuscated field names, decoy responses — all handled, and decoys throw instead of failing silently

## Requirements

- Bun ≥ 1.3 (or Node ≥ 20 for the built bundle)
- A captcha solver for live traffic (any `CaptchaSolver` implementation; an [uncaptcha.io](https://uncaptcha.io) adapter ships at `reversebhw/solvers/uncaptcha`)
- A residential proxy is strongly recommended — BHW's Cloudflare is hostile to datacenter IPs

## Setup

```bash
bun install
bun run build    # dist/ — ESM bundle + type declarations
bun run check    # typecheck
bun test         # 72 tests
```

## Quick start

```ts
import { BhwClient } from "reversebhw";
import { Uncaptcha } from "reversebhw/solvers/uncaptcha";

const client = await BhwClient.create({
  proxy: "http://user:pass@host:port",
  captchaSolver: new Uncaptcha({
    apiKey: process.env.UNCAPTCHA_API_KEY!,
    proxy: "http://user:pass@host:port", // solver mints tokens from your IP
    timeoutMs: 120_000,
  }),
});

try {
  // Register — form fetch, Turnstile, and the anti-bot timer are automatic.
  const result = await client.register({
    username: "TestAcc",
    email: "Test@example.com",
    password: "a-strong-password",
    dob: { month: 3, day: 15, year: 1998 },
  });
  console.log(result.redirect); // → .../register/complete

  // Confirm via the link BHW emails you.
  const confirmed = await client.confirmEmail(
    "https://www.blackhatworld.com/account-confirmation/wrenhalloway.123/email?c=…",
  );
} finally {
  await client.close();
}
```

## Reading

### "What's new" feed

BHW's rolling feed of recently bumped threads, capped at 10 pages. The
`resultSetId` rotates between crawls, so reuse the one from page 1 within a crawl.

```ts
const p1 = await client.whatsNew();
for (const item of p1.items) {
  console.log(item.threadId, item.title, item.forumName, item.replyCount);
}

const p2 = await client.whatsNew({ page: 2, resultSetId: p1.resultSetId });
// item fields: threadId, title, slug, url, forumName/forumUrl,
//              author/authorId, startedAt, lastPoster/lastPosterId/lastPostAt,
//              replyCount, viewCount
```

### Threads and posts

```ts
// Slug is optional — XF2 canonicalizes any value to the thread's real URL.
const page = await client.viewThread(1824185);

page.thread.title;                 // "[JOURNEY] Adult FORUM from 0 to …"
page.thread.forumName;             // "My Journey Discussions"
page.pagination;                   // { currentPage: 1, totalPages: 3, nextPageUrl, lastPageUrl }

for (const post of page.posts) {
  console.log(post.postId, post.author, post.authorId, post.date, post.permalink);
  // post.messageHtml — rich body HTML
}

// Paginate
for (let n = 1; n <= page.pagination.totalPages; n++) {
  const p = await client.viewThread(1824185, { page: n });
  // …20 posts per page, verified unique across pages
}
```

## Posting

Requires a logged-in session (`client.login`).

```ts
await client.login({ username: "you", password: "…" });

await client.reply({
  threadId: 1824185,
  slug: page.thread.slug,          // from viewThread
  messageHtml: "<p>Nice writeup.</p>",
  parentId: page.posts[0].postId,  // optional — quote-reply
  attachmentHash: page.attachmentHash,
});

await client.react({ postId: 20873763, reactionId: 1 }); // 0–6 palette
const { quoteHtml } = await client.quote({ postId: 20873763 });
await client.editPost({ postId: 20873763, messageHtml: "<p>Edited.</p>" });
await client.deletePost({ postId: 20873763, reason: "cleanup" });
await client.reportPost({ postId: 20873763, message: "spam" });
await client.saveDraft({ threadId: 1824185, slug, messageHtml: "<p>WIP</p>" });
```

## Resuming sessions from cookies

Skip the login flow entirely by seeding a session from exported cookies —
e.g. a real browser's export or a previous client's jar:

```ts
// Persist after login
const a = await BhwClient.create({ proxy, captchaSolver });
await a.login({ username: "you", password: "…" });
const cookies = a.exportCookies(); // [{ name, value }, …] — xf_user, xf_session, …
await a.close();

// Resume later (array or "name=value; …" string both accepted)
const b = await BhwClient.create({ proxy, cookies });
// → authenticated immediately; reply/react/account pages work
```

`cf_clearance` is IP-bound — reuse exported cookies through the same proxy
egress, or let the client's WAF resilience mint a fresh one.

## Captcha solvers

The core SDK knows only the `CaptchaSolver` interface, you can write your own adapters in
`src/solvers/`:

```ts
import type {
  CaptchaChallenge,
  CaptchaSolution,
  CaptchaSolveOptions,
  CaptchaSolver,
} from "reversebhw";

class MySolver implements CaptchaSolver {
  async solve(
    challenge: CaptchaChallenge,
    options?: CaptchaSolveOptions,
  ): Promise<CaptchaSolution> {
    // challenge.type: "turnstile" | "cloudflare-waf" | "cloudflare-waf-auto"
    // …
  }
}
```

Two things BHW verifies that your solver must get right:

- **IP consistency** — Turnstile tokens and WAF clearances should be minted
  from the same IP that submits them. Pass your proxy to the solver.
- **`action` binding** — BHW's widget uses `data-action="xf_register"`, which
  is embedded in the token and checked server-side. The SDK extracts and
  forwards it automatically.

## Behavioral notes

- **Registration takes ~25s on purpose.** BHW's form carries `data-timer="21"`;
  faster submissions get a decoy `"Your changes have been saved."` response and
  no account. The SDK waits automatically and **throws**
  `BhwRegistrationError` if it still detects a decoy.
- **Honeypots change shape.** BHW rotates trap fields (plain `email`/`password`
  inputs, extra emails). The SDK submits exactly what a real browser would.
- **`confirmEmail` just needs the link.** Any session can visit it; a fresh
  `BhwClient` works if you didn't keep the registering one.

## Package layout

| Import | Contents |
| --- | --- |
| `reversebhw` | `BhwClient`, sessions, WAF helpers, XF2 helpers, all flow functions (`registerBhwAccount`, `fetchBhwThread`, `fetchBhwWhatsNew`, `loginBhwAccount`, post ops), types |
| `reversebhw/solvers/uncaptcha` | `Uncaptcha`, `UncaptchaError`, `UncaptchaOptions` |

Low-level building blocks if you need them:

```ts
import {
  createBhwSession,          // wreq-js session with cookie jar + config
  wafResilientTransport,     // wrap any transport with WAF auto-clear
  isCloudflareChallenge,
  clearCloudflareWaf,
  parseBhwThreadPage,        // parse without fetching
  parseBhwWhatsNewPage,
  parseXfPagination,
  extractXfToken,
} from "reversebhw";
```

## Error classes

`BhwWafError` · `BhwRegistrationError` · `BhwLoginError` · `BhwThreadError` ·
`BhwPostError` · `BhwWhatsNewError` · `UncaptchaError` · `XfProtocolError`

## Development

```bash
bun run check   # tsc --noEmit (strict, exactOptionalPropertyTypes)
bun test        # bun test — 72 tests, fixture-based, no network
bun run build   # clean + bundle (index + solvers/uncaptcha) + declarations
```

`src/` layout: `client.ts` (facade), `session.ts` (transport), `waf.ts`
(Cloudflare), `captcha.ts` (solver boundary), `xf2.ts` (XF2 envelope +
pagination + dates), `register.ts`, `login.ts`, `thread.ts`, `post.ts`,
`whatsnew.ts`, `solvers/uncaptcha.ts`.
