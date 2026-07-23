'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');

const SERVICE_NAME = 'etl-claims-line';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '64', 10);
const HIDDEN_SIZE = 384;
let extractor = null;

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'appdb',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

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

async function logChange(client, sourceTable, email, changeType, fieldName, oldValue, newValue, jobId) {
  await client.query(
    'CALL sp_etl_log_change($1, $2, $3, $4, $5, $6, $7)',
    [sourceTable, email, changeType, fieldName, oldValue, newValue, jobId],
  );
}

const PRIMARY_COMPARE_FIELDS = [
  'member_id',
  'member_email',
  'claim_type',
  'service_date',
  'provider',
  'amount_billed',
  'amount_paid',
  'plan_year',
  'status',
];

function normaliseValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function claimText(record) {
  return [
    record.claimType,
    record.provider,
    record.status,
  ].filter(Boolean).join(' ');
}

function logText(record) {
  return [
    record.eventType,
    record.claimId,
    record.notes || '',
  ].filter(Boolean).join(' ');
}

async function vectorizeBatch(texts) {
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const embeddings = [];
  for (let batchIndex = 0; batchIndex < texts.length; batchIndex++) {
    const start = batchIndex * HIDDEN_SIZE;
    embeddings.push(Array.from(output.data.slice(start, start + HIDDEN_SIZE)));
  }
  return embeddings;
}

async function upsertPrimaryBatch(records, embeddings, existingByClaimId, jobId) {
  const client = await pool.connect();
  const stats = { created: 0, updated: 0 };
  try {
    await client.query('BEGIN');
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const embedding = `[${embeddings[index].join(',')}]`;
      const existing = existingByClaimId.get(record.claimId);

      await client.query(
        'CALL sp_upsert_claim($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [
          record.memberId,
          record.memberEmail,
          record.claimId,
          record.claimType,
          record.serviceDate,
          record.provider,
          record.amountBilled,
          record.amountPaid,
          record.planYear,
          record.status,
          embedding,
        ],
      );

      if (!existing) {
        await logChange(client, 'claims', record.memberEmail, 'created', null, null, null, jobId);
        stats.created++;
      } else {
        const incomingMap = {
          member_id: record.memberId,
          member_email: record.memberEmail,
          claim_type: record.claimType,
          service_date: record.serviceDate,
          provider: record.provider,
          amount_billed: record.amountBilled,
          amount_paid: record.amountPaid,
          plan_year: record.planYear,
          status: record.status,
        };
        let changed = false;
        for (const field of PRIMARY_COMPARE_FIELDS) {
          const oldValue = normaliseValue(existing[field]);
          const newValue = normaliseValue(incomingMap[field]);
          if (oldValue !== newValue) {
            await logChange(client, 'claims', record.memberEmail, 'updated', field, oldValue, newValue, jobId);
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
  const jobId = await startJob('primary', 'claims');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM sp_get_existing_claims()');
    const existingByClaimId = new Map(existingRows.map(row => [row.claim_id, row]));
    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'primary.json'), 'utf8'));
    const incomingClaimIds = new Set(records.map(record => record.claimId));

    console.log(`[${SERVICE_NAME}] claims: ${records.length} records`);

    for (let index = 0; index < records.length; index += BATCH_SIZE) {
      const batch = records.slice(index, index + BATCH_SIZE);
      const embeddings = await vectorizeBatch(batch.map(claimText));
      const batchStats = await upsertPrimaryBatch(batch, embeddings, existingByClaimId, jobId);
      stats.created += batchStats.created;
      stats.updated += batchStats.updated;
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] claims ${stats.processed}/${records.length}`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [claimId, existing] of existingByClaimId) {
        if (!incomingClaimIds.has(claimId)) {
          await logChange(client, 'claims', existing.member_email, 'deleted', null, null, null, jobId);
          await client.query('CALL sp_delete_claim($1)', [claimId]);
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

    console.log(`[${SERVICE_NAME}] claims complete. created=${stats.created} updated=${stats.updated} deleted=${stats.deleted}`);
    await completeJob(jobId, stats);
  } catch (err) {
    await failJob(jobId, err);
    throw err;
  }
}

async function upsertLogsBatch(records, embeddings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const embedding = `[${embeddings[index].join(',')}]`;
      await client.query(
        'CALL sp_insert_claim_log($1, $2, $3, $4, $5, $6, $7)',
        [
          record.logTimestamp,
          record.memberId,
          record.memberEmail,
          record.claimId,
          record.eventType,
          record.notes || null,
          embedding,
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
  const jobId = await startJob('logs', 'claims_logs');
  const stats = { processed: 0, created: 0, updated: 0, deleted: 0 };

  try {
    await pool.query('CALL sp_truncate_claims_logs()');
    console.log(`[${SERVICE_NAME}] Truncated claims_logs.`);

    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'logs.json'), 'utf8'));
    console.log(`[${SERVICE_NAME}] claims_logs: ${records.length} records`);

    for (let index = 0; index < records.length; index += BATCH_SIZE) {
      const batch = records.slice(index, index + BATCH_SIZE);
      const embeddings = await vectorizeBatch(batch.map(logText));
      await upsertLogsBatch(batch, embeddings);
      stats.processed += batch.length;
      console.log(`[${SERVICE_NAME}] claims_logs ${stats.processed}/${records.length}`);
    }

    stats.created = stats.processed;
    console.log(`[${SERVICE_NAME}] claims_logs complete.`);
    await completeJob(jobId, stats);
  } catch (err) {
    await failJob(jobId, err);
    throw err;
  }
}

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
