# Baserow to D1 Sync Worker

Cloudflare Worker that synchronizes Baserow database tables to Cloudflare D1 and processes images from Google Drive folders to R2. Supports webhooks, manual HTTP triggers, and scheduled cron jobs. Uses MD5 hash comparison to only sync changed files, reducing bandwidth and processing time.

## Features

- **Full Database Sync**: Syncs entire Baserow database to D1 with dynamic table creation
- **Webhook Support**: Real-time sync via Baserow webhooks (rows.created, rows.updated, rows.deleted)
- **Image Processing**: Processes images from Google Drive folders to R2 with optimization
- **Image Tracking**: Tracks all processed images in D1 for change detection and resumable syncs
- **Hash Comparison**: Only syncs files that have changed (MD5 hash comparison)
- **Scheduled Sync**: Automatic sync via cron triggers (configurable schedule)
- **Manual Trigger**: On-demand sync via HTTP endpoint
- **Long-Running Operations**: Uses `ctx.waitUntil()` for async image processing

## Prerequisites

Before deploying the worker, ensure you have:

1. **Cloudflare D1 Database** created and configured
   - Production: `rio-baserow-core`
   - Demo: `rio-baserow-core-demo`
   - Create with: `npx wrangler d1 create riocore`
2. **Cloudflare R2 Buckets** created and configured
   - Production: `rio-images`
   - Demo: `rio-images-demo`
3. **Google Drive API Key**
   - The Drive folders must be set to "Anyone with the link can view"
4. **Baserow Database** with:
   - Database ID (default: 321013)
   - Tables with image fields containing Google Drive folder URLs
   - Baserow API token with read access

## Environments

The worker supports two environments:

- **Production** (default): Uses `rio-baserow-core` D1 database and `rio-images` R2 bucket
- **Demo**: Uses `rio-baserow-core-demo` D1 database and `rio-images-demo` R2 bucket

Each environment has its own:
- Worker deployment (separate URLs)
- D1 database binding
- R2 bucket binding
- Secrets and configuration
- Cron schedule (can be different)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create D1 Databases

**For Production:**
```bash
npx wrangler d1 create riocore
```

Copy the `database_id` from the output and update `wrangler.toml`:
```toml
[[d1_databases]]
binding = "D1_DATABASE"
database_name = "rio-baserow-core"
database_id = "your-database-id-here"
```

**For Demo:**
```bash
npx wrangler d1 create riocore-demo --env demo
```

Copy the `database_id` from the output and update `wrangler.toml`:
```toml
[[env.demo.d1_databases]]
binding = "D1_DATABASE"
database_name = "rio-baserow-core-demo"
database_id = "your-database-id-here"
```

Update `wrangler.toml` with the demo database ID.

### 3. Configure Secrets

Secrets are configured per environment. You can use the same secrets for both environments or different ones.

#### For Production Environment:

**Required secrets:**

```bash
# Google Drive API key
npx wrangler secret put GOOGLE_DRIVE_API_KEY
# When prompted, paste your Google Drive API key

# Baserow API token
npx wrangler secret put BASEROW_API_TOKEN
# When prompted, paste your Baserow API token

# Baserow Database ID (optional, defaults to 321013)
npx wrangler secret put BASEROW_DATABASE_ID
# When prompted, paste your Baserow database ID

# Webhook secret for Baserow webhook verification
npx wrangler secret put WEBHOOK_SECRET
# When prompted, paste a secret (e.g., random UUID)
# This should match the secret configured in Baserow webhook settings

# Bearer token for securing manual trigger endpoint (required)
npx wrangler secret put SYNC_SECRET
# When prompted, paste a secret (e.g., random UUID)
# Manual triggers require: Authorization: Bearer <secret>
```

#### For Demo Environment:

```bash
# Same secrets, but with --env demo flag
npx wrangler secret put GOOGLE_DRIVE_API_KEY --env demo
npx wrangler secret put BASEROW_API_TOKEN --env demo
npx wrangler secret put BASEROW_DATABASE_ID --env demo
npx wrangler secret put WEBHOOK_SECRET --env demo
npx wrangler secret put SYNC_SECRET --env demo  # Required
```

**Note:** 
- Secrets are stored securely by Cloudflare and are not visible in your code
- D1 database and R2 bucket names are already configured in `wrangler.toml`
- **Important:** `SYNC_SECRET` is required - the worker will return 500 error if not configured, and all HTTP requests require valid Bearer token authentication

### 4. Configure Baserow Webhook

1. Go to your Baserow workspace settings
2. Navigate to Webhooks section
3. Create a new webhook with:
   - **URL**: `https://baserow-rio-sync.rent-in-ottawa.ca/webhook`
   - **Events**: Select `rows.created`, `rows.updated`, `rows.deleted`
   - **Secret**: Use the same value as `WEBHOOK_SECRET` in your worker secrets
4. Save the webhook

### 5. Configure Cron Schedule (Optional)

Edit `wrangler.toml` to adjust the cron schedule:

```toml
[triggers]
crons = ["0 * * * *"]  # Every hour (default)
```

**Common schedules:**
- `"0 * * * *"` - Every hour
- `"0 0 * * *"` - Daily at midnight
- `"0 */6 * * *"` - Every 6 hours
- `"0 0 * * 0"` - Weekly on Sunday

To disable cron, comment out or remove the `[triggers]` section.

### 6. Local Development (Optional)

Test the worker locally before deploying:

**For Production:**
```bash
npm run dev
```

**For Demo:**
```bash
npm run dev:demo
```

The worker will be available at `http://localhost:8787`

To test locally, create `.dev.vars` file in the worker directory:

```bash
# Create .dev.vars file
cat > .dev.vars << EOF
GOOGLE_DRIVE_API_KEY=your-api-key-here
BASEROW_API_TOKEN=your-baserow-token-here
BASEROW_DATABASE_ID=321013
WEBHOOK_SECRET=your-webhook-secret-here
SYNC_SECRET=your-secret-here  # Required - use a secure random string
EOF
```

**Note:** Add `.dev.vars` to `.gitignore` to avoid committing secrets.

### 7. Deploy to Cloudflare

**Deploy to Production:**
```bash
npm run deploy:prod
# or simply
npm run deploy
```

**Deploy to Demo:**
```bash
npm run deploy:demo
```

After deployment, note the Worker URL from the output:

**Production:**
```
✨  Deployed to https://baserow-rio-sync.rent-in-ottawa.ca
```

**Demo:**
```
✨  Deployed to https://rio-baserow-demo.workers.dev
```

**Endpoints:**
- Webhook: `https://baserow-rio-sync.rent-in-ottawa.ca/webhook`
- Sync: `https://baserow-rio-sync.rent-in-ottawa.ca/sync`
- Health: `https://baserow-rio-sync.rent-in-ottawa.ca/health`

## Usage

### Webhook Endpoint

The worker automatically receives webhooks from Baserow when rows are created, updated, or deleted. Configure the webhook URL in Baserow settings.

**Webhook Events:**
- `rows.created`: New rows are synced to D1 and images are processed
- `rows.updated`: Updated rows are synced to D1 and changed images are processed
- `rows.deleted`: Rows are deleted from D1 and associated images are cleaned up

### Manual Sync

Trigger a full database sync manually via HTTP:

**Production:**
```bash
# Authentication is required - Bearer token must be provided
curl -H "Authorization: Bearer your-secret-here" \
  https://baserow-rio-sync.rent-in-ottawa.ca/sync
```

**Demo:**
```bash
# Authentication is required - Bearer token must be provided
curl -H "Authorization: Bearer your-secret-here" \
  https://rio-baserow-demo.workers.dev/sync
```

**Response:**
```json
{
  "success": true,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "duration": "45230ms",
  "summary": {
    "tablesProcessed": 5,
    "tablesSucceeded": 5,
    "tablesFailed": 0,
    "rowsProcessed": 150,
    "rowsSucceeded": 148,
    "rowsFailed": 2,
    "imagesProcessed": 45,
    "imagesSkipped": 10,
    "imagesFailed": 2
  }
}
```

### Scheduled Sync (Cron)

The worker automatically runs on the schedule configured in `wrangler.toml`. No action needed - it will sync the entire database periodically.

**View cron execution logs:**
```bash
npx wrangler tail
```

## How It Works

### Database Sync

1. **Fetch Schema**: Worker fetches all tables and fields from Baserow API
2. **Create Tables**: Dynamically creates D1 tables based on Baserow schema
3. **Sync Rows**: Fetches all rows and syncs them to D1
4. **Schema Migrations**: Automatically adds new columns when Baserow schema changes

### Image Processing

1. **Detect Image Fields**: Identifies fields containing Google Drive folder URLs
2. **List Files**: For each folder URL, lists all image files in the Google Drive folder
3. **Check Records**: Queries D1 `image_sync_records` table to check if image was already processed
4. **Hash Comparison**: Compares MD5 hash from Google Drive with stored hash
5. **Process Images**: Downloads, optimizes (future), and uploads to R2
6. **Update Records**: Creates/updates image sync records in D1

### Image Tracking

All processed images are tracked in the `image_sync_records` table with:
- Google Drive file ID and folder ID
- R2 URL and key
- Processing status (processed/failed/pending)
- Original and optimized file sizes
- MD5 hash for change detection
- Error messages for failed processing

## Hash Comparison

The worker uses MD5 hash comparison to avoid unnecessary downloads:

- **Google Drive** provides `md5Checksum` for each file via API
- **D1** stores hash in `image_sync_records` table
- **Comparison**: Only files with different hashes are downloaded and uploaded
- **Result**: Significant bandwidth and time savings, especially for large image catalogs

**First sync**: All files are uploaded (no existing hashes to compare)

**Subsequent syncs**: Only changed files are synced

## Image Storage Details

- **Location:** Images are stored in R2 at `{table_id}/{row_id}/{filename}`
- **Filename Preservation:** Original filenames from Google Drive are preserved (special characters are sanitized)
- **Metadata:** Each image includes:
  - `x-hash-md5`: MD5 hash for change detection
  - `x-drive-file-id`: Google Drive file ID for reference
  - `x-synced-at`: ISO timestamp of last sync
- **Sorting:** Images are sorted alphabetically by filename in Google Drive
- **Supported Formats:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`

## API Endpoints

### POST /webhook

Receives webhooks from Baserow.

**Headers:**
- `X-Baserow-Signature`: Webhook signature (verified against WEBHOOK_SECRET)
- `Content-Type`: application/json

**Response:**
- `200 OK` - Webhook received and queued for processing
- `401 Unauthorized` - Invalid webhook signature

### GET /sync or POST /sync

Triggers a full database sync.

**Headers (required):**
- `Authorization: Bearer <SYNC_SECRET>` - Bearer token authentication is required

**Response:**
- `200 OK` - Sync completed (check `summary` for details)
- `401 Unauthorized` - Missing or invalid Bearer token
- `500 Internal Server Error` - Configuration or API errors

## Monitoring

### View Worker Logs

Monitor worker execution in real-time:

```bash
npx wrangler tail
```

This shows:
- All HTTP requests
- Webhook events
- Cron trigger executions
- Sync progress and errors
- Hash comparison results

### Verify Data in D1

After a sync, verify data is in your D1 database:

1. Go to Cloudflare Dashboard → D1
2. Select your database:
   - Production: `rio-baserow-core`
   - Demo: `rio-baserow-core-demo`
3. Run queries to check synced tables and image records

### Verify Images in R2

After a sync, verify images are in your R2 bucket:

1. Go to Cloudflare Dashboard → R2
2. Select your bucket:
   - Production: `rio-images`
   - Demo: `rio-images-demo`
3. Navigate to a table/row folder (e.g., `740124/12345/`)
4. You should see all uploaded images with their original filenames
5. Check object metadata to see stored hashes

## Troubleshooting

### Sync Returns 500 Error

- **Check worker logs:** `npx wrangler tail`
- **Verify secrets:** Ensure all required secrets are set
- **Check Baserow access:** Verify token has read access to database
- **Check Drive access:** Verify API key works and folders are public
- **Check D1 database:** Ensure database is created and binding is correct

### Webhook Not Working

- **Check webhook URL:** Verify the URL in Baserow matches your worker URL
- **Check webhook secret:** Ensure WEBHOOK_SECRET matches Baserow webhook secret
- **Check logs:** Look for signature verification errors
- **Test manually:** Try sending a test webhook

### No Images Processed

- **Check Baserow fields:** Ensure image fields contain Google Drive folder URLs
- **Check Drive folders:** Verify folders contain image files
- **Check folder permissions:** Folders must be "Anyone with the link can view"
- **Check logs:** Look for specific error messages

### Images Not Skipping (Always Processing)

- **Check image records:** Verify `image_sync_records` table has records
- **Check hash storage:** Verify records have `md5_hash` values
- **First sync is normal:** All files process on first run
- **Check logs:** Look for hash comparison messages

### Cron Not Running

- **Check wrangler.toml:** Verify `[triggers]` section exists
- **Check deployment:** Ensure worker is deployed with cron config
- **Check logs:** `npx wrangler tail` to see if cron triggers appear
- **Verify schedule:** Check cron expression is valid

## Performance Considerations

- **Async Processing**: Images are processed asynchronously using `ctx.waitUntil()`
- **Hash Comparison**: Significantly reduces bandwidth for unchanged files
- **Batch Processing**: Tables and rows are processed in batches
- **Error Recovery**: Failed rows/images don't stop the entire sync
- **Idempotency**: Running sync multiple times is safe (hash comparison prevents duplicates)
- **Resumable**: Can resume from where it left off using image sync records

## Cost Optimization

- **Hash Comparison**: Only changed files are downloaded, reducing bandwidth costs
- **Efficient API Usage**: Uses Baserow and Drive APIs efficiently with pagination
- **D1 Storage**: Only stores what's needed
- **R2 Storage**: Only stores optimized images (no originals)
- **Cron Frequency**: Adjust schedule based on your update frequency needs

## Environment Variables

### Required

- `BASEROW_API_TOKEN` - Baserow API authentication token
- `BASEROW_DATABASE_ID` - Baserow database ID (default: 321013)
- `WEBHOOK_SECRET` - Secret for Baserow webhook verification
- `GOOGLE_DRIVE_API_KEY` - Google Drive API key
- `SYNC_SECRET` - Secret for manual sync endpoint authentication

### Optional

- `MAX_IMAGE_WIDTH` - Maximum image width for optimization (default: 1280)
- `MAX_IMAGE_HEIGHT` - Maximum image height for optimization (default: 1280)
- `IMAGE_QUALITY` - JPEG/WebP quality 0-100 (default: 85)
- `MAX_IMAGE_SIZE` - Recommended maximum file size in bytes (default: 10MB). Files larger than this will receive aggressive optimization but will still be processed.
- `R2_PUBLIC_DOMAIN` - Public domain for R2 bucket (default: https://img.rent-in-ottawa.ca)
- `BASEROW_API_URL` - Custom Baserow API URL (for self-hosted instances)

### Image Optimization

The worker uses **open-source WASM-based image processing** (@jsquash) for automatic compression and resizing:

- **Supported formats**: JPEG and PNG images (most common camera formats)
- **Automatic resizing**: Images are resized to fit within max dimensions while maintaining aspect ratio
- **Format conversion**: JPEG/PNG images are converted to WebP for better compression
- **Iterative optimization**: Large images are compressed multiple times until under 1MB target size
- **Smart quality adjustment**: Quality is automatically reduced for very large images (>20MB)

**No paid services required** - all image processing runs directly in the Worker using WebAssembly.

## Next Steps

After deploying the worker:

1. ✅ **Create D1 databases** - Run `npx wrangler d1 create riocore` (production) and `npx wrangler d1 create riocore-demo --env demo` (demo)
2. ✅ **Configure secrets** - Set all required secrets
3. ✅ **Configure Baserow webhook** - Add webhook URL in Baserow settings
4. ✅ **Test manual sync** - Run sync on-demand to verify setup
5. ✅ **Monitor first sync** - Use `npx wrangler tail` to watch progress
6. ✅ **Verify data in D1** - Check that tables and rows are synced correctly
7. ✅ **Verify images in R2** - Check that images appear correctly
8. ✅ **Test webhook** - Create/update a row in Baserow and verify webhook processing
9. ✅ **Adjust cron schedule** - Set frequency based on your needs
