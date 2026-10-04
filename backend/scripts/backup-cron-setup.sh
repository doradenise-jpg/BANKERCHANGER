#!/bin/bash

# ============================================================================
# Cron Job Setup Script for Database Backups
# ============================================================================
#
# Description:
#   Sets up automated cron jobs for:
#   - Daily database backups (2 AM UTC)
#   - Weekly backup verification (Sunday 3 AM UTC)
#   - Monthly cleanup of old backups (1st of month at 4 AM UTC)
#
# Usage:
#   sudo ./scripts/backup-cron-setup.sh [--user backup] [--app-dir /app]
#   sudo ./scripts/backup-cron-setup.sh --remove  # Remove cron jobs
#
# Requirements:
#   - Run with sudo/root privileges
#   - cron daemon running
#
# ============================================================================

set -euo pipefail

# Configuration
APP_USER="${1:-backup}"
APP_DIR="${2:-/app}"
CRON_JOB_NAME="BANKERCHANGER_DB_BACKUP"

log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $*"
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*" >&2
}

log_warn() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $*"
}

print_usage() {
  cat <<EOF
Cron Job Setup for Database Backups

USAGE:
  sudo $(basename "$0") [--user USERNAME] [--app-dir /path/to/app] [--remove]

OPTIONS:
  --user USERNAME             User to run cron jobs as (default: backup)
  --app-dir PATH             Application directory (default: /app)
  --remove                   Remove all backup cron jobs
  --help                     Show this help message

EXAMPLES:
  # Setup cron jobs
  sudo $(basename "$0") --user postgres --app-dir /home/app/bankerchanger

  # Remove cron jobs
  sudo $(basename "$0") --remove

CRON SCHEDULE:
  - Daily Backup:     2:00 AM UTC (0 2 * * *)
  - Weekly Verify:    3:00 AM UTC Sundays (0 3 * * 0)
  - Monthly Cleanup:  4:00 AM UTC 1st of month (0 4 1 * *)

EOF
}

# Parse arguments
remove_mode=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      APP_USER="$2"
      shift 2
      ;;
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --remove)
      remove_mode=true
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

# Check if running as root
if [[ $EUID -ne 0 ]]; then
  log_error "This script must be run with sudo/root privileges"
  exit 1
fi

# Verify user exists
if ! id "$APP_USER" &>/dev/null; then
  log_error "User does not exist: $APP_USER"
  exit 1
fi

# Verify app directory exists
if [[ ! -d "$APP_DIR" ]]; then
  log_error "Application directory does not exist: $APP_DIR"
  exit 1
fi

remove_cron_jobs() {
  log_info "Removing backup cron jobs..."

  # Remove existing cron jobs
  if crontab -u "$APP_USER" -l 2>/dev/null | grep -q "$CRON_JOB_NAME"; then
    log_info "Removing existing cron entries for $APP_USER"
    crontab -u "$APP_USER" -l 2>/dev/null | \
      grep -v "$CRON_JOB_NAME" | \
      crontab -u "$APP_USER" -

    log_info "✓ Cron jobs removed"
  else
    log_warn "No existing cron jobs found for removal"
  fi
}

setup_cron_jobs() {
  log_info "Setting up backup cron jobs for user: $APP_USER"
  log_info "Application directory: $APP_DIR"

  # Create temporary cron file
  local temp_cron
  temp_cron=$(mktemp)
  trap "rm -f $temp_cron" EXIT

  # Get existing crontab (if any)
  if crontab -u "$APP_USER" -l 2>/dev/null; then
    crontab -u "$APP_USER" -l > "$temp_cron"
  fi

  # Remove old entries for this task (if any)
  if grep -q "$CRON_JOB_NAME" "$temp_cron" 2>/dev/null; then
    log_info "Removing old cron entries..."
    grep -v "$CRON_JOB_NAME" "$temp_cron" > "${temp_cron}.new"
    mv "${temp_cron}.new" "$temp_cron"
  fi

  # Add new cron jobs
  cat >> "$temp_cron" <<'CRON_JOBS'

# ════════════════════════════════════════════════════════════════
# BANKERCHANGER Database Backup Cron Jobs
# ════════════════════════════════════════════════════════════════

# Daily database backup at 2:00 AM UTC
# Backups are encrypted with AES-256 and uploaded to S3
0 2 * * * cd /app && ./backend/scripts/backup-db.sh >> /var/log/backups/cron-backup.log 2>&1 # BANKERCHANGER_DB_BACKUP

# Weekly backup integrity verification (Sundays at 3:00 AM UTC)
# Verifies that all backups are accessible and uncorrupted
0 3 * * 0 cd /app && ./backend/scripts/manage-backups.sh --verify-integrity >> /var/log/backups/cron-verify.log 2>&1 # BANKERCHANGER_DB_BACKUP

# Monthly cleanup of old backups (1st of month at 4:00 AM UTC)
# Removes backups older than BACKUP_RETENTION_DAYS (default 30 days)
0 4 1 * * cd /app && ./backend/scripts/manage-backups.sh --cleanup >> /var/log/backups/cron-cleanup.log 2>&1 # BANKERCHANGER_DB_BACKUP

CRON_JOBS

  # Install new crontab
  if crontab -u "$APP_USER" "$temp_cron"; then
    log_info "✓ Cron jobs installed successfully"
  else
    log_error "Failed to install cron jobs"
    return 1
  fi

  return 0
}

verify_installation() {
  log_info "Verifying cron job installation..."

  local cron_count
  cron_count=$(crontab -u "$APP_USER" -l 2>/dev/null | grep -c "$CRON_JOB_NAME" || echo 0)

  if [[ $cron_count -gt 0 ]]; then
    log_info "✓ $cron_count cron job(s) verified"
    echo ""
    echo "Installed cron jobs:"
    crontab -u "$APP_USER" -l 2>/dev/null | grep "$CRON_JOB_NAME" | grep -v "^#"
    echo ""
    return 0
  else
    log_error "Cron jobs not found"
    return 1
  fi
}

# ── Main Execution ────────────────────────────────────────────────────────

main() {
  log_info "════════════════════════════════════════════════════════════"
  log_info "Database Backup Cron Setup"
  log_info "════════════════════════════════════════════════════════════"
  echo ""

  if [[ "$remove_mode" == true ]]; then
    remove_cron_jobs
  else
    if ! setup_cron_jobs; then
      exit 1
    fi

    if ! verify_installation; then
      exit 1
    fi
  fi

  log_info "════════════════════════════════════════════════════════════"
  log_info "Setup Complete"
  log_info "════════════════════════════════════════════════════════════"
  echo ""

  if [[ "$remove_mode" != true ]]; then
    echo "Next steps:"
    echo "1. Ensure environment variables are set:"
    echo "   - DATABASE_URL"
    echo "   - AWS_S3_BACKUP_BUCKET"
    echo "   - AWS_REGION"
    echo "   - BACKUP_ENCRYPTION_KEY_FILE"
    echo ""
    echo "2. Monitor logs:"
    echo "   - tail -f /var/log/backups/cron-backup.log"
    echo "   - tail -f /var/log/backups/cron-verify.log"
    echo "   - tail -f /var/log/backups/cron-cleanup.log"
    echo ""
    echo "3. Test backup manually:"
    echo "   - cd /app && ./backend/scripts/backup-db.sh"
    echo ""
  fi

  exit 0
}

main "$@"
