#!/bin/bash

# ============================================================================
# PostgreSQL Automated Backup Script with AES-256 Encryption
# ============================================================================
# 
# Description:
#   Performs daily PostgreSQL backup using pg_dump with compression.
#   Encrypts backup with AES-256 using OpenSSL.
#   Uploads encrypted backup to AWS S3 with timestamp.
#   Manages backup retention (default: 30 days).
#
# Requirements:
#   - PostgreSQL client tools (pg_dump)
#   - OpenSSL for encryption
#   - AWS CLI v2 configured with credentials
#   - Environment variables: DATABASE_URL, AWS_S3_BACKUP_BUCKET, AWS_REGION
#
# Usage:
#   ./scripts/backup-db.sh                    # Run once
#   0 2 * * * cd /app && ./scripts/backup-db.sh  # Cron (daily at 2 AM UTC)
#
# Exit Codes:
#   0 - Success
#   1 - Configuration error
#   2 - Backup creation failed
#   3 - Encryption failed
#   4 - S3 upload failed
#   5 - Cleanup failed
#
# ============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────

# Load environment variables if .env file exists
if [[ -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.env"
fi

# Database configuration
DATABASE_URL="${DATABASE_URL:-postgresql://bankerchanger:bankerchanger@localhost:5432/bankerchanger}"
DB_NAME="${DB_NAME:-bankerchanger}"

# Backup storage configuration
BACKUP_DIR="${BACKUP_DIR:-/backups}"
S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-}"
S3_PREFIX="${S3_BACKUP_PREFIX:-db-backups}"
AWS_REGION="${AWS_REGION:-us-east-1}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

# Encryption configuration
ENCRYPTION_CIPHER="aes-256-cbc"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-}"

# Logging
LOG_DIR="${LOG_DIR:-/var/log/backups}"
LOG_FILE="${LOG_DIR}/backup-$(date +%Y%m).log"

# Temporary directory for backup files
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Timestamp for backup file naming
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$TEMP_DIR/${DB_NAME}_backup_${TIMESTAMP}.sql"
COMPRESSED_FILE="${BACKUP_FILE}.gz"
ENCRYPTED_FILE="${COMPRESSED_FILE}.enc"

# ── Functions ─────────────────────────────────────────────────────────────

log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $*" | tee -a "$LOG_FILE"
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*" | tee -a "$LOG_FILE" >&2
}

log_warn() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $*" | tee -a "$LOG_FILE"
}

validate_config() {
  local errors=0

  # Ensure log directory exists
  mkdir -p "$LOG_DIR"

  # Validate S3 configuration
  if [[ -z "$S3_BUCKET" ]]; then
    log_error "AWS_S3_BACKUP_BUCKET environment variable not set"
    ((errors++))
  fi

  # Validate encryption key
  if [[ -z "$ENCRYPTION_KEY_FILE" ]] || [[ ! -f "$ENCRYPTION_KEY_FILE" ]]; then
    log_error "BACKUP_ENCRYPTION_KEY_FILE not set or file does not exist: $ENCRYPTION_KEY_FILE"
    ((errors++))
  fi

  # Validate required tools
  local required_tools=("pg_dump" "gzip" "openssl" "aws")
  for tool in "${required_tools[@]}"; do
    if ! command -v "$tool" &> /dev/null; then
      log_error "Required tool not found: $tool"
      ((errors++))
    fi
  done

  # Validate AWS credentials
  if ! aws sts get-caller-identity --region "$AWS_REGION" &> /dev/null; then
    log_error "AWS credentials not configured or invalid"
    ((errors++))
  fi

  if [[ $errors -gt 0 ]]; then
    log_error "Configuration validation failed with $errors error(s)"
    return 1
  fi

  log_info "Configuration validation passed"
  return 0
}

create_backup() {
  log_info "Starting database backup: $DB_NAME"

  # Extract database credentials from CONNECTION_STRING
  # Format: postgresql://user:password@host:port/database
  local db_user db_host db_port
  
  # Parse DATABASE_URL
  db_user=$(echo "$DATABASE_URL" | grep -oP '(?<=://).*(?=:)' || echo "postgres")
  db_host=$(echo "$DATABASE_URL" | grep -oP '(?<=@).*(?=:)' || echo "localhost")
  db_port=$(echo "$DATABASE_URL" | grep -oP '(?<=:)\d+(?=/)' || echo "5432")

  log_info "Connecting to PostgreSQL: $db_host:$db_port"

  # Perform backup with pg_dump
  if pg_dump "$DATABASE_URL" \
    --format=plain \
    --verbose \
    --no-password \
    > "$BACKUP_FILE" 2>> "$LOG_FILE"; then
    log_info "Backup created successfully: $BACKUP_FILE"
    log_info "Backup size: $(du -h "$BACKUP_FILE" | cut -f1)"
    return 0
  else
    log_error "pg_dump failed for database $DB_NAME"
    return 2
  fi
}

compress_backup() {
  log_info "Compressing backup file..."

  if gzip -f "$BACKUP_FILE"; then
    log_info "Compression completed"
    log_info "Compressed size: $(du -h "$COMPRESSED_FILE" | cut -f1)"
    return 0
  else
    log_error "Compression failed"
    return 2
  fi
}

encrypt_backup() {
  log_info "Encrypting backup with AES-256..."

  if [[ ! -f "$COMPRESSION_KEY_FILE" ]]; then
    log_error "Encryption key file not found: $ENCRYPTION_KEY_FILE"
    return 3
  fi

  # Read encryption key from file
  local encryption_key
  encryption_key=$(cat "$ENCRYPTION_KEY_FILE")

  # Encrypt using OpenSSL with AES-256-CBC
  if echo -n "$encryption_key" | openssl enc \
    -"$ENCRYPTION_CIPHER" \
    -in "$COMPRESSED_FILE" \
    -out "$ENCRYPTED_FILE" \
    -pass stdin \
    -P 2>> "$LOG_FILE"; then
    
    log_info "Encryption completed successfully"
    log_info "Encrypted file size: $(du -h "$ENCRYPTED_FILE" | cut -f1)"
    
    # Secure: remove unencrypted compressed backup
    rm -f "$COMPRESSED_FILE"
    log_info "Removed unencrypted backup"
    return 0
  else
    log_error "Encryption failed"
    return 3
  fi
}

upload_to_s3() {
  local s3_path="s3://${S3_BUCKET}/${S3_PREFIX}/${DB_NAME}_${TIMESTAMP}.sql.gz.enc"

  log_info "Uploading encrypted backup to S3: $s3_path"

  if aws s3 cp "$ENCRYPTED_FILE" "$s3_path" \
    --region "$AWS_REGION" \
    --sse AES256 \
    --metadata "backup-date=$TIMESTAMP,database=$DB_NAME" \
    2>> "$LOG_FILE"; then
    
    log_info "S3 upload completed successfully"
    log_info "S3 Location: $s3_path"
    return 0
  else
    log_error "S3 upload failed"
    return 4
  fi
}

cleanup_old_backups() {
  log_info "Cleaning up backups older than $RETENTION_DAYS days..."

  local cutoff_date
  cutoff_date=$(date -u -d "$RETENTION_DAYS days ago" +%Y-%m-%d)

  log_info "Deleting S3 backups before: $cutoff_date"

  # List and delete old backups from S3
  local count=0
  while IFS= read -r old_backup; do
    if [[ -n "$old_backup" ]]; then
      log_info "Deleting: $old_backup"
      if aws s3 rm "$old_backup" --region "$AWS_REGION" 2>> "$LOG_FILE"; then
        ((count++))
      else
        log_warn "Failed to delete: $old_backup"
      fi
    fi
  done < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive \
    --human-readable | \
    awk -v cutoff="$cutoff_date" '$1 < cutoff {print $4}')

  log_info "Deleted $count old backup(s)"
  return 0
}

send_status() {
  local status="$1"
  local message="$2"

  log_info "Backup Status: $status | $message"

  # Optional: Send to monitoring system (e.g., Sentry, DataDog, CloudWatch)
  # Example with CloudWatch:
  # aws cloudwatch put-metric-data \
  #   --namespace "BANKERCHANGER/Database" \
  #   --metric-name "BackupStatus" \
  #   --value 1 \
  #   --region "$AWS_REGION"
}

# ── Main Execution ────────────────────────────────────────────────────────

main() {
  log_info "════════════════════════════════════════════════════════════"
  log_info "PostgreSQL Backup Process Started"
  log_info "════════════════════════════════════════════════════════════"

  # Validate configuration
  if ! validate_config; then
    send_status "FAILED" "Configuration validation failed"
    exit 1
  fi

  # Create backup
  if ! create_backup; then
    send_status "FAILED" "Backup creation failed"
    exit 2
  fi

  # Compress backup
  if ! compress_backup; then
    send_status "FAILED" "Backup compression failed"
    exit 2
  fi

  # Encrypt backup
  if ! encrypt_backup; then
    send_status "FAILED" "Backup encryption failed"
    exit 3
  fi

  # Upload to S3
  if ! upload_to_s3; then
    send_status "FAILED" "S3 upload failed"
    exit 4
  fi

  # Cleanup old backups
  if ! cleanup_old_backups; then
    log_warn "Cleanup encountered errors but backup succeeded"
  fi

  log_info "════════════════════════════════════════════════════════════"
  log_info "Backup Process Completed Successfully"
  log_info "════════════════════════════════════════════════════════════"
  send_status "SUCCESS" "Backup completed and encrypted"
  exit 0
}

# Execute main function
main
