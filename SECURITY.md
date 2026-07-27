# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

We take the security of BoxMeOut seriously. If you believe you have found a security vulnerability, please report it to us as described below.

**Please do not report security vulnerabilities through public GitHub issues.**

### Reporting Methods

You have two secure channels for reporting vulnerabilities:

#### Option 1: GitHub Private Security Advisory (Recommended)
Use GitHub's built-in security advisory feature for fastest handling:
1. Navigate to the [Security Advisories](https://github.com/your-org/BANKERCHANGER/security/advisories) page
2. Click "Report a vulnerability"
3. Fill out the form with details about the vulnerability
4. Submit—your report is private and only visible to maintainers

**Advantages**: 
- Private by default
- Direct visibility to our security team
- Automatic notification and tracking
- GitHub's infrastructure ensures confidentiality

#### Option 2: Email
If you prefer email, report to: **security@boxmeout.app**

Please include vulnerability details (see "What to include" below). You should receive a response within 48 hours. If you do not, please follow up to ensure your message was received.

### What to include

- Type of issue (e.g. buffer overflow, SQL injection, cross-site scripting, XSS, integer overflow, unauthorized access, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it
- CVSS score estimate (if available)

### Timeline & Response

- **Initial acknowledgment**: Within 48 hours of report submission
- **Triage**: We will assess severity and impact
- **Updates**: We will provide status updates at least weekly
- **Resolution**: We will notify you when a patch is available
- **Disclosure**: We will publicly acknowledge your responsible disclosure if you wish (with your permission)

### Public Disclosure Timeline

For vulnerabilities in released versions:
- **Critical (CVSS 9-10)**: Public disclosure after 7-14 days or patch release
- **High (CVSS 7-8.9)**: Public disclosure after 30 days or patch release
- **Medium (CVSS 4-6.9)**: Public disclosure after 60 days or patch release
- **Low (CVSS 0-3.9)**: Public disclosure after 90 days

We will coordinate with you on the exact timeline if you wish to be publicly credited.

## Preferred Languages

We prefer all communications to be in English.

## Policy

We follow the principle of responsible disclosure. We ask that you:

- Give us a reasonable time to fix the issue before disclosing it publicly
- Make a good faith effort to avoid privacy violations, destruction of data, and interruption of our services
- Do not exploit the vulnerability beyond what is necessary to demonstrate the issue
- Do not access or modify user data without explicit consent
