'use strict';

/**
 * vectorize.js — etl-m365-line
 *
 * Single container that vectorizes both:
 *   - m365_group_memberships       (data/primary.json)
 *   - m365_membership_change_logs  (data/logs.json)
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

const SERVICE_NAME  = 'etl-m365-line';
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

// Compare these fields for change detection (group_email is the natural key)
const PRIMARY_COMPARE_FIELDS = ['group_type', 'users'];

function normaliseValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
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

// ── Pipeline 1: m365_group_memberships (with change detection) ────────────────

async function upsertPrimaryBatch(records, embeddings, existingByEmail, jobId) {
  const client = await pool.connect();
  const stats = { created: 0, updated: 0 };
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      const existing = existingByEmail.get(r.group_email);

      await client.query(
        'CALL sp_upsert_m365_group($1, $2, $3, $4, $5)',
        [r.group, r.group_email, r.group_type, JSON.stringify(r.users || []), emb],
      );

      // Change detection (keyed by group_email, stored in source_change_logs as email)
      if (!existing) {
        await logChange(client, 'm365_group_memberships', r.group_email, 'created', null, null, null, jobId);
        stats.created++;
      } else {
        const incomingMap = {
          group_type: r.group_type,
          users:      r.users || [],
        };
        let changed = false;
        for (const field of PRIMARY_COMPARE_FIELDS) {
          const oldVal = normaliseValue(existing[field]);
          const newVal = normaliseValue(incomingMap[field]);
          if (oldVal !== newVal) {
            await logChange(client, 'm365_group_memberships', r.group_email, 'updated', field, oldVal, newVal, jobId);
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
  const jobId = await startJob('primary', 'm365_group_memberships');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    // Load existing records for change detection
    const { rows: existingRows } = await pool.query(
      'SELECT * FROM sp_get_existing_m365_groups()',
    );
    const existingByEmail = new Map(existingRows.map(r => [r.group_email, r]));

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'primary.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] m365_group_memberships: ${records.length} records`);

    const incomingEmails = new Set(records.map(r => r.group_email));

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(r => {
        const users = r.users || [];
        const owners  = users.filter(u => u.role === 'owner').slice(0, 5).map(u => u.email).join(', ');
        const members = users.filter(u => u.role === 'member').slice(0, 10).map(u => u.email).join(', ');
        return [
          r.group,
          `type=${r.group_type}`,
          r.group_email,
          `totalMembers=${users.length}`,
          owners  ? `owners: ${owners}`   : '',
          members ? `members: ${members}` : '',
        ].filter(Boolean).join(' ');
      });
      const embeddings = await vectorizeBatch(texts);
      const batchStats = await upsertPrimaryBatch(batch, embeddings, existingByEmail, jobId);
      stats.created += batchStats.created;
      stats.updated += batchStats.updated;
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] m365_group_memberships ${stats.processed}/${records.length}`);
    }

    // Detect deletions: existing group_emails not in incoming set
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [groupEmail] of existingByEmail) {
        if (!incomingEmails.has(groupEmail)) {
          await logChange(client, 'm365_group_memberships', groupEmail, 'deleted', null, null, null, jobId);
          await client.query('CALL sp_delete_m365_group($1)', [groupEmail]);
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

    console.log(`[${SERVICE_NAME}] m365_group_memberships complete. created=${stats.created} updated=${stats.updated} deleted=${stats.deleted}`);
    await completeJob(jobId, stats);
  } catch (err) {
    await failJob(jobId, err);
    throw err;
  }
}

// ── Pipeline 2: m365_membership_change_logs ───────────────────────────────────

async function upsertLogsBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        'CALL sp_insert_m365_membership_change_log($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          r.timestamp, r.group_name, r.user_email,
          r.change_action, r.role || null,
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
  const jobId = await startJob('logs', 'm365_membership_change_logs');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    // Truncate logs table (append-only from source file each run)
    const client = await pool.connect();
    try {
      await client.query('CALL sp_truncate_m365_membership_change_logs()');
      console.log(`[${SERVICE_NAME}] Truncated m365_membership_change_logs.`);
    } finally {
      client.release();
    }

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'logs.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] m365_membership_change_logs: ${records.length} records`);

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(r =>
        [
          r.group_name,
          r.user_email,
          `action=${r.change_action}`,
          r.role ? `role=${r.role}` : '',
          r.changed_by ? `by=${r.changed_by}` : '',
          r.notes || '',
        ].filter(Boolean).join(' '),
      );
      const embeddings = await vectorizeBatch(texts);
      await upsertLogsBatch(batch, embeddings);
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] membership_change_logs ${stats.processed}/${records.length}`);
    }
    stats.created = stats.processed;

    console.log(`[${SERVICE_NAME}] membership_change_logs complete.`);
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
