<!-- 9a98c933-6d84-430a-95fd-f60b332e9b23 a7021912-580c-438b-9e90-bf3eebf89e33 -->
# Cloudflare Worker: Baserow to D1 Sync with Google Drive and R2 Image Processing

## Overview

Build a Cloudflare Worker that receives authenticated webhooks from Baserow and synchronizes entire database tables to Cloudflare D1. The worker handles `rows.created`, `rows.updated`, and `rows.deleted` events, includes webhook authentication, supports on-demand and hourly sync via cron triggers, processes images from Google Drive folders to R2 with optimization and compression, and maintains comprehensive image tracking records in D1 for sync state management.

## Architecture

- **Worker**: TypeScript-based Cloudflare Worker with cron triggers
- **Database**: Cloudflare D1 (SQLite-compatible) - created from scratch
- **Storage**: Cloudflare R2 for optimized images
- **Webhook**: POST endpoint with authentication verification
- **Sync**: Full database sync with dynamic table creation based on Baserow schema
- **API Integration**: Baserow REST API and Google Drive API v3
- **Image Processing**: Download from Google Drive folders, optimize, compress, and upload images to R2
- **Image Tracking**: Dedicated D1 table to track all processed images with sync state

## Implementation Steps

### 1. Project Setup

- Initialize Cloudflare Worker project with TypeScript
- Create `wrangler.toml` with:
- D1 database binding
- R2 bucket binding for images
- Cron trigger for hourly sync (0 * * * *)
- Environment variables for secrets
- Set up `package.json` with dependencies:
- crypto for webhook verification
- Image processing capabilities (Web API or compatible library)
- Configure `tsconfig.json` for TypeScript

### 2. Baserow API Integration (`src/baserow.ts`)

- **API Client**:
- Fetch database schema from Baserow API (database_id: 321013)
- Fetch all tables in database
- Fetch table field definitions for each table
- Fetch rows for each table
- Use API token from environment variable for authentication

- **Schema Discovery**:
- Map Baserow field types to SQLite types
- Handle special field types (text, number, date, boolean, link, file, etc.)
- Identify image/file fields for processing (especially "Image Folder URL" fields)
- Generate dynamic table schemas

### 3. Google Drive API Integration (`src/google-drive.ts`)

- **API Client**:
- Extract Google Drive folder ID from URLs (support various URL formats)
- List all files in Google Drive folder using Drive API v3
- Filter for image files only (mimeType starts with "image/")
- Fetch file metadata including MD5 checksum, name, mimeType, and file ID
- Handle pagination for folders with many files
- Download files using Google Drive API

- **Authentication**:
- Support Google Drive API key authentication (for public folders)
- Optional: Support service account authentication
- Use API key from environment variable

### 4. D1 Database Schema Management (`src/schema.ts`)

- **Dynamic Schema Creation**:
- Create tables dynamically based on Baserow schema
- Store table metadata (table_id, field mappings)
- Handle schema migrations when Baserow schema changes
- Create indexes on common fields (id, slug, etc.)

- **Table Structure**:
- Each Baserow table → D1 table
- Store Baserow row ID as primary key
- Map Baserow field names to database columns (sanitize special characters)
- Handle JSON fields (arrays, objects)
- Store R2 URLs for processed images (as JSON array)

- **Image Tracking Table** (`image_sync_records`):
- Track all processed images in a dedicated D1 table
- Fields: `id` (auto-increment), `google_drive_file_id` (TEXT), `google_drive_folder_id` (TEXT), `r2_url` (TEXT), `r2_key` (TEXT), `table_id` (INTEGER), `row_id` (INTEGER), `field_name` (TEXT), `original_size` (INTEGER), `optimized_size` (INTEGER), `status` (TEXT: processed/failed/pending), `processed_at` (TEXT ISO timestamp), `error_message` (TEXT), `md5_hash` (TEXT), `file_name` (TEXT)
- Indexes on `google_drive_file_id`, `google_drive_folder_id`, `r2_key`, `table_id`, `row_id` for fast lookups
- Enable tracking of sync state and prevent duplicate processing
- Support change detection via MD5 hash comparison
- Track which folder each image came from for organization

### 5. Image Processing (`src/images.ts`)

- **Image Detection**:
- Identify image fields in Baserow tables (especially "Image Folder URL" fields)
- Extract Google Drive folder URLs from Baserow fields
- Parse Google Drive folder URLs to extract folder ID
- Handle both direct folder URLs and folder IDs

- **Google Drive Folder Processing**:
- List all files in Google Drive folder using Google Drive API
- Filter for image files only (mimeType starts with "image/")
- Process each image file in the folder

- **Image Record Management**:
- Check `image_sync_records` table before processing each file
- Use Google Drive file ID + MD5 hash for change detection
- Skip images that are already processed and unchanged (using MD5 hash comparison)
- Create/update records for each processed image
- Track processing status (pending, processed, failed)
- Store original and optimized file sizes for metrics
- Update records when images change (hash mismatch)
- Track Google Drive file ID and folder ID in records

- **Image Download & Processing**:
- Download images from Google Drive using file ID
- Check file size before processing (skip if too large or invalid)
- Use Google Drive's MD5 checksum or calculate MD5 hash of original image for change detection
- Optimize/compress images to web-optimized sizes:
  - Resize large images (max width/height constraints, configurable)
  - Compress JPEG/PNG with quality settings (default: 85)
  - Convert to WebP format when beneficial
  - Strip EXIF metadata to reduce file size
- No original size preservation (only store optimized version)

- **R2 Upload**:
- Upload optimized images to R2 bucket
- Store with appropriate content-type headers (image/webp, image/jpeg, etc.)
- Maintain folder structure based on table/row context (e.g., `{table_id}/{row_id}/{filename}`)
- Generate R2 public URLs
- Update image sync record with R2 URL, sizes, hash, and status
- Store Google Drive file ID in R2 metadata for reference

- **Long-Running Operation Support**:
- Process images in batches to avoid timeout
- Use `ctx.waitUntil()` for async operations that extend beyond request timeout
- Implement queue-based processing for large syncs
- Return partial results for long-running syncs
- Support resumable syncs (check existing records to skip processed images)

### 6. Worker Implementation (`src/index.ts`)

- **Webhook Handler** (`/webhook`):
- Verify webhook signature/authentication
- Accept POST requests with JSON payload
- Validate payload structure
- Handle three event types:
  - `rows.created`: Insert new rows, process images from Google Drive folders to R2, create image records
  - `rows.updated`: Update existing rows (use `items` and `old_items`), process new/changed images from folders, update image records
  - `rows.deleted`: Delete rows by `row_ids` array, optionally clean up R2 images and records

- **Sync Endpoints**:
- `POST /sync` or `GET /sync`: On-demand full database sync
- Triggered by cron: Hourly automatic sync
- Fetch all tables and rows from Baserow API
- Upsert all data into D1
- Process and optimize images from Google Drive folders during sync
- Use `ctx.waitUntil()` for long-running image processing
- Return immediate response, process images asynchronously

- **Long-Running Operation Support**:
- Process images asynchronously using `ctx.waitUntil()` to extend operation time
- Batch image processing to avoid memory issues and timeouts
- Support partial syncs (process in chunks)
- Return immediate response with sync status
- Optional: Status endpoint to check sync progress (future enhancement)

- **Data Mapping**:
- Convert Baserow field names to valid SQL identifiers
- Handle null values
- Serialize complex types (arrays, objects) to JSON
- Map field types appropriately
- Update image URLs in row data with R2 URLs after processing (store as JSON array)
- Maintain image sync records for tracking and change detection

### 7. Webhook Authentication (`src/auth.ts`)

- Verify webhook requests from Baserow
- Implement signature verification (HMAC or similar)
- Validate request authenticity
- Reject unauthorized requests

### 8. Error Handling & Logging

- Comprehensive error handling for API failures
- Database transaction management
- Image processing error handling (skip failed images, continue processing, record errors)
- Retry logic for transient failures
- Structured logging for debugging
- Return appropriate HTTP status codes
- Track failed images in `image_sync_records` with error messages

### 9. Configuration

- Environment variables:
- `BASEROW_API_TOKEN` - Baserow API authentication token
- `BASEROW_DATABASE_ID` - Database ID (321013)
- `WEBHOOK_SECRET` - Secret for webhook verification
- `D1_DATABASE` - D1 database binding name
- `R2_BUCKET` - R2 bucket binding for image storage
- `GOOGLE_DRIVE_API_KEY` - Google Drive API key for accessing Drive folders (or `GOOGLE_SERVICE_ACCOUNT_JSON` for service account)
- `MAX_IMAGE_WIDTH` - Maximum image width for optimization (default: 1920)
- `MAX_IMAGE_HEIGHT` - Maximum image height for optimization (default: 1920)
- `IMAGE_QUALITY` - JPEG/WebP quality 0-100 (default: 85)
- `MAX_IMAGE_SIZE` - Maximum file size to process in bytes (default: 10MB)

### 10. Testing & Deployment

- Local testing with `wrangler dev`
- Test webhook authentication
- Test all three event types
- Test on-demand sync endpoint
- Test cron trigger locally
- Test Google Drive folder parsing and file listing
- Test image processing with various formats and sizes
- Test image tracking and change detection
- Test long-running operations with `ctx.waitUntil()`
- Deploy with `wrangler deploy`
- Configure Baserow webhook URL

## Files to Create

- `wrangler.toml` - Worker configuration with cron, D1 binding, and R2 binding
- `package.json` - Dependencies (crypto, fetch utilities, image processing)
- `tsconfig.json` - TypeScript configuration
- `src/index.ts` - Main worker router and handlers
- `src/baserow.ts` - Baserow API client
- `src/google-drive.ts` - Google Drive API client for listing and downloading files
- `src/schema.ts` - D1 schema management, migrations, and image_sync_records table
- `src/images.ts` - Image processing, optimization, R2 upload, and record management
- `src/auth.ts` - Webhook authentication
- `src/types.ts` - TypeScript type definitions
- `src/utils.ts` - Utility functions (field name sanitization, Google Drive URL parsing, etc.)
- `.gitignore` - Git ignore rules
- `README.md` - Setup, deployment, and configuration instructions

## Image Processing Details

- **Google Drive Integration**:
- Extract folder ID from Google Drive folder URLs in Baserow fields
- Use Google Drive API v3 to list files in folder
- Filter for image files (mimeType starts with "image/")
- Fetch file metadata including MD5 checksum for change detection
- Download files using Google Drive API
- Support API key authentication (for public folders) or service account
- **Library**: Use Cloudflare's Web API (Canvas API, ImageBitmap) or compatible image processing
- **Optimization Strategy**:
- Check file size before processing (skip if exceeds MAX_IMAGE_SIZE)
- Resize images exceeding max dimensions (maintain aspect ratio)
- Compress JPEG/PNG with configurable quality
- Convert to WebP when beneficial (better compression)
- Strip EXIF metadata
- **Storage**: Store only optimized versions in R2 (no originals)
- **URL Updates**: Update Baserow row data with R2 URLs after processing (store as JSON array of URLs)
- **Error Handling**: Skip images that fail processing, log errors, continue with other images, record failures in tracking table
- **Folder Processing**: Process all images in a Google Drive folder when folder URL is detected in Baserow field

## Image Tracking Details

- **Purpose**: Track all processed images to enable change detection and prevent duplicate processing
- **Change Detection**: Use MD5 hash comparison (from Google Drive or calculated) to detect when images have changed
- **Sync State**: Track processing status (pending, processed, failed) for monitoring and debugging
- **Metrics**: Store original and optimized file sizes for compression ratio analysis
- **Resumable Syncs**: Check existing records to skip already-processed images during full syncs
- **Error Tracking**: Record error messages for failed image processing attempts
- **Google Drive Tracking**: Track Google Drive file ID and folder ID for reference and organization

## Long-Running Operations

- **Timeout Handling**: Use `ctx.waitUntil()` to extend operation time beyond request timeout (up to 30 seconds for free tier, longer for paid)
- **Batch Processing**: Process images in batches to avoid memory issues and timeouts
- **Resumable Syncs**: Check existing image records to skip already-processed images
- **Async Processing**: Image processing happens asynchronously, doesn't block webhook response
- **Progress Tracking**: Future enhancement - optional status endpoint to track sync progress

## Key Features

- Full database sync (all tables in database 321013)
- Webhook authentication verification
- Handles rows.created, rows.updated, rows.deleted events
- On-demand sync via API endpoint
- Hourly automatic sync via cron trigger
- Dynamic table creation based on Baserow schema
- Baserow API integration with token authentication
- **Google Drive folder integration** - extract folder IDs, list files, download images
- R2 image processing with optimization and compression
- File size checking and validation
- Web-optimized image output (no original preservation)
- **Image tracking in D1 with change detection**
- **Long-running operation support with ctx.waitUntil()**
- **Resumable syncs using image records**

### To-dos

- [ ] Initialize Cloudflare Worker project with TypeScript, wrangler.toml, package.json, and tsconfig.json
- [ ] Create schema.sql with table structure matching Baserow fields (id, order, title, slug, city, address, status, monthly_rent, bedrooms, bathrooms, parking, description, image_folder_url, pets, interest)
- [ ] Implement src/index.ts with webhook handler for rows.created and rows.updated events, including data mapping and D1 upsert operations
- [ ] Add error handling, validation, and logging to the worker
- [ ] Create README.md with setup instructions, deployment steps, and configuration details