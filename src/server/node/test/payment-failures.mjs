#!/usr/bin/env node
// Every way paying an invoice can fail, exercised against a live deployment
// in Stripe TEST mode.
//
// Written to answer a specific question: when something goes wrong, what
// does the payer see, what does the creator get, and what does the app
// believe? Several of these currently end with the invoice marked paid and
// the creator unpaid — those are recorded as the CURRENT behaviour, not as
// approval of it. See test/README.md for the table and for how to reach
// each one by hand in the app.
//
//   npm run test:payments              # everything
//   npm run test:payments -- cards     # only cases whose id contains "cards"
//
// Stripe references:
//   test cards and pm_ tokens    https://docs.stripe.com/testing
//   connected-account test values https://docs.stripe.com/connect/testing

import {
  config, mintPayableCreator, mintUnfinishedCreator, creatorStatus,
  publishInvoice, getPayPage, createIntent, payWithCard, completePayment,
  paymentStatus, runPayout,
} from './lib/harness.mjs';

// ── Cases ───────────────────────────────────────────────────────────────────
//
// Each: `trigger` says how to reproduce it (in the app, or which Stripe test
// value does it), `run` returns the facts, `expect` asserts them. An
// assertion failure means behaviour changed from what's documented here —
// which may be a fix, so read before "repairing" the test.

const cases = [

  // ── The invoice link itself ──────────────────────────────────────────────

  {
    id: 'link/missing-credentials',
    what: 'Pay link with its query string stripped',
    trigger: 'Open a pay_url with ?hash&timestamp&signature removed — e.g. a link a chat app truncated.',
    async run() {
      const { uuid } = await publishInvoice();
      const res = await fetch(`${config.eumachia}pay/${uuid}`);
      return { status: res.status, body: (await res.text()).slice(0, 80) };
    },
    expect: (r) => [
      [r.status === 400, `400 with an explanation, got ${r.status}`],
    ],
  },

  {
    id: 'link/bad-signature',
    what: 'Pay link whose signature does not match',
    trigger: 'Tamper with any character of the signature in a pay_url.',
    async run() {
      const { uuid, credentials } = await publishInvoice();
      const tampered = { ...credentials, signature: credentials.signature.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) };
      const page = await getPayPage(uuid, tampered);
      return { status: page.status, body: page.body.slice(0, 80) };
    },
    expect: (r) => [
      [r.status === 404, `refused (404 = BDO won't release the record), got ${r.status}`],
    ],
  },

  {
    id: 'link/unknown-invoice',
    what: 'Pay link for an invoice that does not exist',
    trigger: 'Change the uuid in a pay_url, or open a link whose BDO record was deleted.',
    async run() {
      const { credentials } = await publishInvoice();
      const page = await getPayPage('00000000-0000-4000-8000-000000000000', credentials);
      return { status: page.status };
    },
    expect: (r) => [
      [r.status === 404, `404, got ${r.status}`],
    ],
  },

  {
    id: 'link/estimate-is-payable',
    what: 'An ESTIMATE can be paid if someone constructs the URL',
    trigger: 'getpayed never puts a pay_url on an estimate, but eumachia does not check `kind`. Hand-build the URL from an estimate\'s BDO uuid.',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ kind: 'estimate', creatorPubKey: creator.pubKey, description: 'Quote, not an invoice' });
      const page = await getPayPage(uuid, credentials);
      const intent = await createIntent(uuid, credentials);
      return { pageStatus: page.status, intentStatus: intent.status };
    },
    // Recorded as current behaviour: a quote is chargeable. Only reachable
    // by hand-building a URL the app never hands out.
    expect: (r) => [
      [r.pageStatus === 200 && r.intentStatus === 200, `currently chargeable (page ${r.pageStatus}, intent ${r.intentStatus})`],
    ],
  },

  // ── The payer's card ─────────────────────────────────────────────────────
  //
  // Each uses one of Stripe's shared PaymentMethod tokens, so no card
  // number is ever handled here. The pay page reaches the same states with
  // the matching card number typed into the Payment Element.

  ...[
    { id: 'cards/generic-decline', token: 'pm_card_visa_chargeDeclined', card: '4000000000000002', code: 'generic_decline' },
    { id: 'cards/insufficient-funds', token: 'pm_card_visa_chargeDeclinedInsufficientFunds', card: '4000000000009995', code: 'insufficient_funds' },
    { id: 'cards/lost-card', token: 'pm_card_visa_chargeDeclinedLostCard', card: '4000000000009987', code: 'lost_card' },
    { id: 'cards/stolen-card', token: 'pm_card_visa_chargeDeclinedStolenCard', card: '4000000000009979', code: 'stolen_card' },
    { id: 'cards/expired-card', token: 'pm_card_chargeDeclinedExpiredCard', card: '4000000000000069', code: 'expired_card' },
    { id: 'cards/incorrect-cvc', token: 'pm_card_chargeDeclinedIncorrectCvc', card: '4000000000000127', code: 'incorrect_cvc' },
    { id: 'cards/processing-error', token: 'pm_card_chargeDeclinedProcessingError', card: '4000000000000119', code: 'processing_error' },
    { id: 'cards/velocity-limit', token: 'pm_card_visa_chargeDeclinedVelocityLimitExceeded', card: '4000000000006975', code: 'card_velocity_exceeded' },
    { id: 'cards/radar-block', token: 'pm_card_radarBlock', card: '4100000000000019', code: 'fraudulent' },
  ].map(({ id, token, card, code }) => ({
    id,
    what: `Card declined — ${id.split('/')[1].replace(/-/g, ' ')}`,
    trigger: `Pay with card ${card} (token ${token}) in the Payment Element.`,
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      const paid = await payWithCard(intent, token);
      // The pay page only calls /complete when confirmPayment() succeeds, so
      // a decline should leave the invoice untouched and payable again.
      const after = await paymentStatus(uuid);
      return { intentStatus: paid.intentStatus, errorCode: paid.errorCode, declineCode: paid.declineCode, message: paid.message, paid: after.paid, expectedCode: code };
    },
    expect: (r) => [
      [r.intentStatus !== 'succeeded', `charge refused (${r.errorCode || 'no code'}), got status ${r.intentStatus ?? 'none'}`],
      [r.paid === false, `invoice still unpaid, got paid=${r.paid}`],
      [!r.expectedCode || r.declineCode === r.expectedCode, `decline_code ${r.expectedCode}, got ${r.declineCode ?? r.errorCode}`],
    ],
  })),

  {
    id: 'cards/authentication-required',
    what: 'Card needs 3D Secure and the payer has not completed it',
    trigger: 'Pay with card 4000002500003155 (token pm_card_authenticationRequired). The Payment Element shows a bank challenge.',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      const paid = await payWithCard(intent, 'pm_card_authenticationRequired');
      const after = await paymentStatus(uuid);
      return { intentStatus: paid.intentStatus, nextAction: paid.nextAction, paid: after.paid };
    },
    expect: (r) => [
      [r.intentStatus === 'requires_action', `requires_action, got ${r.intentStatus}`],
      [r.paid === false, `invoice unpaid until the challenge is passed, got paid=${r.paid}`],
    ],
  },

  {
    id: 'cards/premature-complete',
    what: 'Browser reports success while the charge has NOT succeeded',
    trigger: 'A tampered or buggy client POSTs /complete without a successful charge. /complete trusts the caller — Addie exposes no webhook to verify against (a documented eumachia limitation).',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      await payWithCard(intent, 'pm_card_visa_chargeDeclined');
      const complete = await completePayment(uuid, credentials);
      const payout = await runPayout(intent.id);
      return { completeStatus: complete.status, markedPaid: complete.paid, payoutRefused: payout.error };
    },
    // CURRENT behaviour: the invoice is marked paid on the client's word,
    // and only the payout refuses. Worth fixing; recorded, not endorsed.
    expect: (r) => [
      [r.markedPaid === true, `invoice marked paid on the client's word, got ${r.markedPaid}`],
      [/not succeeded/i.test(r.payoutRefused || ''), `payout refuses ("payment not succeeded"), got ${r.payoutRefused}`],
    ],
  },

  {
    id: 'cards/already-paid',
    what: 'Paying an invoice that is already paid',
    trigger: 'Open the same pay link twice and pay again — or refresh after paying.',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      await payWithCard(intent, 'pm_card_bypassPending');
      await completePayment(uuid, credentials);
      const second = await createIntent(uuid, credentials);
      const page = await getPayPage(uuid, credentials);
      return { secondIntentStatus: second.status, secondError: second.error, pageSaysPaid: /already been paid|paid/i.test(page.body) };
    },
    expect: (r) => [
      [r.secondIntentStatus === 400, `second charge refused with 400, got ${r.secondIntentStatus}`],
      [/already been paid/i.test(r.secondError || ''), `says already paid, got ${r.secondError}`],
    ],
  },

  // ── The creator's payout ─────────────────────────────────────────────────
  //
  // These are the dangerous ones: the payer is charged successfully, so
  // everyone believes the transaction worked, and the creator's money is
  // what goes missing. eumachia logs a payout failure server-side and still
  // returns paid: true.

  {
    id: 'payout/happy-path',
    what: 'Creator with a finished account is paid',
    trigger: 'Finish Stripe onboarding, then have someone pay the invoice.',
    async run() {
      const creator = await mintPayableCreator();
      const status = await creatorStatus(creator);
      const { uuid, credentials } = await publishInvoice({ amountCents: 2500, creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      const paid = await payWithCard(intent, 'pm_card_bypassPending');
      // eumachia pays the creator inside /complete; call it as the pay page
      // does, then re-run the payout to read back what it did.
      await completePayment(uuid, credentials);
      const payout = await runPayout(intent.id);
      const after = await paymentStatus(uuid);
      return { transfersActive: status.transfersActive, intentStatus: paid.intentStatus, alreadyPaidOut: /already a transfer using this source/i.test(payout.transferError || ''), transferError: payout.transferError, paid: after.paid };
    },
    expect: (r) => [
      [r.intentStatus === 'succeeded', `charge succeeds, got ${r.intentStatus}`],
      [r.transfersActive === true, `creator can receive transfers, got ${r.transfersActive}`],
      [r.paid === true, `invoice marked paid, got ${r.paid}`],
      // /complete already transferred, so re-running hits Stripe's
      // source-amount cap — which names the amount it paid: 91% of $25,
      // the platform keeping 9%.
      [r.alreadyPaidOut, `creator already paid $22.75 by /complete, got: ${r.transferError}`],
    ],
  },

  {
    id: 'payout/onboarding-unfinished',
    what: 'Creator started Stripe setup but never finished it',
    trigger: 'Tap "Set Up Payouts" in getpayed, close the sheet without completing the form, then get paid. The account exists; its transfers capability is inactive.',
    async run() {
      const creator = await mintUnfinishedCreator();
      const status = await creatorStatus(creator);
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      await payWithCard(intent, 'pm_card_bypassPending');
      const complete = await completePayment(uuid, credentials);
      const payout = await runPayout(intent.id);
      return { transfersActive: status.transfersActive, requirementsDue: status.currentlyDue, markedPaid: complete.paid, transferId: payout.transferId, transferError: payout.transferError };
    },
    expect: (r) => [
      [r.transfersActive === false, `transfers inactive, got ${r.transfersActive}`],
      [r.requirementsDue > 0, `Stripe still wants details, got ${r.requirementsDue}`],
      [r.markedPaid === true, `invoice marked paid anyway (current behaviour), got ${r.markedPaid}`],
      [!r.transferId, `no transfer happened, got ${r.transferId}`],
      [/capability|transfers/i.test(r.transferError || ''), `refused over the transfers capability, got: ${r.transferError}`],
    ],
  },

  {
    id: 'payout/no-account-at-all',
    what: 'Invoice carries a creator pubkey with no Stripe account behind it',
    trigger: 'Reinstall getpayed (new Addie identity) while an older invoice still names the previous pubkey, then have that invoice paid.',
    async run() {
      const { uuid, credentials } = await publishInvoice({
        // A well-formed pubkey Addie has never seen.
        creatorPubKey: '02' + 'ab'.repeat(32),
      });
      const intent = await createIntent(uuid, credentials);
      await payWithCard(intent, 'pm_card_bypassPending');
      const complete = await completePayment(uuid, credentials);
      const payout = await runPayout(intent.id);
      return { markedPaid: complete.paid, transferId: payout.transferId, transferError: payout.transferError };
    },
    expect: (r) => [
      [r.markedPaid === true, `invoice marked paid anyway (current behaviour), got ${r.markedPaid}`],
      [!r.transferId, `no transfer, got ${r.transferId}`],
      // Addie's getUserByPublicKey throws for a pubkey it has never seen, so
      // this surfaces as a bare "not found" — less informative than the
      // "No Stripe Connected Account" message a KNOWN creator without an
      // account gets. Worth improving; recorded as-is.
      [/not found|no stripe connected account/i.test(r.transferError || ''), `refused, got: ${r.transferError}`],
    ],
  },

  {
    id: 'payout/no-creator-on-invoice',
    what: 'Invoice with no creator at all — the whole charge stays with the platform',
    trigger: 'Create an invoice before connecting Stripe. getpayed now blocks this, but invoices made before the gate existed have no creatorAddiePubKey.',
    async run() {
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: null });
      const intent = await createIntent(uuid, credentials);
      await payWithCard(intent, 'pm_card_bypassPending');
      await completePayment(uuid, credentials);
      const payout = await runPayout(intent.id);
      return { message: payout.message, transfers: payout.transfers?.length };
    },
    expect: (r) => [
      [r.transfers === 0, `no recipients, got ${r.transfers}`],
      [/no payees/i.test(r.message || ''), `says there is no one to pay, got: ${r.message}`],
    ],
  },

  {
    id: 'payout/double-payout',
    what: 'Payout run twice for the same payment',
    trigger: 'POST /complete twice, or retry a payout by hand after one succeeded.',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      await payWithCard(intent, 'pm_card_bypassPending');
      const first = await runPayout(intent.id);
      const second = await runPayout(intent.id);
      return { firstTransfer: first.transferId, secondTransfer: second.transferId, secondError: second.transferError };
    },
    expect: (r) => [
      [!!r.firstTransfer, `first payout succeeds, got error ${r.secondError}`],
      [!r.secondTransfer, `second pays nothing, got ${r.secondTransfer}`],
      // source_transaction caps transfers at the charge amount, so Stripe
      // itself refuses the duplicate.
      [/must not exceed the source amount/i.test(r.secondError || ''), `Stripe blocks the duplicate, got: ${r.secondError}`],
    ],
  },

  {
    id: 'payout/pending-balance',
    what: 'Payout from a charge whose funds have not settled',
    trigger: 'Pay with the ordinary test card (pm_card_visa / 4242…) instead of pm_card_bypassPending. Its funds land in Stripe\'s PENDING balance.',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      const paid = await payWithCard(intent, 'pm_card_visa');
      const payout = await runPayout(intent.id);
      return { intentStatus: paid.intentStatus, transferId: payout.transferId, transferError: payout.transferError };
    },
    // source_transaction draws on the charge itself, so an unsettled balance
    // is no longer a problem. Before that fix this failed with
    // "insufficient available funds".
    expect: (r) => [
      [r.intentStatus === 'succeeded', `charge succeeds, got ${r.intentStatus}`],
      [!!r.transferId, `payout still works off an unsettled charge, got error: ${r.transferError}`],
    ],
  },

  // ── Disputes ────────────────────────────────────────────────────────────

  {
    id: 'dispute/fraudulent-chargeback',
    what: 'Payer charges back after the creator has been paid',
    trigger: 'Pay with card 4000000000000259 (token pm_card_createDispute). Stripe opens a dispute immediately.',
    async run() {
      const creator = await mintPayableCreator();
      const { uuid, credentials } = await publishInvoice({ creatorPubKey: creator.pubKey });
      const intent = await createIntent(uuid, credentials);
      const paid = await payWithCard(intent, 'pm_card_createDispute');
      await completePayment(uuid, credentials);
      const payout = await runPayout(intent.id);
      const after = await paymentStatus(uuid);
      return { intentStatus: paid.intentStatus, transferId: payout.transferId, transferError: payout.transferError, paid: after.paid };
    },
    // Nothing here reacts to a dispute: no webhook handler exists, so the
    // invoice stays paid and any transfer stands. Recorded so the gap is
    // visible rather than assumed.
    expect: (r) => [
      [r.intentStatus === 'succeeded', `charge succeeds, got ${r.intentStatus}`],
      [r.paid === true, `invoice stays paid, got ${r.paid}`],
    ],
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0];
const selected = filter ? cases.filter((c) => c.id.includes(filter)) : cases;

console.log(`\nPayment failure modes — ${config.eumachia}`);
console.log(`Stripe test mode. ${selected.length} case${selected.length === 1 ? '' : 's'}${filter ? ` matching "${filter}"` : ''}.\n`);

let passed = 0;
const failures = [];

for (const testCase of selected) {
  process.stdout.write(`  ${testCase.id} … `);
  try {
    const result = await testCase.run();
    const checks = testCase.expect(result);
    const broken = checks.filter(([ok]) => !ok);
    if (broken.length === 0) {
      passed++;
      console.log('ok');
      for (const [, description] of checks) console.log(`      ${description}`);
    } else {
      failures.push({ id: testCase.id, reasons: broken.map(([, d]) => d), result });
      console.log('CHANGED');
      for (const [, description] of broken) console.log(`      expected ${description}`);
    }
  } catch (err) {
    failures.push({ id: testCase.id, reasons: [`threw: ${err.message}`] });
    console.log(`ERROR — ${err.message}`);
  }
}

console.log(`\n${passed}/${selected.length} as documented.`);
if (failures.length) {
  console.log('\nDiffering from test/README.md — a fix, or a regression:');
  for (const f of failures) console.log(`  ${f.id}: ${f.reasons.join('; ')}`);
}
process.exit(failures.length ? 1 : 0);
