# BANKERCHANGER Database Backup Strategy

## Overview

This document describes the automated PostgreSQL backup infrastructure for BANKERCHANGER, including daily encrypted backups to AWS S3, disaster recovery procedures, and monthly restore drills.

**Key Features:**
- ✅ Daily automated backups (2:00 AM UTC)
- ✅ AES-256 encryption at rest
- ✅ AWS S3 storage with versioning
- ✅ 30-day retention policy
- ✅ Weekly integrity verification
- ✅ Monthly restore testing (CI/CD)
- ✅ Point-in-time recovery support

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL Database                      │
│                  (bankerchanger at 5432)                    │
└────────────────────────┬────────────────────────────────────┘
                         │
                    pg_dump -v
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    SQL Backup File                          │
│               (daily at 2:00 AM UTC)                        │
└────────────────────────┬────────────────────────────────────┘
                         │
                    gzip -f
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  Compressed Backup                          │
│              (backup.sql.gz - reduced 80%)                  │
└────────────────────────┬────────────────────────────────────┘
                         │
            openssl enc -aes-256-cbc
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│               AES-256 Encrypted Backup                      │
│         (backup.sql.gz.enc - secure storage)                │
└────────────────────────┬────────────────────────────────────┘
                         │
                   aws s3 cp
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                      AWS S3 Bucket                          │
│        s3://bankerchanger-backups/db-backups/               │
│     (Versioning enabled, Lifecycle policies)                │
└─────────────────────────────────────────────────────────────┘
```

## Files & Scripts

### Core Backup Scripts

| Script | Purpose | Schedule |
|--------|---------|----------|
| `backup-db.sh` | Create encrypted backups with pg_dump | Daily 2 AM UTC (cron) |
| `restore-db.sh` | Decrypt and restore backups from S3 | On-demand |
| `manage-backups.sh` | List, verify, cleanup backups | Manual + cron |
| `generate-backup-key.sh` | Generate AES-256 encryption keys | One-time setup |
| `backup-cron-setup.sh` | Install/remove automated cron jobs | One-time setup |

### Documentation & Configuration

| File | Purpose |
|------|---------|
| `BACKUP_STRATEGY.md` | This file - comprehensive backup guide |
| `docs/runbook.md` | Operational procedures (disaster recovery section) |
| `backend/.env.example` | Environment variables for backup config |
| `.github/workflows/backup-restore-drill.yml` | Monthly automated restore test (CI) |

## Quick Start

### 1. Generate Encryption Key

```bash
# Generate and store locally (development)
cd /app && ./backend/scripts/generate-backup-key.sh \
  --key-file /secure/backups/encryption.key

# Or store in AWS Secrets Manager (production recommended)
cd /app && ./backend/scripts/generate-backup-key.sh --to-secrets-manager
```

### 2. Configure Environment Variables

```bash
# Set in .env or environment
export DATABASE_URL=postgresql://user:pass@localhost:5432/bankerchanger
export AWS_S3_BACKUP_BUCKET=my-backups-bucket
export AWS_REGION=us-east-1
export BACKUP_ENCRYPTION_KEY_FILE=/secure/backups/encryption.key
export BACKUP_RETENTION_DAYS=30
```

### 3. Test Backup Manually

```bash
cd /app && ./backend/scripts/backup-db.sh

# Monitor in another terminal
tail -f /var/log/backups/backup-$(date +%Y%m).log
```

### 4. Setup Automated Cron Jobs

```bash
# Install daily backup, weekly verify, monthly cleanup
sudo ./backend/scripts/backup-cron-setup.sh \
  --user backup \
  --app-dir /app

# Verify installation
crontab -u backup -l | grep BANKERCHANGER_DB_BACKUP
```

## Backup Lifecycle

### Daily Backup (2:00 AM UTC)

1. **Trigger:** Automated cron job
2. **Process:**
   - Connect to PostgreSQL
   - Run `pg_dump` with verbose output
   - Compress with gzip (typically 80% reduction)
   - Encrypt with AES-256 using OpenSSL
   - Upload to S3 with metadata
   - Log completion status
3. **Output:** `s3://bucket/db-backups/{db}_{timestamp}.sql.gz.enc`
4. **Size:** Typically 50-200 MB (encrypted)
5. **Duration:** 5-15 minutes (depending on database size)

### Weekly Verification (3:00 AM UTC, Sundays)

1. **Trigger:** Automated cron job
2. **Process:**
   - List all backups in S3
   - Check each backup file exists and is accessible
   - Verify file size > 0
   - Log verification results
3. **Alert:** Any backup marked INVALID should trigger investigation

### Monthly Cleanup (4:00 AM UTC, 1st of month)

1. **Trigger:** Automated cron job
2. **Process:**
   - Calculate cutoff date (retention_days ago)
   - List all backups older than cutoff
   - Delete old backups from S3
   - Log deletion summary
3. **Retention:** Default 30 days (configurable)

### Monthly Restore Drill (1st of month, 5:00 AM UTC)

1. **Trigger:** GitHub Actions workflow
2. **Process:**
   - Download latest backup from S3
   - Decrypt using GitHub Secrets
   - Restore to temporary test database
   - Validate schema (check table count)
   - Verify critical tables (users, markets, bets, disputes)
   - Check data integrity (row counts)
   - Cleanup test database
   - Report results
3. **Purpose:** Verify restore procedures work before disaster strikes
4. **Result:** GitHub workflow summary + Slack notification

## Disaster Recovery

### Scenario: Recent Backup Available

**RTO:** < 1 hour  
**RPO:** < 24 hours (depends on backup frequency)

```bash
# List available backups
./backend/scripts/manage-backups.sh --list

# Restore latest backup
./backend/scripts/restore-db.sh --latest --target-db bankerchanger_restore_test

# Verify restored data
psql postgresql://user:pass@localhost:5432/bankerchanger_restore_test \
  -c "SELECT COUNT(*) FROM markets; SELECT COUNT(*) FROM bets;"

# Swap databases after verification
# See docs/runbook.md for detailed swap procedure
```

### Scenario: Point-in-Time Recovery

```bash
# List backups with timestamps
./backend/scripts/manage-backups.sh --list

# Restore specific backup
./backend/scripts/restore-db.sh \
  --backup-timestamp 20240115_020000 \
  --target-db bankerchanger_restore_test
```

### Scenario: Complete Database Loss

```bash
# 1. Stop application
systemctl stop bankerchanger-backend

# 2. Drop corrupted database
psql postgresql://postgres@localhost/postgres \
  -c "DROP DATABASE IF EXISTS bankerchanger;"

# 3. Restore from backup
./backend/scripts/restore-db.sh --latest

# 4. Start application
systemctl start bankerchanger-backend

# 5. Monitor logs
journalctl -u bankerchanger-backend -f
```

## Security Considerations

### Encryption

- **Algorithm:** AES-256-CBC (128-bit IV, 256-bit key)
- **Key Size:** 32 bytes (256 bits) of random data
- **Key Storage:** AWS Secrets Manager (recommended) or local file with 600 permissions
- **Key Rotation:** Every 90 days recommended

### Access Control

- **IAM Permissions:** Backup user/role needs S3 and Secrets Manager access
- **Audit Logging:** All restore operations logged (when, who, which backup)
- **Encryption Keys:** Never commit to version control
- **S3 Bucket Policy:** Restrict to specific IAM roles only

### Best Practices

1. **Store keys separately from backups** - Different AWS account or vault
2. **Test restores regularly** - Monthly drill validates procedures
3. **Monitor backup age** - Alert if latest backup > 24 hours old
4. **Encrypt in transit** - Use HTTPS for S3 and TLS for database connections
5. **Log all restore operations** - Maintain audit trail for compliance
6. **Backup encryption keys** - Store backup of master key securely
7. **Rotate keys periodically** - Every 90 days or after personnel changes

## Monitoring & Alerts

### Key Metrics

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Backup Missing | > 24 hours | Manual restore needed? Check cron |
| Backup Size | < 1MB or > 500MB | Unusual? Investigate database |
| S3 Upload Failure | Any failure | Check AWS credentials and S3 access |
| Verification Failure | Any INVALID backup | Review S3 corruption or upload errors |
| Restore Test Failure | Any monthly failure | Debug restore procedures immediately |

### CloudWatch Metrics (Optional)

```bash
# Send backup success metric
aws cloudwatch put-metric-data \
  --namespace "BANKERCHANGER/Database" \
  --metric-name "BackupSuccess" \
  --value 1 \
  --region us-east-1

# Query metrics
aws cloudwatch get-metric-statistics \
  --namespace "BANKERCHANGER/Database" \
  --metric-name "BackupSuccess" \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-31T23:59:59Z \
  --period 86400 \
  --statistics Sum
```

## Troubleshooting

### Backup Failed

```bash
# Check logs
tail -100 /var/log/backups/backup-$(date +%Y%m).log

# Verify database connectivity
psql $DATABASE_URL -c "SELECT 1"

# Check AWS credentials
aws sts get-caller-identity

# Check S3 bucket access
aws s3 ls s3://$AWS_S3_BACKUP_BUCKET --region $AWS_REGION
```

### Restore Failed

```bash
# Check restore log
tail -100 /var/log/backups/restore-*.log

# Verify backup exists in S3
aws s3 ls "s3://$AWS_S3_BACKUP_BUCKET/db-backups/" --recursive

# Test decryption manually
openssl enc -aes-256-cbc -d \
  -in /tmp/backup.sql.gz.enc \
  -pass file:$BACKUP_ENCRYPTION_KEY_FILE \
  | gunzip | head -100
```

### S3 Upload Issues

```bash
# Verify S3 bucket policy
aws s3api get-bucket-policy --bucket $AWS_S3_BACKUP_BUCKET

# Check bucket region
aws s3api get-bucket-location --bucket $AWS_S3_BACKUP_BUCKET

# List recent uploads
aws s3 ls s3://$AWS_S3_BACKUP_BUCKET/db-backups/ \
  --recursive --human-readable | tail -10
```

## Performance Characteristics

### Database Size Impact

| DB Size | Backup Time | Compressed Size | Encrypted Size |
|---------|------------|-----------------|-----------------|
| 1 GB | 2-3 min | ~200 MB | ~200 MB |
| 10 GB | 5-8 min | ~2 GB | ~2 GB |
| 50 GB | 15-25 min | ~10 GB | ~10 GB |
| 100+ GB | 30+ min | Custom planning needed |

### S3 Upload Performance

- **Upload Speed:** ~50-100 MB/s on typical cloud infrastructure
- **100 MB backup:** ~1-2 seconds
- **1 GB backup:** ~10-20 seconds
- **10 GB backup:** 2-3 minutes

### Storage Costs (AWS S3 - us-east-1)

- **Storage:** $0.023 per GB/month
- **10 GB backups:** ~$0.23/month per backup
- **30-day retention:** ~$7/month
- **Plus:** Data transfer, API calls (minimal)

## Compliance & Legal

### Retention Policies

- **Default:** 30 days (meets most compliance requirements)
- **Healthcare (HIPAA):** Minimum 6 years recommended
- **Finance (PCI-DSS):** Minimum 1 year
- **General (GDPR):** Depends on data classification

### Audit Trail

```bash
# Query all restore operations from logs
grep "Restoring backup" /var/log/backups/restore-*.log

# Check S3 access logs (requires enabling)
aws s3api get-bucket-logging --bucket $AWS_S3_BACKUP_BUCKET
```

### Data Privacy

- **Encryption at rest:** ✅ AES-256
- **Encryption in transit:** ✅ HTTPS/TLS
- **Key management:** ✅ AWS Secrets Manager
- **Access logging:** ✅ CloudTrail available
- **Data retention:** ✅ Automated cleanup after 30 days

## Maintenance Tasks

### Monthly

- [ ] Review backup restore drill results
- [ ] Check backup integrity verification logs
- [ ] Verify at least 2+ backups exist
- [ ] Monitor S3 storage costs

### Quarterly

- [ ] Rotate encryption keys
- [ ] Test full disaster recovery scenario
- [ ] Review backup strategy with ops team
- [ ] Update retention policy if needed

### Annually

- [ ] Document recovery procedures
- [ ] Audit backup/restore access logs
- [ ] Plan for database growth
- [ ] Review and update this documentation

## References

### Scripts

- `backend/scripts/backup-db.sh` - Main backup script with full documentation
- `backend/scripts/restore-db.sh` - Restore script with all options
- `backend/scripts/manage-backups.sh` - Backup lifecycle management
- `backend/scripts/generate-backup-key.sh` - Encryption key generation
- `backend/scripts/backup-cron-setup.sh` - Cron job installation

### Documentation

- `docs/runbook.md` - Operational procedures and incident response
- `backend/.env.example` - Configuration variables
- `.github/workflows/backup-restore-drill.yml` - Monthly CI/CD test

### External Resources

- [PostgreSQL pg_dump Documentation](https://www.postgresql.org/docs/15/app-pgdump.html)
- [OpenSSL enc Command](https://www.openssl.org/docs/man1.1.1/man1/enc.html)
- [AWS S3 Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/BestPractices.html)
- [NIST Backup Guidelines](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5)

## Support & Issues

For backup-related issues:

1. Check `docs/runbook.md` - Database Backup & Disaster Recovery section
2. Review script logs: `/var/log/backups/`
3. Run `./backend/scripts/manage-backups.sh --report` for status
4. Contact DevOps team with logs and error details

---

**Last Updated:** January 2024  
**Version:** 1.0  
**Status:** Production Ready
