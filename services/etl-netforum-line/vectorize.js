'use strict';

/**
 * vectorize.js — etl-netforum-line
 *
 * Single container that vectorizes both:
 *   - netforum_members          (data/primary.json)
 *   - netforum_activity_logs    (data/logs.json)
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

const SERVICE_NAME  = 'etl-netforum-line';
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

// ── Job Logging Helpers ───────────────────────────────────────────────────────

async function startJob(phase, targetTable) {
  const { rows } = await pool.query(
    `INSERT INTO etl_job_logs (service, phase, target_table, status, started_at)
     VALUES ($1, $2, $3, 'running', now()) RETURNING id`,
    [SERVICE_NAME, phase, targetTable],
  );
  return rows[0].id;
}

async function completeJob(jobId, stats) {
  await pool.query(
    `UPDATE etl_job_logs
     SET status = 'completed', records_processed = $2, records_created = $3,
         records_updated = $4, records_deleted = $5, finished_at = now()
     WHERE id = $1`,
    [jobId, stats.processed, stats.created, stats.updated, stats.deleted],
  );
}

async function failJob(jobId, error) {
  await pool.query(
    `UPDATE etl_job_logs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1`,
    [jobId, String(error)],
  );
}

// ── Change Detection Helpers ──────────────────────────────────────────────────

async function logChange(client, sourceTable, email, changeType, fieldName, oldValue, newValue, jobId) {
  await client.query(
    `INSERT INTO source_change_logs
       (source_table, email, change_type, field_name, old_value, new_value, etl_job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sourceTable, email, changeType, fieldName, oldValue, newValue, jobId],
  );
}

const PRIMARY_COMPARE_FIELDS = ['first_name', 'last_name', 'type', 'enabled', 'last_login'];

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

// ── Pipeline 1: netforum_members (with change detection) ─────────────────────

async function upsertPrimaryBatch(records, embeddings, existingByEmail, jobId) {
  const client = await pool.connect();
  const stats = { created: 0, updated: 0 };
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      const existing = existingByEmail.get(r.email);

      await client.query(
        `INSERT INTO netforum_members
           (first_name, last_name, email, type, enabled, last_login, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
         ON CONFLICT (email) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           last_name  = EXCLUDED.last_name,
           type       = EXCLUDED.type,
           enabled    = EXCLUDED.enabled,
           last_login = EXCLUDED.last_login,
           embedding  = EXCLUDED.embedding`,
        [
          r.first_name, r.last_name, r.email, r.type || 'member',
          r.enabled !== undefined ? r.enabled : true,
          r.lastLogin || null,
          emb,
        ],
      );

      // Change detection
      if (!existing) {
        await logChange(client, 'netforum_members', r.email, 'created', null, null, null, jobId);
        stats.created++;
      } else {
        const incomingMap = {
          first_name: r.first_name,
          last_name: r.last_name,
          type: r.type || 'member',
          enabled: String(r.enabled !== undefined ? r.enabled : true),
          last_login: r.lastLogin || null,
        };
        let changed = false;
        for (const field of PRIMARY_COMPARE_FIELDS) {
          const oldVal = normaliseValue(existing[field]);
          const newVal = normaliseValue(incomingMap[field]);
          if (oldVal !== newVal) {
            await logChange(client, 'netforum_members', r.email, 'updated', field, oldVal, newVal, jobId);
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
  const jobId = await startJob('primary', 'netforum_members');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    // Load existing records for change detection
    const { rows: existingRows } = await pool.query(
      'SELECT email, first_name, last_name, type, enabled, last_login FROM netforum_members',
    );
    const existingByEmail = new Map(existingRows.map(r => [r.email, r]));

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'primary.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] netforum_members: ${records.length} records`);

    const incomingEmails = new Set(records.map(r => r.email));

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(r => `${r.first_name} ${r.last_name} ${r.email}`);
      const embeddings = await vectorizeBatch(texts);
      const batchStats = await upsertPrimaryBatch(batch, embeddings, existingByEmail, jobId);
      stats.created += batchStats.created;
      stats.updated += batchStats.updated;
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] netforum_members ${stats.processed}/${records.length}`);
    }

    // Detect deletions: existing emails not in incoming set
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [email] of existingByEmail) {
        if (!incomingEmails.has(email)) {
          await logChange(client, 'netforum_members', email, 'deleted', null, null, null, jobId);
          await client.query('DELETE FROM netforum_members WHERE email = $1', [email]);
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

    console.log(`[${SERVICE_NAME}] netforum_members complete. created=${stats.created} updated=${stats.updated} deleted=${stats.deleted}`);
    await completeJob(jobId, stats);
  } catch (err) {
    await failJob(jobId, err);
    throw err;
  }
}

// ── Pipeline 2: netforum_activity_logs ───────────────────────────────────────

async function upsertLogsBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO netforum_activity_logs
           (log_timestamp, first_name, last_name, email, changed_by, notes, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [r.timestamp, r.first_name, r.last_name, r.email, r.changed_by || null, r.notes || null, emb],
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
  const jobId = await startJob('logs', 'netforum_activity_logs');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    // Truncate logs table (append-only from source file each run)
    const client = await pool.connect();
    try {
      await client.query('TRUNCATE TABLE netforum_activity_logs RESTART IDENTITY');
      console.log(`[${SERVICE_NAME}] Truncated netforum_activity_logs.`);
    } finally {
      client.release();
    }

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'logs.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] netforum_activity_logs: ${records.length} records`);

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(r =>
        [`${r.first_name} ${r.last_name}`, r.email, r.changed_by || '', r.notes || ''].join(' '),
      );
      const embeddings = await vectorizeBatch(texts);
      await upsertLogsBatch(batch, embeddings);
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] activity_logs ${stats.processed}/${records.length}`);
    }
    stats.created = stats.processed;

    console.log(`[${SERVICE_NAME}] activity_logs complete.`);
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
