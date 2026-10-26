#!/bin/bash

# ============================================================================
# PostgreSQL Automated Backup Script with AES-256 / GPG Encryption
# and Optional Off-Site Remote Storage Upload (AWS S3 / Google Cloud Storage)
# ============================================================================
# 
# Description:
#   Performs PostgreSQL backup using pg_dump with gzip compression.
#   Encrypts backup with AES-256 (OpenSSL) or GPG before off-site transfer.
#   Generates a SHA-256 checksum sidecar for integrity verification.
#   Saves backup and checksum locally to /var/backups/bankerchanger/.
#   Optionally uploads encrypted backup and checksum to off-site object storage:
#     - AWS S3 (via AWS CLI or rclone)
#     - Google Cloud Storage (via gcloud, gsutil, or rclone)
#     - Any rclone remote storage target
#   Prunes both off-site and local backups older than retention policy (default: 30 days).
#
# Requirements:
#   - PostgreSQL client tools (pg_dump)
#   - gzip for compression
#   - OpenSSL (for AES-256) and/or GPG (for GPG encryption)
#   - Optional remote tools: AWS CLI (aws), Google Cloud SDK (gcloud/gsutil), or rclone
#
# Exit Codes:
#   0 - Success
#   1 - Configuration error
#   2 - Backup creation / compression failed
#   3 - Encryption failed
#   4 - Remote upload failed
#   5 - Retention cleanup failed
#   6 - Checksum generation failed
#
# ============================================================================

set -euo pipefail

# ── Default Configuration ──────────────────────────────────────────────────

# Load environment variables if .env file exists
if [[ -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.env"
fi

# Database configuration
DATABASE_URL="${DATABASE_URL:-postgresql://bankerchanger:bankerchanger@localhost:5432/bankerchanger}"
DB_NAME="${DB_NAME:-bankerchanger}"

# Local storage configuration
BACKUP_DIR="${BACKUP_DIR:-/var/backups/bankerchanger}"
KEEP_LOCAL_BACKUP="${KEEP_LOCAL_BACKUP:-true}"

# Remote storage configuration: s3, gcs, rclone, none (auto-detected if empty)
REMOTE_STORAGE="${REMOTE_STORAGE:-}"
REMOTE_TOOL="${REMOTE_TOOL:-}" # aws, rclone, gcloud, gsutil
SKIP_UPLOAD="${SKIP_UPLOAD:-false}"

# AWS S3 configuration
S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-${S3_BUCKET:-}}"
S3_PREFIX="${S3_BACKUP_PREFIX:-db-backups}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Google Cloud Storage configuration
GCS_BUCKET="${GCS_BACKUP_BUCKET:-${GCS_BUCKET:-}}"
GCS_PREFIX="${GCS_BACKUP_PREFIX:-db-backups}"

# rclone configuration
RCLONE_DEST="${RCLONE_DEST:-${RCLONE_REMOTE:-}}"

# Retention configuration (default: 30 days)
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

# Encryption configuration (aes-256, gpg, none)
ENCRYPTION_ENABLED="${BACKUP_ENCRYPTION_ENABLED:-true}"
ENCRYPTION_TYPE="${BACKUP_ENCRYPTION_TYPE:-aes-256}"
ENCRYPTION_CIPHER="${ENCRYPTION_CIPHER:-aes-256-cbc}"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

# GPG configuration
GPG_RECIPIENT="${GPG_RECIPIENT:-}"
GPG_PASSPHRASE_FILE="${GPG_PASSPHRASE_FILE:-}"
GPG_PASSPHRASE="${GPG_PASSPHRASE:-}"

# Logging
LOG_DIR="${LOG_DIR:-/var/log/backups}"
LOG_FILE="${LOG_DIR}/backup-$(date +%Y%m).log"

# Temporary directory for intermediate backup operations
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Timestamp for backup file naming
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$TEMP_DIR/${DB_NAME}_backup_${TIMESTAMP}.sql"
COMPRESSED_FILE="${BACKUP_FILE}.gz"
FINAL_BACKUP_FILE=""
CHECKSUM_FILE=""

# ── Logging Functions ──────────────────────────────────────────────────────

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
PostgreSQL Database Backup Script

USAGE:
  $(basename "$0") [OPTIONS]

OPTIONS:
  --storage <PROVIDER>          Remote storage provider: s3, gcs, rclone, none (default: auto-detect)
  --tool <TOOL>                 Upload tool: aws, rclone, gcloud, gsutil (default: auto-detect)
  --s3-bucket <BUCKET>          AWS S3 bucket name
  --gcs-bucket <BUCKET>         Google Cloud Storage bucket name
  --prefix <PREFIX>             Storage path prefix (default: db-backups)
  --rclone-dest <DEST>          rclone destination (e.g., s3:my-bucket/db-backups or gcs:bucket/prefix)
  --encryption <TYPE>           Encryption type: aes-256, gpg, none (default: aes-256)
  --key-file <PATH>             Path to encryption key or passphrase file
  --gpg-recipient <RECIPIENT>   GPG recipient ID/email (for asymmetric encryption)
  --gpg-passphrase-file <PATH>  GPG passphrase file (for symmetric AES-256 encryption)
  --backup-dir <PATH>           Local backup directory (default: /var/backups/bankerchanger)
  --retention-days <DAYS>       Retention period in days for off-site & local pruning (default: 30)
  --skip-upload                 Skip remote upload (save locally only)
  --no-local                    Do not keep local copy after upload
  --help                        Show this help message

EXAMPLES:
  # Standard automated run using environment variables:
  $(basename "$0")

  # Upload to AWS S3 using AWS CLI and AES-256 encryption:
  $(basename "$0") --storage s3 --s3-bucket bankerchanger-backups --key-file /secure/backup.key

  # Upload to Google Cloud Storage using rclone with GPG encryption:
  $(basename "$0") --storage gcs --gcs-bucket bankerchanger-gcs-backups --tool rclone --encryption gpg --gpg-passphrase-file /secure/gpg.pass

  # Local-only backup (no remote storage required):
  $(basename "$0") --storage none --backup-dir /var/backups/bankerchanger

EOF
}

# ── Parse Command Line Arguments ───────────────────────────────────────────

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
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
      --rclone-dest)
        RCLONE_DEST="$2"
        shift 2
        ;;
      --encryption)
        ENCRYPTION_TYPE="$2"
        if [[ "$ENCRYPTION_TYPE" == "none" ]]; then
          ENCRYPTION_ENABLED=false
        else
          ENCRYPTION_ENABLED=true
        fi
        shift 2
        ;;
      --key-file)
        ENCRYPTION_KEY_FILE="$2"
        shift 2
        ;;
      --gpg-recipient)
        GPG_RECIPIENT="$2"
        shift 2
        ;;
      --gpg-passphrase-file)
        GPG_PASSPHRASE_FILE="$2"
        shift 2
        ;;
      --backup-dir)
        BACKUP_DIR="$2"
        shift 2
        ;;
      --retention-days)
        RETENTION_DAYS="$2"
        shift 2
        ;;
      --skip-upload)
        SKIP_UPLOAD=true
        shift
        ;;
      --no-local)
        KEEP_LOCAL_BACKUP=false
        shift
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
}

# ── Configuration & Environment Validation ─────────────────────────────────

resolve_remote_storage() {
  # Auto-detect remote storage provider if not explicitly defined
  if [[ -z "$REMOTE_STORAGE" ]]; then
    if [[ "$SKIP_UPLOAD" == "true" ]]; then
      REMOTE_STORAGE="none"
    elif [[ -n "$S3_BUCKET" ]]; then
      REMOTE_STORAGE="s3"
    elif [[ -n "$GCS_BUCKET" ]]; then
      REMOTE_STORAGE="gcs"
    elif [[ -n "$RCLONE_DEST" ]]; then
      REMOTE_STORAGE="rclone"
    else
      REMOTE_STORAGE="none"
    fi
  fi

  # Auto-detect tool based on provider
  if [[ -z "$REMOTE_TOOL" ]]; then
    case "$REMOTE_STORAGE" in
      s3)
        if command -v aws &>/dev/null; then
          REMOTE_TOOL="aws"
        elif command -v rclone &>/dev/null; then
          REMOTE_TOOL="rclone"
        else
          REMOTE_TOOL="aws"
        fi
        ;;
      gcs)
        if command -v rclone &>/dev/null && [[ -n "$RCLONE_DEST" ]]; then
          REMOTE_TOOL="rclone"
        elif command -v gcloud &>/dev/null; then
          REMOTE_TOOL="gcloud"
        elif command -v gsutil &>/dev/null; then
          REMOTE_TOOL="gsutil"
        elif command -v rclone &>/dev/null; then
          REMOTE_TOOL="rclone"
        else
          REMOTE_TOOL="gsutil"
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

  # Setup logging directory
  if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    LOG_DIR="/tmp/bankerchanger-logs"
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    LOG_FILE="${LOG_DIR}/backup-$(date +%Y%m).log"
  fi

  # Validate core database backup tools
  if [[ "${SKIP_PG_DUMP_CHECK:-false}" != "true" ]]; then
    if ! command -v pg_dump &>/dev/null; then
      log_error "Required tool 'pg_dump' not found in PATH"
      ((errors++))
    fi
  fi

  if ! command -v gzip &>/dev/null; then
    log_error "Required tool 'gzip' not found in PATH"
    ((errors++))
  fi

  if ! command -v sha256sum &>/dev/null; then
    log_error "Required tool 'sha256sum' not found in PATH"
    ((errors++))
  fi

  # Validate encryption setup
  if [[ "$ENCRYPTION_ENABLED" == "true" && "$ENCRYPTION_TYPE" != "none" ]]; then
    case "$ENCRYPTION_TYPE" in
      aes-256|openssl)
        if ! command -v openssl &>/dev/null; then
          log_error "OpenSSL required for AES-256 encryption but not found"
          ((errors++))
        fi
        if [[ -z "$ENCRYPTION_KEY_FILE" && -z "$BACKUP_ENCRYPTION_KEY" ]]; then
          log_error "AES-256 encryption requested, but neither BACKUP_ENCRYPTION_KEY_FILE nor BACKUP_ENCRYPTION_KEY is set"
          ((errors++))
        elif [[ -n "$ENCRYPTION_KEY_FILE" && ! -f "$ENCRYPTION_KEY_FILE" ]]; then
          log_error "Encryption key file not found: $ENCRYPTION_KEY_FILE"
          ((errors++))
        fi
        ;;
      gpg)
        if ! command -v gpg &>/dev/null; then
          log_error "GPG tool not found in PATH"
          ((errors++))
        fi
        local gpg_pass_file="${GPG_PASSPHRASE_FILE:-$ENCRYPTION_KEY_FILE}"
        local gpg_pass="${GPG_PASSPHRASE:-$BACKUP_ENCRYPTION_KEY}"
        if [[ -z "$GPG_RECIPIENT" && -z "$gpg_pass_file" && -z "$gpg_pass" ]]; then
          log_error "GPG encryption requires GPG_RECIPIENT, GPG_PASSPHRASE_FILE, or GPG_PASSPHRASE"
          ((errors++))
        elif [[ -n "$gpg_pass_file" && ! -f "$gpg_pass_file" ]]; then
          log_error "GPG passphrase file not found: $gpg_pass_file"
          ((errors++))
        fi
        ;;
      *)
        log_error "Unsupported encryption type: $ENCRYPTION_TYPE (choose 'aes-256', 'gpg', or 'none')"
        ((errors++))
        ;;
    esac
  fi

  # Validate remote storage if upload is enabled
  if [[ "$REMOTE_STORAGE" != "none" && "$SKIP_UPLOAD" != "true" ]]; then
    case "$REMOTE_STORAGE" in
      s3)
        if [[ -z "$S3_BUCKET" ]]; then
          log_error "AWS S3 storage chosen but AWS_S3_BACKUP_BUCKET is not set"
          ((errors++))
        fi
        if [[ "$REMOTE_TOOL" == "rclone" ]]; then
          if ! command -v rclone &>/dev/null; then
            log_error "rclone tool not found in PATH"
            ((errors++))
          fi
        else
          if ! command -v aws &>/dev/null; then
            log_error "AWS CLI tool ('aws') not found in PATH"
            ((errors++))
          fi
          # Check AWS credentials if not explicitly skipped
          if [[ "${SKIP_AWS_CREDENTIAL_CHECK:-false}" != "true" ]]; then
            if ! aws sts get-caller-identity --region "$AWS_REGION" &>/dev/null; then
              log_error "AWS credentials not configured or invalid for region $AWS_REGION"
              ((errors++))
            fi
          fi
        fi
        ;;
      gcs)
        if [[ -z "$GCS_BUCKET" ]]; then
          log_error "Google Cloud Storage chosen but GCS_BACKUP_BUCKET is not set"
          ((errors++))
        fi
        if [[ "$REMOTE_TOOL" == "rclone" ]]; then
          if ! command -v rclone &>/dev/null; then
            log_error "rclone tool not found in PATH"
            ((errors++))
          fi
        elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
          if ! command -v gcloud &>/dev/null; then
            log_error "Google Cloud CLI ('gcloud') not found in PATH"
            ((errors++))
          fi
        else
          if ! command -v gsutil &>/dev/null; then
            log_error "Google Cloud Storage tool ('gsutil') not found in PATH"
            ((errors++))
          fi
        fi
        ;;
      rclone)
        if [[ -z "$RCLONE_DEST" ]]; then
          log_error "rclone storage chosen but RCLONE_DEST is not set"
          ((errors++))
        fi
        if ! command -v rclone &>/dev/null; then
          log_error "rclone tool not found in PATH"
          ((errors++))
        fi
        ;;
      *)
        log_error "Invalid remote storage provider: $REMOTE_STORAGE"
        ((errors++))
        ;;
    esac
  fi

  if [[ $errors -gt 0 ]]; then
    log_error "Configuration validation failed with $errors error(s)"
    return 1
  fi

  log_info "Configuration validation passed (Remote Storage: $REMOTE_STORAGE, Encryption: ${ENCRYPTION_TYPE})"
  return 0
}

# ── Backup Creation & Compression ──────────────────────────────────────────

create_backup() {
  log_info "Starting database backup for database: $DB_NAME"

  # Parse host and port for logging
  local db_host db_port
  db_host=$(echo "$DATABASE_URL" | grep -oP '(?<=@).*(?=:)' || echo "localhost")
  db_port=$(echo "$DATABASE_URL" | grep -oP '(?<=:)\d+(?=/)' || echo "5432")

  log_info "Connecting to PostgreSQL at $db_host:$db_port"

  if pg_dump "$DATABASE_URL" \
    --format=plain \
    --verbose \
    --no-password \
    > "$BACKUP_FILE" 2>> "$LOG_FILE"; then
    log_info "Database dump created: $BACKUP_FILE"
    log_info "Raw dump size: $(du -h "$BACKUP_FILE" | cut -f1)"
    return 0
  else
    log_error "pg_dump failed for database $DB_NAME"
    return 2
  fi
}

compress_backup() {
  log_info "Compressing backup file with gzip..."

  if gzip -f "$BACKUP_FILE"; then
    log_info "Compression completed: $COMPRESSED_FILE"
    log_info "Compressed dump size: $(du -h "$COMPRESSED_FILE" | cut -f1)"
    return 0
  else
    log_error "gzip compression failed"
    return 2
  fi
}

# ── Encryption (OpenSSL AES-256 / GPG) ──────────────────────────────────────

encrypt_backup() {
  if [[ "$ENCRYPTION_ENABLED" != "true" || "$ENCRYPTION_TYPE" == "none" ]]; then
    log_info "Encryption disabled; using unencrypted compressed dump."
    FINAL_BACKUP_FILE="$COMPRESSED_FILE"
    return 0
  fi

  case "$ENCRYPTION_TYPE" in
    aes-256|openssl)
      log_info "Encrypting backup with AES-256 (OpenSSL)..."
      FINAL_BACKUP_FILE="${COMPRESSED_FILE}.enc"

      local openssl_args=(-"$ENCRYPTION_CIPHER" -salt -pbkdf2)
      if [[ -n "$ENCRYPTION_KEY_FILE" && -f "$ENCRYPTION_KEY_FILE" ]]; then
        openssl_args+=(-pass "file:$ENCRYPTION_KEY_FILE")
      elif [[ -n "$BACKUP_ENCRYPTION_KEY" ]]; then
        openssl_args+=(-pass "env:BACKUP_ENCRYPTION_KEY")
      else
        log_error "No encryption key provided"
        return 3
      fi

      if openssl enc "${openssl_args[@]}" \
        -in "$COMPRESSED_FILE" \
        -out "$FINAL_BACKUP_FILE" 2>> "$LOG_FILE"; then
        
        log_info "AES-256 encryption completed: $(basename "$FINAL_BACKUP_FILE")"
        log_info "Encrypted file size: $(du -h "$FINAL_BACKUP_FILE" | cut -f1)"
        rm -f "$COMPRESSED_FILE"
        return 0
      else
        log_error "AES-256 encryption failed"
        return 3
      fi
      ;;

    gpg)
      log_info "Encrypting backup with GPG (AES-256)..."
      FINAL_BACKUP_FILE="${COMPRESSED_FILE}.gpg"

      if [[ -n "$GPG_RECIPIENT" ]]; then
        log_info "Encrypting with GPG public key for recipient: $GPG_RECIPIENT"
        if gpg --batch --yes --trust-model always \
          --encrypt --recipient "$GPG_RECIPIENT" \
          --output "$FINAL_BACKUP_FILE" \
          "$COMPRESSED_FILE" 2>> "$LOG_FILE"; then
          log_info "GPG recipient encryption completed: $(basename "$FINAL_BACKUP_FILE")"
          rm -f "$COMPRESSED_FILE"
          return 0
        else
          log_error "GPG recipient encryption failed"
          return 3
        fi
      else
        local gpg_pass_file="${GPG_PASSPHRASE_FILE:-$ENCRYPTION_KEY_FILE}"
        local gpg_pass="${GPG_PASSPHRASE:-$BACKUP_ENCRYPTION_KEY}"

        if [[ -n "$gpg_pass_file" && -f "$gpg_pass_file" ]]; then
          log_info "Encrypting with GPG symmetric AES-256 using passphrase file"
          if gpg --batch --yes --pinentry-mode loopback \
            --symmetric --cipher-algo AES256 \
            --passphrase-file "$gpg_pass_file" \
            --output "$FINAL_BACKUP_FILE" \
            "$COMPRESSED_FILE" 2>> "$LOG_FILE"; then
            log_info "GPG symmetric encryption completed: $(basename "$FINAL_BACKUP_FILE")"
            rm -f "$COMPRESSED_FILE"
            return 0
          else
            log_error "GPG symmetric encryption failed"
            return 3
          fi
        elif [[ -n "$gpg_pass" ]]; then
          log_info "Encrypting with GPG symmetric AES-256 using passphrase variable"
          if echo -n "$gpg_pass" | gpg --batch --yes --pinentry-mode loopback \
            --symmetric --cipher-algo AES256 \
            --passphrase-fd 0 \
            --output "$FINAL_BACKUP_FILE" \
            "$COMPRESSED_FILE" 2>> "$LOG_FILE"; then
            log_info "GPG symmetric encryption completed: $(basename "$FINAL_BACKUP_FILE")"
            rm -f "$COMPRESSED_FILE"
            return 0
          else
            log_error "GPG symmetric encryption failed"
            return 3
          fi
        else
          log_error "No GPG passphrase or recipient provided"
          return 3
        fi
      fi
      ;;

    *)
      log_error "Unknown encryption type: $ENCRYPTION_TYPE"
      return 3
      ;;
  esac
}

# ── Local Storage Save ─────────────────────────────────────────────────────

save_local_backup() {
  if [[ "$KEEP_LOCAL_BACKUP" != "true" ]]; then
    log_info "KEEP_LOCAL_BACKUP is false; skipping local backup retention."
    return 0
  fi

  log_info "Saving backup copy locally to: $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR" 2>/dev/null || true

  if [[ ! -d "$BACKUP_DIR" || ! -w "$BACKUP_DIR" ]]; then
    log_warn "Local backup directory $BACKUP_DIR is not writable; falling back to /tmp/backups"
    BACKUP_DIR="/tmp/backups"
    mkdir -p "$BACKUP_DIR" 2>/dev/null || true
  fi

  local target_file="$BACKUP_DIR/$(basename "$FINAL_BACKUP_FILE")"
  if cp "$FINAL_BACKUP_FILE" "$target_file"; then
    chmod 600 "$target_file" 2>/dev/null || true
    log_info "Local backup successfully saved: $target_file ($(du -h "$target_file" | cut -f1))"
    if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
      local target_checksum="$BACKUP_DIR/$(basename "$CHECKSUM_FILE")"
      cp "$CHECKSUM_FILE" "$target_checksum" 2>/dev/null || true
      chmod 600 "$target_checksum" 2>/dev/null || true
      log_info "Local checksum sidecar saved: $target_checksum"
    fi
    return 0
  else
    log_warn "Failed to copy backup to local directory: $BACKUP_DIR"
    return 0
  fi
}

generate_checksum() {
  log_info "Generating SHA-256 checksum for backup: $(basename "$FINAL_BACKUP_FILE")..."

  local checksum
  if ! checksum=$(sha256sum "$FINAL_BACKUP_FILE" | awk '{print $1}'); then
    log_error "Failed to compute SHA-256 checksum"
    return 6
  fi

  local filename
  filename=$(basename "$FINAL_BACKUP_FILE")
  CHECKSUM_FILE="${FINAL_BACKUP_FILE}.sha256"

  if ! printf '%s  %s\n' "$checksum" "$filename" > "$CHECKSUM_FILE"; then
    log_error "Failed to write checksum file: $CHECKSUM_FILE"
    return 6
  fi

  log_info "Checksum generated: $checksum ($filename)"
  return 0
}

# ── Remote Object Storage Upload ───────────────────────────────────────────

upload_to_remote() {
  if [[ "$REMOTE_STORAGE" == "none" || "$SKIP_UPLOAD" == "true" ]]; then
    log_info "Remote storage upload skipped/not configured. Backup stored locally at $BACKUP_DIR."
    return 0
  fi

  log_info "Uploading backup to remote off-site storage: $REMOTE_STORAGE (tool: $REMOTE_TOOL)"

  case "$REMOTE_STORAGE" in
    s3)
      upload_to_s3
      ;;
    gcs)
      upload_to_gcs
      ;;
    rclone)
      upload_to_rclone
      ;;
    *)
      log_error "Unsupported remote storage provider: $REMOTE_STORAGE"
      return 4
      ;;
  esac
}

upload_to_s3() {
  local filename
  filename=$(basename "$FINAL_BACKUP_FILE")
  local checksum_filename="${filename}.sha256"

  if [[ "$REMOTE_TOOL" == "rclone" ]]; then
    local rclone_dest="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
    local target_uri="${rclone_dest%/}/$filename"
    log_info "Uploading to S3 via rclone: $target_uri"
    if ! rclone copyto "$FINAL_BACKUP_FILE" "$target_uri" 2>> "$LOG_FILE"; then
      log_error "rclone S3 upload failed"
      return 4
    fi
    if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
      rclone copyto "$CHECKSUM_FILE" "${target_uri}.sha256" 2>> "$LOG_FILE" || true
    fi
    log_info "rclone S3 upload succeeded: $target_uri"
    return 0
  else
    local s3_path="s3://${S3_BUCKET}/${S3_PREFIX%/}/$filename"
    log_info "Uploading to AWS S3 via AWS CLI: $s3_path"
    if ! aws s3 cp "$FINAL_BACKUP_FILE" "$s3_path" \
      --region "$AWS_REGION" \
      --sse AES256 \
      --metadata "backup-date=$TIMESTAMP,database=$DB_NAME,encryption=$ENCRYPTION_TYPE" \
      2>> "$LOG_FILE"; then
      log_error "AWS S3 upload failed"
      return 4
    fi
    if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
      local checksum_s3_path="s3://${S3_BUCKET}/${S3_PREFIX%/}/${checksum_filename}"
      log_info "Uploading checksum to AWS S3: $checksum_s3_path"
      if ! aws s3 cp "$CHECKSUM_FILE" "$checksum_s3_path" \
        --region "$AWS_REGION" \
        --sse AES256 \
        --metadata "backup-date=$TIMESTAMP,database=$DB_NAME" \
        2>> "$LOG_FILE"; then
        log_error "Checksum upload failed"
        return 4
      fi
    fi
    log_info "AWS S3 upload succeeded: $s3_path"
    return 0
  fi
}

upload_to_gcs() {
  local filename
  filename=$(basename "$FINAL_BACKUP_FILE")

  if [[ "$REMOTE_TOOL" == "rclone" ]]; then
    local rclone_dest="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
    local target_uri="${rclone_dest%/}/$filename"
    log_info "Uploading to Google Cloud Storage via rclone: $target_uri"
    if ! rclone copyto "$FINAL_BACKUP_FILE" "$target_uri" 2>> "$LOG_FILE"; then
      log_error "rclone GCS upload failed"
      return 4
    fi
    if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
      rclone copyto "$CHECKSUM_FILE" "${target_uri}.sha256" 2>> "$LOG_FILE" || true
    fi
    log_info "rclone GCS upload succeeded: $target_uri"
    return 0
  elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
    local gcs_path="gs://${GCS_BUCKET}/${GCS_PREFIX%/}/$filename"
    log_info "Uploading to Google Cloud Storage via gcloud: $gcs_path"
    if ! gcloud storage cp "$FINAL_BACKUP_FILE" "$gcs_path" 2>> "$LOG_FILE"; then
      log_error "gcloud GCS upload failed"
      return 4
    fi
    if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
      gcloud storage cp "$CHECKSUM_FILE" "${gcs_path}.sha256" 2>> "$LOG_FILE" || true
    fi
    log_info "gcloud GCS upload succeeded: $gcs_path"
    return 0
  else
    local gcs_path="gs://${GCS_BUCKET}/${GCS_PREFIX%/}/$filename"
    log_info "Uploading to Google Cloud Storage via gsutil: $gcs_path"
    if ! gsutil cp "$FINAL_BACKUP_FILE" "$gcs_path" 2>> "$LOG_FILE"; then
      log_error "gsutil GCS upload failed"
      return 4
    fi
    if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
      gsutil cp "$CHECKSUM_FILE" "${gcs_path}.sha256" 2>> "$LOG_FILE" || true
    fi
    log_info "gsutil GCS upload succeeded: $gcs_path"
    return 0
  fi
}

upload_to_rclone() {
  local filename
  filename=$(basename "$FINAL_BACKUP_FILE")
  local target_uri="${RCLONE_DEST%/}/$filename"

  log_info "Uploading to remote target via rclone: $target_uri"
  if ! rclone copyto "$FINAL_BACKUP_FILE" "$target_uri" 2>> "$LOG_FILE"; then
    log_error "rclone upload failed"
    return 4
  fi
  if [[ -n "$CHECKSUM_FILE" && -f "$CHECKSUM_FILE" ]]; then
    rclone copyto "$CHECKSUM_FILE" "${target_uri}.sha256" 2>> "$LOG_FILE" || true
  fi
  log_info "rclone upload succeeded: $target_uri"
  return 0
}

# ── Retention Lifecycle Pruning ────────────────────────────────────────────

cleanup_old_backups() {
  log_info "Starting retention lifecycle pruning (retention limit: $RETENTION_DAYS days)..."
  local errors=0

  # Prune remote off-site backups
  if [[ "$REMOTE_STORAGE" != "none" && "$SKIP_UPLOAD" != "true" ]]; then
    if ! cleanup_remote_backups; then
      ((errors++))
    fi
  fi

  # Prune local backups
  if [[ -d "$BACKUP_DIR" ]]; then
    if ! cleanup_local_backups; then
      ((errors++))
    fi
  fi

  if [[ $errors -gt 0 ]]; then
    log_warn "Retention pruning finished with minor warnings"
  else
    log_info "Retention pruning completed successfully"
  fi
  return 0
}

cleanup_remote_backups() {
  local cutoff_compact
  cutoff_compact=$(date -u -d "$RETENTION_DAYS days ago" +%Y%m%d)
  local count=0

  log_info "Pruning off-site backups older than $RETENTION_DAYS days (cutoff: $cutoff_compact)..."

  case "$REMOTE_STORAGE" in
    s3)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
        log_info "Pruning S3 backups via rclone delete --min-age ${RETENTION_DAYS}d: $rclone_dest"
        rclone delete "$rclone_dest" --min-age "${RETENTION_DAYS}d" 2>> "$LOG_FILE" || true
      else
        log_info "Scanning S3 for backups to prune: s3://${S3_BUCKET}/${S3_PREFIX%/}/"
        while IFS= read -r s3_file; do
          if [[ -n "$s3_file" && "$s3_file" =~ ([0-9]{8})_[0-9]{6} ]]; then
            local file_date="${BASH_REMATCH[1]}"
            if [[ "$file_date" < "$cutoff_compact" ]]; then
              log_info "Deleting off-site S3 backup older than $RETENTION_DAYS days: $s3_file"
              if aws s3 rm "s3://${S3_BUCKET}/${s3_file}" --region "$AWS_REGION" 2>> "$LOG_FILE"; then
                ((count++))
              else
                log_warn "Failed to delete S3 backup: $s3_file"
              fi
            fi
          fi
        done < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX%/}/" --region "$AWS_REGION" --recursive 2>/dev/null | awk '{print $4}' || true)
        log_info "Pruned $count off-site backup(s) from S3"
      fi
      ;;

    gcs)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
        log_info "Pruning GCS backups via rclone delete --min-age ${RETENTION_DAYS}d: $rclone_dest"
        rclone delete "$rclone_dest" --min-age "${RETENTION_DAYS}d" 2>> "$LOG_FILE" || true
      elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
        log_info "Scanning GCS via gcloud for backups to prune: gs://${GCS_BUCKET}/${GCS_PREFIX%/}/"
        while IFS= read -r gcs_uri; do
          if [[ -n "$gcs_uri" && "$gcs_uri" =~ ([0-9]{8})_[0-9]{6} ]]; then
            local file_date="${BASH_REMATCH[1]}"
            if [[ "$file_date" < "$cutoff_compact" ]]; then
              log_info "Deleting off-site GCS backup older than $RETENTION_DAYS days: $gcs_uri"
              if gcloud storage rm "$gcs_uri" 2>> "$LOG_FILE"; then
                ((count++))
              else
                log_warn "Failed to delete GCS backup: $gcs_uri"
              fi
            fi
          fi
        done < <(gcloud storage ls "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null || true)
        log_info "Pruned $count off-site backup(s) from GCS"
      else
        log_info "Scanning GCS via gsutil for backups to prune: gs://${GCS_BUCKET}/${GCS_PREFIX%/}/"
        while IFS= read -r gcs_uri; do
          if [[ -n "$gcs_uri" && "$gcs_uri" =~ ([0-9]{8})_[0-9]{6} ]]; then
            local file_date="${BASH_REMATCH[1]}"
            if [[ "$file_date" < "$cutoff_compact" ]]; then
              log_info "Deleting off-site GCS backup older than $RETENTION_DAYS days: $gcs_uri"
              if gsutil rm "$gcs_uri" 2>> "$LOG_FILE"; then
                ((count++))
              else
                log_warn "Failed to delete GCS backup: $gcs_uri"
              fi
            fi
          fi
        done < <(gsutil ls "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null || true)
        log_info "Pruned $count off-site backup(s) from GCS"
      fi
      ;;

    rclone)
      log_info "Pruning backups via rclone delete --min-age ${RETENTION_DAYS}d: $RCLONE_DEST"
      rclone delete "${RCLONE_DEST}" --min-age "${RETENTION_DAYS}d" 2>> "$LOG_FILE" || true
      ;;
  esac

  return 0
}

cleanup_local_backups() {
  local count=0
  local cutoff_compact
  cutoff_compact=$(date -u -d "$RETENTION_DAYS days ago" +%Y%m%d)

  log_info "Scanning local directory for backups older than $RETENTION_DAYS days: $BACKUP_DIR"

  for file in "$BACKUP_DIR"/*; do
    if [[ -f "$file" ]]; then
      local base
      base=$(basename "$file")
      if [[ "$base" =~ ([0-9]{8})_[0-9]{6} ]]; then
        local file_date="${BASH_REMATCH[1]}"
        if [[ "$file_date" < "$cutoff_compact" ]]; then
          log_info "Deleting old local backup: $base"
          rm -f "$file"
          ((count++))
        fi
      fi
    fi
  done

  log_info "Pruned $count local backup(s)"
  return 0
}

# ── Status Notification ────────────────────────────────────────────────────

send_status() {
  local status="$1"
  local message="$2"

  log_info "Backup Status: $status | $message"

  # Optional monitoring integration (e.g. CloudWatch)
  if [[ "$status" == "SUCCESS" && "${ENABLE_CLOUDWATCH_METRICS:-false}" == "true" ]] && command -v aws &>/dev/null; then
    aws cloudwatch put-metric-data \
      --namespace "BANKERCHANGER/Database" \
      --metric-name "BackupStatus" \
      --value 1 \
      --region "$AWS_REGION" 2>/dev/null || true
  fi
}

# ── Main Execution Flow ────────────────────────────────────────────────────

main() {
  parse_args "$@"
  resolve_remote_storage

  log_info "════════════════════════════════════════════════════════════"
  log_info "PostgreSQL Backup Process Started"
  log_info "════════════════════════════════════════════════════════════"

  # 1. Validate configuration
  if ! validate_config; then
    send_status "FAILED" "Configuration validation failed"
    exit 1
  fi

  # 2. Create raw database dump
  if ! create_backup; then
    send_status "FAILED" "Database dump failed"
    exit 2
  fi

  # 3. Compress database dump
  if ! compress_backup; then
    send_status "FAILED" "Backup compression failed"
    exit 2
  fi

  # 4. Encrypt compressed backup
  if ! encrypt_backup; then
    send_status "FAILED" "Backup encryption failed"
    exit 3
  fi

  # 5. Generate SHA-256 checksum
  if ! generate_checksum; then
    send_status "FAILED" "Checksum generation failed"
    exit 6
  fi

  # 6. Save local backup copy (with checksum sidecar)
  save_local_backup

  # 7. Upload to remote object storage (AWS S3 / GCS / rclone with checksum sidecar)
  if ! upload_to_remote; then
    send_status "FAILED" "Remote storage upload failed"
    exit 4
  fi

  # 8. Retention lifecycle pruning (off-site & local)
  if ! cleanup_old_backups; then
    log_warn "Cleanup encountered errors but backup succeeded"
  fi

  log_info "════════════════════════════════════════════════════════════"
  log_info "Backup Process Completed Successfully"
  log_info "File: $(basename "$FINAL_BACKUP_FILE")"
  log_info "Remote: $REMOTE_STORAGE | Encryption: $ENCRYPTION_TYPE"
  log_info "════════════════════════════════════════════════════════════"
  send_status "SUCCESS" "Backup completed, encrypted, and saved"
  exit 0
}

# Run main if invoked directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
