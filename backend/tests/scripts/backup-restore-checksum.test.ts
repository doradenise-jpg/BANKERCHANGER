import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT_DIR = path.resolve(__dirname, '../../scripts');
const BACKUP_SCRIPT = path.join(SCRIPT_DIR, 'backup-db.sh');
const RESTORE_SCRIPT = path.join(SCRIPT_DIR, 'restore-db.sh');

const TIMESTAMP = '20240115_020000';
const OBJECT_NAME = `bankerchanger_${TIMESTAMP}.sql.gz.enc`;

interface Workspace {
  dir: string;
  binDir: string;
  s3Dir: string;
  logDir: string;
  keyFile: string;
  psqlLog: string;
}

function sha256(contents: string | Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function createWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bankerchanger-checksum-'));
  const binDir = path.join(dir, 'bin');
  const s3Dir = path.join(dir, 's3');
  const logDir = path.join(dir, 'logs');

  [binDir, s3Dir, logDir].forEach((entry) => fs.mkdirSync(entry, { recursive: true }));

  const keyFile = path.join(dir, 'backup.key');
  fs.writeFileSync(keyFile, 'test-encryption-key');

  const psqlLog = path.join(dir, 'psql.log');

  writeExecutable(
    path.join(binDir, 'aws'),
    `#!/bin/bash
set -euo pipefail
command="\${1:-} \${2:-}"
if [[ "$command" == "sts get-caller-identity" ]]; then
  echo '{"Account":"123456789012"}'
  exit 0
fi
if [[ "$command" == "s3 cp" ]]; then
  src="\${3:-}"
  dest="\${4:-}"
  name="$(basename "$src")"
  if [[ "$src" == s3://* ]]; then
    if [[ "$name" == *.sha256 ]]; then
      [[ -f "$FAKE_S3_DIR/checksum.sha256" ]] || { echo "checksum not found" >&2; exit 1; }
      cp "$FAKE_S3_DIR/checksum.sha256" "$dest"
    else
      [[ -f "$FAKE_S3_DIR/backup.enc" ]] || { echo "backup not found" >&2; exit 1; }
      cp "$FAKE_S3_DIR/backup.enc" "$dest"
    fi
  else
    cp "$src" "$FAKE_S3_DIR/$(basename "$dest")"
  fi
  exit 0
fi
if [[ "$command" == "s3 ls" ]]; then
  exit 0
fi
echo "unsupported aws command: $*" >&2
exit 1
`
  );

  writeExecutable(
    path.join(binDir, 'openssl'),
    `#!/bin/bash
set -euo pipefail
infile=""
outfile=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -in) infile="$2"; shift 2 ;;
    -out) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "$infile" && -n "$outfile" ]]; then
  cp "$infile" "$outfile"
elif [[ -n "$infile" ]]; then
  cat "$infile"
fi
`
  );

  writeExecutable(
    path.join(binDir, 'pg_dump'),
    `#!/bin/bash
echo "-- fake database dump"
`
  );

  writeExecutable(
    path.join(binDir, 'gunzip'),
    `#!/bin/bash
cat
`
  );

  writeExecutable(
    path.join(binDir, 'psql'),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PSQL_LOG"
for arg in "$@"; do
  if [[ "$arg" == *"COUNT(*)"* ]]; then
    echo " 5"
    exit 0
  fi
done
exit 0
`
  );

  return { dir, binDir, s3Dir, logDir, keyFile, psqlLog };
}

function runScript(
  script: string,
  workspace: Workspace,
  args: string[] = []
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${workspace.binDir}:${process.env.PATH}`,
      FAKE_S3_DIR: workspace.s3Dir,
      PSQL_LOG: workspace.psqlLog,
      DATABASE_URL: 'postgresql://bankerchanger:bankerchanger@localhost:5432/bankerchanger',
      DB_NAME: 'bankerchanger',
      AWS_S3_BACKUP_BUCKET: 'test-backups',
      AWS_REGION: 'us-east-1',
      BACKUP_ENCRYPTION_KEY_FILE: workspace.keyFile,
      LOG_DIR: workspace.logDir,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readPsqlLog(workspace: Workspace): string {
  if (!fs.existsSync(workspace.psqlLog)) {
    return '';
  }
  return fs.readFileSync(workspace.psqlLog, 'utf8');
}

function writeChecksumFixture(workspace: Workspace, backupContents: string): void {
  const digest = sha256(backupContents);
  fs.writeFileSync(path.join(workspace.s3Dir, 'checksum.sha256'), `${digest}  ${OBJECT_NAME}\n`);
}

describe('backup-db.sh checksum generation', () => {
  let workspace: Workspace;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
  });

  it('uploads a .sha256 checksum alongside every encrypted backup', () => {
    const result = runScript(BACKUP_SCRIPT, workspace);

    expect(result.stderr).not.toContain('Checksum generation failed');
    expect(result.status).toBe(0);

    const uploadedFiles = fs.readdirSync(workspace.s3Dir);
    const encryptedFile = uploadedFiles.find((name) => name.endsWith('.sql.gz.enc'));
    const checksumFile = uploadedFiles.find((name) => name.endsWith('.sql.gz.enc.sha256'));

    expect(encryptedFile).toBeDefined();
    expect(checksumFile).toBeDefined();

    const expectedDigest = sha256(
      fs.readFileSync(path.join(workspace.s3Dir, encryptedFile as string))
    );
    const checksumContents = fs.readFileSync(
      path.join(workspace.s3Dir, checksumFile as string),
      'utf8'
    );

    expect(checksumContents.trim()).toBe(`${expectedDigest}  ${encryptedFile}`);
  });
});

describe('restore-db.sh checksum verification', () => {
  let workspace: Workspace;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(() => {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
  });

  it('rejects a corrupted backup before restoring or creating a database', () => {
    const originalContents = '-- original valid dump\n';
    writeChecksumFixture(workspace, originalContents);
    fs.writeFileSync(path.join(workspace.s3Dir, 'backup.enc'), '-- corrupted dump\n');

    const result = runScript(RESTORE_SCRIPT, workspace, [
      '--backup-timestamp',
      TIMESTAMP,
      '--target-db',
      'restore_test',
    ]);

    expect(result.status).toBe(7);
    expect(result.stderr).toContain('Checksum verification FAILED');
    expect(readPsqlLog(workspace)).toBe('');
  });

  it('rejects a backup when its checksum file is missing', () => {
    fs.writeFileSync(path.join(workspace.s3Dir, 'backup.enc'), '-- valid dump\n');

    const result = runScript(RESTORE_SCRIPT, workspace, [
      '--backup-timestamp',
      TIMESTAMP,
      '--target-db',
      'restore_test',
    ]);

    expect(result.status).toBe(7);
    expect(result.stderr).toContain('Checksum download failed');
    expect(readPsqlLog(workspace)).toBe('');
  });

  it('rejects a checksum that references a different backup file', () => {
    const backupContents = '-- valid dump\n';
    const digest = sha256(backupContents);
    fs.writeFileSync(
      path.join(workspace.s3Dir, 'checksum.sha256'),
      `${digest}  ../../../etc/passwd\n`
    );
    fs.writeFileSync(path.join(workspace.s3Dir, 'backup.enc'), backupContents);

    const result = runScript(RESTORE_SCRIPT, workspace, [
      '--backup-timestamp',
      TIMESTAMP,
      '--target-db',
      'restore_test',
    ]);

    expect(result.status).toBe(7);
    expect(result.stderr).toContain('references unexpected file');
    expect(readPsqlLog(workspace)).toBe('');
  });

  it('proceeds with the restore when the checksum matches', () => {
    const backupContents = '-- valid dump\n';
    writeChecksumFixture(workspace, backupContents);
    fs.writeFileSync(path.join(workspace.s3Dir, 'backup.enc'), backupContents);

    const result = runScript(RESTORE_SCRIPT, workspace, [
      '--backup-timestamp',
      TIMESTAMP,
      '--target-db',
      'restore_test',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checksum verification passed');

    const psqlCalls = readPsqlLog(workspace);
    expect(psqlCalls).toContain('CREATE DATABASE restore_test');
    expect(psqlCalls).toContain('COUNT(*)');
  });
});
