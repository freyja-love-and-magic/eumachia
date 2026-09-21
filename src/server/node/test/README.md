# Payment failure modes

Every way paying an invoice can fail, with how to reach each one by hand.

```
npm run test:payments              # all 31 cases
npm run test:payments -- cards     # just the card declines
npm run test:payments -- payout    # just the creator-payout cases
npm run test:payments -- retry     # just the retry route
```

Runs against a live deployment in Stripe **test mode**; no real money moves.
Point it elsewhere with `EUMACHIA_URL`, `ADDIE_URL`, `BDO_URL`. Each case
mints its own Addie identities and publishes its own BDO invoice, so runs
don't interfere with each other or need cleanup.

The suite needs no Stripe secret key: a PaymentIntent can be confirmed with
just the publishable key and the intent's own client secret, which is what
Stripe.js does inside the pay page. Cards are never handled directly —
every case uses one of Stripe's shared `pm_card_*` tokens.

`31/31 as documented` means behaviour matches this file. A `CHANGED` line
means something moved: possibly a fix, possibly a regression. Read before
"repairing" the test.

## What happens today

Verified 2026-09-21 against dev.8as.world.

### The invoice link

| Case | Trigger | Result |
|---|---|---|
| `link/missing-credentials` | Open a pay link with `?hash&timestamp&signature` stripped — a chat app truncating it, say | `400`, "This invoice link is missing required parameters." |
| `link/bad-signature` | Change any character of the signature | `404` — BDO won't release the record |
| `link/unknown-invoice` | Change the uuid, or open a link whose record was deleted | `404`, "Invoice not found." |
| `link/estimate-is-payable` | Hand-build a pay URL from an **estimate's** BDO uuid | **Chargeable.** eumachia doesn't check `kind` |

The last one isn't reachable through the app — getpayed never puts a
`pay_url` on an estimate — but nothing server-side would stop a payment if
someone constructed the URL.

### The payer's card

All nine declines behave identically from our side: the charge is refused,
`/complete` is never called, and the invoice stays unpaid and payable again.
Only the message the payer sees differs, and that comes from Stripe's
Payment Element, not from us.

| Case | Card | Shared token | `decline_code` |
|---|---|---|---|
| `cards/generic-decline` | 4000000000000002 | `pm_card_visa_chargeDeclined` | `generic_decline` |
| `cards/insufficient-funds` | 4000000000009995 | `pm_card_visa_chargeDeclinedInsufficientFunds` | `insufficient_funds` |
| `cards/lost-card` | 4000000000009987 | `pm_card_visa_chargeDeclinedLostCard` | `lost_card` |
| `cards/stolen-card` | 4000000000009979 | `pm_card_visa_chargeDeclinedStolenCard` | `stolen_card` |
| `cards/expired-card` | 4000000000000069 | `pm_card_chargeDeclinedExpiredCard` | `expired_card` |
| `cards/incorrect-cvc` | 4000000000000127 | `pm_card_chargeDeclinedIncorrectCvc` | `incorrect_cvc` |
| `cards/processing-error` | 4000000000000119 | `pm_card_chargeDeclinedProcessingError` | `processing_error` |
| `cards/velocity-limit` | 4000000000006975 | `pm_card_visa_chargeDeclinedVelocityLimitExceeded` | `card_velocity_exceeded` |
| `cards/radar-block` | 4100000000000019 | `pm_card_radarBlock` | `fraudulent` (blocked by Radar) |

Plus:

| Case | Trigger | Result |
|---|---|---|
| `cards/authentication-required` | 4000002500003155 / `pm_card_authenticationRequired` | `requires_action` — the bank challenge appears; invoice unpaid until it's passed |
| `cards/already-paid` | Open the same pay link twice and pay again | Second attempt `400`, "This invoice has already been paid" |
| `cards/premature-complete` | A tampered client POSTs `/complete` without a successful charge | **Invoice marked paid on the client's word.** Only the payout refuses ("payment not succeeded") |

`cards/premature-complete` is a known limitation, not a surprise:
`/complete` trusts the payer's browser because Addie exposes no webhook to
verify a charge against. It's recorded so the gap stays visible.

### The creator's payout

These are the ones worth feeling out, because **the payer is charged
successfully in every one of them**. The invoice reads "paid" to everybody,
and it's the creator's money that goes missing. `/complete` logs a payout
failure server-side and still returns `paid: true`.

| Case | Trigger | Payer | Creator |
|---|---|---|---|
| `payout/happy-path` | Creator finished onboarding | charged $25 | **paid $22.75** (91%; platform keeps 9%) |
| `payout/onboarding-unfinished` | Tap "Set Up Payouts", close the sheet without finishing, then get paid | charged $25 | **nothing** — "destination account needs… transfers" |
| `payout/no-account-at-all` | Invoice names a pubkey with no Stripe account — e.g. app reinstalled, new identity, older invoice still out there | charged $25 | **nothing** — "not found" |
| `payout/no-creator-on-invoice` | Invoice created before Stripe was connected (getpayed now blocks this) | charged $25 | **nothing** — whole charge stays with the platform |
| `payout/double-payout` | `/complete` called twice, or a payout retried after one succeeded | charged once | paid once; Stripe refuses the duplicate |
| `payout/pending-balance` | Pay with the ordinary test card (`pm_card_visa`) whose funds land in Stripe's *pending* balance | charged $25 | **paid** — transfers draw on the charge, not the platform float |

Two notes on these:

- **`payout/double-payout` is safe because of `source_transaction`.** Each
  transfer is tied to the charge that funded it, and Stripe caps transfers at
  the source amount, so a retry fails with "already a transfer using this
  source". There is no application-level idempotency guard; this is Stripe's.
- **`payout/no-account-at-all` reports a bare "not found".** Addie's
  `getUserByPublicKey` throws for a pubkey it has never seen, so this reads
  less clearly than the "No Stripe Connected Account" a *known* creator
  without an account gets. Worth improving before this text ends up in front
  of anyone.

### What the creator's app is told

`/complete` records the payout outcome and `/status` returns it under
`payout`, so getpayed can tell "paid and the money reached me" from "paid
and it didn't". Before this they were indistinguishable — both `paid: true`.

| Case | Reported | getpayed shows |
|---|---|---|
| `reported/payout-sent` | `state: sent`, `amount: 2275`, transfer id | "Paid — $22.75 sent to your Stripe" |
| `reported/payout-failed-onboarding` | `state: failed`, `reason: onboarding_incomplete` | "Paid — payout is waiting on your Stripe setup" + Finish Setup, Retry |
| `reported/payout-failed-no-account` | `state: failed`, `reason: no_payout_account` | "Paid — no payout account to send it to" + Finish Setup |
| `reported/payout-none` | nothing recorded (no payout attempted) | "Paid — but not routed to you" |

The full set of reasons eumachia classifies: `onboarding_incomplete`,
`no_payout_account`, `already_paid_out`, `platform_funds`,
`payment_not_succeeded`, `unreachable`, `unknown`. getpayed branches on
these, never on Stripe's error string, which it shows only as detail.

`/complete` deliberately does **not** return payout state to the payer:
whether the creator finished onboarding is not theirs to see, and not
something they could act on.

### Retrying a payout

`POST /pay/:uuid/payout` takes the same pre-signed invoice credentials as
the pay routes, so only someone holding the invoice link can call it — and
in practice that's the creator's own app, signing with the invoice's BDO
keypair.

| Case | Trigger | Result |
|---|---|---|
| `retry/still-failing` | Tap Retry Payout without fixing the cause | Same reason returned; nothing charged again |
| `retry/already-sent` | Retry an invoice already paid out | The **original** transfer id, unchanged — eumachia short-circuits rather than letting Stripe refuse a duplicate |
| `retry/unpaid-invoice` | Retry before the invoice is paid | `400`, "This invoice has not been paid yet" |
| `retry/bad-credentials` | Retry without valid invoice credentials | `404` |

### Disputes

| Case | Trigger | Result |
|---|---|---|
| `dispute/fraudulent-chargeback` | 4000000000000259 / `pm_card_createDispute` | Charge succeeds, invoice stays paid, any transfer stands |

Nothing reacts to a dispute — there's no webhook handler anywhere in the
stack. A chargeback after a creator has been paid leaves the platform short.
Recorded so the gap is deliberate rather than assumed.

## Not automated here

These need the platform's Stripe secret key, or a direct charge on a
connected account, so they can't be driven through eumachia's routes. To
exercise them, use the Stripe CLI or dashboard against the connected account
(values from https://docs.stripe.com/connect/testing):

| State | How |
|---|---|
| Account requirements become `currently_due` | Charge with `tok_visa_triggerNextRequirements` (4000000000004202), `on_behalf_of` the account |
| Account disabled, requirements overdue | `tok_visa_triggerChargeBlock` (4000000000004210) or `tok_visa_triggerPayoutBlock` (4000000000004236) |
| Verification fails on identity | `individual.id_number` = `111111111` (mismatch), `111111113` (inactive) |
| Verification fails on address | `address.line1` = `address_no_match` / `address_zip_no_match` |
| Verification fails on business name | `company.name` = `mismatch_business_name` / `disallowed_name` |
| Account paused for inactivity | `business_profile.url` = `https://inactivity.stripe.com` |
| Payout to bank fails | Test account numbers with routing `110000000`: `000111111116` (no account), `000111111113` (closed), `000222222227` (insufficient funds) |

The values that make an account verify *instantly* are the ones the harness
already uses to build a payable creator: `company.tax_id` `000000000`,
`address.line1` `address_full_match`, `dob` `1901-01-01`.

## How the harness builds each kind of creator

- `mintPayableCreator()` — Addie's company-account route, whose Stripe test
  values verify immediately, so `transfers` goes active with no onboarding
  form. Stands in for a creator who finished onboarding.
- `mintUnfinishedCreator()` — an Express account via the embedded-onboarding
  route, with requirements outstanding and `transfers` inactive. The state
  every real creator is in between tapping "Set Up Payouts" and completing
  Stripe's form.
- `creatorStatus()` — what Addie reports from Stripe, the same call
  getpayed's Payouts view makes.

One gotcha worth knowing if you write more cases: `sessionless-node` keeps a
single set of keys at module scope, and `generateKeys` overwrites whatever
the last caller registered. With several identities in flight this silently
signs with the wrong key and Addie answers "auth error". The harness gives
every identity a bound signer that re-points the module at its own keys
first.
