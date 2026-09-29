#!/bin/bash

# ============================================================================
# Backup Encryption Key Generation Script
# ============================================================================
#
# Description:
#   Generates a strong AES-256 encryption key for database backups.
#   Stores key securely with restricted permissions.
#   Can be managed via AWS Secrets Manager or local secure storage.
#
# Usage:
#   ./scripts/generate-backup-key.sh [--key-file /path/to/key] [--to-secrets-manager]
#
# ============================================================================

set -euo pipefail

# Configuration
KEY_FILE="${1:-.backup-encryption.key}"
TO_SECRETS_MANAGER="${2:-false}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SECRET_NAME="${BACKUP_KEY_SECRET_NAME:-bankerchanger/db-backup-key}"

log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $*"
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*" >&2
}

print_usage() {
  cat <<EOF
Generate Backup Encryption Key

USAGE:
  $(basename "$0") [OPTIONS]

OPTIONS:
  --key-file <PATH>           Output file for encryption key (default: .backup-encryption.key)
  --to-secrets-manager        Store key in AWS Secrets Manager instead of file
  --secret-name <NAME>        AWS Secrets Manager secret name (default: bankerchanger/db-backup-key)
  --help                      Show this help message

EXAMPLES:
  # Generate key and store locally
  $(basename "$0") --key-file /secure/backups/encryption.key

  # Generate and store in AWS Secrets Manager
  $(basename "$0") --to-secrets-manager

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-file)
      KEY_FILE="$2"
      shift 2
      ;;
    --to-secrets-manager)
      TO_SECRETS_MANAGER=true
      shift
      ;;
    --secret-name)
      SECRET_NAME="$2"
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

log_info "Generating AES-256 encryption key..."

# Generate 32 bytes (256 bits) of random data for AES-256
# Encode in base64 for safe storage and transfer
ENCRYPTION_KEY=$(openssl rand -base64 32)

if [[ "$TO_SECRETS_MANAGER" == true ]]; then
  log_info "Storing key in AWS Secrets Manager: $SECRET_NAME"
  
  # Check if AWS CLI is available
  if ! command -v aws &> /dev/null; then
    log_error "AWS CLI not found. Cannot store key in Secrets Manager."
    exit 1
  fi

  # Check if secret exists
  if aws secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --region "$AWS_REGION" \
    &> /dev/null; then
    
    log_info "Secret already exists. Updating..."
    aws secretsmanager update-secret \
      --secret-id "$SECRET_NAME" \
      --secret-string "$ENCRYPTION_KEY" \
      --region "$AWS_REGION"
  else
    log_info "Creating new secret..."
    aws secretsmanager create-secret \
      --name "$SECRET_NAME" \
      --secret-string "$ENCRYPTION_KEY" \
      --region "$AWS_REGION" \
      --description "Database backup encryption key for BANKERCHANGER"
  fi

  log_info "✓ Key stored in AWS Secrets Manager"
  log_info "Secret ARN: $(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$AWS_REGION" --query 'ARN' --output text)"

else
  log_info "Storing key in local file: $KEY_FILE"

  # Create directory if it doesn't exist
  mkdir -p "$(dirname "$KEY_FILE")"

  # Write key to file
  echo -n "$ENCRYPTION_KEY" > "$KEY_FILE"

  # Restrict permissions (owner read-only)
  chmod 600 "$KEY_FILE"

  log_info "✓ Key stored successfully"
  log_info "Key file: $KEY_FILE"
  log_info "Permissions: 600 (owner read-only)"
  
  # Verify key was written
  if [[ -f "$KEY_FILE" ]]; then
    log_info "✓ Key file verified"
    log_info "Key length: $(wc -c < "$KEY_FILE") bytes"
  else
    log_error "Failed to create key file"
    exit 1
  fi
fi

log_info ""
log_info "════════════════════════════════════════════════════════════"
log_info "Encryption Key Generated Successfully"
log_info "════════════════════════════════════════════════════════════"
log_info ""
log_info "NEXT STEPS:"
log_info "1. Set BACKUP_ENCRYPTION_KEY_FILE environment variable:"
log_info "   export BACKUP_ENCRYPTION_KEY_FILE=$KEY_FILE"
log_info ""
log_info "2. Test backup script:"
log_info "   ./scripts/backup-db.sh"
log_info ""
log_info "3. Verify backup was encrypted and uploaded to S3"
log_info ""
log_info "⚠️  IMPORTANT:"
log_info "- Keep this key secure and backed up"
log_info "- If using Secrets Manager, ensure backup scripts have IAM permissions"
log_info "- Store key separately from backups for security"
log_info "════════════════════════════════════════════════════════════"
log_info ""

exit 0
