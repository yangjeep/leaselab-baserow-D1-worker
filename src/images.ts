/**
 * Image processing and R2 upload
 * Uploads original images to R2 for on-demand transformation via Cloudflare Image Resizing
 * 
 * This module handles:
 * - Downloading images from Google Drive
 * - Uploading originals to R2
 * - Generating optimized URLs with Cloudflare Image Resizing parameters
 * - Tracking sync status in D1 database
 */

import type { DriveFile, Env, ImageSyncRecord } from "./types";
import { extractDriveFolderId, sanitizeFieldName } from "./utils";
import { listDriveFiles, downloadDriveFile, getAccessToken } from "./google-drive";
import { getEnvNumber, getEnvString } from "./utils";
import { getTableColumns } from "./schema";

/**
 * Generate optimized image URL using Cloudflare Image Resizing
 * This doesn't process images at upload time, but provides URLs that will be optimized on-demand
 */
function generateOptimizedImageUrl(
  baseUrl: string,
  maxWidth: number,
  maxHeight: number,
  quality: number,
  format: 'auto' | 'webp' | 'avif' | 'json' = 'auto'
): string {
  // If already has cdn-cgi/image in it, return as-is
  if (baseUrl.includes('/cdn-cgi/image/')) {
    return baseUrl;
  }
  
  // Cloudflare Image Resizing URL format:
  // https://domain.com/cdn-cgi/image/width=800,height=600,quality=85,format=auto/image-path
  const params = `width=${maxWidth},height=${maxHeight},quality=${quality},fit=scale-down,format=${format}`;
  return baseUrl.replace(/^(https?:\/\/[^/]+)(.+)$/, `$1/cdn-cgi/image/${params}$2`);
}

/**
 * Convert existing R2 URLs to optimized URLs
 */
export function convertToOptimizedUrls(
  urls: string[],
  maxWidth: number = 1280,
  maxHeight: number = 1280,
  quality: number = 85
): string[] {
  return urls.map(url => generateOptimizedImageUrl(url, maxWidth, maxHeight, quality, 'auto'));
}

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
 * Check if an existing image record needs resyncing
 */
async function shouldResyncImage(
  existingRecord: ImageSyncRecord,
  file: DriveFile,
  bucket: R2Bucket
): Promise<{ needsResync: boolean; canReuseUrl: boolean; existingUrl?: string }> {
  // Check for discrepancies: verify R2 file exists and hash matches
  let needsResync = false;
  
  if (existingRecord.r2_key) {
    // Check if R2 file exists
    const r2Object = await bucket.head(existingRecord.r2_key);
    if (!r2Object) {
      console.log(`Discrepancy detected: R2 file missing for ${file.name} (key: ${existingRecord.r2_key}), resyncing...`);
      needsResync = true;
    } else {
      // Check if hash matches
      const r2Hash = r2Object.customMetadata?.["x-hash-md5"];
      if (existingRecord.md5_hash && r2Hash && existingRecord.md5_hash !== r2Hash) {
        console.log(`Discrepancy detected: Hash mismatch for ${file.name} (DB: ${existingRecord.md5_hash}, R2: ${r2Hash}), resyncing...`);
        needsResync = true;
      } else if (existingRecord.md5_hash !== file.md5Checksum) {
        // Drive file has changed
        console.log(`File changed: ${file.name} (old hash: ${existingRecord.md5_hash}, new hash: ${file.md5Checksum}), resyncing...`);
        needsResync = true;
      }
    }
  } else {
    // Record says processed but no R2 key - discrepancy
    console.log(`Discrepancy detected: Record marked processed but no R2 key for ${file.name}, resyncing...`);
    needsResync = true;
  }
  
  // If no discrepancies and hash matches, can reuse
  if (!needsResync && existingRecord.md5_hash === file.md5Checksum && existingRecord.r2_url) {
    return { needsResync: false, canReuseUrl: true, existingUrl: existingRecord.r2_url };
  }
  
  return { needsResync, canReuseUrl: false };
}

/**
 * Try to recover from a failed image record
 */
async function tryRecoverFailedImage(
  existingRecord: ImageSyncRecord,
  file: DriveFile,
  bucket: R2Bucket,
  db: D1Database,
  folderId: string,
  tableId: number,
  rowId: number,
  fieldName: string,
  env: Env
): Promise<string | null> {
  console.log(`Retrying failed image: ${file.name}`);
  
  // Log the previous error for context
  if (existingRecord.error_message) {
    console.log(`Previous error for ${file.name}: ${existingRecord.error_message}`);
  }
  
  // Check if there's an existing R2 URL that might still be valid
  if (existingRecord.r2_url && existingRecord.r2_key) {
    try {
      const r2Object = await bucket.head(existingRecord.r2_key);
      if (r2Object) {
        // Convert existing URL to optimized format if needed
        const baseMaxWidth = getEnvNumber(env, "MAX_IMAGE_WIDTH", 1280);
        const baseMaxHeight = getEnvNumber(env, "MAX_IMAGE_HEIGHT", 1280);
        const baseQuality = getEnvNumber(env, "IMAGE_QUALITY", 85);
        
        const optimizedUrl = generateOptimizedImageUrl(
          existingRecord.r2_url,
          baseMaxWidth,
          baseMaxHeight,
          baseQuality,
          'auto'
        );
        
        console.log(`Found existing R2 file for failed image ${file.name}, reusing URL: ${optimizedUrl}`);
        
        // Update status to processed and store the optimized URL
        await upsertImageSyncRecord(db, {
          google_drive_file_id: file.id,
          google_drive_folder_id: folderId,
          r2_url: optimizedUrl,
          r2_key: existingRecord.r2_key,
          table_id: tableId,
          row_id: rowId,
          field_name: fieldName,
          original_size: existingRecord.original_size,
          optimized_size: existingRecord.optimized_size,
          status: "processed",
          processed_at: new Date().toISOString(),
          error_message: null,
          md5_hash: file.md5Checksum || existingRecord.md5_hash,
          file_name: file.name,
        });
        return optimizedUrl;
      }
    } catch (r2CheckError) {
      console.log(`Existing R2 file check failed for ${file.name}, will reprocess:`, r2CheckError);
    }
  }
  
  return null; // Need to reprocess
}

/**
 * Download image from Google Drive
 */
async function downloadImageFromDrive(
  file: DriveFile,
  accessToken: string
): Promise<ArrayBuffer> {
  console.log(`📥 Downloading ${file.name} from Google Drive...`);
  
  try {
    const imageData = await downloadDriveFile(file.id, accessToken);
    const sizeMB = (imageData.byteLength / (1024 * 1024)).toFixed(2);
    console.log(`✓ Downloaded ${file.name} (${sizeMB}MB)`);
    return imageData;
  } catch (error) {
    console.error(`✗ Failed to download ${file.name}:`, error);
    throw new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Upload original image to R2 and generate optimized URL
 */
async function uploadImageToR2(
  file: DriveFile,
  imageData: ArrayBuffer,
  bucket: R2Bucket,
  env: Env,
  tableId: number,
  rowId: number
): Promise<{ r2Url: string; r2Key: string }> {
  // Generate R2 key - keep original filename
  const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `${tableId}/${rowId}/${sanitizedFilename}`;
  const sizeMB = (imageData.byteLength / (1024 * 1024)).toFixed(2);
  
  console.log(`☁️  Uploading ${file.name} (${sizeMB}MB) to R2: ${r2Key}`);

  // Prepare metadata
  const customMetadata: Record<string, string> = {
    "x-drive-file-id": file.id,
    "x-synced-at": new Date().toISOString(),
    "x-original-size": imageData.byteLength.toString(),
  };

  if (file.md5Checksum) {
    customMetadata["x-hash-md5"] = file.md5Checksum;
  }

  // Upload to R2
  try {
    await bucket.put(r2Key, imageData, {
      httpMetadata: {
        contentType: file.mimeType,
      },
      customMetadata,
    });
    console.log(`✓ Uploaded ${file.name} to R2`);
  } catch (error) {
    console.error(`✗ R2 upload failed for ${file.name}:`, error);
    throw new Error(`R2 upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Generate optimized URL with Cloudflare Image Resizing parameters
  const r2PublicDomain = getEnvString(env, "R2_PUBLIC_DOMAIN", "https://img.rent-in-ottawa.ca");
  const originalUrl = `${r2PublicDomain}/${r2Key}`;
  
  const maxWidth = getEnvNumber(env, "MAX_IMAGE_WIDTH", 1280);
  const maxHeight = getEnvNumber(env, "MAX_IMAGE_HEIGHT", 1280);
  const quality = getEnvNumber(env, "IMAGE_QUALITY", 85);
  
  const optimizedUrl = generateOptimizedImageUrl(
    originalUrl,
    maxWidth,
    maxHeight,
    quality,
    'auto'
  );
  
  console.log(`🔗 Generated optimized URL with dimensions ${maxWidth}x${maxHeight}, quality ${quality}`);
  
  return { r2Url: optimizedUrl, r2Key };
}

/**
 * Process a single image file
 */
async function processSingleImage(
  file: DriveFile,
  folderId: string,
  accessToken: string,
  db: D1Database,
  bucket: R2Bucket,
  env: Env,
  tableId: number,
  rowId: number,
  fieldName: string
): Promise<string | null> {
  try {
    console.log(`\n📸 Processing ${file.name}...`);
    
    // Check if already processed
    const existingRecord = await getImageSyncRecord(db, file.id);
    
    if (existingRecord && existingRecord.status === "processed") {
      const syncCheck = await shouldResyncImage(existingRecord, file, bucket);
      if (syncCheck.canReuseUrl && syncCheck.existingUrl) {
        console.log(`✓ Using existing URL for ${file.name}`);
        return syncCheck.existingUrl;
      }
      if (syncCheck.needsResync) {
        console.log(`🔄 Resyncing ${file.name}`);
      }
    }
    
    // Try to recover from failed images
    if (existingRecord && existingRecord.status === "failed") {
      const recoveredUrl = await tryRecoverFailedImage(
        existingRecord,
        file,
        bucket,
        db,
        folderId,
        tableId,
        rowId,
        fieldName,
        env
      );
      if (recoveredUrl) {
        console.log(`✓ Recovered ${file.name}`);
        return recoveredUrl;
      }
    }

    // Download from Google Drive
    const imageData = await downloadImageFromDrive(file, accessToken);
    const originalSize = imageData.byteLength;

    // Upload to R2 and generate optimized URL
    const { r2Url, r2Key } = await uploadImageToR2(
      file,
      imageData,
      bucket,
      env,
      tableId,
      rowId
    );

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
      optimized_size: originalSize, // Same as original since we don't optimize at upload time
      status: "processed",
      processed_at: new Date().toISOString(),
      error_message: null,
      md5_hash: file.md5Checksum || null,
      file_name: file.name,
    });

    console.log(`✅ Processed ${file.name}`);
    return r2Url;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`❌ Failed to process ${file.name}:`, errorMessage);
    if (errorStack) {
      console.error(`Error stack for ${file.name}:`, errorStack);
    }
    
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
      error_message: errorMessage,
      md5_hash: file.md5Checksum || null,
      file_name: file.name,
    });
    
    return null;
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
    console.log(`📂 No images found in folder ${folderId}`);
    return [];
  }

  console.log(`📂 Processing ${imageFiles.length} images from folder ${folderId} for row ${rowId}, field ${fieldName}`);

  // Process each image
  const r2Urls: string[] = [];
  for (const file of imageFiles) {
    const r2Url = await processSingleImage(
      file,
      folderId,
      accessToken,
      db,
      bucket,
      env,
      tableId,
      rowId,
      fieldName
    );
    
    if (r2Url) {
      r2Urls.push(r2Url);
    }
  }

  console.log(`✨ Processed ${r2Urls.length}/${imageFiles.length} images successfully`);

  // Update the row in the D1 table with R2 URLs if table name is provided
  if (tableName && r2Urls.length > 0) {
    try {
      await updateRowWithR2Urls(db, tableName, rowId, fieldName, r2Urls);
      console.log(`Successfully wrote back ${r2Urls.length} R2 URLs to ${tableName} for row ${rowId}, field ${fieldName}`);
    } catch (error) {
      console.error(`Failed to write back R2 URLs to ${tableName} for row ${rowId}, field ${fieldName}:`, error);
      // Don't throw - images were processed successfully, write-back failure is logged
      // But we should still return the URLs so they're available
    }
  } else if (!tableName) {
    console.warn(`No table name provided, skipping R2 URL write-back for row ${rowId}, field ${fieldName}`);
  } else if (r2Urls.length === 0) {
    console.log(`No R2 URLs to write back for row ${rowId}, field ${fieldName}`);
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
    console.log(`Updating R2 URLs for row ${rowId} in ${tableName}, column: ${r2UrlsColumnName}, URLs: ${r2Urls.length}`);
    
    // Check if column exists, if not add it
    const columns = await getTableColumns(db, tableName);
    console.log(`Existing columns in ${tableName}:`, columns);
    
    if (!columns.includes(r2UrlsColumnName)) {
      console.log(`Adding column ${r2UrlsColumnName} to ${tableName}`);
      const alterResult = await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${r2UrlsColumnName} TEXT`).run();
      if (!alterResult.success) {
        throw new Error(`Failed to add column ${r2UrlsColumnName} to ${tableName}`);
      }
      console.log(`Successfully added column ${r2UrlsColumnName} to ${tableName}`);
    } else {
      console.log(`Column ${r2UrlsColumnName} already exists in ${tableName}`);
    }
    
    // Check if URLs need conversion to optimized format
    const needsConversion = r2Urls.some(url => !url.includes('/cdn-cgi/image/'));
    if (needsConversion) {
      console.log(`Converting ${r2Urls.length} URLs to optimized format`);
      // Note: r2Urls are already optimized from uploadImageToR2, but keep this for safety
    }
    
    // Update the row with R2 URLs as JSON array
    const r2UrlsJson = JSON.stringify(r2Urls);
    const updateResult = await db.prepare(`
      UPDATE ${tableName} 
      SET ${r2UrlsColumnName} = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(r2UrlsJson, rowId).run();
    
    if (!updateResult.success) {
      throw new Error(`Failed to update row ${rowId} with R2 URLs`);
    }
    
    // Verify the update worked
    const verifyResult = await db.prepare(`
      SELECT ${r2UrlsColumnName} FROM ${tableName} WHERE id = ?
    `).bind(rowId).first<{ [key: string]: string | null }>();
    
    if (verifyResult && verifyResult[r2UrlsColumnName]) {
      console.log(`Successfully updated row ${rowId} in ${tableName} with ${r2Urls.length} R2 URLs for field ${fieldName}`);
      console.log(`Verified R2 URLs in column ${r2UrlsColumnName}:`, verifyResult[r2UrlsColumnName]);
    } else {
      console.warn(`Warning: R2 URLs update may not have persisted for row ${rowId} in ${tableName}`);
    }
  } catch (error) {
    console.error(`Error updating row ${rowId} with R2 URLs in ${tableName}:`, error);
    console.error(`Error details:`, error instanceof Error ? error.stack : String(error));
    // Re-throw to surface the error - this is important for sync
    throw error;
  }
}

/**
 * Update existing URLs in database to use optimized format
 */
export async function upgradeUrlsToOptimized(
  db: D1Database,
  tableName: string,
  env: Env
): Promise<{ updated: number; skipped: number }> {
  const baseMaxWidth = getEnvNumber(env, "MAX_IMAGE_WIDTH", 1280);
  const baseMaxHeight = getEnvNumber(env, "MAX_IMAGE_HEIGHT", 1280);
  const baseQuality = getEnvNumber(env, "IMAGE_QUALITY", 85);
  
  // Get all rows with R2 URLs
  const rows = await db.prepare(`
    SELECT id, image_folder_url_r2_urls 
    FROM ${tableName} 
    WHERE image_folder_url_r2_urls IS NOT NULL
  `).all<{ id: number; image_folder_url_r2_urls: string }>();
  
  let updated = 0;
  let skipped = 0;
  
  for (const row of rows.results || []) {
    try {
      const urls = JSON.parse(row.image_folder_url_r2_urls) as string[];
      
      // Check if any URL needs conversion
      if (urls.some(url => !url.includes('/cdn-cgi/image/'))) {
        const optimizedUrls = convertToOptimizedUrls(urls, baseMaxWidth, baseMaxHeight, baseQuality);
        const optimizedJson = JSON.stringify(optimizedUrls);
        
        await db.prepare(`
          UPDATE ${tableName} 
          SET image_folder_url_r2_urls = ?, updated_at = datetime('now')
          WHERE id = ?
        `).bind(optimizedJson, row.id).run();
        
        console.log(`Updated row ${row.id} with optimized URLs`);
        updated++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`Failed to update row ${row.id}:`, error);
    }
  }
  
  return { updated, skipped };
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

