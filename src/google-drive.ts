/**
 * Google Drive API integration
 * Extracted from existing worker code
 */

import type { DriveFile, DriveListResponse, Env } from "./types";

/**
 * Get access token for Google Drive API
 */
export async function getAccessToken(env: Env): Promise<string | null> {
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
export async function listDriveFiles(folderId: string, accessToken: string): Promise<DriveFile[]> {
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
export async function downloadDriveFile(fileId: string, accessToken: string): Promise<ArrayBuffer> {
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

