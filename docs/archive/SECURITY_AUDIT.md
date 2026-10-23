# Security Audit Configuration

## Overview
This document outlines the npm security audit configuration for the BANKERCHANGER project. All three npm-based environments (backend, frontend, indexer) are now configured to fail CI builds on HIGH and CRITICAL vulnerabilities.

## Configuration Details

### CI Pipeline Changes
- **Backend CI** (`backend-ci.yml`): Added `npm audit --audit-level=high` after dependency installation
- **Frontend CI** (`frontend-ci.yml`): Added `npm audit --audit-level=high` after dependency installation
- **Indexer CI** (`indexer-ci.yml`): Created new CI pipeline with `npm audit --audit-level=high` check

### .npmrc Files
Created `.npmrc` files in each environment to enforce `audit-level=high`:
- `backend/.npmrc`
- `frontend/.npmrc`
- `indexer/.npmrc`

These files ensure that any direct execution of `npm audit` will enforce HIGH vulnerability blocking.

### Dependabot Configuration
Updated `.github/dependabot.yml` to:
1. **Enable Auto-merge** for security patches:
   - Backend: Up to 5 auto-merged PRs (with security label)
   - Frontend: Up to 5 auto-merged PRs (with security label)
   - Indexer: Up to 3 auto-merged PRs (with security label)
   - Cargo/Contracts: Up to 3 auto-merged PRs
   - GitHub Actions: Up to 2 auto-merged PRs

2. **Weekly Security Patches** (Monday):
   - All npm directories run on Monday schedule
   - Security patches are auto-merged after CI passes

3. **Labels**: Added "security" label to all dependency updates for better tracking

## Current Vulnerabilities

### Backend
The backend package.json had duplicate and conflicting dependency versions that have been resolved:
- Unified `drizzle-kit` to `^0.31.10`
- Unified `drizzle-orm` to `^0.45.2`
- Unified `express` to `^4.19.2`
- Removed duplicate `@typescript-eslint/parser` entries
- Unified `jest` and other duplicates to consistent versions

### Frontend
Frontend dependencies are current with no known HIGH/CRITICAL vulnerabilities.

### Indexer
Indexer dependencies are current with no known HIGH/CRITICAL vulnerabilities.

## npm Audit Override Justification

In case any HIGH/CRITICAL vulnerabilities require justification before updating:
- Create `.npmrc` overrides in the format: `audit-level-override=<package>:<version>:<reason>`
- Document the justification in this file
- Only apply overrides temporarily until a fix is available

## Testing

To manually test the audit:
```bash
# Backend
cd backend && npm audit --audit-level=high

# Frontend
cd frontend && npm audit --audit-level=high

# Indexer
cd indexer && npm audit --audit-level=high
```

## References
- [npm audit documentation](https://docs.npmjs.com/cli/v8/commands/npm-audit)
- [GitHub Dependabot documentation](https://docs.github.com/en/code-security/dependabot)
- [OWASP Dependency-Check](https://owasp.org/www-project-dependency-check/)
