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
 * Check if image should be converted to WebP
 */
function shouldConvertToWebP(mimeType: string): boolean {
  // Convert JPEG and PNG to WebP for better compression
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

/**
 * Optimize image using Cloudflare's Image Resizing API
 * This function uploads the image to a temporary R2 location, uses the
 * Image Resizing API to get an optimized version, then returns it
 */
async function optimizeImage(
  imageData: ArrayBuffer,
  mimeType: string,
  maxWidth: number,
  maxHeight: number,
  quality: number,
  bucket: R2Bucket,
  tempKey: string,
  r2PublicDomain: string
): Promise<ArrayBuffer> {
  try {
    // Step 1: Upload original to temporary R2 location
    await bucket.put(tempKey, imageData, {
      httpMetadata: {
        contentType: mimeType,
      },
    });
    
    // Step 2: Use Cloudflare Image Resizing API to get optimized version
    // The Image Resizing API is available at: /cdn-cgi/image/
    // Note: This requires the R2 public domain to be on Cloudflare
    const resizeUrl = `${r2PublicDomain}/cdn-cgi/image/width=${maxWidth},height=${maxHeight},quality=${quality},format=auto/${tempKey}`;
    
    // Fetch optimized version with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    try {
      const response = await fetch(resizeUrl, {
        headers: {
          'Accept': 'image/webp,image/*',
        },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.warn(`Image Resizing API failed, using original. Status: ${response.status}`);
        // Clean up temp file
        await bucket.delete(tempKey).catch(() => {});
        return imageData;
      }
      
      const optimizedData = await response.arrayBuffer();
      
      // Step 3: Clean up temporary file
      await bucket.delete(tempKey).catch(() => {});
      
      // Return optimized version if it's actually smaller (at least 5% reduction)
      if (optimizedData.byteLength < imageData.byteLength * 0.95) {
        console.log(`Image optimized: ${imageData.byteLength} -> ${optimizedData.byteLength} bytes (${Math.round((1 - optimizedData.byteLength / imageData.byteLength) * 100)}% reduction)`);
        return optimizedData;
      }
      
      // If optimized isn't significantly smaller, return original
      console.log(`Image optimization didn't reduce size enough, using original`);
      return imageData;
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.warn(`Image Resizing API timeout, using original`);
      } else {
        console.warn(`Image Resizing API error, using original:`, fetchError);
      }
      // Clean up temp file on error
      await bucket.delete(tempKey).catch(() => {});
      return imageData;
    }
  } catch (error) {
    console.warn(`Image optimization failed, using original:`, error);
    // Clean up temp file on error
    await bucket.delete(tempKey).catch(() => {});
    return imageData;
  }
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
      if (existingRecord && existingRecord.status === "processed") {
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
        
        // If no discrepancies and hash matches, skip processing
        if (!needsResync && existingRecord.md5_hash === file.md5Checksum) {
          if (existingRecord.r2_url) {
            r2Urls.push(existingRecord.r2_url);
          }
          continue;
        }
        
        // If there's a discrepancy or hash changed, we'll resync below
        console.log(`Resyncing image: ${file.name}`);
      }
      
      // Also resync if record exists but status is failed
      if (existingRecord && existingRecord.status === "failed") {
        console.log(`Retrying failed image: ${file.name}`);
        // Check if there's an existing R2 URL that might still be valid
        if (existingRecord.r2_url && existingRecord.r2_key) {
          try {
            const r2Object = await bucket.head(existingRecord.r2_key);
            if (r2Object) {
              console.log(`Found existing R2 file for failed image ${file.name}, reusing URL: ${existingRecord.r2_url}`);
              // Reuse existing URL if file still exists
              r2Urls.push(existingRecord.r2_url);
              // Update status to processed since we found a valid file
              await upsertImageSyncRecord(db, {
                google_drive_file_id: file.id,
                google_drive_folder_id: folderId,
                r2_url: existingRecord.r2_url,
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
              continue; // Skip reprocessing if we found a valid existing file
            }
          } catch (r2CheckError) {
            console.log(`Existing R2 file check failed for ${file.name}, will reprocess:`, r2CheckError);
            // Continue with reprocessing
          }
        }
        // Log the previous error for context
        if (existingRecord.error_message) {
          console.log(`Previous error for ${file.name}: ${existingRecord.error_message}`);
        }
      }

      // Download and process image
      console.log(`Downloading image ${file.name} (${file.id}) from Google Drive...`);
      let imageData: ArrayBuffer;
      try {
        imageData = await downloadDriveFile(file.id, accessToken);
        console.log(`Successfully downloaded ${file.name}, size: ${imageData.byteLength} bytes`);
      } catch (downloadError) {
        console.error(`Failed to download ${file.name} from Google Drive:`, downloadError);
        throw new Error(`Download failed: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
      }
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

      // Image optimization/compression
      const maxWidth = getEnvNumber(env, "MAX_IMAGE_WIDTH", 1920);
      const maxHeight = getEnvNumber(env, "MAX_IMAGE_HEIGHT", 1920);
      const quality = getEnvNumber(env, "IMAGE_QUALITY", 85);
      const r2PublicDomain = getEnvString(env, "R2_PUBLIC_DOMAIN", "https://img.rent-in-ottawa.ca");
      
      let optimizedData: ArrayBuffer;
      let optimizedMimeType: string = file.mimeType;
      
      // Generate temporary key for optimization
      const tempKey = `temp/${tableId}/${rowId}/${Date.now()}-${file.id}`;
      
      try {
        optimizedData = await optimizeImage(
          imageData,
          file.mimeType,
          maxWidth,
          maxHeight,
          quality,
          bucket,
          tempKey,
          r2PublicDomain
        );
        
        // Check if optimization was successful and determine mime type
        if (optimizedData !== imageData) {
          const originalSize = imageData.byteLength;
          const optimizedSize = optimizedData.byteLength;
          
          // If optimized is significantly smaller, use it
          if (optimizedSize < originalSize * 0.95) {
            // Check if WebP conversion would be beneficial
            if (shouldConvertToWebP(file.mimeType) && optimizedSize < originalSize * 0.8) {
              optimizedMimeType = "image/webp";
            } else {
              optimizedMimeType = file.mimeType; // Keep original format
            }
          } else {
            // Optimization didn't help much, use original
            optimizedData = imageData;
            optimizedMimeType = file.mimeType;
          }
        } else {
          optimizedMimeType = file.mimeType;
        }
      } catch (error) {
        console.warn(`Image optimization failed for ${file.name}, using original:`, error);
        optimizedData = imageData; // Fallback to original on error
        optimizedMimeType = file.mimeType;
      }
      
      const optimizedSize = optimizedData.byteLength;

      // Generate R2 key - update extension if converted to WebP
      let sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      if (optimizedMimeType === "image/webp" && !sanitizedFilename.toLowerCase().endsWith(".webp")) {
        // Replace extension with .webp
        sanitizedFilename = sanitizedFilename.replace(/\.[^.]+$/, ".webp");
      }
      const r2Key = `${tableId}/${rowId}/${sanitizedFilename}`;
      console.log(`Uploading ${file.name} to R2 with key: ${r2Key}, size: ${optimizedSize} bytes, mimeType: ${optimizedMimeType}`);

      // Upload to R2
      const customMetadata: Record<string, string> = {
        "x-drive-file-id": file.id,
        "x-synced-at": new Date().toISOString(),
      };

      if (file.md5Checksum) {
        customMetadata["x-hash-md5"] = file.md5Checksum;
      }

      try {
        await bucket.put(r2Key, optimizedData, {
          httpMetadata: {
            contentType: optimizedMimeType,
          },
          customMetadata,
        });
        console.log(`Successfully uploaded ${file.name} to R2: ${r2Key}`);
      } catch (uploadError) {
        console.error(`Failed to upload ${file.name} to R2:`, uploadError);
        throw new Error(`R2 upload failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
      }

      // Generate R2 public URL
      const r2Url = `${r2PublicDomain}/${r2Key}`;

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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`Failed to process image ${file.name}:`, errorMessage);
      if (errorStack) {
        console.error(`Error stack for ${file.name}:`, errorStack);
      }
      
      // Record error with detailed information
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
    }
  }

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

