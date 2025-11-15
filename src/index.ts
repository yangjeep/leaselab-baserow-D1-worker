/**
 * Cloudflare Worker to sync Baserow database to D1 and process images from Google Drive to R2
 * Supports webhooks, manual HTTP triggers, and scheduled cron jobs
 */

import type { Env, BaserowWebhookPayload, BaserowRow, BaserowField } from "./types";
import { jsonResponse, getEnvString } from "./utils";
import { verifyWebhookSignature } from "./auth";
import { fetchTables, fetchFields, fetchAllRows, fetchRows } from "./baserow";
import {
  createBaserowTable,
  getTableName,
  initializeSchema,
  addMissingColumns,
  tableExists,
} from "./schema";
import { processImagesFromFolder, deleteRowImages } from "./images";
import { sanitizeFieldName } from "./utils";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      console.log("Worker fetch handler called", {
        method: request.method,
        url: request.url,
      });
      
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Baserow-Signature",
          },
        });
      }

      let url: URL;
      try {
        url = new URL(request.url);
        console.log("URL parsed", { pathname: url.pathname });
      } catch (urlError) {
        console.error("Failed to parse URL:", urlError);
        return jsonResponse({ error: "Invalid URL" }, 400);
      }

      // Normalize pathname (remove trailing slash, handle root)
      let normalizedPath = url.pathname;
      if (normalizedPath.endsWith("/") && normalizedPath.length > 1) {
        normalizedPath = normalizedPath.slice(0, -1);
      }
      normalizedPath = normalizedPath.toLowerCase();
      
      console.log("Routing check:", {
        original: url.pathname,
        normalized: normalizedPath,
        method: request.method,
        fullUrl: request.url
      });

      // Health check endpoint - simplest possible
      if (normalizedPath === "/health" || (normalizedPath === "" && request.method === "GET")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Webhook endpoint for Baserow
      // Handle both /webhook and /webhook/ (with or without trailing slash)
      // Also handle GET requests for webhook verification (some systems send GET)
      if (normalizedPath === "/webhook") {
        if (request.method === "POST") {
          console.log("Webhook endpoint matched (POST)");
          return await handleWebhook(request, env, ctx);
        } else if (request.method === "GET") {
          // Some webhook systems send GET for verification
          console.log("Webhook endpoint matched (GET - verification)");
          return jsonResponse({ 
            status: "ok", 
            message: "Webhook endpoint is active",
            endpoint: "/webhook"
          });
        }
      }

      // Sync endpoint
      if (normalizedPath === "/sync") {
        // Require SYNC_SECRET to be configured
        if (!env.SYNC_SECRET) {
          return jsonResponse({ error: "SYNC_SECRET not configured" }, 500);
        }

        // Validate Bearer token - authentication is required
        const authHeader = request.headers.get("Authorization");
        if (authHeader !== `Bearer ${env.SYNC_SECRET}`) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        if (request.method === "GET" || request.method === "POST") {
          return await handleFullSync(env, ctx);
        }
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.error("Unhandled error in fetch handler:", error);
      return jsonResponse(
        {
          error: "Internal server error",
          details: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        },
        500
      );
    }
  },

  // Cron trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron trigger fired at ${new Date(event.scheduledTime).toISOString()}`);
    try {
      const response = await handleFullSync(env, ctx);
      const result = await response.json();
      console.log("Full sync completed:", JSON.stringify(result));
    } catch (error) {
      console.error("Full sync failed:", error);
    }
  },
};

/**
 * Handle Baserow webhook
 */
async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  console.log("=== WEBHOOK HANDLER START ===");
  console.log("Method:", request.method);
  console.log("URL:", request.url);
  
  // Log headers safely
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  console.log("Headers:", JSON.stringify(headers));
  
  try {
    // Read body once
    const bodyText = await request.text();
    console.log("Body received, length:", bodyText.length);
    
    // Parse body
    let body: BaserowWebhookPayload;
    try {
      body = JSON.parse(bodyText) as BaserowWebhookPayload;
      console.log("Body parsed:", { event_type: body.event_type, table_id: body.table_id });
    } catch (parseError) {
      console.error("Failed to parse body:", parseError);
      return jsonResponse(
        {
          error: "Failed to parse webhook body",
          details: parseError instanceof Error ? parseError.message : "Unknown error",
        },
        400
      );
    }

    // Validate webhook payload
    if (!body.event_type) {
      return jsonResponse({ error: "Missing event_type in webhook payload" }, 400);
    }

    // Verify signature (skip if no secret configured)
    if (env.WEBHOOK_SECRET) {
      const signature = request.headers.get("X-Baserow-Signature");
      console.log("Signature verification attempt", {
        hasSignature: !!signature,
        signatureLength: signature?.length || 0,
        signaturePrefix: signature?.substring(0, 30) || "none",
        bodyLength: bodyText.length,
        bodyPreview: bodyText.substring(0, 100),
        webhookSecretLength: env.WEBHOOK_SECRET.length,
        webhookSecretPrefix: env.WEBHOOK_SECRET.substring(0, 20),
      });
      
      const verified = await verifyWebhookSignature(
        bodyText,
        signature,
        env
      );
      if (!verified) {
        console.warn("Signature verification failed - detailed info logged above");
        return jsonResponse({ error: "Invalid webhook signature" }, 401);
      } else {
        console.log("✅ Signature verified successfully");
      }
    } else {
      console.log("WEBHOOK_SECRET not configured, skipping signature verification");
    }

    // Process webhook asynchronously (don't wait)
    ctx.waitUntil(
      processWebhook(body, env, ctx).catch((error) => {
        console.error("Error in async webhook processing:", error);
      })
    );

    // Return immediate success response
    console.log("=== WEBHOOK HANDLER SUCCESS ===");
    return jsonResponse({ 
      received: true, 
      event_type: body.event_type,
      table_id: body.table_id,
    });
  } catch (error) {
    console.error("=== WEBHOOK HANDLER ERROR ===", error);
    return jsonResponse(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      },
      500
    );
  }
}

/**
 * Process webhook payload
 */
async function processWebhook(payload: BaserowWebhookPayload, env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    console.log("processWebhook: starting", { event_type: payload.event_type, table_id: payload.table_id });
    
    // Validate required environment variables
    if (!env.D1_DATABASE) {
      throw new Error("D1_DATABASE not configured");
    }

    if (!env.BASEROW_API_TOKEN) {
      console.warn("BASEROW_API_TOKEN not configured, skipping webhook processing");
      return;
    }

    // Verify D1 database is accessible
    try {
      console.log("processWebhook: testing D1 database connection");
      await env.D1_DATABASE.prepare("SELECT 1").first();
      console.log("processWebhook: D1 database connection verified");
    } catch (dbError) {
      console.error("processWebhook: D1 database connection failed:", dbError);
      throw new Error(`D1 database not accessible: ${dbError instanceof Error ? dbError.message : "Unknown error"}`);
    }

    console.log("processWebhook: initializing schema");
    await initializeSchema(env.D1_DATABASE);
    console.log("processWebhook: schema initialized");

    if (payload.event_type === "rows.created" && payload.items) {
      await handleRowsCreated(payload.items, payload.table_id, env, ctx);
    } else if (payload.event_type === "rows.updated" && payload.items) {
      await handleRowsUpdated(payload.items, payload.old_items || [], payload.table_id, env, ctx);
    } else if (payload.event_type === "rows.deleted" && payload.row_ids) {
      await handleRowsDeleted(payload.row_ids, payload.table_id, env);
    } else {
      console.warn("Unknown or unsupported event type:", payload.event_type);
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    // Re-throw to ensure it's logged in waitUntil
    throw error;
  }
}

/**
 * Handle rows.created event
 */
async function handleRowsCreated(items: BaserowRow[], tableId: number, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log("handleRowsCreated: starting", { tableId, itemCount: items.length });
  
  // Get table fields to identify image fields
  console.log("handleRowsCreated: fetching fields");
  const fields = await fetchFields(env, tableId);
  console.log("handleRowsCreated: fields fetched", { fieldCount: fields.length });
  
  const imageFields = fields.filter((f) =>
    f.name.toLowerCase().includes("image") || f.type === "file"
  );
  console.log("handleRowsCreated: image fields", { count: imageFields.length });

  // Ensure table exists in D1
  // When using Database Token, we can't fetch tables from Backend API
  // So we'll use the table ID as the name (similar to handleFullSync)
  // Skip API call entirely - Database Token doesn't support Backend API
  const tableName = String(tableId);
  console.log("handleRowsCreated: using table ID as name (Database Token mode)", { tableId, tableName });

  const d1TableName = getTableName(tableId, tableName);
  console.log("handleRowsCreated: D1 table name", { d1TableName });
  
  const exists = await tableExists(env.D1_DATABASE, d1TableName);
  console.log("handleRowsCreated: table exists check", { exists });
  
  if (!exists) {
    console.log("handleRowsCreated: creating D1 table");
    await createBaserowTable(env.D1_DATABASE, tableId, tableName, fields);
    console.log("handleRowsCreated: D1 table created");
  } else {
    console.log("handleRowsCreated: D1 table already exists");
    // Add missing columns if table exists
    await addMissingColumns(env.D1_DATABASE, d1TableName, fields);
  }

  // Process each row - sync data and images together
  for (const row of items) {
    await syncRowWithImages(
      env.D1_DATABASE,
      env.R2_BUCKET,
      env,
      d1TableName,
      row,
      fields,
      imageFields,
      tableId
    );
  }
}

/**
 * Handle rows.updated event
 */
async function handleRowsUpdated(
  items: BaserowRow[],
  oldItems: BaserowRow[],
  tableId: number,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const fields = await fetchFields(env, tableId);
  const imageFields = fields.filter((f) =>
    f.name.toLowerCase().includes("image") || f.type === "file"
  );

  // Skip API call - Database Token doesn't support Backend API
  // Use table ID as name directly
  const tableName = String(tableId);
  const d1TableName = getTableName(tableId, tableName);

  // Process each updated row - sync data and images together
  for (const row of items) {
    const oldRow = oldItems.find((r) => r.id === row.id);
    
    // Check if image fields changed - if so, we need to process images
    const imageFieldsToProcess = imageFields.filter((field) => {
      const newValue = row[field.name];
      const oldValue = oldRow?.[field.name];
      return newValue && newValue !== oldValue && typeof newValue === "string";
    });

    // Sync row data and process images as part of sync operation
    await syncRowWithImages(
      env.D1_DATABASE,
      env.R2_BUCKET,
      env,
      d1TableName,
      row,
      fields,
      imageFieldsToProcess,
      tableId
    );
  }
}

/**
 * Handle rows.deleted event
 */
async function handleRowsDeleted(rowIds: number[], tableId: number, env: Env): Promise<void> {
  // Skip API call - Database Token doesn't support Backend API
  // Use table ID as name directly
  const tableName = String(tableId);
  const d1TableName = getTableName(tableId, tableName);
  
  for (const rowId of rowIds) {
    // Delete from D1
    await env.D1_DATABASE.prepare(`DELETE FROM ${d1TableName} WHERE id = ?`)
      .bind(rowId)
      .run();

    // Delete images
    await deleteRowImages(env.D1_DATABASE, env.R2_BUCKET, tableId, rowId);
  }
}

/**
 * Extract selection values from Baserow selection fields, ignoring color codes
 */
function extractSelectionValue(value: any, fieldType: string): any {
  if (value === null || value === undefined) {
    return null;
  }

  // Only process selection fields for pets and status
  if (fieldType !== "single_select" && fieldType !== "multiple_select") {
    return value;
  }

  // For single_select, extract value property if it's an object
  if (fieldType === "single_select") {
    if (typeof value === "object" && value !== null && "value" in value) {
      return value.value;
    }
    return value;
  }

  // For multiple_select, extract value properties from array
  if (fieldType === "multiple_select" && Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "object" && item !== null && "value" in item) {
        return item.value;
      }
      return item;
    });
  }

  return value;
}

/**
 * Sync a single row to D1
 */
async function syncRowToD1(
  db: D1Database,
  tableName: string,
  row: BaserowRow,
  fields: BaserowField[]
): Promise<void> {
  try {
    const columns: string[] = ["id"];
    const values: any[] = [row.id];

    const placeholders: string[] = ["?"];

    for (const field of fields) {
      const columnName = sanitizeFieldName(field.name);
      let value = row[field.name];

      columns.push(columnName);
      placeholders.push("?");

      // Extract selection values for pets and status fields, ignoring color codes
      const isPetsOrStatus = field.name === "pets" || field.name === "status";
      if (isPetsOrStatus) {
        value = extractSelectionValue(value, field.type);
        // For multiple_select, convert array to comma-separated string
        if (Array.isArray(value)) {
          value = value.join(", ");
        }
      }

      // Serialize complex types to JSON (but not for pets/status which are stored as plain strings)
      if (value !== null && value !== undefined) {
        if (isPetsOrStatus) {
          // For pets/status, store as plain string (already converted from array if needed)
          values.push(String(value));
        } else if (typeof value === "object" || Array.isArray(value)) {
          // For other complex types, serialize to JSON
          values.push(JSON.stringify(value));
        } else {
          // For simple values, store as-is
          values.push(value);
        }
      } else {
        values.push(null);
      }
    }

    // Upsert row
    const updateColumns = columns
      .slice(2)
      .map((col) => `${col} = excluded.${col}`)
      .join(", ");

    const sql = `
      INSERT INTO ${tableName} (${columns.join(", ")}, updated_at)
      VALUES (${placeholders.join(", ")}, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        ${updateColumns},
        updated_at = datetime('now')
    `;

    const result = await db.prepare(sql).bind(...values).run();
    
    if (!result.success) {
      throw new Error(`Failed to sync row ${row.id} to ${tableName}`);
    }
  } catch (error) {
    console.error(`Error syncing row ${row.id} to ${tableName}:`, error);
    throw error;
  }
}

/**
 * Sync a single row to D1 and process images (part of sync operation)
 */
async function syncRowWithImages(
  db: D1Database,
  bucket: R2Bucket | undefined,
  env: Env,
  tableName: string,
  row: BaserowRow,
  fields: BaserowField[],
  imageFields: BaserowField[],
  tableId: number
): Promise<void> {
  // First, sync the row data to D1
  await syncRowToD1(db, tableName, row, fields);

  // Then, process images as part of the sync operation
  if (bucket && imageFields.length > 0) {
    for (const field of imageFields) {
      const fieldValue = row[field.name];
      if (fieldValue && typeof fieldValue === "string") {
        try {
          // Process images synchronously as part of sync
          await processImagesFromFolder(
            db,
            bucket,
            env,
            fieldValue,
            tableId,
            row.id,
            field.name,
            tableName
          );
          console.log(`Synced images for row ${row.id}, field ${field.name}`);
        } catch (error) {
          console.error(`Error processing images for row ${row.id}, field ${field.name}:`, error);
          // Don't throw - image processing errors shouldn't fail the sync
        }
      }
    }
  }
}

/**
 * Handle full database sync
 */
async function handleFullSync(env: Env, ctx: ExecutionContext): Promise<Response> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    if (!env.BASEROW_API_TOKEN || !env.BASEROW_DATABASE_ID) {
      return jsonResponse(
        {
          error: "Baserow credentials not configured (BASEROW_API_TOKEN, BASEROW_DATABASE_ID required)",
        },
        500
      );
    }

    const databaseId = parseInt(env.BASEROW_DATABASE_ID);
    console.log("Starting full sync...");

    // Initialize schema
    await initializeSchema(env.D1_DATABASE);

    // Sync table from environment variable (skip table fetching - Database Token doesn't support Backend API)
    if (!env.BASEROW_TABLE_ID) {
      return jsonResponse({
        success: false,
        error: "BASEROW_TABLE_ID not configured",
        timestamp,
      }, 400);
    }
    
    const tableId = parseInt(env.BASEROW_TABLE_ID);
    if (isNaN(tableId)) {
      return jsonResponse({
        success: false,
        error: `Invalid BASEROW_TABLE_ID: ${env.BASEROW_TABLE_ID}`,
        timestamp,
      }, 400);
    }
    
    console.log(`Syncing table ${tableId} directly`);
    
    // Verify table is accessible by fetching a row
    let testRows;
    try {
      testRows = await fetchRows(env, tableId, { size: 1, user_field_names: true });
      console.log(`Table ${tableId} accessible, row count: ${testRows.count}`);
    } catch (error) {
      console.error(`Table ${tableId} access error:`, error instanceof Error ? error.message : String(error));
      return jsonResponse({
        success: false,
        error: `Cannot access table ${tableId}: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp,
      }, 400);
    }
    
    // Create table object for sync
    const tables = [{
      id: tableId,
      name: String(tableId), // Use table ID as name (getTableName will add table_ prefix)
      order: 0,
      database: databaseId,
    }];

    const summary = {
      tablesProcessed: tables.length,
      tablesSucceeded: 0,
      tablesFailed: 0,
      rowsProcessed: 0,
      rowsSucceeded: 0,
      rowsFailed: 0,
      imagesProcessed: 0,
      imagesSkipped: 0,
      imagesFailed: 0,
    };

    // Process each table
    for (const table of tables) {
      try {
        // Fetch fields (will infer from row data if Backend API not available)
        const fields = await fetchFields(env, table.id);
        console.log(`Table ${table.id}: ${fields.length} fields`);
        const imageFields = fields.filter(
          (f) => f.name.toLowerCase().includes("image") || f.type === "file"
        );

        // Create/update table in D1
        const d1TableName = getTableName(table.id, table.name);
        console.log(`Checking for table: ${d1TableName}`);
        const exists = await tableExists(env.D1_DATABASE, d1TableName);
        console.log(`Table exists: ${exists}`);
        
        if (!exists) {
          console.log(`Creating table: ${d1TableName}`);
          await createBaserowTable(env.D1_DATABASE, table.id, table.name, fields);
          console.log(`Table created: ${d1TableName}`);
        } else {
          console.log(`Table already exists, adding missing columns: ${d1TableName}`);
          await addMissingColumns(env.D1_DATABASE, d1TableName, fields);
        }

        // Fetch all rows
        const rows = await fetchAllRows(env, table.id, { user_field_names: true });
        console.log(`Table ${table.name}: ${rows.length} rows`);

        // Sync rows to D1 with images as part of sync operation
        for (const row of rows) {
          try {
            await syncRowWithImages(
              env.D1_DATABASE,
              env.R2_BUCKET,
              env,
              d1TableName,
              row,
              fields,
              imageFields,
              table.id
            );
            summary.rowsSucceeded++;
            
            // Count processed images
            for (const field of imageFields) {
              const fieldValue = row[field.name];
              if (fieldValue && typeof fieldValue === "string" && env.R2_BUCKET) {
                summary.imagesProcessed++;
              }
            }
          } catch (error) {
            console.error(`Error syncing row ${row.id}:`, error);
            summary.rowsFailed++;
            
            // Count failed images
            for (const field of imageFields) {
              const fieldValue = row[field.name];
              if (fieldValue && typeof fieldValue === "string" && env.R2_BUCKET) {
                summary.imagesFailed++;
              }
            }
          }
          summary.rowsProcessed++;
        }

        summary.tablesSucceeded++;
      } catch (error) {
        console.error(`Error syncing table ${table.name}:`, error);
        summary.tablesFailed++;
      }
    }

    const duration = Date.now() - startTime;

    return jsonResponse({
      success: true,
      timestamp,
      duration: `${duration}ms`,
      summary,
    });
  } catch (error) {
    console.error("Full sync error:", error);
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp,
      },
      500
    );
  }
}
