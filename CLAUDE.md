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

### Addie client dependency

`payments.js` calls `addie.processConnectedTransfers(paymentIntentId)`, which
settles splits to Stripe **Connected Accounts** — distinct from
`processPaymentTransfers`, which moves funds to payout cards via Stripe
Issuing. They're two different Addie routes
(`/payment/:id/process-connected-transfers` vs `/payment/:id/process-transfers`)
backed by two different processors.

That method did not exist in addie-js until **0.0.7**; eumachia's call against
any earlier version throws `TypeError`. `package.json` pins `^0.0.7` for
exactly this reason — don't relax it.

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
  published SVG, cannot host a checkout
- **Addie** — payment processing; eumachia's `processConnectedTransfers` needs
  addie-js ≥ 0.0.7
- **BDO** — where invoices and the payments ledger live
- **getpayed/Gelder** — publishes the invoices eumachia renders
