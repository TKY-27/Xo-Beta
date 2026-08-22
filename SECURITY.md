# Security Policy

## Supported versions

The latest `main` branch and the most recent release tag receive fixes.

## Scope

Xo Beta is a fully client-side game:

- No accounts, no personal data collection, no analytics.
- No secrets are embedded in the bundle (verified by CI license/policy checks).
- The optional Cloudflare deployment serves static files only via Workers
  Static Assets; no privileged bindings are exposed.

## Reporting

Report vulnerabilities privately via GitHub Security Advisories
(**Security** tab → *Report a vulnerability*). Please avoid filing public
issues for exploitable defects. Expect a response within 7 days.

Please report things like XSS vectors through UI strings, dependency
vulnerabilities, or supply-chain concerns here rather than in public issues.
