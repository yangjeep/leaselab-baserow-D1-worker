/**
 * Image processing and R2 upload
 * Uses @jsquash WASM-based image processing
 */

import type { DriveFile, Env, ImageSyncRecord } from "./types";
import { extractDriveFolderId, sanitizeFieldName } from "./utils";
import { listDriveFiles, downloadDriveFile, getAccessToken } from "./google-drive";
import { getEnvNumber, getEnvString } from "./utils";
import { getTableColumns } from "./schema";
import resize from "@jsquash/resize";
import { encode as encodeJpeg } from "@jsquash/jpeg";
import { encode as encodeWebp } from "@jsquash/webp";

// Type definitions for browser APIs available in Cloudflare Workers
declare function createImageBitmap(blob: Blob): Promise<ImageBitmap>;
declare class OffscreenCanvas {
  constructor(width: number, height: number);
  getContext(contextId: "2d"): OffscreenCanvasRenderingContext2D | null;
  width: number;
  height: number;
}
interface OffscreenCanvasRenderingContext2D {
  drawImage(image: ImageBitmap, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}
interface ImageBitmap {
  readonly width: number;
  readonly height: number;
}
interface ImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Check if image should be converted to WebP
 */
function shouldConvertToWebP(mimeType: string): boolean {
  // Convert JPEG and PNG to WebP for better compression
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

/**
 * Calculate optimal resize parameters based on image size
 * Larger images get more aggressive resizing and lower quality
 */
function calculateOptimalResizeParams(
  originalSize: number,
  baseMaxWidth: number,
  baseMaxHeight: number,
  baseQuality: number
): { maxWidth: number; maxHeight: number; quality: number } {
  const sizeMB = originalSize / (1024 * 1024);
  
  // For very large images (>20MB), use aggressive settings
  if (sizeMB > 20) {
    return {
      maxWidth: Math.floor(baseMaxWidth * 0.6), // 60% of base width
      maxHeight: Math.floor(baseMaxHeight * 0.6), // 60% of base height
      quality: Math.max(70, baseQuality - 15), // Lower quality by 15, min 70
    };
  }
  
  // For large images (10-20MB), use moderate settings
  if (sizeMB > 10) {
    return {
      maxWidth: Math.floor(baseMaxWidth * 0.75), // 75% of base width
      maxHeight: Math.floor(baseMaxHeight * 0.75), // 75% of base height
      quality: Math.max(75, baseQuality - 10), // Lower quality by 10, min 75
    };
  }
  
  // For medium images (5-10MB), use slightly reduced settings
  if (sizeMB > 5) {
    return {
      maxWidth: Math.floor(baseMaxWidth * 0.85), // 85% of base width
      maxHeight: Math.floor(baseMaxHeight * 0.85), // 85% of base height
      quality: Math.max(80, baseQuality - 5), // Lower quality by 5, min 80
    };
  }
  
  // For smaller images (<5MB), use base settings
  return {
    maxWidth: baseMaxWidth,
    maxHeight: baseMaxHeight,
    quality: baseQuality,
  };
}

/**
 * Decode image from ArrayBuffer to ImageData
 */
async function decodeImage(imageData: ArrayBuffer, mimeType: string): Promise<ImageData> {
  // Create a blob from the ArrayBuffer
  const blob = new Blob([imageData], { type: mimeType });
  
  // Use native browser ImageBitmap API (available in Workers)
  const imageBitmap = await createImageBitmap(blob);
  
  // Create canvas and get ImageData
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }
  
  ctx.drawImage(imageBitmap, 0, 0);
  return ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height);
}

/**
 * Calculate optimal dimensions maintaining aspect ratio
 */
function calculateDimensions(
  originalWidth: number,
  originalHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  let width = originalWidth;
  let height = originalHeight;
  
  // Only resize if image is larger than max dimensions
  if (width > maxWidth || height > maxHeight) {
    const aspectRatio = width / height;
    
    if (width > height) {
      width = Math.min(width, maxWidth);
      height = Math.round(width / aspectRatio);
    } else {
      height = Math.min(height, maxHeight);
      width = Math.round(height * aspectRatio);
    }
    
    // Ensure we don't exceed max dimensions
    if (width > maxWidth) {
      width = maxWidth;
      height = Math.round(width / aspectRatio);
    }
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height * aspectRatio);
    }
  }
  
  return { width, height };
}

/**
 * Optimize image using WASM-based processing (@jsquash)
 * This function decodes, resizes, and re-encodes the image
 */
async function optimizeImage(
  imageData: ArrayBuffer,
  mimeType: string,
  maxWidth: number,
  maxHeight: number,
  quality: number,
  originalSize?: number
): Promise<{ data: ArrayBuffer; mimeType: string }> {
  try {
    console.log(`Starting WASM-based optimization: target ${maxWidth}x${maxHeight}, quality ${quality}`);
    
    // Decode image to ImageData
    const imageDataObj = await decodeImage(imageData, mimeType);
    const originalWidth = imageDataObj.width;
    const originalHeight = imageDataObj.height;
    
    console.log(`Original dimensions: ${originalWidth}x${originalHeight}`);
    
    // Calculate target dimensions
    const { width, height } = calculateDimensions(originalWidth, originalHeight, maxWidth, maxHeight);
    
    console.log(`Target dimensions: ${width}x${height}`);
    
    // Resize if needed
    let resizedImageData = imageDataObj;
    if (width !== originalWidth || height !== originalHeight) {
      resizedImageData = await resize(imageDataObj, {
        width,
        height,
      });
      console.log(`Resized to ${width}x${height}`);
    }
    
    // Encode to WebP for best compression (or JPEG as fallback)
    let encoded: ArrayBuffer;
    let outputMimeType: string;
    
    if (shouldConvertToWebP(mimeType)) {
      try {
        encoded = await encodeWebp(resizedImageData, { quality });
        outputMimeType = "image/webp";
        console.log(`Encoded as WebP with quality ${quality}`);
      } catch (webpError) {
        console.warn(`WebP encoding failed, falling back to JPEG:`, webpError);
        encoded = await encodeJpeg(resizedImageData, { quality });
        outputMimeType = "image/jpeg";
        console.log(`Encoded as JPEG with quality ${quality}`);
      }
    } else {
      encoded = await encodeJpeg(resizedImageData, { quality });
      outputMimeType = "image/jpeg";
      console.log(`Encoded as JPEG with quality ${quality}`);
    }
    
    // Check if optimization was successful
    if (encoded.byteLength < imageData.byteLength * 0.95) {
      const reduction = Math.round((1 - encoded.byteLength / imageData.byteLength) * 100);
      console.log(`✅ Image optimized: ${imageData.byteLength} -> ${encoded.byteLength} bytes (${reduction}% reduction)`);
      return { data: encoded, mimeType: outputMimeType };
    }
    
    // If not significantly smaller, return original
    console.log(`Optimization didn't reduce size enough, using original`);
    return { data: imageData, mimeType };
    
  } catch (error) {
    console.warn(`Image optimization failed, using original:`, error);
    return { data: imageData, mimeType };
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
  fieldName: string
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
        console.log(`Found existing R2 file for failed image ${file.name}, reusing URL: ${existingRecord.r2_url}`);
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
        return existingRecord.r2_url;
      }
    } catch (r2CheckError) {
      console.log(`Existing R2 file check failed for ${file.name}, will reprocess:`, r2CheckError);
    }
  }
  
  return null; // Need to reprocess
}

/**
 * Download and validate image from Google Drive
 */
async function downloadAndValidateImage(
  file: DriveFile,
  accessToken: string,
  maxImageSize: number
): Promise<{ imageData: ArrayBuffer; originalSize: number }> {
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
  const maxImageSizeMB = (maxImageSize / (1024 * 1024)).toFixed(2);
  const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(2);
  console.log(`Checking file size for ${file.name}: ${originalSizeMB}MB (recommended max: ${maxImageSizeMB}MB)`);

  // Warn if large but proceed with aggressive optimization
  if (originalSize > maxImageSize) {
    console.warn(`⚠️  Large image detected: ${file.name} is ${originalSizeMB}MB (exceeds recommended ${maxImageSizeMB}MB). Will apply aggressive resizing and compression.`);
  } else {
    console.log(`File size check passed for ${file.name}, proceeding with processing...`);
  }
  
  return { imageData, originalSize };
}

/**
 * Optimize image with iterative compression
 */
async function optimizeImageIteratively(
  file: DriveFile,
  imageData: ArrayBuffer,
  originalSize: number,
  env: Env
): Promise<{ data: ArrayBuffer; mimeType: string; size: number }> {
  const baseMaxWidth = getEnvNumber(env, "MAX_IMAGE_WIDTH", 1280);
  const baseMaxHeight = getEnvNumber(env, "MAX_IMAGE_HEIGHT", 1280);
  const baseQuality = getEnvNumber(env, "IMAGE_QUALITY", 85);
  
  // Threshold for direct upload without optimization (2MB)
  const directUploadThreshold = 2 * 1024 * 1024;
  const sizeMB = (originalSize / (1024 * 1024)).toFixed(2);
  
  // For small images, skip optimization
  if (originalSize <= directUploadThreshold) {
    console.log(`Image ${file.name} (${sizeMB}MB) is small enough, uploading directly without optimization`);
    return { data: imageData, mimeType: file.mimeType, size: originalSize };
  }
  
  // Calculate optimal resize parameters
  const resizeParams = calculateOptimalResizeParams(
    originalSize,
    baseMaxWidth,
    baseMaxHeight,
    baseQuality
  );
  
  console.log(`Optimizing ${file.name} (${sizeMB}MB): width=${resizeParams.maxWidth}, height=${resizeParams.maxHeight}, quality=${resizeParams.quality}`);
  
  const targetSize = 1024 * 1024; // 1MB target
  let currentParams = { ...resizeParams };
  let attempts = 0;
  const maxAttempts = 3;
  
  let optimizedData: ArrayBuffer;
  let optimizedMimeType: string;
  let optimizedSize: number;
  
  try {
    do {
      attempts++;
      
      const result = await optimizeImage(
        imageData,
        file.mimeType,
        currentParams.maxWidth,
        currentParams.maxHeight,
        currentParams.quality,
        originalSize
      );
      
      optimizedData = result.data;
      optimizedMimeType = result.mimeType;
      optimizedSize = optimizedData.byteLength;
      
      // Check if we've reached target size
      if (optimizedSize < targetSize) {
        console.log(`Image ${file.name} optimized to ${(optimizedSize / 1024).toFixed(2)}KB (target: <1MB achieved)`);
        break;
      }
      
      // Apply more aggressive settings for next attempt
      if (attempts < maxAttempts && optimizedSize >= targetSize) {
        console.log(`Image ${file.name} still ${(optimizedSize / 1024 / 1024).toFixed(2)}MB after attempt ${attempts}, applying more aggressive optimization...`);
        currentParams.maxWidth = Math.floor(currentParams.maxWidth * 0.8);
        currentParams.maxHeight = Math.floor(currentParams.maxHeight * 0.8);
        currentParams.quality = Math.max(60, currentParams.quality - 5);
      } else {
        if (optimizedSize >= targetSize) {
          console.warn(`⚠️  Image ${file.name} is ${(optimizedSize / 1024 / 1024).toFixed(2)}MB after ${attempts} attempts (target: <1MB not achieved)`);
        }
        break;
      }
    } while (attempts < maxAttempts && optimizedSize >= targetSize);
    
    return { data: optimizedData, mimeType: optimizedMimeType, size: optimizedSize };
    
  } catch (error) {
    console.warn(`Image optimization failed for ${file.name}, using original:`, error);
    return { data: imageData, mimeType: file.mimeType, size: originalSize };
  }
}

/**
 * Upload optimized image to R2
 */
async function uploadImageToR2(
  file: DriveFile,
  optimizedData: ArrayBuffer,
  optimizedMimeType: string,
  optimizedSize: number,
  bucket: R2Bucket,
  env: Env,
  tableId: number,
  rowId: number
): Promise<{ r2Url: string; r2Key: string }> {
  // Check if final image is suspiciously small
  const minSizeThreshold = 200 * 1024; // 200KB
  if (optimizedSize < minSizeThreshold) {
    console.warn(`⚠️  Warning: Image ${file.name} is very small (${(optimizedSize / 1024).toFixed(2)}KB), which may indicate an issue with optimization or the source image`);
  }
  
  // Generate R2 key
  let sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (optimizedMimeType === "image/webp" && !sanitizedFilename.toLowerCase().endsWith(".webp")) {
    sanitizedFilename = sanitizedFilename.replace(/\.[^.]+$/, ".webp");
  }
  const r2Key = `${tableId}/${rowId}/${sanitizedFilename}`;
  const finalSizeMB = (optimizedSize / 1024 / 1024).toFixed(2);
  console.log(`Uploading ${file.name} to R2 with key: ${r2Key}, size: ${finalSizeMB}MB (${(optimizedSize / 1024).toFixed(2)}KB), mimeType: ${optimizedMimeType}`);

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

  const r2PublicDomain = getEnvString(env, "R2_PUBLIC_DOMAIN", "https://img.rent-in-ottawa.ca");
  const r2Url = `${r2PublicDomain}/${r2Key}`;
  
  return { r2Url, r2Key };
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
  fieldName: string,
  maxImageSize: number
): Promise<string | null> {
  try {
    // Check if already processed
    const existingRecord = await getImageSyncRecord(db, file.id);
    
    if (existingRecord && existingRecord.status === "processed") {
      const syncCheck = await shouldResyncImage(existingRecord, file, bucket);
      if (syncCheck.canReuseUrl && syncCheck.existingUrl) {
        return syncCheck.existingUrl;
      }
      if (syncCheck.needsResync) {
        console.log(`Resyncing image: ${file.name}`);
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
        fieldName
      );
      if (recoveredUrl) {
        return recoveredUrl;
      }
    }

    // Download and validate
    const { imageData, originalSize } = await downloadAndValidateImage(
      file,
      accessToken,
      maxImageSize
    );

    // Optimize
    const { data: optimizedData, mimeType: optimizedMimeType, size: optimizedSize } = 
      await optimizeImageIteratively(file, imageData, originalSize, env);

    // Upload to R2
    const { r2Url, r2Key } = await uploadImageToR2(
      file,
      optimizedData,
      optimizedMimeType,
      optimizedSize,
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
      optimized_size: optimizedSize,
      status: "processed",
      processed_at: new Date().toISOString(),
      error_message: null,
      md5_hash: file.md5Checksum || null,
      file_name: file.name,
    });

    console.log(`Processed image: ${file.name} -> ${r2Key}`);
    return r2Url;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`Failed to process image ${file.name}:`, errorMessage);
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
    return [];
  }

  const maxImageSize = getEnvNumber(env, "MAX_IMAGE_SIZE", 10 * 1024 * 1024);
  const maxImageSizeMB = (maxImageSize / (1024 * 1024)).toFixed(2);
  console.log(`Processing images from folder ${folderId} for row ${rowId}, field ${fieldName}. Max image size: ${maxImageSizeMB}MB`);

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
      fieldName,
      maxImageSize
    );
    
    if (r2Url) {
      r2Urls.push(r2Url);
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

