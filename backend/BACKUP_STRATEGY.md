# BANKERCHANGER Database Backup Strategy

## Overview

This document describes the automated PostgreSQL backup infrastructure for BANKERCHANGER, including daily encrypted backups, local storage persistence, optional remote off-site object storage upload (AWS S3 and Google Cloud Storage via AWS CLI, GCS tools, or rclone), disaster recovery procedures, and monthly restore drills.

**Key Features:**
- ✅ Daily automated backups (2:00 AM UTC via cron)
- ✅ AES-256 (OpenSSL) or GPG encryption before remote transfer
- ✅ SHA-256 checksum generated with every backup and verified before every restore
- ✅ Local storage persistence (`/var/backups/bankerchanger/`)
- ✅ Optional Off-Site Remote Storage:
  - **AWS S3** (via AWS CLI or rclone, with versioning support)
  - **Google Cloud Storage (GCS)** (via gsutil, gcloud, or rclone)
  - **rclone remotes** (compatible with any S3-compatible or cloud object storage)
- ✅ 30-day retention lifecycle pruning (automatically deletes remote & local backups older than 30 days)
- ✅ Weekly integrity verification
- ✅ Monthly automated restore testing (CI/CD)
- ✅ Point-in-time recovery support

---

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
│              (backup.sql.gz - ~80% reduction)               │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
┌─────────────────────────┐   ┌─────────────────────────────┐
│ OpenSSL AES-256 (-pbkdf2)│   │ GPG Symmetric / Recipient   │
│ (.sql.gz.enc)           │   │ (.sql.gz.gpg)               │
└────────┬────────────────┘   └──────────────┬──────────────┘
         │                                   │
         └───────────────┬───────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                Local Backup Directory                       │
│             (/var/backups/bankerchanger/)                   │
│   (Preserved locally; pruned after 30-day retention limit)  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │
                   sha256sum
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                 SHA-256 Checksum Sidecar                    │
│        (backup.sql.gz.enc.sha256 - integrity proof)         │
└────────────────────────┬────────────────────────────────────┘
                         │ (Optional Off-Site Upload Step)
                         │
         ┌───────────────┴───────────────┬───────────────────────────────┐
         ▼                               ▼                               ▼
┌──────────────────┐           ┌──────────────────┐            ┌──────────────────┐
│   AWS S3 Bucket  │           │   GCS Bucket     │            │  rclone Remote   │
│   (aws s3 cp /   │           │ (gsutil / gcloud │            │ (rclone copyto)  │
│   rclone copyto) │           │ / rclone copyto) │            │                  │
└────────┬─────────┘           └────────┬─────────┘            └────────┬─────────┘
         │                              │                               │
         └──────────────────────────────┴───────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Automated Lifecycle Pruning                             │
│       (Deletes backups older than 30 days from off-site storage & local)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

Every backup is uploaded and stored together with a `.sha256` sidecar. `restore-db.sh`
downloads or verifies the sidecar and runs `sha256sum -c` against the encrypted file
**before** decrypting or touching the database. A missing, malformed, or
mismatched checksum aborts the restore with exit code `7`.

## Files & Scripts

### Core Backup Scripts

| Script | Purpose | Schedule |
|--------|---------|----------|
| `backend/scripts/backup-db.sh` | Create compressed dumps, encrypt with AES-256 or GPG, save locally, upload to S3/GCS/rclone, and prune expired backups | Daily 2 AM UTC (cron) |
| `backend/scripts/restore-db.sh` | Decrypt and restore backups from S3, GCS, rclone, or local file | On-demand |
| `backend/scripts/manage-backups.sh` | List, verify integrity, report, and cleanup backups across S3/GCS/rclone/local | Manual + cron |
| `backend/scripts/generate-backup-key.sh` | Generate AES-256 encryption keys (file or AWS Secrets Manager) | One-time setup |
| `backend/scripts/backup-cron-setup.sh` | Install/remove automated backup cron jobs | One-time setup |

### Documentation & Configuration

| File | Purpose |
|------|---------|
| `backend/BACKUP_STRATEGY.md` | This file - comprehensive backup and recovery guide |
| `docs/runbook.md` | Operational procedures (disaster recovery section) |
| `backend/.env.example` | Configuration templates for local, AWS S3, GCS, and rclone backups |
| `.github/workflows/backup-restore-drill.yml` | Monthly automated restore drill (CI) |

---

## Off-Site Storage Configuration

Database dumps are saved locally to `/var/backups/bankerchanger/` by default. To prevent data loss if the host disk fails or container instances terminate, off-site storage uploads can be enabled for **AWS S3**, **Google Cloud Storage (GCS)**, or **rclone**.

### 1. AWS S3 Configuration

#### Using AWS CLI (`aws`)
AWS CLI is the default tool for S3 uploads.

```bash
# Environment variables (.env)
REMOTE_STORAGE=s3
REMOTE_TOOL=aws
AWS_S3_BACKUP_BUCKET=bankerchanger-backups-prod
AWS_REGION=us-east-1
S3_BACKUP_PREFIX=db-backups
BACKUP_RETENTION_DAYS=30
```

Required IAM permissions:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::bankerchanger-backups-prod",
        "arn:aws:s3:::bankerchanger-backups-prod/*"
      ]
    }
  ]
}
```

#### Using rclone for S3
If AWS CLI is not installed or when using S3-compatible alternatives (MinIO, Wasabi, Backblaze B2, Ceph):

```bash
# Configure rclone remote (e.g. named 's3remote')
rclone config create s3remote s3 \
  provider AWS \
  region us-east-1 \
  access_key_id "$AWS_ACCESS_KEY_ID" \
  secret_access_key "$AWS_SECRET_ACCESS_KEY"

# In .env:
REMOTE_STORAGE=s3
REMOTE_TOOL=rclone
RCLONE_DEST=s3remote:bankerchanger-backups-prod/db-backups
```

---

### 2. Google Cloud Storage (GCS) Configuration

#### Using Google Cloud SDK (`gsutil` or `gcloud`)
For environments hosted on GCP or using Google Cloud Storage:

```bash
# Environment variables (.env)
REMOTE_STORAGE=gcs
REMOTE_TOOL=gsutil   # or 'gcloud'
GCS_BACKUP_BUCKET=bankerchanger-backups-gcs-prod
GCS_BACKUP_PREFIX=db-backups
BACKUP_RETENTION_DAYS=30
```

Authenticate service account:
```bash
gcloud auth activate-service-account --key-file=/secure/gcp/service-account.json
```

Required IAM roles on the GCP service account:
- `roles/storage.objectAdmin` (or `storage.objectCreator`, `storage.objectViewer`, and `storage.legacyBucketReader`)

#### Using rclone for GCS
```bash
# Configure rclone for Google Cloud Storage:
rclone config create gcsremote google cloud storage \
  service_account_file /secure/gcp/service-account.json \
  project_number my-gcp-project

# In .env:
REMOTE_STORAGE=gcs
REMOTE_TOOL=rclone
RCLONE_DEST=gcsremote:bankerchanger-backups-gcs-prod/db-backups
```

---

### 3. Local-Only Mode (No Remote Storage)

If off-site storage is not yet provisioned, the backup script runs in local-only mode:

```bash
# In .env or CLI:
REMOTE_STORAGE=none
BACKUP_DIR=/var/backups/bankerchanger
```

Backups are saved exclusively to `/var/backups/bankerchanger/` with permissions `600`, and pruned according to `BACKUP_RETENTION_DAYS` (30 days default).

---

## Encryption Configuration

Backups must always be encrypted before being transmitted over networks or stored in off-site object storage.

### Option A: OpenSSL AES-256 (Default)

Symmetric AES-256-CBC encryption using PBKDF2 key derivation.

1. **Generate 256-bit encryption key:**
   ```bash
   ./backend/scripts/generate-backup-key.sh --key-file /secure/backups/encryption.key
   chmod 600 /secure/backups/encryption.key
   ```
2. **Configure environment:**
   ```bash
   BACKUP_ENCRYPTION_TYPE=aes-256
   BACKUP_ENCRYPTION_KEY_FILE=/secure/backups/encryption.key
   ```
3. **File Output:** `bankerchanger_backup_YYYYMMDD_HHMMSS.sql.gz.enc`

### Option B: GPG Encryption

GPG can be configured for either symmetric encryption (with passphrase) or asymmetric encryption (with public key recipient).

#### Symmetric GPG (AES-256):
```bash
# In .env:
BACKUP_ENCRYPTION_TYPE=gpg
GPG_PASSPHRASE_FILE=/secure/backups/gpg.passphrase
# Alternatively:
# GPG_PASSPHRASE=YourStrongPassphraseHere
```

#### Asymmetric GPG (Public Key / Recipient):
```bash
# Import DevOps public key:
gpg --import /secure/backups/devops-backup-public.asc

# In .env:
BACKUP_ENCRYPTION_TYPE=gpg
GPG_RECIPIENT=devops@bankerchanger.internal
```
3. **File Output:** `bankerchanger_backup_YYYYMMDD_HHMMSS.sql.gz.gpg`

---

## Retention Lifecycle Pruning (30-Day Policy)

Backups older than 30 days (`BACKUP_RETENTION_DAYS=30`) are automatically pruned from both off-site storage and local storage.

### 1. Automated Script Pruning
Every time `backup-db.sh` or `manage-backups.sh --cleanup` executes:
- It computes the cutoff timestamp (`30 days ago`, formatted `YYYYMMDD`).
- Files matching `${DB_NAME}_backup_YYYYMMDD_HHMMSS.*` with `YYYYMMDD < cutoff` are securely deleted.
- Supports AWS S3, Google Cloud Storage, rclone remotes, and local directories.

### 2. Cloud Storage Native Bucket Lifecycle Policies (Recommended)

In addition to script-based pruning, configuring native bucket lifecycle rules ensures automated expiration even if the backup host is down.

#### AWS S3 Lifecycle Rule (30 Days):
```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$AWS_S3_BACKUP_BUCKET" \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "PruneBackupsOlderThan30Days",
        "Filter": {
          "Prefix": "db-backups/"
        },
        "Status": "Enabled",
        "Expiration": {
          "Days": 30
        },
        "NoncurrentVersionExpiration": {
          "NoncurrentDays": 7
        }
      }
    ]
  }'
```

#### Google Cloud Storage Lifecycle Rule (30 Days):
Create `lifecycle.json`:
```json
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {
        "age": 30,
        "matchesPrefix": ["db-backups/"]
      }
    }
  ]
}
```
Apply to GCS bucket:
```bash
gcloud storage buckets update "gs://$GCS_BACKUP_BUCKET" --lifecycle-file=lifecycle.json
```

---

## Environment Variables Reference

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://bankerchanger:bankerchanger@localhost:5432/bankerchanger` | `postgresql://user:pass@host:5432/db` |
| `DB_NAME` | Database name | `bankerchanger` | `bankerchanger` |
| `BACKUP_DIR` | Local backup storage directory | `/var/backups/bankerchanger` | `/var/backups/bankerchanger` |
| `KEEP_LOCAL_BACKUP` | Retain local backup copy | `true` | `true` / `false` |
| `REMOTE_STORAGE` | Off-site storage provider | Auto-detected (`none` if unset) | `s3`, `gcs`, `rclone`, `none` |
| `REMOTE_TOOL` | Remote transfer CLI tool | Auto-detected | `aws`, `rclone`, `gcloud`, `gsutil` |
| `AWS_S3_BACKUP_BUCKET` | AWS S3 bucket name | Empty | `bankerchanger-backups-prod` |
| `AWS_REGION` | AWS region | `us-east-1` | `us-east-1` |
| `S3_BACKUP_PREFIX` | S3 path prefix | `db-backups` | `db-backups` |
| `GCS_BACKUP_BUCKET` | Google Cloud Storage bucket | Empty | `bankerchanger-gcs-backups` |
| `GCS_BACKUP_PREFIX` | GCS path prefix | `db-backups` | `db-backups` |
| `RCLONE_DEST` | rclone remote destination | Empty | `s3:mybucket/prefix` or `gcs:bucket/prefix` |
| `BACKUP_RETENTION_DAYS` | Retention pruning threshold | `30` | `30` |
| `BACKUP_ENCRYPTION_TYPE` | Encryption algorithm/tool | `aes-256` | `aes-256`, `gpg`, `none` |
| `BACKUP_ENCRYPTION_KEY_FILE`| Key/passphrase file path | Empty | `/secure/backups/encryption.key` |
| `BACKUP_ENCRYPTION_KEY` | Direct key / passphrase variable | Empty | Base64 random key string |
| `GPG_RECIPIENT` | GPG recipient email/key ID | Empty | `devops@bankerchanger.internal` |
| `GPG_PASSPHRASE_FILE` | GPG passphrase file path | Empty | `/secure/backups/gpg.pass` |
| `GPG_PASSPHRASE` | Direct GPG passphrase string | Empty | Secret passphrase |
| `LOG_DIR` | Directory for backup logs | `/var/log/backups` | `/var/log/backups` |

---

## Disaster Recovery Runbook

### Scenario 1: Restore Latest Backup from S3 or GCS

```bash
# 1. Inspect available backups
./backend/scripts/manage-backups.sh --list

# 2. Restore latest backup into a temporary validation database
./backend/scripts/restore-db.sh --latest --target-db bankerchanger_restore_test

# 3. Verify table counts and data integrity
psql postgresql://user:pass@localhost:5432/bankerchanger_restore_test \
  -c "SELECT count(*) FROM users; SELECT count(*) FROM markets;"
```

### Scenario 2: Restore from a Local Backup File

```bash
# Restore directly from local encrypted dump
./backend/scripts/restore-db.sh \
  --file /var/backups/bankerchanger/bankerchanger_backup_20261022_020000.sql.gz.enc \
  --target-db bankerchanger_restore_test
```

### Scenario 3: Point-in-Time Recovery from Remote Timestamp

```bash
# List all backups
./backend/scripts/manage-backups.sh --list

# Restore specific snapshot
./backend/scripts/restore-db.sh \
  --backup-timestamp 20261022_020000 \
  --target-db bankerchanger_restore_test
```

---

## Troubleshooting & Verification

### Test decryptions manually:

#### For OpenSSL AES-256 (.enc):
```bash
openssl enc -aes-256-cbc -d -pbkdf2 \
  -in /var/backups/bankerchanger/backup.sql.gz.enc \
  -pass file:/secure/backups/encryption.key \
  | gunzip | head -50
```

#### For GPG (.gpg):
```bash
gpg --batch --yes --pinentry-mode loopback --decrypt \
  --passphrase-file /secure/backups/gpg.passphrase \
  /var/backups/bankerchanger/backup.sql.gz.gpg \
  | gunzip | head -50
```

### Check Logs:
```bash
tail -100 /var/log/backups/backup-$(date +%Y%m).log
tail -100 /var/log/backups/restore-*.log
```

---

**Last Updated:** October 2026  
**Version:** 2.0  
**Status:** Production Ready  
