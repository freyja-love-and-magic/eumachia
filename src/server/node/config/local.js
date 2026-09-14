import defaultConfig from './default.js';

export default {
  ...defaultConfig,
  // LOCALHOST=true means "every allyabase service is on this same box, on its
  // conventional port" — which is how allyabase_setup.sh's pm2 ecosystem runs
  // them. Matches bdo.js/addie.js's own LOCALHOST-conditional and the same
  // ports they use.
  //
  // An explicit BDO_BASE_URL/ADDIE_BASE_URL still wins: default.js reads
  // those first, and overriding them here would make the explicit setting
  // unreachable whenever LOCALHOST happened to be set too.
  bdoBaseURL: process.env.BDO_BASE_URL
    || (process.env.LOCALHOST ? 'http://localhost:3003/' : defaultConfig.bdoBaseURL),
  addieBaseURL: process.env.ADDIE_BASE_URL
    || (process.env.LOCALHOST ? 'http://localhost:3005/' : defaultConfig.addieBaseURL)
};
