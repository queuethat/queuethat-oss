# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Advisories → [Report a vulnerability](https://github.com/queuethat/queuethat-oss/security/advisories/new)**.
Do not open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. If you cannot
use GitHub's private reporting, email support@queuethat.com instead.

This is a small project with one maintainer. We aim to acknowledge a report within 7 days, agree
a fix and disclosure date with you, and credit you in the advisory unless you prefer otherwise.
Please give us a reasonable time to fix the issue before disclosing it.

## Scope

In scope: this repository and the hosted service at app.queuethat.com. We are especially interested in

- one organisation reading or changing another organisation's data (RLS, `api.*` functions)
- guest status links that can be guessed, reused after they should expire, or used to act on
  someone else's visit
- paired display or kiosk devices gaining more access than their role
- personal data (names, phone numbers) appearing in logs, URLs or public screens

Out of scope: denial of service by volume, social engineering, reports from automated
scanners without a demonstrated impact, and problems in third-party services (Supabase,
Cloudflare) that should go to those vendors.

## Supported versions

Only the latest commit on `main` and the hosted service receive fixes. There are no tagged
releases yet; self-hosters should track `main`.
