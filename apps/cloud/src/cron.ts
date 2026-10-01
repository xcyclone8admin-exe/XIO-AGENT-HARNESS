import { withNeonTransaction } from './neon';

const WINDOW_MS = 15 * 60 * 1000;

export async function runScheduledMaintenance(
  connectionString: string,
  scheduledTime: number,
): Promise<{ duplicate: boolean; deletedReplayRows: number }> {
  const windowStart = Math.floor(scheduledTime / WINDOW_MS) * WINDOW_MS;
  return withNeonTransaction(connectionString, {}, async (client) => {
    const started = await client.query(
      `INSERT INTO cloud_cron_runs(job_name,window_start)
       VALUES ('dpop-replay-cleanup',to_timestamp($1 / 1000.0))
       ON CONFLICT DO NOTHING RETURNING 1`,
      [windowStart],
    );
    if (!started.rows.length) return { duplicate: true, deletedReplayRows: 0 };
    try {
      const deleted = await client.query(
        'DELETE FROM cloud_dpop_replays WHERE expires_at < now() RETURNING 1',
      );
      await client.query(
        `UPDATE cloud_cron_runs SET finished_at=now(),outcome='succeeded'
          WHERE job_name='dpop-replay-cleanup' AND window_start=to_timestamp($1 / 1000.0)`,
        [windowStart],
      );
      return { duplicate: false, deletedReplayRows: deleted.rows.length };
    } catch (failure) {
      await client.query(
        `UPDATE cloud_cron_runs SET finished_at=now(),outcome='failed'
          WHERE job_name='dpop-replay-cleanup' AND window_start=to_timestamp($1 / 1000.0)`,
        [windowStart],
      );
      throw failure;
    }
  });
}
