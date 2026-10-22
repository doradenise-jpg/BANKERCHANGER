#!/bin/bash

# ============================================================================
# PostgreSQL Database Restore Script
# Supports S3, Google Cloud Storage, rclone, and Local Backup Restores
# with OpenSSL AES-256 and GPG Decryption
# ============================================================================
#
# Description:
#   Restores PostgreSQL database from encrypted or compressed backups.
#   Supports downloading backups from:
#     - AWS S3 (via AWS CLI or rclone)
#     - Google Cloud Storage (via gcloud, gsutil, or rclone)
#     - rclone remotes
#     - Local filesystem (/var/backups/bankerchanger or custom path)
#   Decrypts backups with OpenSSL AES-256 or GPG.
#   Decompresses and restores data into specified database.
#   Validates schema and tables after restore.
#
# Requirements:
#   - PostgreSQL client tools (psql)
#   - OpenSSL (for AES-256) and/or GPG (for GPG decrypt)
#   - gzip / gunzip
#   - Remote storage CLI tool (aws, gsutil, gcloud, or rclone) if fetching remotely
#
# Usage:
#   ./scripts/restore-db.sh --latest [--target-db restore_test]
#   ./scripts/restore-db.sh --backup-timestamp 20261022_020000
#   ./scripts/restore-db.sh --file /var/backups/bankerchanger/backup.sql.gz.enc
#   ./scripts/restore-db.sh --list
#
# Exit Codes:
#   0 - Success
#   1 - Configuration/argument error
#   2 - Download / file acquisition failed
#   3 - Decryption failed
#   4 - Decompression failed
#   5 - Database restore failed
#   6 - Validation failed
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

# Storage configuration
BACKUP_DIR="${BACKUP_DIR:-/var/backups/bankerchanger}"
REMOTE_STORAGE="${REMOTE_STORAGE:-}"
REMOTE_TOOL="${REMOTE_TOOL:-}"

S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-${S3_BUCKET:-}}"
S3_PREFIX="${S3_BACKUP_PREFIX:-db-backups}"
AWS_REGION="${AWS_REGION:-us-east-1}"

GCS_BUCKET="${GCS_BACKUP_BUCKET:-${GCS_BUCKET:-}}"
GCS_PREFIX="${GCS_BACKUP_PREFIX:-db-backups}"

RCLONE_DEST="${RCLONE_DEST:-${RCLONE_REMOTE:-}}"

# Encryption configuration
ENCRYPTION_CIPHER="aes-256-cbc"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
GPG_PASSPHRASE_FILE="${GPG_PASSPHRASE_FILE:-}"
GPG_PASSPHRASE="${GPG_PASSPHRASE:-}"

# Temporary directory for restore files
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Logging
LOG_DIR="${LOG_DIR:-/var/log/backups}"
LOG_FILE="${LOG_DIR}/restore-$(date +%Y%m%d_%H%M%S).log"

# ── Functions ─────────────────────────────────────────────────────────────

log_info() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $*"
  echo "$msg"
  if [[ -d "$LOG_DIR" && -w "$LOG_DIR" ]]; then
    echo "$msg" >> "$LOG_FILE"
  fi
}

log_error() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*"
  echo "$msg" >&2
  if [[ -d "$LOG_DIR" && -w "$LOG_DIR" ]]; then
    echo "$msg" >> "$LOG_FILE"
  fi
}

log_warn() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $*"
  echo "$msg"
  if [[ -d "$LOG_DIR" && -w "$LOG_DIR" ]]; then
    echo "$msg" >> "$LOG_FILE"
  fi
}

print_usage() {
  cat <<EOF
PostgreSQL Restore Script

USAGE:
  $(basename "$0") [OPTIONS]

OPTIONS:
  --file <PATH>                   Restore directly from local backup file (.sql, .sql.gz, .sql.gz.enc, .sql.gz.gpg)
  --backup-timestamp <TIMESTAMP>  Restore specific backup (format: YYYYMMDD_HHMMSS)
  --latest                        Restore the most recent backup
  --list                          List available backups in configured storage
  --target-db <DATABASE>          Target database name (default: ${DB_NAME}_restore)
  --storage <PROVIDER>            Storage provider: s3, gcs, rclone, local (default: auto-detect)
  --tool <TOOL>                   Download tool: aws, rclone, gcloud, gsutil
  --s3-bucket <BUCKET>            AWS S3 bucket name
  --gcs-bucket <BUCKET>           Google Cloud Storage bucket name
  --prefix <PREFIX>               Storage prefix (default: db-backups)
  --key-file <PATH>               Path to encryption key / passphrase file
  --help                          Show this help message

EXAMPLES:
  # Restore latest backup from S3/GCS:
  $(basename "$0") --latest

  # Restore specific backup timestamp:
  $(basename "$0") --backup-timestamp 20261022_020000

  # Restore directly from local file:
  $(basename "$0") --file /var/backups/bankerchanger/bankerchanger_backup_20261022_020000.sql.gz.enc

  # Restore to custom database:
  $(basename "$0") --latest --target-db test_restore_db

EOF
}

resolve_storage() {
  if [[ -n "$LOCAL_FILE" ]]; then
    REMOTE_STORAGE="local"
    return 0
  fi

  if [[ -z "$REMOTE_STORAGE" ]]; then
    if [[ -n "$S3_BUCKET" ]]; then
      REMOTE_STORAGE="s3"
    elif [[ -n "$GCS_BUCKET" ]]; then
      REMOTE_STORAGE="gcs"
    elif [[ -n "$RCLONE_DEST" ]]; then
      REMOTE_STORAGE="rclone"
    elif [[ -d "$BACKUP_DIR" ]]; then
      REMOTE_STORAGE="local"
    else
      REMOTE_STORAGE="s3"
    fi
  fi

  if [[ -z "$REMOTE_TOOL" ]]; then
    case "$REMOTE_STORAGE" in
      s3)
        if command -v aws &>/dev/null; then
          REMOTE_TOOL="aws"
        elif command -v rclone &>/dev/null; then
          REMOTE_TOOL="rclone"
        fi
        ;;
      gcs)
        if command -v gcloud &>/dev/null; then
          REMOTE_TOOL="gcloud"
        elif command -v gsutil &>/dev/null; then
          REMOTE_TOOL="gsutil"
        elif command -v rclone &>/dev/null; then
          REMOTE_TOOL="rclone"
        fi
        ;;
      rclone)
        REMOTE_TOOL="rclone"
        ;;
    esac
  fi
}

validate_config() {
  local errors=0

  # Ensure log directory exists
  if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    LOG_DIR="/tmp/bankerchanger-logs"
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    LOG_FILE="${LOG_DIR}/restore-$(date +%Y%m%d_%H%M%S).log"
  fi

  if ! command -v psql &>/dev/null; then
    log_error "psql client tool not found in PATH"
    ((errors++))
  fi

  if ! command -v gunzip &>/dev/null; then
    log_error "gunzip tool not found in PATH"
    ((errors++))
  fi

  # Validate remote storage requirements if not using local file
  if [[ -z "$LOCAL_FILE" && "$REMOTE_STORAGE" != "local" ]]; then
    case "$REMOTE_STORAGE" in
      s3)
        if [[ -z "$S3_BUCKET" ]]; then
          log_error "AWS_S3_BACKUP_BUCKET not set"
          ((errors++))
        fi
        if [[ "$REMOTE_TOOL" == "rclone" ]]; then
          if ! command -v rclone &>/dev/null; then
            log_error "rclone not found in PATH"
            ((errors++))
          fi
        elif ! command -v aws &>/dev/null; then
          log_error "AWS CLI ('aws') not found in PATH"
          ((errors++))
        fi
        ;;
      gcs)
        if [[ -z "$GCS_BUCKET" ]]; then
          log_error "GCS_BACKUP_BUCKET not set"
          ((errors++))
        fi
        if [[ "$REMOTE_TOOL" == "rclone" ]]; then
          if ! command -v rclone &>/dev/null; then
            log_error "rclone not found in PATH"
            ((errors++))
          fi
        elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
          if ! command -v gcloud &>/dev/null; then
            log_error "gcloud not found in PATH"
            ((errors++))
          fi
        elif ! command -v gsutil &>/dev/null; then
          log_error "gsutil not found in PATH"
          ((errors++))
        fi
        ;;
      rclone)
        if [[ -z "$RCLONE_DEST" ]]; then
          log_error "RCLONE_DEST not set"
          ((errors++))
        fi
        if ! command -v rclone &>/dev/null; then
          log_error "rclone not found in PATH"
          ((errors++))
        fi
        ;;
    esac
  fi

  if [[ $errors -gt 0 ]]; then
    return 1
  fi

  return 0
}

list_backups() {
  log_info "Listing available backups (Storage: $REMOTE_STORAGE)..."

  case "$REMOTE_STORAGE" in
    s3)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
        rclone lsl "$rclone_dest" | tee -a "$LOG_FILE"
      else
        aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX%/}/" \
          --region "$AWS_REGION" \
          --human-readable \
          --recursive | \
          awk '{print $1 " " $2 " " $3 " " $4}' | \
          tee -a "$LOG_FILE"
      fi
      ;;
    gcs)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
        rclone lsl "$rclone_dest" | tee -a "$LOG_FILE"
      elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
        gcloud storage ls --long "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" | tee -a "$LOG_FILE"
      else
        gsutil ls -l "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" | tee -a "$LOG_FILE"
      fi
      ;;
    rclone)
      rclone lsl "$RCLONE_DEST" | tee -a "$LOG_FILE"
      ;;
    local)
      if [[ -d "$BACKUP_DIR" ]]; then
        ls -lh "$BACKUP_DIR" | tee -a "$LOG_FILE"
      else
        log_warn "Local backup directory $BACKUP_DIR does not exist"
      fi
      ;;
  esac
}

get_latest_backup_remote() {
  case "$REMOTE_STORAGE" in
    s3)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
        rclone lsf "$rclone_dest" | sort | tail -1
      else
        aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX%/}/" \
          --region "$AWS_REGION" \
          --recursive | \
          sort | \
          tail -1 | \
          awk '{print $4}'
      fi
      ;;
    gcs)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
        rclone lsf "$rclone_dest" | sort | tail -1
      elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
        gcloud storage ls "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null | sort | tail -1
      else
        gsutil ls "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null | sort | tail -1
      fi
      ;;
    rclone)
      rclone lsf "$RCLONE_DEST" | sort | tail -1
      ;;
    local)
      find "$BACKUP_DIR" -type f \( -name "*.sql*" -o -name "*.enc" -o -name "*.gpg" \) 2>/dev/null | sort | tail -1
      ;;
  esac
}

download_backup() {
  local remote_path="$1"
  local local_dest="$2"

  log_info "Downloading backup: $remote_path -> $local_dest"

  case "$REMOTE_STORAGE" in
    s3)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_src="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
        rclone copyto "${rclone_src%/}/$(basename "$remote_path")" "$local_dest" 2>> "$LOG_FILE"
      else
        local s3_uri
        if [[ "$remote_path" == s3://* ]]; then
          s3_uri="$remote_path"
        elif [[ "$remote_path" == */* ]]; then
          s3_uri="s3://${S3_BUCKET}/${remote_path}"
        else
          s3_uri="s3://${S3_BUCKET}/${S3_PREFIX%/}/${remote_path}"
        fi
        aws s3 cp "$s3_uri" "$local_dest" --region "$AWS_REGION" 2>> "$LOG_FILE"
      fi
      ;;
    gcs)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_src="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
        rclone copyto "${rclone_src%/}/$(basename "$remote_path")" "$local_dest" 2>> "$LOG_FILE"
      elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
        local gcs_uri
        if [[ "$remote_path" == gs://* ]]; then
          gcs_uri="$remote_path"
        else
          gcs_uri="gs://${GCS_BUCKET}/${GCS_PREFIX%/}/${remote_path}"
        fi
        gcloud storage cp "$gcs_uri" "$local_dest" 2>> "$LOG_FILE"
      else
        local gcs_uri
        if [[ "$remote_path" == gs://* ]]; then
          gcs_uri="$remote_path"
        else
          gcs_uri="gs://${GCS_BUCKET}/${GCS_PREFIX%/}/${remote_path}"
        fi
        gsutil cp "$gcs_uri" "$local_dest" 2>> "$LOG_FILE"
      fi
      ;;
    rclone)
      rclone copyto "${RCLONE_DEST%/}/$(basename "$remote_path")" "$local_dest" 2>> "$LOG_FILE"
      ;;
    local)
      cp "$remote_path" "$local_dest"
      ;;
  esac

  if [[ -f "$local_dest" && -s "$local_dest" ]]; then
    log_info "Download completed: $(du -h "$local_dest" | cut -f1)"
    return 0
  else
    log_error "Download failed or downloaded file is empty"
    return 2
  fi
}

decrypt_backup() {
  local encrypted_file="$1"
  local output_sql_file="$2"

  log_info "Decrypting and decompressing: $(basename "$encrypted_file")"

  # Case 1: GPG encrypted (.gpg)
  if [[ "$encrypted_file" == *.gpg ]]; then
    log_info "Detected GPG encrypted backup"
    local gpg_pass_file="${GPG_PASSPHRASE_FILE:-$ENCRYPTION_KEY_FILE}"
    local gpg_pass="${GPG_PASSPHRASE:-$BACKUP_ENCRYPTION_KEY}"
    local decomp_gz="$TEMP_DIR/decrypted.sql.gz"

    local gpg_cmd=(gpg --batch --yes --pinentry-mode loopback --decrypt)
    if [[ -n "$gpg_pass_file" && -f "$gpg_pass_file" ]]; then
      gpg_cmd+=(--passphrase-file "$gpg_pass_file")
      "${gpg_cmd[@]}" --output "$decomp_gz" "$encrypted_file" 2>> "$LOG_FILE" || return 3
    elif [[ -n "$gpg_pass" ]]; then
      echo -n "$gpg_pass" | "${gpg_cmd[@]}" --passphrase-fd 0 --output "$decomp_gz" "$encrypted_file" 2>> "$LOG_FILE" || return 3
    else
      # Try agent / keyring default
      "${gpg_cmd[@]}" --output "$decomp_gz" "$encrypted_file" 2>> "$LOG_FILE" || return 3
    fi

    gunzip -c "$decomp_gz" > "$output_sql_file"
    rm -f "$decomp_gz"
    return 0

  # Case 2: OpenSSL AES-256 encrypted (.enc)
  elif [[ "$encrypted_file" == *.enc ]]; then
    log_info "Detected OpenSSL AES-256 encrypted backup"
    local openssl_pass_args=()
    if [[ -n "$ENCRYPTION_KEY_FILE" && -f "$ENCRYPTION_KEY_FILE" ]]; then
      openssl_pass_args=(-pass "file:$ENCRYPTION_KEY_FILE")
    elif [[ -n "$BACKUP_ENCRYPTION_KEY" ]]; then
      openssl_pass_args=(-pass "env:BACKUP_ENCRYPTION_KEY")
    else
      log_error "Decryption requires BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY"
      return 3
    fi

    # Try PBKDF2 first
    if openssl enc -"$ENCRYPTION_CIPHER" -d -pbkdf2 \
      -in "$encrypted_file" "${openssl_pass_args[@]}" 2>/dev/null | gunzip > "$output_sql_file"; then
      log_info "Decrypted with PBKDF2 successfully"
      return 0
    fi

    # Fallback to legacy OpenSSL key derivation
    log_warn "PBKDF2 decryption failed; attempting legacy key derivation..."
    if openssl enc -"$ENCRYPTION_CIPHER" -d \
      -in "$encrypted_file" "${openssl_pass_args[@]}" 2>> "$LOG_FILE" | gunzip > "$output_sql_file"; then
      log_info "Legacy decryption completed successfully"
      return 0
    else
      log_error "OpenSSL decryption failed"
      return 3
    fi

  # Case 3: Gzipped plain SQL dump (.gz)
  elif [[ "$encrypted_file" == *.gz ]]; then
    log_info "File is gzipped SQL dump (unencrypted); decompressing..."
    gunzip -c "$encrypted_file" > "$output_sql_file"
    return 0

  # Case 4: Plain SQL dump
  else
    log_info "File is plain uncompressed SQL dump"
    cp "$encrypted_file" "$output_sql_file"
    return 0
  fi
}

create_target_database() {
  local target_db="$1"
  log_info "Creating target database: $target_db"

  if psql "$DATABASE_URL" -tc "SELECT 1 FROM pg_database WHERE datname = '$target_db'" | grep -q 1; then
    log_warn "Target database already exists: $target_db; recreating..."
    psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS \"$target_db\";" 2>> "$LOG_FILE"
  fi

  if psql "$DATABASE_URL" -c "CREATE DATABASE \"$target_db\";" 2>> "$LOG_FILE"; then
    log_info "Database created: $target_db"
    return 0
  else
    log_error "Failed to create database $target_db"
    return 5
  fi
}

restore_database() {
  local sql_file="$1"
  local target_db="$2"
  log_info "Restoring SQL dump into: $target_db"

  local target_url
  target_url=$(echo "$DATABASE_URL" | sed "s|/.*$|/$target_db|")

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

  local target_url
  target_url=$(echo "$DATABASE_URL" | sed "s|/.*$|/$target_db|")

  local table_count
  table_count=$(psql "$target_url" -tc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>> "$LOG_FILE" | tr -d ' ')

  if [[ -z "$table_count" || "$table_count" -lt 1 ]]; then
    log_error "Database validation failed: No public tables found"
    return 6
  fi

  log_info "Validation passed: $table_count table(s) found in schema"
  return 0
}

# ── Main ───────────────────────────────────────────────────────────────────

LOCAL_FILE=""

main() {
  local backup_timestamp=""
  local use_latest=false
  local list_only=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --file)
        LOCAL_FILE="$2"
        shift 2
        ;;
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
      --storage)
        REMOTE_STORAGE="$2"
        shift 2
        ;;
      --tool)
        REMOTE_TOOL="$2"
        shift 2
        ;;
      --s3-bucket)
        S3_BUCKET="$2"
        shift 2
        ;;
      --gcs-bucket)
        GCS_BUCKET="$2"
        shift 2
        ;;
      --prefix)
        S3_PREFIX="$2"
        GCS_PREFIX="$2"
        shift 2
        ;;
      --key-file)
        ENCRYPTION_KEY_FILE="$2"
        shift 2
        ;;
      --help|-h)
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

  resolve_storage

  log_info "════════════════════════════════════════════════════════════"
  log_info "PostgreSQL Restore Process Started"
  log_info "════════════════════════════════════════════════════════════"

  if ! validate_config; then
    exit 1
  fi

  if [[ "$list_only" == true ]]; then
    list_backups
    exit 0
  fi

  local source_file=""
  if [[ -n "$LOCAL_FILE" ]]; then
    if [[ ! -f "$LOCAL_FILE" ]]; then
      log_error "Specified local backup file does not exist: $LOCAL_FILE"
      exit 1
    fi
    source_file="$LOCAL_FILE"
  elif [[ "$use_latest" == true ]]; then
    local latest
    latest=$(get_latest_backup_remote)
    if [[ -z "$latest" ]]; then
      log_error "Failed to locate latest backup"
      exit 1
    fi
    source_file="$latest"
    log_info "Latest backup detected: $source_file"
  elif [[ -n "$backup_timestamp" ]]; then
    # Search for matching file
    source_file="${DB_NAME}_backup_${backup_timestamp}.sql.gz.enc"
  else
    log_error "Must specify --file, --latest, or --backup-timestamp"
    print_usage
    exit 1
  fi

  local downloaded_file="$TEMP_DIR/$(basename "$source_file")"
  local sql_file="$TEMP_DIR/restored_dump.sql"

  # Acquire file
  if [[ -n "$LOCAL_FILE" ]]; then
    downloaded_file="$LOCAL_FILE"
  else
    if ! download_backup "$source_file" "$downloaded_file"; then
      exit 2
    fi
  fi

  # Decrypt & Decompress
  if ! decrypt_backup "$downloaded_file" "$sql_file"; then
    exit 3
  fi

  # Recreate database and restore
  if ! create_target_database "$TARGET_DB"; then
    exit 5
  fi

  if ! restore_database "$sql_file" "$TARGET_DB"; then
    exit 5
  fi

  # Validate
  if ! validate_restore "$TARGET_DB"; then
    exit 6
  fi

  log_info "════════════════════════════════════════════════════════════"
  log_info "Restore Process Completed Successfully"
  log_info "Target Database: $TARGET_DB"
  log_info "════════════════════════════════════════════════════════════"
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
