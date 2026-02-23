'use strict';

/**
 * vectorize.js — etl-dg-line
 *
 * Single container that vectorizes both:
 *   - distribution_groups         (data/primary.json)
 *   - distribution_group_sync_logs (data/logs.json)
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
    console.log(`[etl-dg-line] Truncated ${table}.`);
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

// ── Pipeline 1: distribution_groups ──────────────────────────────────────────

async function upsertPrimaryBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO distribution_groups (name, alias, email, contacts, embedding)
         VALUES ($1, $2, $3, $4::jsonb, $5::vector)
         ON CONFLICT (email) DO UPDATE SET
           name      = EXCLUDED.name,
           alias     = EXCLUDED.alias,
           contacts  = EXCLUDED.contacts,
           embedding = EXCLUDED.embedding`,
        [r.name, r.alias, r.email, JSON.stringify(r.contacts || []), emb],
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
  await truncate('distribution_groups');
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'primary.json'), 'utf8'));
  console.log(`[etl-dg-line] distribution_groups: ${records.length} records`);

  let processed = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r =>
      [r.name, r.alias, r.email, ...(r.contacts || []).map(c => `${c.first_name} ${c.last_name} ${c.email}`)].join(' '),
    );
    const embeddings = await vectorizeBatch(texts);
    await upsertPrimaryBatch(batch, embeddings);
    processed += batch.length;
    console.log(`[etl-dg-line] distribution_groups ${processed}/${records.length}`);
  }
  console.log('[etl-dg-line] distribution_groups complete.');
}

// ── Pipeline 2: distribution_group_sync_logs ──────────────────────────────────

async function upsertLogsBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i++) {
      const r   = records[i];
      const emb = `[${embeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO distribution_group_sync_logs
           (sync_timestamp, group_name, accounts_added, accounts_removed, notes, embedding)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::vector)`,
        [
          r.sync_timestamp,
          r.group_name,
          JSON.stringify(r.accounts_added || []),
          JSON.stringify(r.accounts_removed || []),
          r.notes || null,
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
  await truncate('distribution_group_sync_logs');
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'logs.json'), 'utf8'));
  console.log(`[etl-dg-line] distribution_group_sync_logs: ${records.length} records`);

  let processed = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r => {
      const added   = (r.accounts_added   || []).map(a => `${a.first_name} ${a.last_name}`).join(' ');
      const removed = (r.accounts_removed || []).map(a => `${a.first_name} ${a.last_name}`).join(' ');
      return [r.group_name, added, removed, r.notes || ''].join(' ');
    });
    const embeddings = await vectorizeBatch(texts);
    await upsertLogsBatch(batch, embeddings);
    processed += batch.length;
    console.log(`[etl-dg-line] sync_logs ${processed}/${records.length}`);
  }
  console.log('[etl-dg-line] sync_logs complete.');
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function run() {
  await runPrimary();
  await runLogs();
}

async function main() {
  console.log('[etl-dg-line] Loading SBERT model (Xenova/all-MiniLM-L6-v2)...');
  const { pipeline } = await import('@xenova/transformers');
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  await run();

  console.log(`[etl-dg-line] Scheduled: "${CRON_SCHEDULE}"`);
  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`[etl-dg-line] [cron] Triggered at ${new Date().toISOString()}`);
    run().catch(err => console.error('[etl-dg-line] [cron] Run failed:', err));
  });
}

main().catch(err => {
  console.error('[etl-dg-line] Fatal error:', err);
  process.exit(1);
});
