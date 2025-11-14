/**
 * Baserow API client
 */

import type { BaserowTable, BaserowField, BaserowRow, Env } from "./types";

const BASEROW_API_BASE = "https://api.baserow.io/api";

/**
 * Get Baserow API base URL (supports self-hosted instances)
 */
function getBaserowApiBase(env: Env): string {
  // If BASEROW_API_URL is set, use it (for self-hosted)
  // Otherwise use the default cloud API
  return (env as any).BASEROW_API_URL || BASEROW_API_BASE;
}

/**
 * Make authenticated request to Baserow API
 */
async function baserowRequest<T>(
  env: Env,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  if (!env.BASEROW_API_TOKEN) {
    throw new Error("BASEROW_API_TOKEN not configured");
  }

  const apiBase = getBaserowApiBase(env);
  const url = `${apiBase}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  console.log("Baserow API request:", {
    url,
    hasToken: !!env.BASEROW_API_TOKEN,
    tokenLength: env.BASEROW_API_TOKEN?.length,
    tokenPrefix: env.BASEROW_API_TOKEN?.substring(0, 10) + "...",
  });

  // Always use Token format for Database Token
  const authHeader = `Token ${env.BASEROW_API_TOKEN}`;
  console.log("Using auth format: Token (Database Token)");

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Baserow API error: ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage += ` - ${errorJson.error || errorJson.detail || errorText}`;
    } catch {
      errorMessage += ` - ${errorText}`;
    }
    throw new Error(errorMessage);
  }

  return await response.json() as T;
}

/**
 * Fetch all tables in a database
 * If Backend API is not available, return empty array (tables will be discovered via webhooks)
 */
export async function fetchTables(env: Env, databaseId: number): Promise<BaserowTable[]> {
  try {
    const tables = await baserowRequest<BaserowTable[]>(
      env,
      `/database/tables/database/${databaseId}/`
    );
    return tables;
  } catch (error) {
    // If Backend API is not available with Database Token, return empty
    // Tables will be discovered via webhooks or need to be specified
    console.log("Cannot fetch tables via API (Backend API requires JWT token)");
    console.log("For initial sync, tables will need to be discovered via webhooks");
    return [];
  }
}

/**
 * Fetch all fields for a table
 * If Backend API is not available, infer fields from row data
 */
export async function fetchFields(env: Env, tableId: number): Promise<BaserowField[]> {
  try {
    const fields = await baserowRequest<BaserowField[]>(
      env,
      `/database/fields/table/${tableId}/`
    );
    return fields;
  } catch (error) {
    // If Backend API is not available, infer fields from first row
    console.log("Cannot fetch fields via API, inferring from row data");
    const rowsResponse = await fetchRows(env, tableId, { size: 1, user_field_names: true });
    if (rowsResponse.results.length === 0) {
      throw new Error(`Cannot infer fields: table ${tableId} has no rows`);
    }
    
    const firstRow = rowsResponse.results[0];
    const inferredFields: BaserowField[] = [];
    let fieldId = 1;
    
    // Infer fields from row keys (excluding id and order)
    for (const [key, value] of Object.entries(firstRow)) {
      if (key !== 'id' && key !== 'order') {
        inferredFields.push({
          id: fieldId++,
          name: key,
          type: inferFieldType(value),
          table: tableId,
          order: fieldId,
        });
      }
    }
    
    return inferredFields;
  }
}

/**
 * Infer Baserow field type from value
 */
function inferFieldType(value: any): string {
  if (value === null || value === undefined) {
    return 'text'; // Default for null values
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'number' : 'number';
  }
  if (Array.isArray(value)) {
    return 'multiple_select'; // or could be link_row
  }
  if (typeof value === 'object') {
    return 'file'; // Could be file field
  }
  return 'text'; // Default to text
}

/**
 * Fetch all rows from a table
 */
export async function fetchRows(
  env: Env,
  tableId: number,
  options: {
    size?: number;
    user_field_names?: boolean;
  } = {}
): Promise<{ results: BaserowRow[]; count: number; next?: string | null }> {
  const params = new URLSearchParams();
  if (options.size) {
    params.set("size", String(options.size));
  }
  if (options.user_field_names !== undefined) {
    params.set("user_field_names", String(options.user_field_names));
  }

  const queryString = params.toString();
  const endpoint = `/database/rows/table/${tableId}/${queryString ? `?${queryString}` : ""}`;

  const response = await baserowRequest<{
    results: BaserowRow[];
    count: number;
    next: string | null;
  }>(env, endpoint);

  return response;
}

/**
 * Fetch all rows from a table (with pagination)
 */
export async function fetchAllRows(
  env: Env,
  tableId: number,
  options: {
    user_field_names?: boolean;
    batchSize?: number;
  } = {}
): Promise<BaserowRow[]> {
  const allRows: BaserowRow[] = [];
  let next: string | null = null;
  const batchSize = options.batchSize || 200;

  do {
    const params = new URLSearchParams();
    params.set("size", String(batchSize));
    if (options.user_field_names !== undefined) {
      params.set("user_field_names", String(options.user_field_names));
    }
    if (next) {
      // Extract offset from next URL if present
      const nextUrl = new URL(next);
      const offset = nextUrl.searchParams.get("offset");
      if (offset) {
        params.set("offset", offset);
      }
    }

    const queryString = params.toString();
    const endpoint = `/database/rows/table/${tableId}/?${queryString}`;

    const response = await baserowRequest<{
      results: BaserowRow[];
      count: number;
      next: string | null;
    }>(env, endpoint);

    allRows.push(...response.results);
    next = response.next;
  } while (next);

  return allRows;
}

/**
 * Fetch a single row by ID
 */
export async function fetchRow(env: Env, tableId: number, rowId: number): Promise<BaserowRow> {
  const row = await baserowRequest<BaserowRow>(
    env,
    `/database/rows/table/${tableId}/${rowId}/`
  );
  return row;
}

/**
 * Get database information
 */
export async function fetchDatabase(env: Env, databaseId: number): Promise<{
  id: number;
  name: string;
  order: number;
  workspace: number;
}> {
  const database = await baserowRequest<{
    id: number;
    name: string;
    order: number;
    workspace: number;
  }>(env, `/database/databases/${databaseId}/`);
  return database;
}

