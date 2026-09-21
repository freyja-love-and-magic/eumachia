// Shared setup for the payment tests: minting the identities and records a
// real payment needs, and the Stripe calls a payer's browser would make.
//
// These talk to a LIVE deployment (dev.8as.world by default) in Stripe TEST
// mode. Nothing here needs the Stripe secret key: a PaymentIntent can be
// confirmed with the publishable key plus the intent's own client secret,
// which is exactly what Stripe.js does inside eumachia's pay page.

import sessionless from 'sessionless-node';
import bdo from 'bdo-js';

export const config = {
  eumachia: process.env.EUMACHIA_URL || 'https://dev.8as.world/eumachia/',
  addie: process.env.ADDIE_URL || 'https://dev.8as.world/addie/',
  bdo: process.env.BDO_URL || 'https://dev.8as.world/bdo/',
  // Matches BDO_HASH in getpayed's src-tauri/src/lib.rs. The invoices these
  // tests publish are the same shape the app publishes.
  hash: process.env.BDO_HASH || 'gelder-invoice',
};

bdo.baseURL = config.bdo;

export const now = () => Date.now() + '';

// sessionless-node keeps ONE set of keys at module scope: generateKeys
// overwrites whatever the last caller registered, and sign() reads
// sessionless.getKeys at call time. With several identities in flight (a
// creator, a payer, an invoice's own publish key) that silently signs with
// the wrong key and Addie answers "auth error". So every signing call
// re-points the module at its own keys first.
function boundSigner(keys) {
  return async (message) => {
    sessionless.getKeys = async () => keys;
    return sessionless.sign(message);
  };
}

async function freshKeys() {
  let keys;
  await sessionless.generateKeys((k) => { keys = k; }, () => keys);
  return keys;
}

// bdo-js logs the whole created record to stdout; keep the test output readable.
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** A fresh sessionless keypair with its own Addie user. */
export async function mintIdentity() {
  const keys = await freshKeys();
  const sign = boundSigner(keys);

  const timestamp = now();
  const res = await fetch(`${config.addie}user/create`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, pubKey: keys.pubKey, signature: await sign(timestamp + keys.pubKey) }),
  });
  const user = await res.json();
  if (!user.uuid) throw new Error(`Addie user/create failed: ${JSON.stringify(user)}`);

  return { keys, pubKey: keys.pubKey, uuid: user.uuid, sign };
}

/**
 * A creator whose connected account can actually receive transfers.
 *
 * Uses Addie's company-account route, whose Stripe test values
 * (tax_id 000000000, address line1 'address_full_match' — see
 * https://docs.stripe.com/connect/testing) satisfy verification
 * immediately, so `transfers` goes active without anyone filling in an
 * onboarding form. Stands in for a creator who HAS finished onboarding.
 */
export async function mintPayableCreator() {
  const identity = await mintIdentity();
  const timestamp = now();
  const name = 'Test Creator LLC';
  const email = `zach+payable${Date.now()}@planetnine.app`;

  const res = await fetch(`${config.addie}user/${identity.uuid}/processor/stripe`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp, country: 'US', name, email,
      signature: await identity.sign(timestamp + identity.uuid + name + email),
    }),
  });
  const user = await res.json();
  if (!user.stripeAccountId) throw new Error(`Could not create payable account: ${JSON.stringify(user).slice(0, 300)}`);

  return { ...identity, stripeAccountId: user.stripeAccountId };
}

/**
 * A creator who has STARTED onboarding and not finished it — an Express
 * account with requirements outstanding, so `transfers` is inactive. This is
 * the state every real creator is in between tapping "Set Up Payouts" and
 * completing Stripe's form, and it's what getpayed's Payouts view shows as
 * "Setup unfinished".
 */
export async function mintUnfinishedCreator() {
  const identity = await mintIdentity();
  const timestamp = now();

  const res = await fetch(`${config.addie}user/${identity.uuid}/processor/stripe/account-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp, country: 'US', email: `zach+unfinished${Date.now()}@planetnine.app`,
      signature: await identity.sign(timestamp + identity.uuid),
    }),
  });
  const session = await res.json();
  if (!session.accountId) throw new Error(`Could not create Express account: ${JSON.stringify(session).slice(0, 300)}`);

  return { ...identity, stripeAccountId: session.accountId, publishableKey: session.publishableKey };
}

/** Live account status as Addie reports it, straight from Stripe. */
export async function creatorStatus(identity) {
  const timestamp = now();
  const signature = await identity.sign(timestamp + identity.uuid);
  const res = await fetch(`${config.addie}user/${identity.uuid}/processor/stripe/account?timestamp=${timestamp}&signature=${signature}`);
  return res.json();
}

/**
 * Publishes an invoice to BDO exactly as getpayed's create_invoice does,
 * and returns it with the pre-signed read credentials its pay_url carries.
 */
export async function publishInvoice({ amountCents = 2500, creatorPubKey = null, kind = 'invoice', description = 'Test invoice' } = {}) {
  const keys = await freshKeys();
  const sign = boundSigner(keys);
  sessionless.getKeys = async () => keys;

  const uuid = await quietly(() => bdo.createUser(config.hash, {
    id: 'test-' + Date.now(),
    kind,
    description,
    amountCents,
    currency: 'USD',
    fromName: 'Test Creator',
    toName: 'Test Payer',
    status: 'pending',
    createdAt: now(),
    creatorAddiePubKey: creatorPubKey,
  }, () => {}, () => keys));

  const timestamp = now();
  const signature = await sign(timestamp + uuid + config.hash);
  return { uuid, credentials: { hash: config.hash, timestamp, signature } };
}

// ── The pay page's own calls ────────────────────────────────────────────────

export async function getPayPage(uuid, credentials) {
  const { hash, timestamp, signature } = credentials;
  const res = await fetch(`${config.eumachia}pay/${uuid}?hash=${hash}&timestamp=${timestamp}&signature=${signature}`);
  return { status: res.status, body: await res.text() };
}

export async function createIntent(uuid, credentials) {
  const res = await fetch(`${config.eumachia}pay/${uuid}/intent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body, id: body.clientSecret?.split('_secret_')[0] };
}

/**
 * Confirms a PaymentIntent the way the pay page's Stripe.js does —
 * publishable key + client secret, no secret key — using one of Stripe's
 * shared test PaymentMethod tokens (https://docs.stripe.com/testing).
 */
export async function payWithCard(intent, paymentMethod) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${intent.id}/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${intent.publishableKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      payment_method: paymentMethod,
      client_secret: intent.clientSecret,
      return_url: `${config.eumachia}done`,
    }),
  });
  const body = await res.json();
  return {
    status: res.status,
    intentStatus: body.status,
    declineCode: body.error?.decline_code || body.last_payment_error?.decline_code,
    errorCode: body.error?.code || body.last_payment_error?.code,
    message: body.error?.message || body.last_payment_error?.message,
    nextAction: body.next_action?.type,
  };
}

/** What the payer's browser POSTs after confirmPayment() resolves. */
export async function completePayment(uuid, credentials) {
  const res = await fetch(`${config.eumachia}pay/${uuid}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

/** What getpayed's "Check Payment" button polls. */
export async function paymentStatus(uuid) {
  const res = await fetch(`${config.eumachia}pay/${uuid}/status`);
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

/** Asks eumachia to retry a payout — what getpayed's Retry Payout does. */
export async function retryPayout(uuid, credentials) {
  const res = await fetch(`${config.eumachia}pay/${uuid}/payout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

/**
 * Runs the payout leg directly through Addie, bypassing eumachia's record.
 * Used to see what a transfer does independently of what eumachia stored. eumachia calls this itself
 * inside /complete but swallows the outcome, so the tests call it directly
 * to see what a creator's payout actually did.
 */
export async function runPayout(paymentIntentId) {
  const res = await fetch(`${config.addie}payment/${paymentIntentId}/process-connected-transfers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp: now() }),
  });
  const body = await res.json().catch(() => ({}));
  const transfer = body.transfers?.[0];
  return {
    status: res.status,
    ...body,
    transferId: transfer?.transferId,
    transferError: transfer?.error,
    amount: transfer?.amount,
  };
}
