#!/bin/bash

# ============================================================================
# Backup Retention and S3 Management Script
# ============================================================================
#
# Description:
#   Manages backup lifecycle and S3 storage.
#   Lists available backups with metadata.
#   Verifies backup integrity.
#   Manages retention policies (30-day default).
#   Generates backup reports.
#
# Usage:
#   ./scripts/manage-backups.sh --list                    # List all backups
#   ./scripts/manage-backups.sh --cleanup                 # Remove old backups
#   ./scripts/manage-backups.sh --verify-integrity        # Check backup health
#   ./scripts/manage-backups.sh --report                  # Generate report
#
# ============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────

# Load environment variables
if [[ -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.env"
fi

S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-}"
S3_PREFIX="${S3_BACKUP_PREFIX:-db-backups}"
AWS_REGION="${AWS_REGION:-us-east-1}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

LOG_DIR="${LOG_DIR:-/var/log/backups}"
LOG_FILE="${LOG_DIR}/manage-$(date +%Y%m%d_%H%M%S).log"

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
Backup Management Script

USAGE:
  $(basename "$0") [OPTIONS]

OPTIONS:
  --list                      List all backups in S3
  --cleanup                   Remove backups older than retention period
  --verify-integrity          Verify backup file integrity
  --report                    Generate backup report
  --stats                     Show storage statistics
  --help                      Show this help message

EXAMPLES:
  $(basename "$0") --list
  $(basename "$0") --cleanup
  $(basename "$0") --report

EOF
}

validate_config() {
  local errors=0

  mkdir -p "$LOG_DIR"

  if [[ -z "$S3_BUCKET" ]]; then
    log_error "AWS_S3_BACKUP_BUCKET not set"
    ((errors++))
  fi

  if ! command -v aws &> /dev/null; then
    log_error "AWS CLI not found"
    ((errors++))
  fi

  if [[ $errors -gt 0 ]]; then
    return 1
  fi

  return 0
}

list_backups() {
  log_info "Listing backups in s3://${S3_BUCKET}/${S3_PREFIX}/"

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "AVAILABLE BACKUPS"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive \
    --human-readable | \
    awk '{
      date = $1
      time = $2
      size = $3
      path = $4
      # Extract timestamp from path
      match(path, /([0-9]{8}_[0-9]{6})/, arr)
      timestamp = arr[1]
      # Extract database name
      match(path, /([^\/]+)_backup_/, arr)
      db = arr[1]
      
      printf "%-20s %-12s %s %s\n", timestamp, size, db, date " " time
    }' | sort -r

  echo ""
  echo "════════════════════════════════════════════════════════════"
}

cleanup_old_backups() {
  log_info "Cleaning up backups older than $RETENTION_DAYS days"

  local cutoff_date
  cutoff_date=$(date -u -d "$RETENTION_DAYS days ago" +%Y-%m-%d)

  log_info "Deleting backups before: $cutoff_date"

  local count=0
  local freed_space=0

  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi

    local size
    local backup_path
    size=$(echo "$line" | awk '{print $3}')
    backup_path=$(echo "$line" | awk '{print $4}')

    local backup_date
    backup_date=$(echo "$line" | awk '{print $1}')

    if [[ "$backup_date" < "$cutoff_date" ]]; then
      log_info "Deleting: $backup_path (Size: $size, Date: $backup_date)"

      if aws s3 rm "s3://${S3_BUCKET}/${backup_path}" --region "$AWS_REGION"; then
        ((count++))
        freed_space=$((freed_space + $(echo "$size" | sed 's/[KMG]B//' | cut -d. -f1)))
      else
        log_warn "Failed to delete: $backup_path"
      fi
    fi
  done < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive \
    --human-readable | sort)

  log_info "Deleted $count old backup(s)"
  echo ""
  echo "Cleanup Summary:"
  echo "- Backups deleted: $count"
  echo "- Space freed: ~${freed_space}MB"
  echo ""
}

verify_integrity() {
  log_info "Verifying backup integrity..."

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "BACKUP INTEGRITY CHECK"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  local total=0
  local valid=0
  local invalid=0

  while IFS= read -r backup_path; do
    if [[ -z "$backup_path" ]]; then
      continue
    fi

    ((total++))

    # Check if file exists and is accessible
    if aws s3 ls "s3://${S3_BUCKET}/${backup_path}" --region "$AWS_REGION" &> /dev/null; then
      local file_size
      file_size=$(aws s3 ls "s3://${S3_BUCKET}/${backup_path}" --region "$AWS_REGION" | awk '{print $3}')

      if [[ -n "$file_size" ]] && [[ "$file_size" -gt 0 ]]; then
        echo "✓ VALID: $backup_path (Size: $file_size bytes)"
        ((valid++))
      else
        echo "✗ INVALID: $backup_path (Empty or zero size)"
        ((invalid++))
      fi
    else
      echo "✗ INACCESSIBLE: $backup_path"
      ((invalid++))
    fi
  done < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | \
    awk '{print $4}')

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "Integrity Check Summary:"
  echo "- Total backups: $total"
  echo "- Valid: $valid"
  echo "- Invalid/Inaccessible: $invalid"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  if [[ $invalid -gt 0 ]]; then
    log_warn "Found $invalid backup(s) with integrity issues"
    return 1
  fi

  return 0
}

generate_report() {
  log_info "Generating backup report..."

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "BACKUP REPORT"
  echo "Generated: $(date)"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  # Backup count
  local total_backups
  total_backups=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | wc -l)

  # Total size
  local total_size
  total_size=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive \
    --human-readable | \
    awk '{sum += $3} END {print sum}')

  # Oldest backup
  local oldest
  oldest=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | \
    head -1)

  # Newest backup
  local newest
  newest=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | \
    tail -1)

  # S3 storage class stats
  local storage_stats
  storage_stats=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive \
    --summarize | tail -3)

  echo "Configuration:"
  echo "- S3 Bucket: $S3_BUCKET"
  echo "- S3 Prefix: $S3_PREFIX"
  echo "- Retention Policy: $RETENTION_DAYS days"
  echo ""

  echo "Statistics:"
  echo "- Total Backups: $total_backups"
  echo "- Total Size: $total_size"
  echo ""

  echo "Oldest Backup:"
  echo "$oldest" | awk '{print "  Date: " $1 " " $2; print "  File: " $4}'
  echo ""

  echo "Latest Backup:"
  echo "$newest" | awk '{print "  Date: " $1 " " $2; print "  File: " $4}'
  echo ""

  echo "Storage Summary:"
  echo "$storage_stats"
  echo ""

  echo "════════════════════════════════════════════════════════════"
  echo ""
}

show_stats() {
  log_info "Calculating storage statistics..."

  local total_files
  local total_bytes
  local avg_file_size

  total_files=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | wc -l)

  total_bytes=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "$AWS_REGION" \
    --recursive | \
    awk '{sum += $3} END {print sum}')

  if [[ $total_files -gt 0 ]]; then
    avg_file_size=$((total_bytes / total_files))
  else
    avg_file_size=0
  fi

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "STORAGE STATISTICS"
  echo "════════════════════════════════════════════════════════════"
  echo ""
  printf "%-30s %15s\n" "Total Files:" "$total_files"
  printf "%-30s %15s\n" "Total Size (bytes):" "$total_bytes"
  printf "%-30s %15s\n" "Average File Size (bytes):" "$avg_file_size"
  printf "%-30s %15s\n" "Average File Size (MB):" "$((avg_file_size / 1024 / 1024))"
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo ""
}

# ── Main Execution ────────────────────────────────────────────────────────

main() {
  local action=""

  # Parse arguments
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
      --report)
        action="report"
        shift
        ;;
      --stats)
        action="stats"
        shift
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
    stats)
      show_stats
      ;;
    *)
      log_error "No action specified"
      print_usage
      exit 1
      ;;
  esac
}

main "$@"
