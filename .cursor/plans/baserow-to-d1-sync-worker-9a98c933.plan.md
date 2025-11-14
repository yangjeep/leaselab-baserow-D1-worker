<!-- 9a98c933-6d84-430a-95fd-f60b332e9b23 06cb1928-cb49-47bc-a1f5-a2d2c452dbb0 -->
# Cloudflare Worker: Baserow to D1 Sync with Google Drive and R2 Image Processing

## Overview

Build a Cloudflare Worker that receives authenticated webhooks from Baserow and synchronizes entire database tables to Cloudflare D1. The worker handles `rows.created`, `rows.updated`, and `rows.deleted` events, includes webhook authentication, supports on-demand and hourly sync via cron triggers, processes images from Google Drive folders to R2 with optimization and compression, and maintains comprehensive image tracking records in D1 for sync state management.

**Note**: This worker is being built by refactoring and extending existing worker code that already handles Google Drive to R2 image syncing.

## Architecture

- **Worker**: TypeScript-based Cloudflare Worker with cron triggers
- **Database**: Cloudflare D1 (SQLite-compatible) - created from scratch
- **Storage**: Cloudflare R2 for optimized images (existing)
- **Webhook**: POST endpoint with authentication verification
- **Sync**: Full database sync with dynamic table creation based on Baserow schema
- **API Integration**: Baserow REST API and Google Drive API v3 (existing)
- **Image Processing**: Download from Google Drive folders, optimize, compress, and upload images to R2 (existing logic to be refactored)
- **Image Tracking**: Dedicated D1 table to track all processed images with sync state

## Implementation Steps

### 1. Project Setup

- **UPDATE** existing `wrangler.toml` to add D1 database binding
- **KEEP** existing R2 bucket binding and cron configuration
- **UPDATE** `package.json` if new dependencies needed
- **KEEP** existing `tsconfig.json`

### 2. Baserow API Integration (`src/baserow.ts`)

- **CREATE** new Baserow API client
- Fetch database schema from Baserow API (database_id: 321013)
- Fetch all tables, field definitions, and rows
- Use API token from environment variable

### 3. Google Drive API Integration (`src/google-drive.ts`)

- **EXTRACT** existing Google Drive code from `src/index.ts`
- Move `listDriveFiles`, `downloadDriveFile`, `extractDriveFolderId` functions
- Keep existing functionality for listing files and downloading
- Support API key authentication (already implemented)

### 4. D1 Database Schema Management (`src/schema.ts`)

- **CREATE** new module for D1 schema management
- Create tables dynamically based on Baserow schema
- Create `image_sync_records` table for tracking processed images
- Handle schema migrations

### 5. Image Processing (`src/images.ts`)

- **EXTRACT** existing image processing from `src/index.ts`
- Move `compareAndSyncFile`, `downloadAndUploadFile` functions
- Enhance with Baserow integration (process folders from Baserow fields)
- Add D1 image_sync_records tracking
- Maintain existing optimization/compression logic

### 6. Worker Implementation (`src/index.ts`)

- **REFACTOR** to replace Airtable sync with Baserow webhook handler
- Add webhook endpoint for `rows.created`, `rows.updated`, `rows.deleted`
- Add D1 sync endpoint
- Integrate with existing image processing flow
- Maintain long-running operation support using `ctx.waitUntil()`

### 7. Webhook Authentication (`src/auth.ts`)

- **CREATE** Baserow webhook signature verification

### 8. Types and Utils

- **CREATE** `src/types.ts` for TypeScript definitions
- **CREATE** `src/utils.ts` with utilities (reuse existing `extractDriveFolderId`)

### 9. Error Handling

- Enhance existing error handling with Baserow-specific errors
- Add D1 transaction management
- Improve image record tracking

### 10. Documentation

- **UPDATE** README.md with Baserow integration details
- Add new environment variables documentation
- Maintain existing Google Drive and R2 setup instructions

## Files to Modify/Create

- `wrangler.toml` - **UPDATE**: Add D1 database binding
- `src/index.ts` - **REFACTOR**: Transform from Airtable to Baserow
- `src/baserow.ts` - **CREATE**: Baserow API client
- `src/google-drive.ts` - **EXTRACT**: Move existing Google Drive code
- `src/schema.ts` - **CREATE**: D1 schema management
- `src/images.ts` - **EXTRACT**: Move existing image processing
- `src/auth.ts` - **CREATE**: Webhook authentication
- `src/types.ts` - **CREATE**: TypeScript definitions
- `src/utils.ts` - **CREATE**: Utility functions
- `README.md` - **UPDATE**: Add Baserow docs

## Key Features

- Full database sync (all tables in database 321013)
- Webhook authentication verification
- Handles rows.created, rows.updated, rows.deleted events
- On-demand sync via API endpoint
- Hourly automatic sync via cron trigger
- Google Drive folder integration (existing code to be refactored)
- R2 image processing with optimization (existing code to be refactored)
- Image tracking in D1 with change detection
- Long-running operation support with ctx.waitUntil() (existing)
- Resumable syncs using image records

### To-dos

- [ ] Update existing wrangler.toml to add D1 database binding, keep existing R2 binding and cron configuration
- [ ] Create src/baserow.ts with API client to fetch database schema, tables, fields, and rows using API token authentication
- [ ] Extract existing Google Drive code from src/index.ts into src/google-drive.ts module, keeping existing listDriveFiles and downloadDriveFile functionality
- [ ] Create src/schema.ts for dynamic D1 table creation based on Baserow schema, including field type mapping, migrations, and image_sync_records table for tracking processed images with Google Drive file/folder IDs and indexes
- [ ] Extract existing image processing from src/index.ts into src/images.ts, enhance with Baserow integration (process folders from Baserow fields), add D1 image_sync_records tracking, and maintain existing optimization/compression logic
- [ ] Create src/auth.ts for Baserow webhook signature verification and authentication
- [ ] Refactor src/index.ts to replace Airtable sync with Baserow webhook handler (rows.created/updated/deleted), add D1 sync endpoint, integrate with existing image processing flow, and maintain long-running operation support using ctx.waitUntil()
- [ ] Create src/types.ts for TypeScript definitions and src/utils.ts for field name sanitization, reuse existing extractDriveFolderId function, and add new data transformation utilities
- [ ] Enhance existing error handling with Baserow-specific errors, add D1 transaction management, and improve image record tracking throughout the worker
- [ ] Update README.md with Baserow integration details, new environment variables (BASEROW_API_TOKEN, WEBHOOK_SECRET, D1_DATABASE), Baserow webhook configuration, and maintain existing Google Drive and R2 setup instructions