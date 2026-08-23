# Security Policy

## Supported versions

The latest `master` branch and the most recent release tag receive fixes.

## Scope

Xo Beta is a fully client-side game:

- No accounts, no personal data collection, no analytics.
- No runtime network calls: all assets ship with the build and nothing loads
  from CDNs. A strict Content-Security-Policy (`public/_headers`) enforces
  `default-src 'self'` in production.
- No secrets are embedded in the repository or bundle — CI runs a pattern-based
  secret scan on every push/PR (`npm run audit:secrets`).
- The optional Cloudflare deployment serves static files only via Workers
  Static Assets; no privileged bindings are exposed.

## Reporting

Report vulnerabilities privately via GitHub Security Advisories
(**Security** tab → *Report a vulnerability*). Please avoid filing public
issues for exploitable defects. Expect a response within 7 days.

Please report things like XSS vectors through UI strings, dependency
vulnerabilities, or supply-chain concerns here rather than in public issues.
