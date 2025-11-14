/**
 * Cloudflare Worker to bulk sync images from Google Drive to R2
 * Supports manual HTTP triggers and scheduled cron jobs
 * Uses MD5 hash comparison to only sync changed files
 */

export interface Env {
  R2_BUCKET: R2Bucket;
  GOOGLE_DRIVE_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  AIRTABLE_TOKEN?: string;
  AIRTABLE_BASE_ID?: string;
  AIRTABLE_TABLE_NAME?: string;
  SYNC_SECRET: string;
}

interface Property {
  slug: string;
  imageFolderUrl: string;
  airtableRecordId: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

interface AirtableResponse {
  records: AirtableRecord[];
  offset?: string;
}

interface SyncResult {
  slug: string;
  status: "success" | "failed" | "skipped";
  filesSynced: number;
  filesSkipped: number;
  filesFailed: number;
  filesDeleted: number;
  errors: string[];
}

interface SyncSummary {
  propertiesProcessed: number;
  propertiesSucceeded: number;
  propertiesFailed: number;
  propertiesSkipped: number;
  filesSynced: number;
  filesSkipped: number;
  filesFailed: number;
  filesDeleted: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const url = new URL(request.url);

    // Route: GET /sync or POST /sync
    if (url.pathname === "/sync" || url.pathname === "/") {
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
        return handleBulkSync(env);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  // Cron trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron trigger fired at ${new Date(event.scheduledTime).toISOString()}`);
    try {
      const response = await handleBulkSync(env);
      const result = await response.json();
      console.log("Bulk sync completed:", JSON.stringify(result));
    } catch (error) {
      console.error("Bulk sync failed:", error);
    }
  },
};

/**
 * Main handler for bulk sync
 */
async function handleBulkSync(env: Env): Promise<Response> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    // Validate Airtable credentials
    if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
      return jsonResponse({ 
        error: "Airtable credentials not configured (AIRTABLE_TOKEN, AIRTABLE_BASE_ID required)" 
      }, 500);
    }

    // Validate Google Drive credentials
    const accessToken = await getAccessToken(env);
    if (!accessToken) {
      return jsonResponse({ 
        error: "Google Drive credentials not configured" 
      }, 500);
    }

    console.log("Starting bulk sync...");

    // Fetch all properties from Airtable
    const properties = await fetchProperties(env);
    console.log(`Found ${properties.length} properties with Image Folder URL`);

    if (properties.length === 0) {
      return jsonResponse({
        success: true,
        timestamp,
        summary: {
          propertiesProcessed: 0,
          propertiesSucceeded: 0,
          propertiesFailed: 0,
          propertiesSkipped: 0,
          filesSynced: 0,
          filesSkipped: 0,
          filesFailed: 0,
          filesDeleted: 0,
        },
        details: [],
        message: "No properties with Image Folder URL found",
      });
    }

    // Sync each property
    const results: SyncResult[] = [];
    const summary: SyncSummary = {
      propertiesProcessed: properties.length,
      propertiesSucceeded: 0,
      propertiesFailed: 0,
      propertiesSkipped: 0,
      filesSynced: 0,
      filesSkipped: 0,
      filesFailed: 0,
      filesDeleted: 0,
    };

    for (const property of properties) {
      try {
        const result = await syncProperty(property, env, accessToken);
        results.push(result);

        if (result.status === "success") {
          summary.propertiesSucceeded++;
        } else if (result.status === "skipped") {
          summary.propertiesSkipped++;
        } else {
          summary.propertiesFailed++;
        }

        summary.filesSynced += result.filesSynced;
        summary.filesSkipped += result.filesSkipped;
        summary.filesFailed += result.filesFailed;
        summary.filesDeleted += result.filesDeleted;
      } catch (error) {
        console.error(`Error syncing property ${property.slug}:`, error);
        results.push({
          slug: property.slug,
          status: "failed",
          filesSynced: 0,
          filesSkipped: 0,
          filesFailed: 0,
          filesDeleted: 0,
          errors: [error instanceof Error ? error.message : "Unknown error"],
        });
        summary.propertiesFailed++;
      }
    }

    const duration = Date.now() - startTime;

    return jsonResponse({
      success: true,
      timestamp,
      duration: `${duration}ms`,
      summary,
      details: results,
    });

  } catch (error) {
    console.error("Bulk sync error:", error);
    return jsonResponse({ 
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp,
    }, 500);
  }
}

/**
 * Fetch all properties from Airtable
 */
async function fetchProperties(env: Env): Promise<Property[]> {
  const tableName = env.AIRTABLE_TABLE_NAME || "Properties";
  const properties: Property[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`);
    url.searchParams.set("pageSize", "100");
    if (offset) {
      url.searchParams.set("offset", offset);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Airtable API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as AirtableResponse;

    for (const record of data.records) {
      const imageFolderUrl = record.fields["Image Folder URL"];
      if (!imageFolderUrl) {
        continue; // Skip properties without Image Folder URL
      }

      const rawSlug = record.fields["Slug"];
      const title = record.fields["Title"] || "";
      const slug = rawSlug ? String(rawSlug) : slugify(title);

      if (!slug) {
        console.warn(`Skipping record ${record.id}: no slug or title`);
        continue;
      }

      properties.push({
        slug,
        imageFolderUrl: String(imageFolderUrl),
        airtableRecordId: record.id,
      });
    }

    offset = data.offset;
  } while (offset);

  return properties;
}

/**
 * Sync images for a single property
 */
async function syncProperty(
  property: Property,
  env: Env,
  accessToken: string
): Promise<SyncResult> {
  const result: SyncResult = {
    slug: property.slug,
    status: "success",
    filesSynced: 0,
    filesSkipped: 0,
    filesFailed: 0,
    filesDeleted: 0,
    errors: [],
  };

  try {
    // Extract Google Drive folder ID
    const folderId = extractDriveFolderId(property.imageFolderUrl);
    if (!folderId) {
      result.status = "failed";
      result.errors.push("Invalid Google Drive folder URL");
      return result;
    }

    console.log(`Syncing property: ${property.slug}, folder: ${folderId}`);

    // List image files from Drive folder (with hashes)
    const driveFiles = await listDriveFiles(folderId, accessToken);
    const imageFiles = driveFiles.filter(f => f.mimeType.startsWith("image/"));

    if (imageFiles.length === 0) {
      result.status = "skipped";
      result.errors.push("No image files found in Drive folder");
      return result;
    }

    console.log(`Found ${imageFiles.length} image files for ${property.slug}`);

    // Sync each image file
    for (const file of imageFiles) {
      try {
        const syncResult = await compareAndSyncFile(property.slug, file, env.R2_BUCKET, accessToken);
        if (syncResult.synced) {
          result.filesSynced++;
        } else {
          result.filesSkipped++;
        }
      } catch (error) {
        result.filesFailed++;
        const errorMsg = `Failed to sync ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`;
        result.errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    // Delete orphaned files from R2 (files that exist in R2 but not in Drive)
    // Only delete if Drive folder has files (prevents accidental mass deletion)
    if (imageFiles.length > 0) {
      try {
        const deletedCount = await deleteOrphanedFiles(property.slug, imageFiles, env.R2_BUCKET);
        result.filesDeleted = deletedCount;
        if (deletedCount > 0) {
          console.log(`Deleted ${deletedCount} orphaned files for ${property.slug}`);
        }
      } catch (error) {
        const errorMsg = `Failed to delete orphaned files: ${error instanceof Error ? error.message : "Unknown error"}`;
        result.errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    if (result.filesFailed > 0 && result.filesSynced === 0) {
      result.status = "failed";
    }

  } catch (error) {
    result.status = "failed";
    result.errors.push(error instanceof Error ? error.message : "Unknown error");
  }

  return result;
}

/**
 * Compare file hash and sync if needed
 */
async function compareAndSyncFile(
  slug: string,
  driveFile: DriveFile,
  bucket: R2Bucket,
  accessToken: string
): Promise<{ synced: boolean }> {
  // Sanitize filename
  const sanitizedFilename = driveFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const r2Key = `${slug}/${sanitizedFilename}`;

  // Get hash from R2 if file exists
  const r2Hash = await getR2ObjectHash(bucket, r2Key);

  // If no hash from Drive, we need to download to compute it
  // For now, if Drive doesn't provide hash, we'll sync anyway
  if (!driveFile.md5Checksum) {
    console.log(`No MD5 hash from Drive for ${driveFile.name}, syncing anyway`);
    await downloadAndUploadFile(slug, driveFile, bucket, accessToken);
    return { synced: true };
  }

  // Compare hashes
  if (r2Hash && r2Hash === driveFile.md5Checksum) {
    console.log(`Skipping ${r2Key} - hash matches (${driveFile.md5Checksum})`);
    return { synced: false };
  }

  // Hashes differ or file doesn't exist - sync it
  console.log(`Syncing ${r2Key} - ${r2Hash ? 'hash changed' : 'new file'}`);
  await downloadAndUploadFile(slug, driveFile, bucket, accessToken, driveFile.md5Checksum);
  return { synced: true };
}

/**
 * List all files in R2 for a property slug
 */
async function listR2Files(bucket: R2Bucket, slug: string): Promise<string[]> {
  const prefix = `${slug}/`;
  const files: string[] = [];
  let cursor: string | undefined;

  do {
    const options: { prefix: string; cursor?: string } = {
      prefix,
    };
    if (cursor) {
      options.cursor = cursor;
    }

    const listResult = await bucket.list(options);
    files.push(...listResult.objects.map(obj => obj.key));
    cursor = listResult.truncated ? listResult.cursor : undefined;
  } while (cursor);

  return files;
}

/**
 * Delete orphaned files from R2 that no longer exist in Drive
 */
async function deleteOrphanedFiles(
  slug: string,
  driveFiles: DriveFile[],
  bucket: R2Bucket
): Promise<number> {
  // Create a Set of expected R2 keys from Drive files (using sanitized filenames)
  const expectedKeys = new Set<string>();
  for (const driveFile of driveFiles) {
    const sanitizedFilename = driveFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2Key = `${slug}/${sanitizedFilename}`;
    expectedKeys.add(r2Key);
  }

  // List all existing R2 files for this property
  const r2Files = await listR2Files(bucket, slug);
  let deletedCount = 0;

  // Delete files that exist in R2 but not in expected set
  for (const r2Key of r2Files) {
    if (!expectedKeys.has(r2Key)) {
      try {
        await bucket.delete(r2Key);
        deletedCount++;
        console.log(`Deleted orphaned file: ${r2Key}`);
      } catch (error) {
        console.error(`Failed to delete ${r2Key}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  }

  return deletedCount;
}

/**
 * Get MD5 hash from R2 object metadata
 */
async function getR2ObjectHash(bucket: R2Bucket, key: string): Promise<string | null> {
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
 * Download file from Drive and upload to R2
 */
async function downloadAndUploadFile(
  slug: string,
  driveFile: DriveFile,
  bucket: R2Bucket,
  accessToken: string,
  md5Hash?: string
): Promise<void> {
  // Download image from Drive
  const imageData = await downloadDriveFile(driveFile.id, accessToken);

  // Sanitize filename
  const sanitizedFilename = driveFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const r2Key = `${slug}/${sanitizedFilename}`;

  // Prepare metadata
  const customMetadata: Record<string, string> = {
    "x-drive-file-id": driveFile.id,
    "x-synced-at": new Date().toISOString(),
  };

  if (md5Hash) {
    customMetadata["x-hash-md5"] = md5Hash;
  }

  // Upload to R2
  await bucket.put(r2Key, imageData, {
    httpMetadata: {
      contentType: driveFile.mimeType,
    },
    customMetadata,
  });

  console.log(`Uploaded: ${r2Key} (original: ${driveFile.name})`);
}

/**
 * Extract folder ID from Google Drive URL
 */
function extractDriveFolderId(url: string): string | null {
  if (!url) return null;

  // Match: https://drive.google.com/drive/folders/FOLDER_ID
  const match = url.match(/\/folders\/([A-Za-z0-9_\-]+)/);
  if (match) return match[1];

  // If it's already just an ID
  if (/^[A-Za-z0-9_\-]{10,}$/.test(url)) return url;

  return null;
}

/**
 * Get access token for Google Drive API
 */
async function getAccessToken(env: Env): Promise<string | null> {
  // Option 1: API Key (simpler, for public folders)
  if (env.GOOGLE_DRIVE_API_KEY) {
    return env.GOOGLE_DRIVE_API_KEY;
  }

  // Option 2: Service Account (more secure)
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return await getServiceAccountToken(serviceAccount);
    } catch (error) {
      console.error("Failed to parse service account JSON:", error);
      return null;
    }
  }

  return null;
}

/**
 * Get OAuth2 token from service account
 */
async function getServiceAccountToken(serviceAccount: any): Promise<string> {
  const jwtHeader = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  const now = Math.floor(Date.now() / 1000);
  const jwtClaimSet = btoa(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  // Note: In production, you'd need to sign this JWT with the private key
  // This is a simplified version - consider using a library or external service
  // For now, we'll use API key approach which is simpler for Workers

  throw new Error("Service account not fully implemented - use GOOGLE_DRIVE_API_KEY instead");
}

/**
 * List image files in a Google Drive folder (with MD5 hashes)
 */
async function listDriveFiles(folderId: string, accessToken: string): Promise<DriveFile[]> {
  const isApiKey = !accessToken.includes(".");
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,md5Checksum),nextPageToken",
      pageSize: "100",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    // Add auth based on type
    if (isApiKey) {
      params.set("key", accessToken);
    }

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const headers: HeadersInit = {};

    if (!isApiKey) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Drive API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as DriveListResponse;
    files.push(...data.files);
    pageToken = data.nextPageToken;

  } while (pageToken);

  // Sort files by name for consistent ordering
  files.sort((a, b) => a.name.localeCompare(b.name));

  return files;
}

/**
 * Download a file from Google Drive
 */
async function downloadDriveFile(fileId: string, accessToken: string): Promise<ArrayBuffer> {
  const isApiKey = !accessToken.includes(".");
  const params = new URLSearchParams();

  if (isApiKey) {
    params.set("key", accessToken);
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&${params.toString()}`;
  const headers: HeadersInit = {};

  if (!isApiKey) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }

  return await response.arrayBuffer();
}

/**
 * Slugify a string (simple version)
 */
function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Helper to create JSON response
 */
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

