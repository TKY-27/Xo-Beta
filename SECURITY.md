# Security Policy

## Supported version

Before the first stable release, only the latest `master` branch receives
security fixes. This section should be updated when maintained release lines
exist.

## Scope

Xo Beta is a fully client-side game:

- No accounts, no personal data collection, no analytics.
- No third-party runtime network calls: code and assets ship with the build
  and nothing loads from CDNs. Same-origin asset requests are constrained by
  a strict Content-Security-Policy (`public/_headers`) whose production
  default is `default-src 'self'`.
- CI runs a pattern-based secret scan on every push/PR
  (`npm run audit:secrets`), plus dependency, license, asset and production
  bundle checks. This scan is a guardrail, not a substitute for review.
- The optional Cloudflare deployment serves static files only via Workers
  Static Assets; no privileged bindings are exposed.

## Reporting

Use a private GitHub Security Advisory (**Security** tab → *Advisories* →
*New draft advisory*). Before making this repository public, maintainers should
also enable GitHub private vulnerability reporting. If neither private route
is available, open a minimal issue requesting private contact and do not
include exploit details. Please avoid public disclosure of exploitable defects.

Useful reports include XSS vectors through UI strings, dependency
vulnerabilities and supply-chain concerns. Include affected versions,
reproduction steps and impact when it is safe to do so.
