/**
 * D1 Database Schema Management
 */

import type { D1Database, BaserowField } from "./types";
import { sanitizeFieldName, baserowTypeToSQLite } from "./utils";

/**
 * Create the image_sync_records table if it doesn't exist
 */
export async function createImageSyncRecordsTable(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS image_sync_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_drive_file_id TEXT NOT NULL,
      google_drive_folder_id TEXT NOT NULL,
      r2_url TEXT,
      r2_key TEXT,
      table_id INTEGER NOT NULL,
      row_id INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      original_size INTEGER,
      optimized_size INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      processed_at TEXT,
      error_message TEXT,
      md5_hash TEXT,
      file_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_sync_google_drive_file_id 
    ON image_sync_records(google_drive_file_id)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_sync_google_drive_folder_id 
    ON image_sync_records(google_drive_folder_id)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_sync_r2_key 
    ON image_sync_records(r2_key)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_sync_table_row 
    ON image_sync_records(table_id, row_id)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_sync_status 
    ON image_sync_records(status)
  `);
}

/**
 * Create a D1 table based on Baserow table schema
 */
export async function createBaserowTable(
  db: D1Database,
  tableId: number,
  tableName: string,
  fields: BaserowField[]
): Promise<void> {
  // Sanitize table name
  const sanitizedTableName = sanitizeFieldName(`table_${tableId}_${tableName}`);

  // Build column definitions
  const columns: string[] = [
    "id INTEGER PRIMARY KEY", // Baserow row ID
    "order TEXT", // Baserow order field
  ];

  // Add columns for each field
  for (const field of fields) {
    const columnName = sanitizeFieldName(field.name);
    const sqlType = baserowTypeToSQLite(field.type);
    columns.push(`${columnName} ${sqlType}`);
  }

  // Add metadata columns
  columns.push("created_at TEXT DEFAULT (datetime('now'))");
  columns.push("updated_at TEXT DEFAULT (datetime('now'))");

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${sanitizedTableName} (
      ${columns.join(",\n      ")}
    )
  `;

  await db.exec(createTableSQL);

  // Create index on id
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${sanitizedTableName}_id 
    ON ${sanitizedTableName}(id)
  `);
}

/**
 * Check if a table exists
 */
export async function tableExists(db: D1Database, tableName: string): Promise<boolean> {
  const result = await db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name=?
  `).bind(tableName).first<{ name: string }>();

  return !!result;
}

/**
 * Get all column names for a table
 */
export async function getTableColumns(db: D1Database, tableName: string): Promise<string[]> {
  const result = await db.prepare(`PRAGMA table_info(${tableName})`).all<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: any;
    pk: number;
  }>();

  return result.results?.map((col) => col.name) || [];
}

/**
 * Add missing columns to an existing table
 */
export async function addMissingColumns(
  db: D1Database,
  tableName: string,
  fields: BaserowField[]
): Promise<void> {
  const existingColumns = await getTableColumns(db, tableName);
  const existingColumnSet = new Set(existingColumns);

  for (const field of fields) {
    const columnName = sanitizeFieldName(field.name);
    if (!existingColumnSet.has(columnName)) {
      const sqlType = baserowTypeToSQLite(field.type);
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}`);
    }
  }
}

/**
 * Get the sanitized table name for a Baserow table
 */
export function getTableName(tableId: number, tableName: string): string {
  return sanitizeFieldName(`table_${tableId}_${tableName}`);
}

/**
 * Initialize database schema (create image_sync_records table)
 */
export async function initializeSchema(db: D1Database): Promise<void> {
  await createImageSyncRecordsTable(db);
}

