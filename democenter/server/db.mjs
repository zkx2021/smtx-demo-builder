import pg from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL 未配置');
  return new pg.Pool({ connectionString });
}

export async function initializeDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS environments (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      purpose text NOT NULL DEFAULT '',
      url text NOT NULL DEFAULT '',
      external_status text NOT NULL DEFAULT 'internal' CHECK (external_status IN ('public', 'internal')),
      usage_status text NOT NULL DEFAULT 'open' CONSTRAINT environments_usage_status_check
        CHECK (usage_status IN ('open', 'requestable', 'maintenance', 'occupied')),
      release_at timestamptz,
      note text NOT NULL DEFAULT '',
      accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demo_folders (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS demo_folders_name_unique ON demo_folders (lower(name));
    CREATE TABLE IF NOT EXISTS demos (
      id uuid PRIMARY KEY,
      source_demo_id text NOT NULL,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      product_version text NOT NULL DEFAULT '',
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      uploader text NOT NULL DEFAULT '',
      folder_id uuid REFERENCES demo_folders(id) ON DELETE SET NULL,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      format_version integer NOT NULL,
      package_format_version integer NOT NULL,
      step_count integer NOT NULL,
      asset_status text NOT NULL CHECK (asset_status IN ('complete', 'partial', 'legacy', 'no-candidates')),
      resource_issue_count integer NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS demos_folder_id_idx ON demos(folder_id);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'environments'::regclass
          AND conname = 'environments_usage_status_check'
          AND pg_get_constraintdef(oid) LIKE '%requestable%'
      ) THEN
        ALTER TABLE environments DROP CONSTRAINT IF EXISTS environments_usage_status_check;
        ALTER TABLE environments ADD CONSTRAINT environments_usage_status_check
          CHECK (usage_status IN ('open', 'requestable', 'maintenance', 'occupied'));
      END IF;
    END $$;
  `);
}
