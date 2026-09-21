import bdo from 'bdo-js';
import addie from 'addie-js';
import config from '../../config/local.js';
import identity from '../identity/identity.js';

bdo.baseURL = config.bdoBaseURL;
addie.baseURL = config.addieBaseURL;

// Real amount, read server-side from the invoice — never trust a
// client-supplied amount for what to charge. When `merchantPubKey` is
// present (the invoice creator has connected Stripe), requests a 91%/
// 9%-minus-fees split via Addie's buildPayeeMetadata; Addie only embeds
// this into the PaymentIntent's metadata at this point — it does NOT
// transfer anything yet, so simply loading the pay page can never move
// real money. The actual transfer only happens later, via payOutCreator,
// after independently re-verifying the payment succeeded.
async function requestPaymentIntent(amountCents, currency, merchant) {
  identity.claimIdentity();
  const uuid = identity.getAddieUuid();
  const intent = await addie.getPaymentIntent(uuid, config.stripeProcessor, amountCents, currency, [], merchant);
  if (!intent || intent.error) {
    const message = intent?.error?.raw?.message || intent?.error?.message || intent?.error || 'Addie returned no payment intent';
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return intent;
}

async function createIntent(invoiceUuid, amountCents, currency, merchantPubKey) {
  const merchant = merchantPubKey ? { pubKey: merchantPubKey } : null;
  let intent;
  try {
    intent = await requestPaymentIntent(amountCents, currency, merchant);
  } catch (err) {
    // Addie's "unknown uuid" error is generically unhelpful (see the
    // documented `{error: err}` -> `{}` bug in addie.js's own catch
    // blocks), so this can't reliably distinguish "cached identity is
    // stale" from any other failure by message alone. Re-minting and
    // retrying once is cheap and safe here (see resetIdentity's doc
    // comment on why, unlike Gelder's owner-facing identity) — a genuine
    // unrelated failure (Stripe down, bad amount, etc.) will just fail the
    // same way again on the retry and surface normally.
    console.error(`createIntent failed with cached identity, re-minting and retrying once: ${err}`);
    await identity.resetIdentity();
    await identity.ensureIdentity();
    intent = await requestPaymentIntent(amountCents, currency, merchant);
  }
  // addie-js's field naming is a direct passthrough of Addie's own
  // (misleadingly-named) response: `paymentIntent` holds the Stripe
  // clientSecret string, not a PaymentIntent object. Stripe's client secret
  // has the well-known format `{paymentIntentId}_secret_{secret}` — the raw
  // ID is what process-connected-transfers is keyed by, so it's extracted
  // and persisted here rather than trusted from the client later.
  const paymentIntentId = (intent.paymentIntent || '').split('_secret_')[0];

  identity.claimIdentity();
  const record = await bdo.getBDO(identity.getBdoUuid(), config.paymentsHash);
  const payments = record?.bdo?.payments || {};
  payments[invoiceUuid] = { ...(payments[invoiceUuid] || {}), paid: false, paymentIntentId };
  identity.claimIdentity();
  await bdo.updateBDO(identity.getBdoUuid(), config.paymentsHash, { payments }, false);

  return { clientSecret: intent.paymentIntent, publishableKey: intent.publishableKey };
}

// eumachia owns this record (created once at identity bootstrap) — a plain
// map of invoice uuid -> {paid, paidAt}, read/written with eumachia's own
// signing key, never Gelder's or the invoice's. This is the read-modify-
// write pattern already accepted for idothis's shared directory this
// session, with the same known race window on genuinely concurrent writes;
// acceptable here for the same reason (personal-tool scale, not a
// high-stakes ledger).
async function readPaymentStatus(invoiceUuid) {
  identity.claimIdentity();
  const record = await bdo.getBDO(identity.getBdoUuid(), config.paymentsHash);
  const payments = record?.bdo?.payments || {};
  return payments[invoiceUuid] || null;
}

async function markPaid(invoiceUuid) {
  identity.claimIdentity();
  const record = await bdo.getBDO(identity.getBdoUuid(), config.paymentsHash);
  const payments = record?.bdo?.payments || {};
  payments[invoiceUuid] = { ...(payments[invoiceUuid] || {}), paid: true, paidAt: Date.now() };
  identity.claimIdentity();
  await bdo.updateBDO(identity.getBdoUuid(), config.paymentsHash, { payments }, false);
  return payments[invoiceUuid];
}

/**
 * Flattens Addie's transfer response into something an app can act on.
 *
 * A payout either moved money or it didn't, and when it didn't the reason
 * decides what the creator should do about it — finish Stripe onboarding,
 * or nothing at all. Without this, a failed payout was only ever a line in
 * eumachia's own log: the payer was charged, the invoice read "paid", and
 * nobody downstream could tell the creator hadn't been paid.
 *
 *   sent   — a real Stripe transfer exists
 *   none   — nobody to pay; the invoice carries no creator (the whole
 *            charge stays with the platform, by construction)
 *   failed — attempted and refused; `error` says why, `reason` classifies it
 */
function summarizePayout(result) {
  const transfer = result?.transfers?.[0];
  const attemptedAt = Date.now();

  if (transfer?.transferId) {
    return { state: 'sent', amount: transfer.amount, transferId: transfer.transferId, destination: transfer.destination, attemptedAt };
  }

  if (!transfer) {
    // "No payees to transfer to" — an invoice with no creatorAddiePubKey.
    if (result?.success) return { state: 'none', attemptedAt };
    return { state: 'failed', reason: 'unknown', error: result?.error || 'Addie returned no transfer result', attemptedAt };
  }

  return { state: 'failed', reason: classifyPayoutError(transfer.error), amount: transfer.amount, error: transfer.error, attemptedAt };
}

/**
 * The classification is what an app branches on; `error` is Stripe's own
 * wording, kept verbatim for logs. See eumachia's
 * test/README.md for how each of these is reached.
 */
function classifyPayoutError(error = '') {
  // Account exists, onboarding unfinished, so `transfers` never went active.
  if (/capabilities enabled|capability/i.test(error)) return 'onboarding_incomplete';
  // Addie has never seen this pubkey — e.g. the app was reinstalled and the
  // invoice still names the previous identity.
  if (/not found/i.test(error)) return 'no_payout_account';
  if (/no stripe connected account/i.test(error)) return 'no_payout_account';
  // Already paid: Stripe caps transfers at the funding charge's amount.
  if (/must not exceed the source amount/i.test(error)) return 'already_paid_out';
  if (/insufficient available funds/i.test(error)) return 'platform_funds';
  if (/not succeeded/i.test(error)) return 'payment_not_succeeded';
  return 'unknown';
}

async function writePayout(invoiceUuid, payout) {
  identity.claimIdentity();
  const record = await bdo.getBDO(identity.getBdoUuid(), config.paymentsHash);
  const payments = record?.bdo?.payments || {};
  payments[invoiceUuid] = { ...(payments[invoiceUuid] || {}), payout };
  identity.claimIdentity();
  await bdo.updateBDO(identity.getBdoUuid(), config.paymentsHash, { payments }, false);
  return payments[invoiceUuid];
}

// Re-verifies with Stripe (via Addie) that the underlying PaymentIntent
// actually succeeded before transferring anything — never trusts the
// client's confirmPayment() callback on its own for moving real money.
// Callers are responsible for only invoking this once per invoice (see the
// double-processing guard in eumachia.js's /pay/:uuid/complete route) —
// Addie's process-connected-transfers route has no idempotency guard of
// its own, confirmed by reading its implementation. Stripe's source-amount
// cap catches a duplicate even so, and it lands here as
// `already_paid_out`.
//
// The outcome is always persisted, success or failure, so /status can tell
// the creator what happened.
async function payOutCreator(invoiceUuid) {
  identity.claimIdentity();
  const record = await bdo.getBDO(identity.getBdoUuid(), config.paymentsHash);
  const payments = record?.bdo?.payments || {};
  const paymentIntentId = payments[invoiceUuid]?.paymentIntentId;
  if (!paymentIntentId) return null;

  let payout;
  try {
    identity.claimIdentity();
    payout = summarizePayout(await addie.processConnectedTransfers(paymentIntentId));
  } catch (err) {
    // A transport failure is indistinguishable from a refusal as far as the
    // creator is concerned — either way no money moved — but it IS worth
    // retrying, so record it as such rather than swallowing it.
    payout = { state: 'failed', reason: 'unreachable', error: err.message || String(err), attemptedAt: Date.now() };
  }

  await writePayout(invoiceUuid, payout);
  return payout;
}

export default { createIntent, readPaymentStatus, markPaid, payOutCreator };
