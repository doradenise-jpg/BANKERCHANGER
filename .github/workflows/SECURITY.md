# GitHub Actions Security Practices

## Secret Management

### Admin Secret Key (deploy-testnet.yml)

**Security Measures:**
1. **Source enforcement**: The `ADMIN_SECRET_KEY` is sourced **only from GitHub Secrets**, not from workflow inputs
2. **Explicit masking**: An early workflow step explicitly masks the secret using `::add-mask::` to ensure it's redacted in all subsequent logs
3. **No fallback**: The key is not available via workflow dispatch inputs, preventing accidental exposure during manual runs

**Why This Matters:**
- GitHub Actions automatically masks secrets defined in the repository, but user-provided input via `workflow_dispatch` is not masked by default
- If a deployment script or build tool prints environment variables, an unmasked secret would be visible in logs
- Explicit masking ensures the secret is redacted even if tools ignore GitHub's automatic masking

**To Deploy:**
1. Set `ADMIN_SECRET_KEY` as a GitHub repository secret in Settings → Secrets and variables → Actions
2. Trigger the workflow via **Actions → Deploy to Stellar Testnet → Run workflow**
3. The secret will never appear in logs

### Other Credentials

- **ORACLE_ADDRESSES**: Public Stellar addresses (not sensitive)
- **DEFAULT_FEE_BPS**: Public configuration value (not sensitive)

## Best Practices Applied

| Practice | Implementation |
|----------|-----------------|
| No hardcoded secrets | All sensitive values come from GitHub Secrets only |
| No input-based secrets | Removed `admin_secret_key` from workflow inputs |
| Explicit masking | Added `::add-mask::` step for additional protection |
| Artifact cleanup | Deployment artifacts retained for 90 days, then deleted |
| Environment separation | Deployments use GitHub Environments (testnet) for access control |

## Audit Trail

All deployments are logged and traceable:
- Who triggered the deployment (GitHub Actions job logs)
- When it was triggered (timestamp in logs)
- What was deployed (deployments.json artifact)
- Network target (testnet/mainnet in workflow name)

## Incident Response

If a secret is accidentally exposed:

1. **Rotate immediately**: Generate a new key in your Stellar wallet
2. **Update GitHub Secret**: Set the new value in Settings → Secrets and variables → Actions
3. **Re-deploy**: Trigger a new deployment with the rotated key
4. **Audit logs**: Review who had access to the exposed secret during that time window

---

See also: [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
