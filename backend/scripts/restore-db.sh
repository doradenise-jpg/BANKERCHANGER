#!/bin/bash

# ============================================================================
# PostgreSQL Database Restore Script
# ============================================================================
#
# Description:
#   Restores PostgreSQL database from encrypted S3 backups.
#   Downloads encrypted backup and its SHA-256 checksum from S3.
#   Verifies the checksum before doing anything else.
#   Decrypts and decompresses backup.
#   Restores data into specified database.
#   Validates schema after restore.
#
# Requirements:
#   - PostgreSQL client tools (psql, pg_restore)
#   - OpenSSL for decryption
#   - AWS CLI v2 configured with credentials
#
# Usage:
#   ./scripts/restore-db.sh [--backup-timestamp 20240101_020000] [--target-db restore_test]
#   ./scripts/restore-db.sh --list                              # List available backups
#   ./scripts/restore-db.sh --latest [--target-db restore_test] # Restore latest backup
#
# Exit Codes:
#   0 - Success
#   1 - Configuration/argument error
#   2 - S3 download failed
#   3 - Decryption failed
#   4 - Decompression failed
#   5 - Restore failed
#   6 - Validation failed
#   7 - Checksum verification failed (missing, malformed, or mismatched)
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
TARGET_DB="${DB_NAME}_restore"

# S3 configuration
S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-}"
S3_PREFIX="${S3_BACKUP_PREFIX:-db-backups}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Encryption configuration
ENCRYPTION_CIPHER="aes-256-cbc"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-}"

# Temporary directory for restore files
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Logging
LOG_DIR="${LOG_DIR:-/var/log/backups}"
LOG_FILE="${LOG_DIR}/restore-$(date +%Y%m%d_%H%M%S).log"

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

print_usage() {
  cat <<EOF
PostgreSQL Restore Script

USAGE:
  $(basename "$0") [OPTIONS]

OPTIONS:
  --backup-timestamp <TIMESTAMP>  Restore specific backup (format: YYYYMMDD_HHMMSS)
  --latest                        Restore the most recent backup
  --list                          List available backups
  --target-db <DATABASE>          Target database name (default: ${DB_NAME}_restore)
  --help                          Show this help message

EXAMPLES:
  # List available backups
  $(basename "$0") --list

  # Restore latest backup
  $(basename "$0") --latest

  # Restore specific backup
  $(basename "$0") --backup-timestamp 20240115_020000

  # Restore to custom database
  $(basename "$0") --latest --target-db my_test_db

EOF
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
    log_error "BACKUP_ENCRYPTION_KEY_FILE not set or file does not exist"
    ((errors++))
  fi

  # Validate required tools
  local required_tools=("psql" "openssl" "aws" "gunzip" "sha256sum")
  for tool in "${required_tools[@]}"; do
    if ! command -v "$tool" &> /dev/null; then
      log_error "Required tool not found: $tool"
      ((errors++))
    fi
  done

  if [[ $errors -gt 0 ]]; then
    log_error "Configuration validation failed with $errors error(s)"
    return 1
  fi

  return 0
}

list_backups() {
  log_info "Available backups in S3:"
  log_info "Listing: s3://${S3_BUCKET}/${S3_PREFIX}/"

  aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --human-readable \
    --recursive | \
    awk '$4 !~ /\.sha256$/ {print $1 " " $2 " " $3 " " $4}' | \
    tee -a "$LOG_FILE"
}

get_latest_backup() {
  log_info "Finding latest backup..."

  local latest_backup
  latest_backup=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | \
    awk '$4 !~ /\.sha256$/ {print $4}' | \
    sort | \
    tail -1)

  if [[ -z "$latest_backup" ]]; then
    log_error "No backups found in S3"
    return 1
  fi

  echo "$latest_backup"
}

download_backup() {
  local s3_path="$1"
  local local_file="$2"

  log_info "Downloading backup from S3: s3://${S3_BUCKET}/${s3_path}"

  if aws s3 cp "s3://${S3_BUCKET}/${s3_path}" "$local_file" \
    --region "$AWS_REGION" 2>> "$LOG_FILE"; then
    log_info "Download completed"
    log_info "File size: $(du -h "$local_file" | cut -f1)"
    return 0
  else
    log_error "S3 download failed"
    return 2
  fi
}

download_checksum() {
  local s3_path="$1"
  local local_file="$2"

  log_info "Downloading checksum from S3: s3://${S3_BUCKET}/${s3_path}"

  if aws s3 cp "s3://${S3_BUCKET}/${s3_path}" "$local_file" \
    --region "$AWS_REGION" 2>> "$LOG_FILE"; then
    log_info "Checksum download completed"
    return 0
  else
    log_error "Checksum download failed; refusing to restore an unverified backup"
    return 7
  fi
}

verify_checksum() {
  local encrypted_file="$1"
  local checksum_file="$2"

  log_info "Verifying SHA-256 checksum of downloaded backup..."

  if [[ ! -s "$checksum_file" ]]; then
    log_error "Checksum file is missing or empty; refusing to restore an unverified backup"
    return 7
  fi

  local expected_name
  expected_name=$(basename "$encrypted_file")

  local entry_count digest recorded_name
  entry_count=$(awk 'NF' "$checksum_file" | wc -l)

  if [[ "$entry_count" -ne 1 ]]; then
    log_error "Malformed checksum file: expected exactly one entry, found $entry_count"
    return 7
  fi

  read -r digest recorded_name _ < "$checksum_file"

  # Reject malformed digests and path traversal / mismatched file references
  if [[ ! "$digest" =~ ^[0-9a-fA-F]{64}$ ]]; then
    log_error "Malformed checksum file: invalid SHA-256 digest"
    return 7
  fi

  if [[ "$recorded_name" != "$expected_name" ]]; then
    log_error "Checksum file references unexpected file: ${recorded_name:-<empty>} (expected $expected_name)"
    return 7
  fi

  if ( cd "$TEMP_DIR" && sha256sum -c --strict "$(basename "$checksum_file")" ) >> "$LOG_FILE" 2>&1; then
    log_info "Checksum verification passed"
    return 0
  else
    log_error "Checksum verification FAILED: backup is corrupted or has been tampered with"
    return 7
  fi
}

decrypt_backup() {
  local encrypted_file="$1"
  local decompressed_file="$2"

  log_info "Decrypting backup..."

  if [[ ! -f "$ENCRYPTION_KEY_FILE" ]]; then
    log_error "Encryption key file not found"
    return 3
  fi

  local encryption_key
  encryption_key=$(cat "$ENCRYPTION_KEY_FILE")

  # Decompress and decrypt in one pass
  if echo -n "$encryption_key" | openssl enc \
    -"$ENCRYPTION_CIPHER" \
    -d \
    -in "$encrypted_file" \
    -pass stdin 2>> "$LOG_FILE" | gunzip > "$decompressed_file"; then
    
    log_info "Decryption and decompression completed"
    return 0
  else
    log_error "Decryption failed"
    return 3
  fi
}

create_target_database() {
  local target_db="$1"

  log_info "Creating target database: $target_db"

  # Drop existing database if it exists (with safety prompt)
  if psql "$DATABASE_URL" -tc "SELECT 1 FROM pg_database WHERE datname = '$target_db'" | grep -q 1; then
    log_warn "Target database already exists: $target_db"
    log_warn "Dropping existing database..."
    psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS $target_db;" 2>> "$LOG_FILE"
  fi

  # Create new database
  if psql "$DATABASE_URL" -c "CREATE DATABASE $target_db;" 2>> "$LOG_FILE"; then
    log_info "Database created successfully"
    return 0
  else
    log_error "Failed to create database"
    return 5
  fi
}

restore_database() {
  local sql_file="$1"
  local target_db="$2"

  log_info "Restoring database from SQL dump: $target_db"

  # Build connection string for target database
  local target_url
  target_url=$(echo "$DATABASE_URL" | sed "s|/.*$|/$target_db|")

  # Restore using psql
  if psql "$target_url" < "$sql_file" 2>> "$LOG_FILE"; then
    log_info "Database restore completed successfully"
    return 0
  else
    log_error "Database restore failed"
    return 5
  fi
}

validate_restore() {
  local target_db="$1"

  log_info "Validating restored database: $target_db"

  # Build connection string for target database
  local target_url
  target_url=$(echo "$DATABASE_URL" | sed "s|/.*$|/$target_db|")

  # Check tables exist
  local table_count
  table_count=$(psql "$target_url" -tc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>> "$LOG_FILE" | tr -d ' ')

  if [[ -z "$table_count" ]] || [[ "$table_count" -lt 1 ]]; then
    log_error "Database validation failed: no tables found"
    return 6
  fi

  log_info "Validation passed: $table_count tables found"

  # Check schema integrity
  log_info "Checking schema integrity..."
  if psql "$target_url" -c "\d" > /dev/null 2>> "$LOG_FILE"; then
    log_info "Schema structure verified"
    return 0
  else
    log_error "Schema validation failed"
    return 6
  fi
}

# ── Main Execution ────────────────────────────────────────────────────────

main() {
  local backup_timestamp=""
  local use_latest=false
  local list_only=false

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --backup-timestamp)
        backup_timestamp="$2"
        shift 2
        ;;
      --latest)
        use_latest=true
        shift
        ;;
      --list)
        list_only=true
        shift
        ;;
      --target-db)
        TARGET_DB="$2"
        shift 2
        ;;
      --help)
        print_usage
        exit 0
        ;;
      *)
        log_error "Unknown option: $1"
        print_usage
        exit 1
        ;;
    esac
  done

  log_info "════════════════════════════════════════════════════════════"
  log_info "PostgreSQL Restore Process Started"
  log_info "════════════════════════════════════════════════════════════"

  # Validate configuration
  if ! validate_config; then
    exit 1
  fi

  # List backups and exit
  if [[ "$list_only" == true ]]; then
    list_backups
    exit 0
  fi

  # Determine backup to restore
  if [[ "$use_latest" == true ]]; then
    backup_timestamp=$(get_latest_backup | grep -oP '\d{8}_\d{6}' || echo "")
    if [[ -z "$backup_timestamp" ]]; then
      log_error "Failed to determine latest backup"
      exit 1
    fi
    log_info "Using latest backup: $backup_timestamp"
  elif [[ -z "$backup_timestamp" ]]; then
    log_error "Backup timestamp not specified. Use --latest or --backup-timestamp"
    print_usage
    exit 1
  fi

  # Prepare file paths
  local backup_path="${S3_PREFIX}/${DB_NAME}_${backup_timestamp}.sql.gz.enc"
  local checksum_path="${backup_path}.sha256"
  local encrypted_file="$TEMP_DIR/${DB_NAME}_${backup_timestamp}.sql.gz.enc"
  local checksum_file="$TEMP_DIR/${DB_NAME}_${backup_timestamp}.sql.gz.enc.sha256"
  local sql_file="$TEMP_DIR/${DB_NAME}_${backup_timestamp}.sql"

  # Download backup
  if ! download_backup "$backup_path" "$encrypted_file"; then
    exit 2
  fi

  # Download and verify checksum before any decryption or restore operation
  if ! download_checksum "$checksum_path" "$checksum_file"; then
    exit 7
  fi

  if ! verify_checksum "$encrypted_file" "$checksum_file"; then
    log_error "Aborting restore: backup integrity could not be verified"
    exit 7
  fi

  # Decrypt backup
  if ! decrypt_backup "$encrypted_file" "$sql_file"; then
    exit 3
  fi

  # Create target database
  if ! create_target_database "$TARGET_DB"; then
    exit 5
  fi

  # Restore database
  if ! restore_database "$sql_file" "$TARGET_DB"; then
    exit 5
  fi

  # Validate restore
  if ! validate_restore "$TARGET_DB"; then
    exit 6
  fi

  log_info "════════════════════════════════════════════════════════════"
  log_info "Restore Process Completed Successfully"
  log_info "Database: $TARGET_DB"
  log_info "════════════════════════════════════════════════════════════"
  exit 0
}

# Execute main function
main "$@"
