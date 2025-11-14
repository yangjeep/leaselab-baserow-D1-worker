/**
 * TypeScript type definitions for Baserow to D1 sync worker
 */

export interface Env {
  D1_DATABASE: D1Database;
  R2_BUCKET?: R2Bucket;
  GOOGLE_DRIVE_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  BASEROW_API_TOKEN?: string;
  BASEROW_DATABASE_ID?: string;
  BASEROW_TABLE_ID?: string;
  WEBHOOK_SECRET?: string;
  SYNC_SECRET?: string;
  MAX_IMAGE_WIDTH?: string;
  MAX_IMAGE_HEIGHT?: string;
  IMAGE_QUALITY?: string;
  MAX_IMAGE_SIZE?: string;
}

// Baserow API Types
export interface BaserowTable {
  id: number;
  name: string;
  order: number;
  database: number;
}

export interface BaserowField {
  id: number;
  name: string;
  type: string;
  table: number;
  order: number;
  primary?: boolean;
  read_only?: boolean;
}

export interface BaserowRow {
  id: number;
  order: string;
  [key: string]: any;
}

export interface BaserowWebhookPayload {
  table_id: number;
  database_id: number;
  workspace_id: number;
  event_id: string;
  event_type: "rows.created" | "rows.updated" | "rows.deleted";
  items?: BaserowRow[];
  old_items?: BaserowRow[];
  row_ids?: number[];
}

// Google Drive Types
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
}

export interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

// Image Sync Record Types
export interface ImageSyncRecord {
  id?: number;
  google_drive_file_id: string;
  google_drive_folder_id: string;
  r2_url: string | null;
  r2_key: string | null;
  table_id: number;
  row_id: number;
  field_name: string;
  original_size: number | null;
  optimized_size: number | null;
  status: "processed" | "failed" | "pending";
  processed_at: string | null;
  error_message: string | null;
  md5_hash: string | null;
  file_name: string;
}

// Sync Result Types
export interface SyncResult {
  table_id: number;
  row_id: number;
  status: "success" | "failed" | "skipped";
  imagesProcessed: number;
  imagesSkipped: number;
  imagesFailed: number;
  errors: string[];
}

export interface SyncSummary {
  tablesProcessed: number;
  tablesSucceeded: number;
  tablesFailed: number;
  rowsProcessed: number;
  rowsSucceeded: number;
  rowsFailed: number;
  imagesProcessed: number;
  imagesSkipped: number;
  imagesFailed: number;
}

