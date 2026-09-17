import type { PoolClient } from "pg";
import { getIoDatabase } from "../src/lib/io/db";
import { closeIoPgPool, withIoPgTransaction } from "../src/lib/io/pg-db";
import { runIoPgMigrations } from "../src/lib/io/pg-migrations";

type Row = Record<string, unknown>;

const apply = process.argv.includes("--apply");

function rows(table: string): Row[] {
  return getIoDatabase().prepare(`SELECT * FROM ${table}`).all() as Row[];
}

function json(value: unknown): unknown | null {
  if (value == null || value === "") return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function boolean(value: unknown): boolean {
  return Number(value) === 1 || value === true;
}

async function importAccounts(client: PoolClient, values: Row[]) {
  for (const row of values) {
    await client.query(
      `INSERT INTO accounts (
        account_id, username, display_name, avatar_url, cover_url, description,
        created_at, protected, followers_count, following_count, statuses_count, fetched_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (account_id) DO UPDATE SET
        username = EXCLUDED.username,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        cover_url = EXCLUDED.cover_url,
        description = EXCLUDED.description,
        created_at = EXCLUDED.created_at,
        protected = EXCLUDED.protected,
        followers_count = EXCLUDED.followers_count,
        following_count = EXCLUDED.following_count,
        statuses_count = EXCLUDED.statuses_count,
        fetched_at = EXCLUDED.fetched_at`,
      [
        row.account_id, row.username, row.display_name, row.avatar_url, row.cover_url,
        row.description, row.created_at, boolean(row.protected), row.followers_count,
        row.following_count, row.statuses_count, row.fetched_at,
      ],
    );
  }
}

async function importRuns(client: PoolClient, values: Row[]) {
  for (const row of values) {
    await client.query(
      `INSERT INTO acquisition_runs (
        id, account_id, username, provider, collection_mode, target_count, status,
        progress_message, request_count, page_count, unique_count, candidate_count,
        duplicate_count, output_path, error_message, created_at, started_at, finished_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        status = EXCLUDED.status,
        progress_message = EXCLUDED.progress_message,
        request_count = EXCLUDED.request_count,
        page_count = EXCLUDED.page_count,
        unique_count = EXCLUDED.unique_count,
        candidate_count = EXCLUDED.candidate_count,
        duplicate_count = EXCLUDED.duplicate_count,
        output_path = EXCLUDED.output_path,
        error_message = EXCLUDED.error_message,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at`,
      [
        row.id, row.account_id, row.username, row.provider, row.collection_mode,
        row.target_count, row.status, row.progress_message, row.request_count,
        row.page_count, row.unique_count, row.candidate_count, row.duplicate_count,
        row.output_path, row.error_message, row.created_at, row.started_at, row.finished_at,
      ],
    );
  }
}

async function importPosts(client: PoolClient, values: Row[]) {
  for (const row of values) {
    await client.query(
      `INSERT INTO posts (
        post_id, account_id, author_username, created_at, full_text, url, language,
        media_json, mentions_json, like_count, retweet_count, reply_count, quote_count,
        view_count, conversation_id, in_reply_to_post_id, in_reply_to_user_id,
        in_reply_to_username, provider, source_run_id, coverage_state,
        candidate_sightings, fetched_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      ) ON CONFLICT (post_id) DO UPDATE SET
        coverage_state = CASE
          WHEN posts.coverage_state = 'covered' OR EXCLUDED.coverage_state = 'covered'
          THEN 'covered' ELSE 'candidate' END,
        candidate_sightings = GREATEST(posts.candidate_sightings, EXCLUDED.candidate_sightings),
        fetched_at = EXCLUDED.fetched_at`,
      [
        row.post_id, row.account_id, row.author_username, row.created_at, row.full_text,
        row.url, row.language, json(row.media_json), json(row.mentions_json), row.like_count,
        row.retweet_count, row.reply_count, row.quote_count, row.view_count,
        row.conversation_id, row.in_reply_to_post_id, row.in_reply_to_user_id,
        row.in_reply_to_username, row.provider, row.source_run_id, row.coverage_state,
        row.candidate_sightings, row.fetched_at,
      ],
    );
  }
}

async function importCoverage(client: PoolClient, values: Row[], providers: Map<string, string>) {
  for (const row of values) {
    const provider = providers.get(String(row.run_id));
    if (!provider) throw new Error(`Coverage run ${String(row.run_id)} has no provider`);
    await client.query(
      `INSERT INTO coverage_windows (
        run_id, account_id, provider, start_at, end_at, status, resolution_basis,
        termination_reason, request_count, page_count, unique_count, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (run_id, start_at, end_at) DO UPDATE SET
        status = EXCLUDED.status,
        resolution_basis = EXCLUDED.resolution_basis,
        termination_reason = EXCLUDED.termination_reason,
        request_count = EXCLUDED.request_count,
        page_count = EXCLUDED.page_count,
        unique_count = EXCLUDED.unique_count`,
      [
        row.run_id, row.account_id, provider, row.start_at, row.end_at, row.status,
        row.resolution_basis, row.termination_reason, row.request_count, row.page_count,
        row.unique_count, row.created_at,
      ],
    );
  }
}

async function main() {
  const accounts = rows("accounts");
  const runs = rows("acquisition_runs");
  const posts = rows("posts");
  const coverage = rows("coverage_windows");
  console.log(
    `SQLite inventory: accounts=${accounts.length} runs=${runs.length} posts=${posts.length} coverage=${coverage.length}`,
  );
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write to STELA_IO_DATABASE_URL.");
    return;
  }

  try {
    await runIoPgMigrations();
    const providers = new Map(runs.map((row) => [String(row.id), String(row.provider)]));
    await withIoPgTransaction(async (client) => {
      await importAccounts(client, accounts);
      await importRuns(client, runs);
      await importPosts(client, posts);
      await importCoverage(client, coverage, providers);
    });
    console.log("SQLite import completed.");
  } finally {
    await closeIoPgPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
