#!/bin/bash

# ============================================================================
# Backup Retention and Multi-Storage Management Script
# ============================================================================
#
# Description:
#   Manages backup lifecycle across S3, Google Cloud Storage, rclone, and local disk.
#   Lists available backups with metadata.
#   Verifies backup integrity.
#   Manages retention policies (prunes backups older than 30 days).
#   Generates backup reports and storage statistics.
#
# Usage:
#   ./scripts/manage-backups.sh --list                    # List all backups
#   ./scripts/manage-backups.sh --cleanup                 # Remove old backups (> 30 days)
#   ./scripts/manage-backups.sh --verify-integrity        # Check backup health
#   ./scripts/manage-backups.sh --report                  # Generate report
#   ./scripts/manage-backups.sh --stats                   # Storage usage statistics
#
# ============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────

# Load environment variables
if [[ -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.env"
fi

REMOTE_STORAGE="${REMOTE_STORAGE:-}"
REMOTE_TOOL="${REMOTE_TOOL:-}"

S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-${S3_BUCKET:-}}"
S3_PREFIX="${S3_BACKUP_PREFIX:-db-backups}"
AWS_REGION="${AWS_REGION:-us-east-1}"

GCS_BUCKET="${GCS_BACKUP_BUCKET:-${GCS_BUCKET:-}}"
GCS_PREFIX="${GCS_BACKUP_PREFIX:-db-backups}"

RCLONE_DEST="${RCLONE_DEST:-${RCLONE_REMOTE:-}}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/bankerchanger}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

LOG_DIR="${LOG_DIR:-/var/log/backups}"
LOG_FILE="${LOG_DIR}/manage-$(date +%Y%m%d_%H%M%S).log"

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
Backup Management Script

USAGE:
  $(basename "$0") [OPTIONS]

OPTIONS:
  --list                      List all backups in configured storage
  --cleanup                   Remove backups older than retention period (default: 30 days)
  --verify-integrity          Verify backup file accessibility and non-empty sizes
  --report                    Generate comprehensive backup report
  --stats                     Show storage statistics
  --storage <PROVIDER>        Storage provider: s3, gcs, rclone, local (default: auto-detect)
  --retention-days <DAYS>     Override retention period in days (default: 30)
  --backup-dir <PATH>         Local backup directory (default: /var/backups/bankerchanger)
  --help                      Show this help message

EXAMPLES:
  $(basename "$0") --list
  $(basename "$0") --cleanup --retention-days 30
  $(basename "$0") --report
  $(basename "$0") --storage gcs --list

EOF
}

resolve_storage() {
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
  mkdir -p "$LOG_DIR" 2>/dev/null || true

  case "$REMOTE_STORAGE" in
    s3)
      if [[ -z "$S3_BUCKET" ]]; then
        log_error "AWS_S3_BACKUP_BUCKET not set"
        ((errors++))
      fi
      if [[ "$REMOTE_TOOL" != "rclone" ]] && ! command -v aws &>/dev/null; then
        log_error "AWS CLI ('aws') not found"
        ((errors++))
      fi
      ;;
    gcs)
      if [[ -z "$GCS_BUCKET" ]]; then
        log_error "GCS_BACKUP_BUCKET not set"
        ((errors++))
      fi
      ;;
    rclone)
      if ! command -v rclone &>/dev/null; then
        log_error "rclone not found in PATH"
        ((errors++))
      fi
      ;;
  esac

  if [[ $errors -gt 0 ]]; then
    return 1
  fi
  return 0
}

list_backups() {
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "AVAILABLE BACKUPS (Storage: $REMOTE_STORAGE)"
  echo "════════════════════════════════════════════════════════════"
  printf "%-22s %-12s %s\n" "TIMESTAMP" "SIZE" "FILE / URI"
  echo "────────────────────────────────────────────────────────────"

  case "$REMOTE_STORAGE" in
    s3)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
        rclone lsl "$rclone_dest" | while read -r size date time path; do
          local ts="-"
          if [[ "$path" =~ ([0-9]{8}_[0-9]{6}) ]]; then
            ts="${BASH_REMATCH[1]}"
          fi
          printf "%-22s %-12s %s\n" "$ts" "$size" "$path"
        done
      else
        aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX%/}/" \
          --region "$AWS_REGION" \
          --recursive \
          --human-readable 2>/dev/null | while read -r date time size path; do
            local ts="-"
            if [[ "$path" =~ ([0-9]{8}_[0-9]{6}) ]]; then
              ts="${BASH_REMATCH[1]}"
            fi
            printf "%-22s %-12s %s\n" "$ts" "$size" "$path"
          done | sort -r
      fi
      ;;

    gcs)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
        rclone lsl "$rclone_dest"
      elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
        gcloud storage ls --long "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null || true
      else
        gsutil ls -l "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null || true
      fi
      ;;

    rclone)
      rclone lsl "$RCLONE_DEST"
      ;;

    local)
      if [[ -d "$BACKUP_DIR" ]]; then
        for f in "$BACKUP_DIR"/*; do
          if [[ -f "$f" ]]; then
            local fname sz ts="-"
            fname=$(basename "$f")
            sz=$(du -h "$f" | cut -f1)
            if [[ "$fname" =~ ([0-9]{8}_[0-9]{6}) ]]; then
              ts="${BASH_REMATCH[1]}"
            fi
            printf "%-22s %-12s %s\n" "$ts" "$sz" "$fname"
          fi
        done | sort -r
      else
        log_warn "Local backup directory $BACKUP_DIR does not exist"
      fi
      ;;
  esac

  echo "════════════════════════════════════════════════════════════"
  echo ""
}

cleanup_old_backups() {
  log_info "Cleaning up backups older than $RETENTION_DAYS days..."
  local cutoff_compact
  cutoff_compact=$(date -u -d "$RETENTION_DAYS days ago" +%Y%m%d)
  local count=0

  case "$REMOTE_STORAGE" in
    s3)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-s3:${S3_BUCKET}/${S3_PREFIX%/}}"
        log_info "Running rclone delete --min-age ${RETENTION_DAYS}d on $rclone_dest"
        rclone delete "$rclone_dest" --min-age "${RETENTION_DAYS}d"
      else
        while IFS= read -r s3_path; do
          if [[ -n "$s3_path" && "$s3_path" =~ ([0-9]{8})_[0-9]{6} ]]; then
            local file_date="${BASH_REMATCH[1]}"
            if [[ "$file_date" < "$cutoff_compact" ]]; then
              log_info "Deleting old S3 backup: $s3_path"
              aws s3 rm "s3://${S3_BUCKET}/${s3_path}" --region "$AWS_REGION"
              ((count++))
            fi
          fi
        done < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX%/}/" --region "$AWS_REGION" --recursive 2>/dev/null | awk '{print $4}' || true)
      fi
      ;;

    gcs)
      if [[ "$REMOTE_TOOL" == "rclone" ]]; then
        local rclone_dest="${RCLONE_DEST:-gcs:${GCS_BUCKET}/${GCS_PREFIX%/}}"
        rclone delete "$rclone_dest" --min-age "${RETENTION_DAYS}d"
      elif [[ "$REMOTE_TOOL" == "gcloud" ]]; then
        while IFS= read -r gcs_uri; do
          if [[ -n "$gcs_uri" && "$gcs_uri" =~ ([0-9]{8})_[0-9]{6} ]]; then
            local file_date="${BASH_REMATCH[1]}"
            if [[ "$file_date" < "$cutoff_compact" ]]; then
              log_info "Deleting old GCS backup: $gcs_uri"
              gcloud storage rm "$gcs_uri"
              ((count++))
            fi
          fi
        done < <(gcloud storage ls "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null || true)
      else
        while IFS= read -r gcs_uri; do
          if [[ -n "$gcs_uri" && "$gcs_uri" =~ ([0-9]{8})_[0-9]{6} ]]; then
            local file_date="${BASH_REMATCH[1]}"
            if [[ "$file_date" < "$cutoff_compact" ]]; then
              log_info "Deleting old GCS backup: $gcs_uri"
              gsutil rm "$gcs_uri"
              ((count++))
            fi
          fi
        done < <(gsutil ls "gs://${GCS_BUCKET}/${GCS_PREFIX%/}/" 2>/dev/null || true)
      fi
      ;;

    rclone)
      rclone delete "$RCLONE_DEST" --min-age "${RETENTION_DAYS}d"
      ;;

    local)
      if [[ -d "$BACKUP_DIR" ]]; then
        for f in "$BACKUP_DIR"/*; do
          if [[ -f "$f" ]]; then
            local b
            b=$(basename "$f")
            if [[ "$b" =~ ([0-9]{8})_[0-9]{6} ]]; then
              local file_date="${BASH_REMATCH[1]}"
              if [[ "$file_date" < "$cutoff_compact" ]]; then
                log_info "Deleting old local backup: $b"
                rm -f "$f"
                ((count++))
              fi
            fi
          fi
        done
      fi
      ;;
  esac

  log_info "Pruning finished: deleted $count backup(s) older than $RETENTION_DAYS days"
}

verify_integrity() {
  log_info "Verifying backup accessibility and health..."
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "BACKUP INTEGRITY CHECK"
  echo "════════════════════════════════════════════════════════════"

  local total=0
  local valid=0
  local invalid=0

  case "$REMOTE_STORAGE" in
    s3)
      while IFS= read -r backup_path; do
        if [[ -z "$backup_path" ]]; then continue; fi
        ((total++))
        local file_size
        file_size=$(aws s3 ls "s3://${S3_BUCKET}/${backup_path}" --region "$AWS_REGION" 2>/dev/null | awk '{print $3}' || echo "0")
        if [[ -n "$file_size" && "$file_size" -gt 0 ]]; then
          echo "✓ VALID: $backup_path ($file_size bytes)"
          ((valid++))
        else
          echo "✗ INVALID: $backup_path"
          ((invalid++))
        fi
      done < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX%/}/" --region "$AWS_REGION" --recursive 2>/dev/null | awk '{print $4}' || true)
      ;;

    local)
      if [[ -d "$BACKUP_DIR" ]]; then
        for f in "$BACKUP_DIR"/*; do
          if [[ -f "$f" ]]; then
            ((total++))
            if [[ -s "$f" ]]; then
              echo "✓ VALID: $(basename "$f") ($(du -h "$f" | cut -f1))"
              ((valid++))
            else
              echo "✗ EMPTY: $(basename "$f")"
              ((invalid++))
            fi
          fi
        done
      fi
      ;;

    *)
      log_info "Integrity check for $REMOTE_STORAGE performed via listing:"
      list_backups
      return 0
      ;;
  esac

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "Summary: Total: $total | Valid: $valid | Issues: $invalid"
  echo "════════════════════════════════════════════════════════════"
}

generate_report() {
  log_info "Generating backup report..."
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "BACKUP REPORT"
  echo "Generated: $(date -u)"
  echo "Storage:   $REMOTE_STORAGE"
  echo "Retention: $RETENTION_DAYS days"
  echo "════════════════════════════════════════════════════════════"
  list_backups
}

# ── Main ───────────────────────────────────────────────────────────────────

main() {
  local action=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --list)
        action="list"
        shift
        ;;
      --cleanup)
        action="cleanup"
        shift
        ;;
      --verify-integrity)
        action="verify"
        shift
        ;;
      --report|--stats)
        action="report"
        shift
        ;;
      --storage)
        REMOTE_STORAGE="$2"
        shift 2
        ;;
      --retention-days)
        RETENTION_DAYS="$2"
        shift 2
        ;;
      --backup-dir)
        BACKUP_DIR="$2"
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

  if ! validate_config; then
    exit 1
  fi

  case "$action" in
    list)
      list_backups
      ;;
    cleanup)
      cleanup_old_backups
      ;;
    verify)
      verify_integrity
      ;;
    report)
      generate_report
      ;;
    *)
      print_usage
      exit 0
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
