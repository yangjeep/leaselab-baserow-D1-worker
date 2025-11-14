# Image Sync Worker

Cloudflare Worker that bulk syncs images from Google Drive to R2 bucket for all properties. Uses MD5 hash comparison to only sync changed files, reducing bandwidth and processing time. Supports both manual HTTP triggers and scheduled cron jobs.

## Features

- **Bulk Sync**: Syncs all properties with Image Folder URL in a single operation
- **Hash Comparison**: Only syncs files that have changed (MD5 hash comparison)
- **Scheduled Sync**: Automatic sync via cron triggers (configurable schedule)
- **Manual Trigger**: On-demand sync via HTTP endpoint
- **Efficient**: Skips unchanged files, processes only what's needed

## Prerequisites

Before deploying the worker, ensure you have:

1. **Cloudflare R2 Buckets** created and configured
   - Production: `rental-manager-images`
   - Demo: `rental-manager-demo-images`
2. **Google Drive API Key**
   - The Drive folders must be set to "Anyone with the link can view"
3. **Airtable Base** with Properties table containing:
   - `Image Folder URL` field (Google Drive folder URL or ID)
   - `Slug` field (or `Title` field for auto-generation)
   - Airtable API token with read access

## Environments

The worker supports two environments:

- **Production** (default): Uses `rental-manager-images` R2 bucket
- **Demo**: Uses `rental-manager-demo-images` R2 bucket

Each environment has its own:
- Worker deployment (separate URLs)
- R2 bucket binding
- Secrets and configuration
- Cron schedule (can be different)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Secrets

Secrets are configured per environment. You can use the same secrets for both environments or different ones.

#### For Production Environment:

**Required secrets:**

```bash
# Google Drive API key
npx wrangler secret put GOOGLE_DRIVE_API_KEY
# When prompted, paste your Google Drive API key

# Airtable API token
npx wrangler secret put AIRTABLE_TOKEN
# When prompted, paste your Airtable API token

# Airtable Base ID
npx wrangler secret put AIRTABLE_BASE_ID
# When prompted, paste your Airtable base ID

# Bearer token for securing manual trigger endpoint (required)
npx wrangler secret put SYNC_SECRET
# When prompted, paste a secret (e.g., random UUID)
# Manual triggers require: Authorization: Bearer <secret>
```

#### For Demo Environment:

```bash
# Same secrets, but with --env demo flag
npx wrangler secret put GOOGLE_DRIVE_API_KEY --env demo
npx wrangler secret put AIRTABLE_TOKEN --env demo
npx wrangler secret put AIRTABLE_BASE_ID --env demo
npx wrangler secret put SYNC_SECRET --env demo  # Required
```

**Note:** 
- Secrets are stored securely by Cloudflare and are not visible in your code
- R2 bucket names are already configured in `wrangler.toml`
- `AIRTABLE_TABLE_NAME` defaults to "Properties" but can be set as a secret if different
- **Important:** `SYNC_SECRET` is required - the worker will return 500 error if not configured, and all HTTP requests require valid Bearer token authentication

### 3. Configure Cron Schedule (Optional)

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

### 4. Local Development (Optional)

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
AIRTABLE_TOKEN=your-airtable-token-here
AIRTABLE_BASE_ID=your-base-id-here
AIRTABLE_TABLE_NAME=Properties
SYNC_SECRET=your-secret-here  # Required - use a secure random string
EOF
```

**Note:** Add `.dev.vars` to `.gitignore` to avoid committing secrets.

### 5. Deploy to Cloudflare

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
✨  Deployed to https://rental-manager-image-sync.dwx-rental.workers.dev
```

**Demo:**
```
✨  Deployed to https://rental-manager-image-sync-demo.dwx-rental.workers.dev
```

**On-demand sync URLs:**
- Production: `https://rental-manager-image-sync.dwx-rental.workers.dev/sync`
- Demo: `https://rental-manager-image-sync-demo.dwx-rental.workers.dev/sync`

## Usage

### Manual Trigger

Trigger a bulk sync manually via HTTP:

**Production:**
```bash
# Authentication is required - Bearer token must be provided
curl -H "Authorization: Bearer your-secret-here" \
  https://rental-manager-image-sync.dwx-rental.workers.dev/sync
```

**Demo:**
```bash
# Authentication is required - Bearer token must be provided
curl -H "Authorization: Bearer your-secret-here" \
  https://rental-manager-image-sync-demo.dwx-rental.workers.dev/sync
```

**Response:**
```json
{
  "success": true,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "duration": "45230ms",
  "summary": {
    "propertiesProcessed": 25,
    "propertiesSucceeded": 23,
    "propertiesFailed": 2,
    "propertiesSkipped": 0,
    "filesSynced": 150,
    "filesSkipped": 50,
    "filesFailed": 3
  },
  "details": [
    {
      "slug": "property-1",
      "status": "success",
      "filesSynced": 5,
      "filesSkipped": 2,
      "filesFailed": 0,
      "errors": []
    }
  ]
}
```

### Scheduled Sync (Cron)

The worker automatically runs on the schedule configured in `wrangler.toml`. No action needed - it will sync all properties periodically.

**View cron execution logs:**
```bash
npx wrangler tail
```

## How It Works

1. **Fetch Properties**: Worker fetches all properties from Airtable that have an `Image Folder URL`
2. **For Each Property**:
   - Extract Google Drive folder ID from the URL
   - List all image files in the Drive folder (with MD5 hashes)
   - For each image file:
     - Check if file exists in R2 at `{slug}/filename.jpg`
     - Compare MD5 hash from Drive with hash stored in R2 metadata
     - If hashes match: **Skip** (file unchanged)
     - If hashes differ or file missing: **Download and upload** to R2
3. **Store Metadata**: Upload includes MD5 hash, Drive file ID, and sync timestamp in R2 metadata
4. **Return Summary**: Detailed results with counts of synced/skipped/failed files

## Hash Comparison

The worker uses MD5 hash comparison to avoid unnecessary downloads:

- **Google Drive** provides `md5Checksum` for each file via API
- **R2** stores hash in object metadata as `x-hash-md5`
- **Comparison**: Only files with different hashes are downloaded and uploaded
- **Result**: Significant bandwidth and time savings, especially for large image catalogs

**First sync**: All files are uploaded (no existing hashes to compare)

**Subsequent syncs**: Only changed files are synced

## Image Storage Details

- **Location:** Images are stored in R2 at `{slug}/filename.jpg`
- **Filename Preservation:** Original filenames from Google Drive are preserved (special characters are sanitized)
- **Metadata:** Each image includes:
  - `x-hash-md5`: MD5 hash for change detection
  - `x-drive-file-id`: Google Drive file ID for reference
  - `x-synced-at`: ISO timestamp of last sync
- **Sorting:** Images are sorted alphabetically by filename in Google Drive
- **Supported Formats:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`

## API Endpoint

### GET /sync or POST /sync

Triggers a bulk sync of all properties.

**Headers (required):**
- `Authorization: Bearer <SYNC_SECRET>` - Bearer token authentication is required

**Response:**
- `200 OK` - Sync completed (check `summary` for details)
- `401 Unauthorized` - Missing or invalid Bearer token
- `500 Internal Server Error` - Configuration or API errors (including if SYNC_SECRET is not configured)

## Monitoring

### View Worker Logs

Monitor worker execution in real-time:

```bash
npx wrangler tail
```

This shows:
- All HTTP requests
- Cron trigger executions
- Sync progress and errors
- Hash comparison results

### Verify Images in R2

After a sync, verify images are in your R2 bucket:

1. Go to Cloudflare Dashboard → R2
2. Select your bucket:
   - Production: `rental-manager-images`
   - Demo: `rental-manager-demo-images`
3. Navigate to a property folder (e.g., `property-slug/`)
4. You should see all uploaded images with their original filenames
5. Check object metadata to see stored hashes

## Troubleshooting

### Sync Returns 500 Error

- **Check worker logs:** `npx wrangler tail`
- **Verify secrets:** Ensure all required secrets are set
- **Check Airtable access:** Verify token has read access to base
- **Check Drive access:** Verify API key works and folders are public

### No Files Synced

- **Check Airtable:** Ensure properties have `Image Folder URL` field populated
- **Check Drive folders:** Verify folders contain image files
- **Check folder permissions:** Folders must be "Anyone with the link can view"
- **Check logs:** Look for specific error messages

### Files Not Skipping (Always Syncing)

- **Check hash storage:** Verify R2 objects have `x-hash-md5` metadata
- **First sync is normal:** All files sync on first run
- **Check logs:** Look for hash comparison messages

### Cron Not Running

- **Check wrangler.toml:** Verify `[triggers]` section exists
- **Check deployment:** Ensure worker is deployed with cron config
- **Check logs:** `npx wrangler tail` to see if cron triggers appear
- **Verify schedule:** Check cron expression is valid

## Performance Considerations

- **Sequential Processing**: Properties and files are processed sequentially to avoid rate limits
- **Hash Comparison**: Significantly reduces bandwidth for unchanged files
- **Error Recovery**: Failed properties don't stop the entire sync
- **Idempotency**: Running sync multiple times is safe (hash comparison prevents duplicates)

## Cost Optimization

- **Hash Comparison**: Only changed files are downloaded, reducing bandwidth costs
- **Efficient API Usage**: Uses Drive API efficiently with pagination
- **R2 Storage**: Only stores what's needed, metadata is minimal
- **Cron Frequency**: Adjust schedule based on your update frequency needs

## Next Steps

After deploying the worker:

1. ✅ **Test manual trigger** - Run sync on-demand:
   ```bash
   # Production
   curl -H "Authorization: Bearer your-secret-here" \
     https://rental-manager-image-sync.dwx-rental.workers.dev/sync
   
   # Demo
   curl -H "Authorization: Bearer your-secret-here" \
     https://rental-manager-image-sync-demo.dwx-rental.workers.dev/sync
   ```
2. ✅ **Monitor first sync** - Use `npx wrangler tail` to watch progress
3. ✅ **Verify images in R2** - Check that images appear correctly
4. ✅ **Test hash comparison** - Run sync twice, second should skip unchanged files
5. ✅ **Adjust cron schedule** - Set frequency based on your needs
6. ✅ **Verify in Next.js app** - Check that synced images display correctly

