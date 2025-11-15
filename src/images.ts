/**
 * Image processing and R2 upload
 * Extracted and enhanced from existing worker code
 */

import type { D1Database, R2Bucket, DriveFile, Env, ImageSyncRecord } from "./types";
import { extractDriveFolderId, sanitizeFieldName } from "./utils";
import { listDriveFiles, downloadDriveFile, getAccessToken } from "./google-drive";
import { getEnvNumber, getEnvString } from "./utils";
import { getTableColumns } from "./schema";

/**
 * Get R2 object hash from metadata
 */
export async function getR2ObjectHash(bucket: R2Bucket, key: string): Promise<string | null> {
  try {
    const object = await bucket.head(key);
    if (!object) {
      return null;
    }

    // Check custom metadata for hash
    const hash = object.customMetadata?.["x-hash-md5"];
    return hash || null;
  } catch (error) {
    // File doesn't exist
    return null;
  }
}

/**
 * Get image sync record from D1
 */
export async function getImageSyncRecord(
  db: D1Database,
  googleDriveFileId: string
): Promise<ImageSyncRecord | null> {
  const result = await db.prepare(`
    SELECT * FROM image_sync_records 
    WHERE google_drive_file_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(googleDriveFileId).first<ImageSyncRecord>();

  return result || null;
}

/**
 * Create or update image sync record
 */
export async function upsertImageSyncRecord(
  db: D1Database,
  record: Omit<ImageSyncRecord, "id">
): Promise<void> {
  const existing = await getImageSyncRecord(db, record.google_drive_file_id);

  if (existing) {
    // Update existing record
    await db.prepare(`
      UPDATE image_sync_records SET
        r2_url = ?,
        r2_key = ?,
        original_size = ?,
        optimized_size = ?,
        status = ?,
        processed_at = ?,
        error_message = ?,
        md5_hash = ?,
        updated_at = datetime('now')
      WHERE google_drive_file_id = ?
    `).bind(
      record.r2_url,
      record.r2_key,
      record.original_size,
      record.optimized_size,
      record.status,
      record.processed_at,
      record.error_message,
      record.md5_hash,
      record.google_drive_file_id
    ).run();
  } else {
    // Insert new record
    await db.prepare(`
      INSERT INTO image_sync_records (
        google_drive_file_id,
        google_drive_folder_id,
        r2_url,
        r2_key,
        table_id,
        row_id,
        field_name,
        original_size,
        optimized_size,
        status,
        processed_at,
        error_message,
        md5_hash,
        file_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      record.google_drive_file_id,
      record.google_drive_folder_id,
      record.r2_url,
      record.r2_key,
      record.table_id,
      record.row_id,
      record.field_name,
      record.original_size,
      record.optimized_size,
      record.status,
      record.processed_at,
      record.error_message,
      record.md5_hash,
      record.file_name
    ).run();
  }
}

/**
 * Process images from a Google Drive folder URL
 * Returns array of R2 URLs for processed images
 */
export async function processImagesFromFolder(
  db: D1Database,
  bucket: R2Bucket,
  env: Env,
  folderUrl: string,
  tableId: number,
  rowId: number,
  fieldName: string,
  tableName?: string
): Promise<string[]> {
  const folderId = extractDriveFolderId(folderUrl);
  if (!folderId) {
    throw new Error(`Invalid Google Drive folder URL: ${folderUrl}`);
  }

  const accessToken = await getAccessToken(env);
  if (!accessToken) {
    throw new Error("Google Drive credentials not configured");
  }

  // List files in folder
  const driveFiles = await listDriveFiles(folderId, accessToken);
  const imageFiles = driveFiles.filter((f) => f.mimeType.startsWith("image/"));

  if (imageFiles.length === 0) {
    return [];
  }

  const r2Urls: string[] = [];
  const maxImageSize = getEnvNumber(env, "MAX_IMAGE_SIZE", 10 * 1024 * 1024); // 10MB default

  // Process each image
  for (const file of imageFiles) {
    try {
      // Check if already processed and unchanged
      const existingRecord = await getImageSyncRecord(db, file.id);
      if (existingRecord && existingRecord.md5_hash === file.md5Checksum && existingRecord.status === "processed") {
        if (existingRecord.r2_url) {
          r2Urls.push(existingRecord.r2_url);
        }
        continue;
      }

      // Download and process image
      const imageData = await downloadDriveFile(file.id, accessToken);
      const originalSize = imageData.byteLength;

      // Check file size
      if (originalSize > maxImageSize) {
        await upsertImageSyncRecord(db, {
          google_drive_file_id: file.id,
          google_drive_folder_id: folderId,
          r2_url: null,
          r2_key: null,
          table_id: tableId,
          row_id: rowId,
          field_name: fieldName,
          original_size: originalSize,
          optimized_size: null,
          status: "failed",
          processed_at: new Date().toISOString(),
          error_message: `File size ${originalSize} exceeds maximum ${maxImageSize}`,
          md5_hash: file.md5Checksum || null,
          file_name: file.name,
        });
        continue;
      }

      // TODO: Add image optimization/compression here
      // For now, we'll just upload the original
      // In the future, this should:
      // - Resize if needed (based on MAX_IMAGE_WIDTH/MAX_IMAGE_HEIGHT)
      // - Compress JPEG/PNG
      // - Convert to WebP if beneficial
      // - Strip EXIF metadata
      const optimizedData = imageData; // Placeholder - no optimization yet
      const optimizedSize = optimizedData.byteLength;

      // Generate R2 key
      const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `${tableId}/${rowId}/${sanitizedFilename}`;

      // Upload to R2
      const customMetadata: Record<string, string> = {
        "x-drive-file-id": file.id,
        "x-synced-at": new Date().toISOString(),
      };

      if (file.md5Checksum) {
        customMetadata["x-hash-md5"] = file.md5Checksum;
      }

      await bucket.put(r2Key, optimizedData, {
        httpMetadata: {
          contentType: file.mimeType,
        },
        customMetadata,
      });

      // Generate R2 public URL
      // Note: This is a placeholder - you'll need to configure your R2 public URL
      // For Cloudflare R2, you typically use a custom domain or R2.dev subdomain
      // Adjust this based on your R2 setup
      const r2Url = `https://your-r2-domain.com/${r2Key}`;

      // Update sync record
      await upsertImageSyncRecord(db, {
        google_drive_file_id: file.id,
        google_drive_folder_id: folderId,
        r2_url: r2Url,
        r2_key: r2Key,
        table_id: tableId,
        row_id: rowId,
        field_name: fieldName,
        original_size: originalSize,
        optimized_size: optimizedSize,
        status: "processed",
        processed_at: new Date().toISOString(),
        error_message: null,
        md5_hash: file.md5Checksum || null,
        file_name: file.name,
      });

      r2Urls.push(r2Url);
      console.log(`Processed image: ${file.name} -> ${r2Key}`);
    } catch (error) {
      console.error(`Failed to process image ${file.name}:`, error);
      
      // Record error
      await upsertImageSyncRecord(db, {
        google_drive_file_id: file.id,
        google_drive_folder_id: folderId,
        r2_url: null,
        r2_key: null,
        table_id: tableId,
        row_id: rowId,
        field_name: fieldName,
        original_size: null,
        optimized_size: null,
        status: "failed",
        processed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : "Unknown error",
        md5_hash: file.md5Checksum || null,
        file_name: file.name,
      });
    }
  }

  // Update the row in the D1 table with R2 URLs if table name is provided
  if (tableName && r2Urls.length > 0) {
    await updateRowWithR2Urls(db, tableName, rowId, fieldName, r2Urls);
  }

  return r2Urls;
}

/**
 * Update a row in the D1 table with R2 URLs for a specific field
 */
export async function updateRowWithR2Urls(
  db: D1Database,
  tableName: string,
  rowId: number,
  fieldName: string,
  r2Urls: string[]
): Promise<void> {
  try {
    // Create column name for R2 URLs (e.g., "image_r2_urls")
    const r2UrlsColumnName = sanitizeFieldName(`${fieldName}_r2_urls`);
    
    // Check if column exists, if not add it
    const columns = await getTableColumns(db, tableName);
    if (!columns.includes(r2UrlsColumnName)) {
      console.log(`Adding column ${r2UrlsColumnName} to ${tableName}`);
      await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${r2UrlsColumnName} TEXT`).run();
    }
    
    // Update the row with R2 URLs as JSON array
    const r2UrlsJson = JSON.stringify(r2Urls);
    await db.prepare(`
      UPDATE ${tableName} 
      SET ${r2UrlsColumnName} = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(r2UrlsJson, rowId).run();
    
    console.log(`Updated row ${rowId} in ${tableName} with ${r2Urls.length} R2 URLs for field ${fieldName}`);
  } catch (error) {
    console.error(`Error updating row ${rowId} with R2 URLs:`, error);
    // Don't throw - this is not critical for the sync process
  }
}

/**
 * Delete images for a row (when row is deleted)
 */
export async function deleteRowImages(
  db: D1Database,
  bucket: R2Bucket,
  tableId: number,
  rowId: number
): Promise<number> {
  // Get all image records for this row
  const records = await db.prepare(`
    SELECT r2_key FROM image_sync_records
    WHERE table_id = ? AND row_id = ? AND r2_key IS NOT NULL
  `).bind(tableId, rowId).all<{ r2_key: string }>();

  let deletedCount = 0;

  for (const record of records.results || []) {
    try {
      await bucket.delete(record.r2_key);
      deletedCount++;
    } catch (error) {
      console.error(`Failed to delete R2 object ${record.r2_key}:`, error);
    }
  }

  // Delete records from D1
  await db.prepare(`
    DELETE FROM image_sync_records
    WHERE table_id = ? AND row_id = ?
  `).bind(tableId, rowId).run();

  return deletedCount;
}

