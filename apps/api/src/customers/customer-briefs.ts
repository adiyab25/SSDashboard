import type { CustomerBrief } from '@ssdashboard/contracts';
import { CUSTOMER_FLAG_SEVERITY } from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { pgArray, type Executor } from '../database/sql.js';

/** A timestamp as the api issues it: UTC with microseconds, so a keyset cursor never loses precision. */
export const MICRO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The flag kinds as a SQL array literal, most severe first (`CUSTOMER_FLAG_SEVERITY`). */
export const FLAG_SEVERITY_SQL = `{${CUSTOMER_FLAG_SEVERITY.join(',')}}`;

interface BriefRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  created_at: string;
  phone_count: number;
  primary_phone: string | null;
  risk_flag: CustomerBrief['flagKind'];
  risk_flag_source: CustomerBrief['flagSource'];
}

/**
 * Reads the brief of each given customer row exactly as stored: its own phones plus those of the
 * records merged into it, and its flag by the canonical rule (its own row's, else the most severe
 * on its ids). The caller resolves ids to canonical customers first when it wants her, not the row.
 * Unknown ids are left out; the order of the answer follows `ids`.
 */
export async function briefRows(
  executor: Executor,
  ids: readonly string[],
): Promise<CustomerBrief[]> {
  if (ids.length === 0) return [];
  const { rows } = await executor.execute<BriefRow>(sql`
    WITH canon AS (
      SELECT id, name, created_at FROM customers WHERE id = ANY(${pgArray(ids)}::uuid[])
    ), members AS (
      SELECT k.id AS canonical_id, m.id AS member_id
      FROM canon k JOIN customers m ON m.id = k.id OR m.merged_into_id = k.id
    )
    SELECT k.id, k.name,
           to_char(k.created_at AT TIME ZONE 'UTC', ${sql.raw(MICRO_UTC)}) AS created_at,
           (SELECT count(*) FROM members mm
              JOIN customer_phones p ON p.customer_id = mm.member_id
             WHERE mm.canonical_id = k.id)::int AS phone_count,
           (SELECT p.phone_e164 FROM members mm
              JOIN customer_phones p ON p.customer_id = mm.member_id
             WHERE mm.canonical_id = k.id
             ORDER BY (mm.member_id = k.id) DESC, p.is_primary DESC, p.first_seen_at, p.id
             LIMIT 1) AS primary_phone,
           flag.risk_flag, flag.risk_flag_source
    FROM canon k
    LEFT JOIN LATERAL (
      SELECT f.risk_flag, f.risk_flag_source
      FROM members mm JOIN customers f ON f.id = mm.member_id
      WHERE mm.canonical_id = k.id AND f.risk_flag IS NOT NULL
      ORDER BY (f.id = k.id) DESC,
               array_position(${FLAG_SEVERITY_SQL}::text[], f.risk_flag::text),
               f.risk_flag_set_at DESC, f.id
      LIMIT 1
    ) flag ON true`);
  const byId = new Map(
    rows.map((row): [string, CustomerBrief] => [
      row.id,
      {
        id: row.id,
        name: row.name,
        primaryPhone: row.primary_phone,
        phoneCount: row.phone_count,
        flagKind: row.risk_flag,
        flagSource: row.risk_flag_source,
        createdAt: row.created_at,
      },
    ]),
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}
