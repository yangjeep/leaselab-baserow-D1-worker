/**
 * Utility functions for Baserow to D1 sync worker
 */

/**
 * Extract folder ID from Google Drive URL
 * Reused from existing worker code
 */
export function extractDriveFolderId(url: string): string | null {
  if (!url) return null;

  // Match: https://drive.google.com/drive/folders/FOLDER_ID
  const match = url.match(/\/folders\/([A-Za-z0-9_\-]+)/);
  if (match) return match[1];

  // If it's already just an ID
  if (/^[A-Za-z0-9_\-]{10,}$/.test(url)) return url;

  return null;
}

/**
 * Slugify a string (simple version)
 * Reused from existing worker code
 */
export function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Sanitize field name for use as SQL column name
 */
export function sanitizeFieldName(fieldName: string): string {
  // Replace spaces and special characters with underscores
  // Keep only alphanumeric and underscores
  return fieldName
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&") // Column names can't start with numbers
    .toLowerCase();
}

/**
 * Convert Baserow field type to SQLite type
 */
export function baserowTypeToSQLite(baserowType: string): string {
  const typeMap: Record<string, string> = {
    text: "TEXT",
    long_text: "TEXT",
    number: "REAL",
    rating: "INTEGER",
    boolean: "INTEGER", // SQLite uses INTEGER for booleans (0/1)
    date: "TEXT", // ISO date string
    last_modified: "TEXT",
    created_on: "TEXT",
    url: "TEXT",
    email: "TEXT",
    phone_number: "TEXT",
    link_row: "TEXT", // JSON array of IDs
    file: "TEXT", // JSON array of file objects
    single_select: "TEXT",
    multiple_select: "TEXT", // JSON array
    formula: "TEXT", // Result depends on formula
    lookup: "TEXT", // Result depends on lookup
    uuid: "TEXT",
    autonumber: "INTEGER",
    count: "INTEGER",
    rollup: "TEXT", // Result depends on rollup
  };

  return typeMap[baserowType] || "TEXT";
}

/**
 * Helper to create JSON response
 * Reused from existing worker code
 */
export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Get environment variable as number with default
 */
export function getEnvNumber(env: Record<string, any>, key: string, defaultValue: number): number {
  const value = env[key];
  if (value === undefined || value === null) return defaultValue;
  const parsed = parseInt(String(value), 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get environment variable as string with default
 */
export function getEnvString(env: Record<string, any>, key: string, defaultValue: string): string {
  const value = env[key];
  return value ? String(value) : defaultValue;
}

