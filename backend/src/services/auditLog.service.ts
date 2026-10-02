import { pool } from '../config/db';

interface AuditLogEntry {
  adminId: string | null;
  action: string;
  targetId: string | null;
  beforeState: unknown;
  afterState: unknown;
}

export const auditLog = {
  async write(entry: AuditLogEntry): Promise<void> {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_id, before_state, after_state)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.adminId, entry.action, entry.targetId, entry.beforeState, entry.afterState],
    );
  },
};