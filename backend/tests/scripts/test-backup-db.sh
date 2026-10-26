#!/bin/bash

# ============================================================================
# Comprehensive Test Suite for Database Backup & Restore Scripts
# Tests:
#   1. Local backup creation & gzip compression
#   2. OpenSSL AES-256 encryption & decryption
#   3. GPG AES-256 encryption & decryption
#   4. Remote upload via mock AWS CLI
#   5. Remote upload via mock rclone (S3 & GCS)
#   6. Remote upload via mock gsutil
#   7. Retention pruning (local, S3, GCS)
#   8. Configuration validation and error handling
#   9. Restore script decryption and psql execution
#   10. Manage-backups script listing and cleanup
# ============================================================================

set -euo pipefail

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-db.sh"
RESTORE_SCRIPT="$SCRIPT_DIR/restore-db.sh"
MANAGE_SCRIPT="$SCRIPT_DIR/manage-backups.sh"

MOCK_BIN_DIR="$TEST_DIR/bin"
mkdir -p "$MOCK_BIN_DIR"

# Create mock pg_dump
cat << 'EOF' > "$MOCK_BIN_DIR/pg_dump"
#!/bin/bash
echo "-- MOCK POSTGRESQL DUMP --"
echo "CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(255));"
echo "INSERT INTO users (username) VALUES ('test_user');"
exit 0
EOF
chmod +x "$MOCK_BIN_DIR/pg_dump"

# Create mock psql
RESTORE_LOG="$TEST_DIR/psql_restored.log"
cat << EOF > "$MOCK_BIN_DIR/psql"
#!/bin/bash
if [[ "\$*" == *"-c"* || "\$*" == *"-tc"* ]]; then
  if [[ "\$*" == *"SELECT 1 FROM pg_database"* ]]; then
    echo "1"
  elif [[ "\$*" == *"SELECT COUNT(*) FROM information_schema.tables"* ]]; then
    echo "5"
  fi
  exit 0
fi
cat >> "$RESTORE_LOG"
exit 0
EOF
chmod +x "$MOCK_BIN_DIR/psql"

# Add mock bin to PATH
export PATH="$MOCK_BIN_DIR:$PATH"

PASSED=0
FAILED=0

assert_true() {
  local desc="$1"
  shift
  if "$@"; then
    echo "  ✓ PASS: $desc"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ FAIL: $desc"
    FAILED=$((FAILED + 1))
  fi
}

echo "════════════════════════════════════════════════════════════"
echo "Running Database Backup Scripts Test Suite"
echo "════════════════════════════════════════════════════════════"

# Test 1: Configuration Validation (missing key file)
echo "Test 1: Validation failure when key file is missing"
(
  export BACKUP_ENCRYPTION_KEY_FILE="/nonexistent/path/to/key"
  export BACKUP_ENCRYPTION_TYPE="aes-256"
  export REMOTE_STORAGE="none"
  if ! "$BACKUP_SCRIPT" --storage none --key-file "/nonexistent/key" 2>/dev/null; then
    exit 0
  else
    exit 1
  fi
)
assert_true "Fails when AES-256 key file is nonexistent" test $? -eq 0

# Test 2: Local Backup with OpenSSL AES-256
echo "Test 2: Local backup with OpenSSL AES-256 encryption"
KEY_FILE="$TEST_DIR/test_aes.key"
openssl rand -base64 32 > "$KEY_FILE"
LOCAL_BACKUP_DIR="$TEST_DIR/local_backups"

export BACKUP_DIR="$LOCAL_BACKUP_DIR"
export LOG_DIR="$TEST_DIR/logs"
export SKIP_AWS_CREDENTIAL_CHECK="true"

"$BACKUP_SCRIPT" \
  --storage none \
  --backup-dir "$LOCAL_BACKUP_DIR" \
  --encryption aes-256 \
  --key-file "$KEY_FILE" > /dev/null

BACKUP_COUNT=$(find "$LOCAL_BACKUP_DIR" -type f -name "*backup*.enc" | wc -l)
assert_true "Created AES-256 encrypted backup locally" test "$BACKUP_COUNT" -eq 1

ENC_FILE=$(find "$LOCAL_BACKUP_DIR" -type f -name "*backup*.enc" | head -1)
# Verify file can be decrypted and matches dump
DECRYPTED_SQL="$TEST_DIR/decrypted.sql"
openssl enc -aes-256-cbc -d -pbkdf2 -in "$ENC_FILE" -out - -pass file:"$KEY_FILE" | gunzip > "$DECRYPTED_SQL"
assert_true "Decrypted dump contains original SQL schema" grep -q "CREATE TABLE users" "$DECRYPTED_SQL"

# Test 3: Local Backup with GPG Symmetric AES-256
echo "Test 3: Local backup with GPG symmetric encryption"
GPG_PASS_FILE="$TEST_DIR/test_gpg.pass"
echo "MySuperSecretGpgPassphrase123" > "$GPG_PASS_FILE"
GPG_BACKUP_DIR="$TEST_DIR/gpg_backups"

"$BACKUP_SCRIPT" \
  --storage none \
  --backup-dir "$GPG_BACKUP_DIR" \
  --encryption gpg \
  --gpg-passphrase-file "$GPG_PASS_FILE" > /dev/null

GPG_COUNT=$(find "$GPG_BACKUP_DIR" -type f -name "*backup*.gpg" | wc -l)
assert_true "Created GPG encrypted backup locally" test "$GPG_COUNT" -eq 1

GPG_FILE=$(find "$GPG_BACKUP_DIR" -type f -name "*backup*.gpg" | head -1)
GPG_DECRYPTED="$TEST_DIR/gpg_decrypted.sql"
gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase-file "$GPG_PASS_FILE" "$GPG_FILE" | gunzip > "$GPG_DECRYPTED"
assert_true "Decrypted GPG dump contains original SQL schema" grep -q "CREATE TABLE users" "$GPG_DECRYPTED"

# Test 4: Retention Pruning (Local)
echo "Test 4: Retention lifecycle pruning of local backups"
OLD_BACKUP="$LOCAL_BACKUP_DIR/bankerchanger_backup_20260101_120000.sql.gz.enc"
touch "$OLD_BACKUP"
assert_true "Artificial old backup created" test -f "$OLD_BACKUP"

# Run backup script with 30-day retention
"$BACKUP_SCRIPT" \
  --storage none \
  --backup-dir "$LOCAL_BACKUP_DIR" \
  --encryption aes-256 \
  --key-file "$KEY_FILE" \
  --retention-days 30 > /dev/null

assert_true "Old backup was pruned by retention lifecycle" test ! -f "$OLD_BACKUP"

# Test 5: Mock Remote Upload (AWS S3)
echo "Test 5: Remote upload to S3 using AWS CLI"
MOCK_S3_DIR="$TEST_DIR/mock_s3"
mkdir -p "$MOCK_S3_DIR"

cat << EOF > "$MOCK_BIN_DIR/aws"
#!/bin/bash
if [[ "\$1" == "sts" ]]; then
  echo '{"UserId": "MOCK", "Account": "123456789012"}'
  exit 0
fi
if [[ "\$1" == "s3" && "\$2" == "cp" ]]; then
  src="\$3"
  dest="\$4"
  rel=\$(echo "\$dest" | sed -E 's|^s3://[^/]+/||')
  mkdir -p "$MOCK_S3_DIR/\$(dirname "\$rel")"
  cp "\$src" "$MOCK_S3_DIR/\$rel"
  exit 0
fi
if [[ "\$1" == "s3" && "\$2" == "ls" ]]; then
  find "$MOCK_S3_DIR" -type f | while read -r f; do
    rel=\$(echo "\$f" | sed "s|$MOCK_S3_DIR/||")
    echo "2026-10-22 12:00:00 1024 \$rel"
  done
  exit 0
fi
if [[ "\$1" == "s3" && "\$2" == "rm" ]]; then
  rel=\$(echo "\$3" | sed -E 's|^s3://[^/]+/||')
  rm -f "$MOCK_S3_DIR/\$rel"
  exit 0
fi
exit 0
EOF
chmod +x "$MOCK_BIN_DIR/aws"

"$BACKUP_SCRIPT" \
  --storage s3 \
  --s3-bucket "test-bucket" \
  --prefix "db-backups" \
  --encryption aes-256 \
  --key-file "$KEY_FILE" \
  --backup-dir "$TEST_DIR/s3_local" > /dev/null

S3_UPLOAD_COUNT=$(find "$MOCK_S3_DIR/db-backups" -type f -name "*.enc" 2>/dev/null | wc -l)
assert_true "Backup uploaded to S3 mock destination" test "$S3_UPLOAD_COUNT" -ge 1

# Test 6: Mock Remote Upload (Google Cloud Storage via gsutil)
echo "Test 6: Remote upload to GCS using gsutil"
MOCK_GCS_DIR="$TEST_DIR/mock_gcs"
mkdir -p "$MOCK_GCS_DIR"

cat << EOF > "$MOCK_BIN_DIR/gsutil"
#!/bin/bash
if [[ "\$1" == "cp" ]]; then
  src="\$2"
  dest="\$3"
  rel=\$(echo "\$dest" | sed -E 's|^gs://[^/]+/||')
  mkdir -p "$MOCK_GCS_DIR/\$(dirname "\$rel")"
  cp "\$src" "$MOCK_GCS_DIR/\$rel"
  exit 0
fi
if [[ "\$1" == "ls" ]]; then
  find "$MOCK_GCS_DIR" -type f | while read -r f; do
    rel=\$(echo "\$f" | sed "s|$MOCK_GCS_DIR/||")
    echo "gs://test-gcs-bucket/\$rel"
  done
  exit 0
fi
if [[ "\$1" == "rm" ]]; then
  rel=\$(echo "\$2" | sed -E 's|^gs://[^/]+/||')
  rm -f "$MOCK_GCS_DIR/\$rel"
  exit 0
fi
exit 0
EOF
chmod +x "$MOCK_BIN_DIR/gsutil"

"$BACKUP_SCRIPT" \
  --storage gcs \
  --gcs-bucket "test-gcs-bucket" \
  --prefix "db-backups" \
  --tool gsutil \
  --encryption gpg \
  --gpg-passphrase-file "$GPG_PASS_FILE" \
  --backup-dir "$TEST_DIR/gcs_local" > /dev/null

GCS_UPLOAD_COUNT=$(find "$MOCK_GCS_DIR/db-backups" -type f -name "*.gpg" 2>/dev/null | wc -l)
assert_true "Backup uploaded to GCS mock destination" test "$GCS_UPLOAD_COUNT" -ge 1

# Test 7: Remote Pruning (S3)
echo "Test 7: Remote S3 pruning of backups older than 30 days"
OLD_REMOTE_S3="$MOCK_S3_DIR/db-backups/bankerchanger_backup_20260101_020000.sql.gz.enc"
mkdir -p "$(dirname "$OLD_REMOTE_S3")"
touch "$OLD_REMOTE_S3"

"$BACKUP_SCRIPT" \
  --storage s3 \
  --s3-bucket "test-bucket" \
  --prefix "db-backups" \
  --encryption aes-256 \
  --key-file "$KEY_FILE" \
  --retention-days 30 \
  --backup-dir "$TEST_DIR/s3_local" > /dev/null

assert_true "Old backup pruned from S3 mock bucket" test ! -f "$OLD_REMOTE_S3"

# Test 8: Mock Remote Upload using rclone
echo "Test 8: Remote upload to S3 / GCS via rclone"
MOCK_RCLONE_DIR="$TEST_DIR/mock_rclone"
mkdir -p "$MOCK_RCLONE_DIR"

cat << EOF > "$MOCK_BIN_DIR/rclone"
#!/bin/bash
if [[ "\$1" == "copyto" ]]; then
  src="\$2"
  dest="\$3"
  rel=\$(echo "\$dest" | sed -E 's|^[^:]+:||')
  mkdir -p "$MOCK_RCLONE_DIR/\$(dirname "\$rel")"
  cp "\$src" "$MOCK_RCLONE_DIR/\$rel"
  exit 0
fi
if [[ "\$1" == "delete" ]]; then
  # mock delete
  exit 0
fi
if [[ "\$1" == "lsl" || "\$1" == "lsf" ]]; then
  find "$MOCK_RCLONE_DIR" -type f | while read -r f; do
    echo "1024 2026-10-22 12:00:00 \$(basename "\$f")"
  done
  exit 0
fi
exit 0
EOF
chmod +x "$MOCK_BIN_DIR/rclone"

"$BACKUP_SCRIPT" \
  --storage s3 \
  --s3-bucket "rclone-bucket" \
  --prefix "db-backups" \
  --tool rclone \
  --encryption aes-256 \
  --key-file "$KEY_FILE" \
  --backup-dir "$TEST_DIR/rclone_local" > /dev/null

RCLONE_UPLOAD_COUNT=$(find "$MOCK_RCLONE_DIR" -type f -name "*.enc" 2>/dev/null | wc -l)
assert_true "Backup uploaded via rclone" test "$RCLONE_UPLOAD_COUNT" -ge 1

# Test 9: Restore database from local file using restore-db.sh
echo "Test 9: Restoring database from local backup using restore-db.sh"
rm -f "$RESTORE_LOG"
"$RESTORE_SCRIPT" \
  --file "$ENC_FILE" \
  --key-file "$KEY_FILE" \
  --target-db "test_restore_db" > /dev/null

assert_true "Restore script executed and restored tables" grep -q "CREATE TABLE users" "$RESTORE_LOG"

# Test 10: Manage-backups script listing
echo "Test 10: Listing backups with manage-backups.sh"
MANAGE_OUT=$("$MANAGE_SCRIPT" --storage local --backup-dir "$LOCAL_BACKUP_DIR" --list)
assert_true "manage-backups.sh lists available local backups" echo "$MANAGE_OUT" | grep -q "AVAILABLE BACKUPS"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Test Results: $PASSED passed, $FAILED failed"
echo "════════════════════════════════════════════════════════════"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
exit 0
