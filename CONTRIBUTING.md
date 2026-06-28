# Contributing to BANKERCHANGER

Thank you for contributing! Please read these guidelines before opening a PR.

## Branch Protection Rules for `main`

Direct pushes to `main` are blocked. All changes must go through a pull request.

### Required Status Checks

The following CI jobs **must pass** before a PR can be merged:

| Check | Workflow |
|-------|----------|
| `Backend` | `.github/workflows/backend-ci.yml` |
| `Frontend / TypeScript Build + Tests` | `.github/workflows/frontend-ci.yml` |
| `Frontend / E2E Tests` | `.github/workflows/frontend-ci.yml` |
| `Contracts` | `.github/workflows/contracts-ci.yml` |

### Configuring Branch Protection via GitHub UI

1. Navigate to **Settings → Branches → Branch protection rules** and click **Add rule**.
2. Set **Branch name pattern** to `main`.
3. Enable **Require a pull request before merging**.
   - Set **Required approvals** to `1`.
   - Enable **Dismiss stale pull request approvals when new commits are pushed**.
4. Enable **Require status checks to pass before merging**.
   - Enable **Require branches to be up to date before merging**.
   - Search for and add each check listed in the table above.
5. Enable **Do not allow bypassing the above settings** so admins are also subject to them.
6. Click **Save changes**.

### Configuring Branch Protection via `gh` CLI

```bash
gh api repos/doradenise-jpg/BANKERCHANGER/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["Backend","Frontend / TypeScript Build + Tests","Frontend / E2E Tests","Contracts"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  --field restrictions=null
```

## Development Workflow

1. Fork the repository and create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Make your changes and commit following [Conventional Commits](https://www.conventionalcommits.org/).
3. Run the full check suite locally before pushing:
   ```bash
   npm run lint && npm test && npm run build
   ```
4. Open a pull request against `main`. The PR description must reference the issue it addresses (`Closes #N`).
5. A changelog entry is required for any PR that ships a user-visible change. Add it to `CHANGELOG.md` under `[Unreleased]`.

## Commit Message Format

```
<type>(<scope>): <short summary>

[optional body]

[optional footer: Closes #N]
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`.

## Reporting Bugs

Open a GitHub Issue using the bug report template. Include reproduction steps, expected vs actual behaviour, and environment details.
