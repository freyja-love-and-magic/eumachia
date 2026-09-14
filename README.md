# eumachia

eumachia renders a real, interactive **Pay Now** page for a BDO-backed invoice
and creates the Stripe payment through Addie.

It exists because [savage](https://github.com/freyja-love-and-magic/savage)
can't do this. savage serves a BDO's `svg` as a webpage, but strips all
JavaScript from it first — which is the right call for arbitrary published
content and fatal for a Stripe checkout, which is JavaScript end to end. So
invoices get a second, purpose-built renderer that emits a page it fully
controls.

That inverts the trust model: savage sanitizes untrusted markup, eumachia
emits trusted markup containing untrusted *data*. Invoice fields come from
Gelder, an outside app, so every one of them is HTML-escaped before
interpolation. A crafted invoice description would otherwise run script
against the payer mid-payment.

## Routes

| Route | Purpose |
|---|---|
| `GET /pay/:uuid` | The pay page. Reads the invoice from BDO using the pre-signed credentials on the query string. |
| `POST /pay/:uuid/intent` | Creates the Stripe PaymentIntent via Addie. Called by the page's own JS. |
| `POST /pay/:uuid/complete` | Marks the invoice paid once Stripe confirms. |
| `GET /health` | Liveness. |

`/intent` and `/complete` take the same `hash`/`timestamp`/`signature` read
credentials the page itself was loaded with — embedded in the page and passed
straight back, so eumachia never needs its own authority over the invoice.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3013` | Listen port. Not eumachia's historical 3011 — on a shared allyabase box that belongs to covenant. |
| `PUBLIC_PREFIX` | `/eumachia` | Path prefix eumachia is mounted under externally. Set to `''` when running with no proxy in front. |
| `BDO_BASE_URL` | `${GATEWAY_URL}bdo/` | BDO to read invoices from. |
| `ADDIE_BASE_URL` | `${GATEWAY_URL}addie/` | Addie to create payments through. |
| `GATEWAY_URL` | `https://dev.8as.world/` | Base for the two fallbacks above. |
| `LOCALHOST` | unset | Shorthand for "bdo and addie are on this box": `http://localhost:3003/` and `:3005/`. An explicit `BDO_BASE_URL`/`ADDIE_BASE_URL` still wins. |

## Running behind nginx

The pay page's JavaScript calls back to `/intent` and `/complete`, and those
routes are mounted at `/pay/:uuid/...` internally while the browser sees them
under the mount prefix. The default `PUBLIC_PREFIX=/eumachia` matches the
standard allyabase route:

```nginx
location /eumachia/ {
    proxy_pass http://localhost:3013/;
}
```

The trailing slash on `proxy_pass` strips `/eumachia` before Express sees it,
which is why the page has to add it back when building those URLs. Mount it
somewhere else and `PUBLIC_PREFIX` has to change to match, or the pay button
will 404 on click.

## Identity

eumachia mints its own sessionless keypair on first boot and registers it with
both BDO and Addie, persisted to disk via `src/persistence/client.js`. That
identity owns the payments ledger (one BDO record under the
`eumachia-payments` hash), which is how `/complete` records what's been paid.

Bootstrap retries on failure: nothing orders service startup, so under pm2
eumachia can reach BDO or Addie before they're listening. Without the retry,
its uuids would stay null for the life of the process and every pay page would
break.

## Running

```bash
cd src/server/node
npm install
LOCALHOST=true npm start
```
