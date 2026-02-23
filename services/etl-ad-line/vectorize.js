'use strict';

/**
 * vectorize.js — etl-ad-line
 *
 * Single container that vectorizes both:
 *   - active_directory      (data/primary.json)
 *   - active_directory_activity_logs (data/logs.json)
 *
 * The SBERT model and pg.Pool are shared across both pipelines,
 * reducing memory footprint vs. running two separate containers.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function truncate(table) {
  const client = await pool.connect();
  try {
    await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY`);
    console.log(`[etl-ad-line] Truncated ${table}.`);
  } finally {
    client.release();
  }
}

async function vectorizeBatch(texts) {
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const embeddings = [];
  for (let b = 0; b < texts.length; b++) {
    const start = b * HIDDEN_SIZE;
    embeddings.push(Array.from(output.data.slice(start, start + HIDDEN_SIZE)));
  }
  return embeddings;
}

// ── Pipeline 1: active_directory ─────────────────────────────────────────────

async function upsertPrimaryBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO active_directory
           (first_name, last_name, email, type, enabled, locked, passwordlastreset, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
         ON CONFLICT (email) DO UPDATE SET
           first_name        = EXCLUDED.first_name,
           last_name         = EXCLUDED.last_name,
           type              = EXCLUDED.type,
           enabled           = EXCLUDED.enabled,
           locked            = EXCLUDED.locked,
           passwordlastreset = EXCLUDED.passwordlastreset,
           embedding         = EXCLUDED.embedding`,
        [
          r.first_name, r.last_name, r.email, r.type || 'user',
          r.enabled !== undefined ? r.enabled : true,
          r.locked  !== undefined ? r.locked  : false,
          r.passwordlastreset || null,
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

async function runPrimary() {
  await truncate('active_directory');
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'primary.json'), 'utf8'));
  console.log(`[etl-ad-line] active_directory: ${records.length} records`);

  let processed = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r => `${r.first_name} ${r.last_name} ${r.email}`);
    const embeddings = await vectorizeBatch(texts);
    await upsertPrimaryBatch(batch, embeddings);
    processed += batch.length;
    console.log(`[etl-ad-line] active_directory ${processed}/${records.length}`);
  }
  console.log('[etl-ad-line] active_directory complete.');
}

// ── Pipeline 2: active_directory_activity_logs ────────────────────────────────

async function upsertLogsBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO active_directory_activity_logs
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
  await truncate('active_directory_activity_logs');
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'logs.json'), 'utf8'));
  console.log(`[etl-ad-line] active_directory_activity_logs: ${records.length} records`);

  let processed = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r =>
      [`${r.first_name} ${r.last_name}`, r.email, r.changed_by || '', r.notes || ''].join(' '),
    );
    const embeddings = await vectorizeBatch(texts);
    await upsertLogsBatch(batch, embeddings);
    processed += batch.length;
    console.log(`[etl-ad-line] activity_logs ${processed}/${records.length}`);
  }
  console.log('[etl-ad-line] activity_logs complete.');
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function run() {
  await runPrimary();
  await runLogs();
}

async function main() {
  console.log('[etl-ad-line] Loading SBERT model (Xenova/all-MiniLM-L6-v2)...');
  const { pipeline } = await import('@xenova/transformers');
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  await run();

  console.log(`[etl-ad-line] Scheduled: "${CRON_SCHEDULE}"`);
  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`[etl-ad-line] [cron] Triggered at ${new Date().toISOString()}`);
    run().catch(err => console.error('[etl-ad-line] [cron] Run failed:', err));
  });
}

main().catch(err => {
  console.error('[etl-ad-line] Fatal error:', err);
  process.exit(1);
});
