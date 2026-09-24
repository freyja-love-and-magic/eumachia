# eumachia — Development Documentation

## Overview

eumachia serves the interactive **Pay Now** page for an invoice published to
BDO by Gelder/getpayed, and drives the Stripe payment through Addie.

**Location**: `/eumachia/`
**Stack**: Node 18+, Express 4, ESM. Filesystem persistence, no database.
**Extracted from allyabase** (was `allyabase/deployment/eumachia/`) so it can
be deployed on its own — see "History".

## Why it exists separately from savage

savage strips all JavaScript from anything it serves (it renders arbitrary
published SVG, so it has to). A Stripe checkout is JavaScript end to end, so
it cannot live in a savage-served page. eumachia is the escape hatch: a
renderer that emits markup it wrote itself.

The security posture is therefore **inverted** between the two:

| | savage | eumachia |
|---|---|---|
| Markup | untrusted, sanitized on the way out | trusted, authored here |
| Data | whatever's in the SVG | untrusted invoice fields from Gelder |
| Defense | `removeJavaScript` pass | `escapeHtml` on every interpolated field |

`escapeHtml` in `eumachia.js` is load-bearing. It's the only thing standing
between a crafted invoice `description` and script execution against a payer
mid-payment. Every new field rendered into the page needs to go through it.

## Architecture

```
src/server/node/
├── eumachia.js              # Express app, pay-page rendering, routes
├── config/
│   ├── default.js           # service URLs, port, hash, currency
│   └── local.js             # LOCALHOST overlay on default.js
└── src/
    ├── identity/identity.js # sessionless keypair + BDO/Addie registration
    ├── invoices/invoices.js # reads invoices out of BDO
    ├── payments/payments.js # Addie payment intents, the payments ledger
    └── persistence/client.js# filesystem key/value store
```

### Routes

`GET /pay/:uuid` renders. `POST /pay/:uuid/intent` and `POST /pay/:uuid/complete`
are called by the page's own JS, carrying the same pre-signed
`hash`/`timestamp`/`signature` the page was loaded with. eumachia holds no
authority over the invoice itself — it passes those credentials through to
BDO, same pattern savage uses.

### PUBLIC_PREFIX

The page's `fetch` calls need the external mount prefix, because nginx's
`proxy_pass http://localhost:3013/;` strips `/eumachia` before Express sees
the request. This was previously hardcoded as `/eumachia` in two template
literals; it's now `PUBLIC_PREFIX` (same default), so the service can also run
unproxied with `PUBLIC_PREFIX=''`.

If the pay button 404s on click, this is the first thing to check.

### Identity bootstrap and its retry

eumachia mints its own keypair on first boot and registers with BDO and Addie.
`bootstrapIdentity` retries because nothing orders service startup — under pm2
everything comes up at once and eumachia can lose the race with ECONNREFUSED.
Without the retry, `bdoUuid`/`addieUuid` stay null for the life of the process
and every `/pay/:uuid` afterward silently fails.

### The payout leg is recorded, not just attempted

"The payer was charged" and "the creator got the money" are different facts,
and for most of this service's life only the first was written down. A payout
could fail — onboarding unfinished, no destination, a transfer Stripe
refused — and the payment record still said paid, with the money sitting on
the platform account and the creator's app showing **Paid**.

So `payments.js` now records the outcome: `summarizePayout` writes what
happened, `classifyPayoutError` turns Stripe's message into a stable reason
the apps can branch on, and `writePayout` persists it alongside the payment.
`payOutCreator` stores its outcome whether it succeeded or not.

The reasons are the contract with getpayed. Don't rename them without
changing `describePayout` there:

`onboarding_incomplete`, `no_payout_account`, `already_paid_out`,
`platform_funds`, `payment_not_succeeded`, `unreachable`, `unknown`.

`POST /pay/:uuid/payout` retries one. A retry is worth offering for anything
except `already_paid_out` — Stripe refusing a duplicate transfer means the
money did go out — and the app uses exactly that predicate to decide whether
to keep polling, so a mis-classification here turns into an infinite poll
there.

### What it took to get one payment through

Five things, stacked, each only findable by running a real payment in test
mode. Worth knowing before touching this path:

1. Connected accounts created with `transfers` alone can't receive
   transfers — Stripe wants **`card_payments` alongside it** without special
   approval. Fixed in addie's account creation.
2. `addie-js` 0.0.7's `getPaymentIntent` silently dropped the `merchant`
   argument (see below), so the intent carried no `merchant_pubkey`.
3. Even knowing the merchant, they weren't in the recipients list, so nothing
   was transferred.
4. Transfers drew on the platform's **available** balance, which is empty in
   test mode. They now pass **`source_transaction`** (the charge's
   `latest_charge`), funding the transfer from the charge itself.
   `pm_card_bypassPending` is the test card that settles straight to
   available balance if you want the other behaviour.
5. The platform's own Stripe profile was incomplete, which Stripe reports as
   a capability problem rather than as a profile problem.

### Addie client dependency

`payments.js` calls `addie.processConnectedTransfers(paymentIntentId)`, which
settles splits to Stripe **Connected Accounts** — distinct from
`processPaymentTransfers`, which moves funds to payout cards via Stripe
Issuing. They're two different Addie routes
(`/payment/:id/process-connected-transfers` vs `/payment/:id/process-transfers`)
backed by two different processors.

That method did not exist in addie-js until **0.0.7**; eumachia's call against
any earlier version throws `TypeError`. **0.0.8 is now the floor**, for a
second reason: `getPaymentIntent` took five parameters until then and
silently dropped the `merchant` argument `payments.js` passes as its sixth.
Without it the payment intent carries no `merchant_pubkey`, the payout step
finds no one to pay, and the charge succeeds while the creator's money stays
on the platform account. Don't relax the pin.

## Tests

`npm run test:payments` (`test/payment-failures.mjs`, with its harness in
`test/lib/harness.mjs`) exercises **31 cases** across the payment and payout
legs against a live deployment in Stripe test mode — card declines, 3DS,
disputes, and the payout cases where the payer is charged successfully and
the creator is paid nothing.

`test/README.md` doubles as the manual-testing guide: each case names the
Stripe test card, token or connected-account magic value that triggers it.
That mapping is the valuable part — most of these failures cannot be
reproduced any other way, and several were found only by running them.

Note that Stripe's `pm_card_*` payment methods are shared test-mode objects
rather than per-account ones, so two runs can interfere with each other. The
harness accounts for that; new cases should too.

## Configuration

See README.md for the table. Default port is **3013**, not eumachia's
historical 3011 — 3011 is covenant's in the shared allyabase port map.

Set `BDO_BASE_URL`/`ADDIE_BASE_URL` explicitly in deployment. The
`GATEWAY_URL` fallback deliberately goes through the public gateway rather
than per-service `<subdomain>.bdo.allyabase.com` hosts: those were confirmed
serving a certificate for an unrelated domain, so every request to them died
with `ERR_TLS_CERT_ALTNAME_INVALID` — silently, since the route's catch turned
it into "Something went wrong loading this invoice".

## History

eumachia lived at `allyabase/deployment/eumachia/` and was deployed inside the
Netlify gateway bundle. On extraction:

- `@netlify/blobs` and `src/persistence/client.netlify-blobs.js` dropped; the
  `PERSISTENCE_BACKEND` switch in `identity.js` went with them. The Blobs
  backend existed because a Netlify Function's filesystem is read-only outside
  `/tmp`; on a droplet the filesystem client is correct.
- `"addie-js": "file:../../../../addie/src/client/javascript"` — a relative
  path four levels up into the allyabase tree — replaced with `^0.0.7` from
  npm. This was the only hard coupling preventing extraction.
- `GATEWAY_URL` moved off the retired `allyabase-gateway.netlify.app` to
  `dev.8as.world`, and became env-overridable.
- `_spike_full_flow.mjs` (a dev spike with a hardcoded dead gateway URL)
  dropped. Recoverable from allyabase's git history if wanted.

## Related

- **savage** — sibling service extracted at the same time; serves static
  published SVG, cannot host a checkout. Its sanitizer also strips `data:`
  URIs, which is why it silently dropped photos out of published cards until
  September 2026; if you add anything image-bearing to a savage-served
  payload, check that first.
- **Addie** — payment processing; eumachia's `processConnectedTransfers` needs
  addie-js ≥ 0.0.7
- **BDO** — where invoices and the payments ledger live
- **getpayed** (formerly Gelder) — publishes the invoices eumachia renders,
  and reads the payout record back. Its `CLAUDE.md` documents the
  `PayoutRecord` shape and the UI states each reason maps to.
- **allyabase/CLAUDE.md** → "How the apps and services fit together" — the
  whole money path in one place, plus the other integration seams.
