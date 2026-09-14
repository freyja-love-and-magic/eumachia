// Where eumachia finds the services it depends on.
//
// Prefer setting BDO_BASE_URL / ADDIE_BASE_URL explicitly in deployment. The
// fallbacks below point at the public gateway rather than
// `https://${SUBDOMAIN}.bdo.allyabase.com/` — the convention other allyabase
// services use — because those per-service subdomain boxes were confirmed
// serving a cert for an unrelated domain, so every request to them died with
// ERR_TLS_CERT_ALTNAME_INVALID. That failure was silent and total: GET
// /pay/:uuid rethrows, and eumachia.js's route catch turns it into
// "Something went wrong loading this invoice". Going through the gateway
// costs one extra hop and is reliably correct.
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://dev.8as.world/';

export default {
  bdoBaseURL: process.env.BDO_BASE_URL || `${GATEWAY_URL}bdo/`,
  addieBaseURL: process.env.ADDIE_BASE_URL || `${GATEWAY_URL}addie/`,
  paymentsHash: 'eumachia-payments',
  currency: 'usd',
  stripeProcessor: 'stripe',
  // 3013, not eumachia's historical 3011: on the shared allyabase box 3011
  // is covenant's. PORT overrides it; deployment should set it explicitly.
  port: process.env.PORT || 3013
};
