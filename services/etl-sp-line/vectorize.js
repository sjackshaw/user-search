'use strict';

/**
 * vectorize.js — etl-sp-line
 *
 * Single container that vectorizes both:
 *   - sharepoint_permissions          (data/primary.json)
 *   - sharepoint_permission_change_logs (data/logs.json)
 *
 * The SBERT model and pg.Pool are shared across both pipelines,
 * reducing memory footprint vs. running two separate containers.
 *
 * Includes:
 *   - ETL job logging (etl_job_logs)
 *   - Change detection + source_change_logs for runPrimary()
 *
 * Environment variables (all optional):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 *   BATCH_SIZE      – records per SBERT call (default 64)
 *   CRON_SCHEDULE   – 5-field cron for periodic re-runs (default: hourly)
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cron     = require('node-cron');

const SERVICE_NAME  = 'etl-sp-line';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';
const BATCH_SIZE    = parseInt(process.env.BATCH_SIZE || '64', 10);
const HIDDEN_SIZE   = 384;
let   extractor     = null;

const pool = new Pool({
  host:     process.env.PGHOST     || 'postgres',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'appdb',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

// ── Job Logging Helpers (via stored procedures) ──────────────────────────────

async function startJob(phase, targetTable) {
  const { rows } = await pool.query(
    'SELECT * FROM sp_etl_start_job($1, $2, $3)',
    [SERVICE_NAME, phase, targetTable],
  );
  return rows[0].sp_etl_start_job;
}

async function completeJob(jobId, stats) {
  await pool.query(
    'CALL sp_etl_complete_job($1, $2, $3, $4, $5)',
    [jobId, stats.processed, stats.created, stats.updated, stats.deleted],
  );
}

async function failJob(jobId, error) {
  await pool.query(
    'CALL sp_etl_fail_job($1, $2)',
    [jobId, String(error)],
  );
}

// ── Change Detection Helpers (via stored procedures) ─────────────────────────

async function logChange(client, sourceTable, email, changeType, fieldName, oldValue, newValue, jobId) {
  await client.query(
    'CALL sp_etl_log_change($1, $2, $3, $4, $5, $6, $7)',
    [sourceTable, email, changeType, fieldName, oldValue, newValue, jobId],
  );
}

// Compare these fields for change detection (user_email+site form the natural key)
const PRIMARY_COMPARE_FIELDS = ['role', 'permission_type', 'granted_by', 'granted_at', 'share_scope'];

function normaliseValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function vectorizeBatch(texts) {
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const embeddings = [];
  for (let b = 0; b < texts.length; b++) {
    const start = b * HIDDEN_SIZE;
    embeddings.push(Array.from(output.data.slice(start, start + HIDDEN_SIZE)));
  }
  return embeddings;
}

// Composite key for (user_email, site) → used in change-detection Maps
function permKey(userEmail, site) {
  return `${userEmail}|||${site}`;
}

// ── Pipeline 1: sharepoint_permissions (with change detection) ────────────────

async function upsertPrimaryBatch(records, embeddings, existingByKey, jobId) {
  const client = await pool.connect();
  const stats = { created: 0, updated: 0 };
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      const key = permKey(r.user, r.site);
      const existing = existingByKey.get(key);

      await client.query(
        'CALL sp_upsert_sharepoint_permission($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          r.user, r.site, r.site_url || null, r.role,
          r.permission_type || null,
          r.granted_by || null,
          r.granted_at || null,
          r.share_scope || 'user',
          emb,
        ],
      );

      // Change detection (keyed by user_email for source_change_logs compatibility)
      if (!existing) {
        await logChange(client, 'sharepoint_permissions', r.user, 'created', null, null, null, jobId);
        stats.created++;
      } else {
        const incomingMap = {
          role:            r.role,
          permission_type: r.permission_type || null,
          granted_by:      r.granted_by || null,
          granted_at:      r.granted_at || null,
          share_scope:     r.share_scope || 'user',
        };
        let changed = false;
        for (const field of PRIMARY_COMPARE_FIELDS) {
          const oldVal = normaliseValue(existing[field]);
          const newVal = normaliseValue(incomingMap[field]);
          if (oldVal !== newVal) {
            await logChange(client, 'sharepoint_permissions', r.user, 'updated', field, oldVal, newVal, jobId);
            changed = true;
          }
        }
        if (changed) stats.updated++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return stats;
}

async function runPrimary() {
  const jobId = await startJob('primary', 'sharepoint_permissions');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    // Load existing records for change detection — keyed by composite (user_email, site)
    const { rows: existingRows } = await pool.query(
      'SELECT * FROM sp_get_existing_sharepoint_permissions()',
    );
    const existingByKey = new Map(
      existingRows.map(r => [permKey(r.user_email, r.site), r]),
    );

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'primary.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] sharepoint_permissions: ${records.length} records`);

    const incomingKeys = new Set(records.map(r => permKey(r.user, r.site)));

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(r => [
        r.user,
        `site=${r.site}`,
        `role=${r.role}`,
        r.permission_type ? `type=${r.permission_type}` : '',
        r.granted_by ? `granted_by=${r.granted_by}` : '',
        r.share_scope && r.share_scope !== 'user' ? `share_scope=${r.share_scope}` : '',
      ].filter(Boolean).join(' '));
      const embeddings = await vectorizeBatch(texts);
      const batchStats = await upsertPrimaryBatch(batch, embeddings, existingByKey, jobId);
      stats.created += batchStats.created;
      stats.updated += batchStats.updated;
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] sharepoint_permissions ${stats.processed}/${records.length}`);
    }

    // Detect deletions: existing (user_email, site) pairs not in incoming set
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, existing] of existingByKey) {
        if (!incomingKeys.has(key)) {
          await logChange(client, 'sharepoint_permissions', existing.user_email, 'deleted', null, null, null, jobId);
          await client.query(
            'CALL sp_delete_sharepoint_permission($1, $2)',
            [existing.user_email, existing.site],
          );
          stats.deleted++;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(`[${SERVICE_NAME}] sharepoint_permissions complete. created=${stats.created} updated=${stats.updated} deleted=${stats.deleted}`);
    await completeJob(jobId, stats);
  } catch (err) {
    await failJob(jobId, err);
    throw err;
  }
}

// ── Pipeline 2: sharepoint_permission_change_logs ────────────────────────────

async function upsertLogsBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        'CALL sp_insert_sp_permission_change_log($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          r.timestamp, r.user_email, r.site,
          r.change_type, r.old_role || null, r.new_role || null,
          r.changed_by || null, r.notes || null,
          emb,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runLogs() {
  const jobId = await startJob('logs', 'sharepoint_permission_change_logs');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    // Truncate logs table (append-only from source file each run)
    const client = await pool.connect();
    try {
      await client.query('CALL sp_truncate_sp_permission_change_logs()');
      console.log(`[${SERVICE_NAME}] Truncated sharepoint_permission_change_logs.`);
    } finally {
      client.release();
    }

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'logs.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] sharepoint_permission_change_logs: ${records.length} records`);

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(r => [
        r.user_email,
        `site=${r.site}`,
        `change=${r.change_type}`,
        r.old_role ? `from=${r.old_role}` : '',
        r.new_role ? `to=${r.new_role}` : '',
        r.changed_by ? `by=${r.changed_by}` : '',
        r.notes || '',
      ].filter(Boolean).join(' '));
      const embeddings = await vectorizeBatch(texts);
      await upsertLogsBatch(batch, embeddings);
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] perm_change_logs ${stats.processed}/${records.length}`);
    }
    stats.created = stats.processed;

    console.log(`[${SERVICE_NAME}] perm_change_logs complete.`);
    await completeJob(jobId, stats);
  } catch (err) {
    await failJob(jobId, err);
    throw err;
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function run() {
  await runPrimary();
  await runLogs();
}

async function main() {
  console.log(`[${SERVICE_NAME}] Loading SBERT model (Xenova/all-MiniLM-L6-v2)...`);
  const { pipeline } = await import('@xenova/transformers');
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  await run();

  console.log(`[${SERVICE_NAME}] Scheduled: "${CRON_SCHEDULE}"`);
  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`[${SERVICE_NAME}] [cron] Triggered at ${new Date().toISOString()}`);
    run().catch(err => console.error(`[${SERVICE_NAME}] [cron] Run failed:`, err));
  });
}

main().catch(err => {
  console.error(`[${SERVICE_NAME}] Fatal error:`, err);
  process.exit(1);
});
