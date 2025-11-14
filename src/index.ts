/**
 * Cloudflare Worker to sync Baserow database to D1 and process images from Google Drive to R2
 * Supports webhooks, manual HTTP triggers, and scheduled cron jobs
 */

import type { Env, BaserowWebhookPayload, BaserowRow, BaserowField } from "./types";
import { jsonResponse, getEnvString } from "./utils";
import { verifyWebhookSignature } from "./auth";
import { fetchTables, fetchFields, fetchAllRows } from "./baserow";
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

      // Health check endpoint - simplest possible
      if (url.pathname === "/health" || (url.pathname === "/" && request.method === "GET")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Webhook endpoint for Baserow
      if (url.pathname === "/webhook" && request.method === "POST") {
        console.log("Webhook endpoint matched");
        return await handleWebhook(request, env, ctx);
      }

      // Sync endpoint
      if (url.pathname === "/sync") {
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
      const verified = await verifyWebhookSignature(
        bodyText,
        signature,
        env
      );
      if (!verified) {
        console.warn("Signature verification failed");
        return jsonResponse({ error: "Invalid webhook signature" }, 401);
      }
      console.log("Signature verified");
    } else {
      console.log("WEBHOOK_SECRET not configured, skipping signature verification");
    }

    // Process webhook asynchronously (don't wait)
    ctx.waitUntil(
      processWebhook(body, env).catch((error) => {
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
async function processWebhook(payload: BaserowWebhookPayload, env: Env): Promise<void> {
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
      await handleRowsCreated(payload.items, payload.table_id, env);
    } else if (payload.event_type === "rows.updated" && payload.items) {
      await handleRowsUpdated(payload.items, payload.old_items || [], payload.table_id, env);
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
async function handleRowsCreated(items: BaserowRow[], tableId: number, env: Env): Promise<void> {
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
  console.log("handleRowsCreated: fetching tables");
  const tables = await fetchTables(env, parseInt(getEnvString(env, "BASEROW_DATABASE_ID", "321013")));
  const table = tables.find((t) => t.id === tableId);
  if (!table) {
    throw new Error(`Table ${tableId} not found`);
  }
  console.log("handleRowsCreated: table found", { tableId: table.id, tableName: table.name });

  const d1TableName = getTableName(tableId, table.name);
  console.log("handleRowsCreated: D1 table name", { d1TableName });
  
  const exists = await tableExists(env.D1_DATABASE, d1TableName);
  console.log("handleRowsCreated: table exists check", { exists });
  
  if (!exists) {
    console.log("handleRowsCreated: creating D1 table");
    await createBaserowTable(env.D1_DATABASE, tableId, table.name, fields);
    console.log("handleRowsCreated: D1 table created");
  } else {
    console.log("handleRowsCreated: D1 table already exists");
  }

  // Process each row
  for (const row of items) {
    await syncRowToD1(env.D1_DATABASE, d1TableName, row, fields);

    // Process images from image fields
    for (const field of imageFields) {
      const fieldValue = row[field.name];
      if (fieldValue && typeof fieldValue === "string") {
        // Process images asynchronously
        processImagesFromFolder(
          env.D1_DATABASE,
          env.R2_BUCKET,
          env,
          fieldValue,
          tableId,
          row.id,
          field.name
        ).catch((error) => {
          console.error(`Error processing images for row ${row.id}, field ${field.name}:`, error);
        });
      }
    }
  }
}

/**
 * Handle rows.updated event
 */
async function handleRowsUpdated(
  items: BaserowRow[],
  oldItems: BaserowRow[],
  tableId: number,
  env: Env
): Promise<void> {
  const fields = await fetchFields(env, tableId);
  const imageFields = fields.filter((f) =>
    f.name.toLowerCase().includes("image") || f.type === "file"
  );

  const tables = await fetchTables(env, parseInt(getEnvString(env, "BASEROW_DATABASE_ID", "321013")));
  const table = tables.find((t) => t.id === tableId);
  if (!table) {
    throw new Error(`Table ${tableId} not found`);
  }

  const d1TableName = getTableName(tableId, table.name);

  // Process each updated row
  for (const row of items) {
    await syncRowToD1(env.D1_DATABASE, d1TableName, row, fields);

    // Check if image fields changed
    const oldRow = oldItems.find((r) => r.id === row.id);
    for (const field of imageFields) {
      const newValue = row[field.name];
      const oldValue = oldRow?.[field.name];

      if (newValue && newValue !== oldValue && typeof newValue === "string") {
        // Process images asynchronously
        processImagesFromFolder(
          env.D1_DATABASE,
          env.R2_BUCKET,
          env,
          newValue,
          tableId,
          row.id,
          field.name
        ).catch((error) => {
          console.error(`Error processing images for row ${row.id}, field ${field.name}:`, error);
        });
      }
    }
  }
}

/**
 * Handle rows.deleted event
 */
async function handleRowsDeleted(rowIds: number[], tableId: number, env: Env): Promise<void> {
  for (const rowId of rowIds) {
    // Delete from D1
    const tables = await fetchTables(env, parseInt(getEnvString(env, "BASEROW_DATABASE_ID", "321013")));
    const table = tables.find((t) => t.id === tableId);
    if (table) {
      const d1TableName = getTableName(tableId, table.name);
      await env.D1_DATABASE.prepare(`DELETE FROM ${d1TableName} WHERE id = ?`)
        .bind(rowId)
        .run();
    }

    // Delete images
    await deleteRowImages(env.D1_DATABASE, env.R2_BUCKET, tableId, rowId);
  }
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
    const columns: string[] = ["id", "order"];
    const values: any[] = [row.id, row.order];

    const placeholders: string[] = ["?", "?"];

    for (const field of fields) {
      const columnName = sanitizeFieldName(field.name);
      const value = row[field.name];

      columns.push(columnName);
      placeholders.push("?");

      // Serialize complex types to JSON
      if (value !== null && value !== undefined) {
        if (typeof value === "object" || Array.isArray(value)) {
          values.push(JSON.stringify(value));
        } else {
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

    // Fetch all tables
    const tables = await fetchTables(env, databaseId);
    console.log(`Found ${tables.length} tables`);

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
        // Fetch fields
        const fields = await fetchFields(env, table.id);
        const imageFields = fields.filter(
          (f) => f.name.toLowerCase().includes("image") || f.type === "file"
        );

        // Create/update table in D1
        const d1TableName = getTableName(table.id, table.name);
        if (!(await tableExists(env.D1_DATABASE, d1TableName))) {
          await createBaserowTable(env.D1_DATABASE, table.id, table.name, fields);
        } else {
          await addMissingColumns(env.D1_DATABASE, d1TableName, fields);
        }

        // Fetch all rows
        const rows = await fetchAllRows(env, table.id, { user_field_names: true });
        console.log(`Table ${table.name}: ${rows.length} rows`);

        // Sync rows to D1
        for (const row of rows) {
          try {
            await syncRowToD1(env.D1_DATABASE, d1TableName, row, fields);
            summary.rowsSucceeded++;

            // Process images asynchronously
            for (const field of imageFields) {
              const fieldValue = row[field.name];
              if (fieldValue && typeof fieldValue === "string") {
                ctx.waitUntil(
                  processImagesFromFolder(
                    env.D1_DATABASE,
                    env.R2_BUCKET,
                    env,
                    fieldValue,
                    table.id,
                    row.id,
                    field.name
                  ).then(() => {
                    summary.imagesProcessed++;
                  }).catch((error) => {
                    console.error(`Error processing images:`, error);
                    summary.imagesFailed++;
                  })
                );
              }
            }
          } catch (error) {
            console.error(`Error syncing row ${row.id}:`, error);
            summary.rowsFailed++;
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
