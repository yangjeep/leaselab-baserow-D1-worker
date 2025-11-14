<!-- 510ae327-7167-4815-9183-29d0871b85e8 eb3b1021-5a76-4a22-b3d6-71633b3fbb08 -->
# Add R2 File Deletion for Uni-Directional Sync

## Overview

Currently, the worker only adds/updates files from Google Drive to R2. This plan adds deletion functionality to remove files from R2 that no longer exist in the corresponding Google Drive folder, making it a true uni-directional sync.

## Implementation Details

### 1. List existing R2 files for a property

- Add function `listR2Files(bucket: R2Bucket, slug: string)` to list all files in R2 under `{slug}/` prefix
- Use R2's `list()` API with prefix filtering

### 2. Compare Drive files with R2 files

- In `syncProperty()`, after syncing Drive files, compare the list of Drive files with R2 files
- Identify files that exist in R2 but not in Drive (orphaned files)
- Delete orphaned files from R2 using `bucket.delete(key)`

### 3. Update sync results tracking

- Add `filesDeleted` field to `SyncResult` interface
- Track deleted files count in sync summary
- Include deleted file names in errors array (for logging) or separate field

### 4. Handle edge cases

- Skip deletion if Drive folder is empty (to avoid accidental mass deletion)
- Log each deletion for debugging
- Handle deletion errors gracefully (don't fail entire sync if one deletion fails)

## Files to Modify

- `src/index.ts`:
- Add `filesDeleted` to `SyncResult` interface (line 45-52)
- Add `filesDeleted` to `SyncSummary` interface (line 54-62)
- Add `listR2Files()` function to list files in R2 for a property
- Modify `syncProperty()` to:
- List existing R2 files after syncing Drive files
- Compare and delete orphaned files
- Track deletions in result
- Update summary aggregation to include deleted files count

## Implementation Approach

1. After syncing all Drive files in `syncProperty()`, list all R2 files with prefix `{slug}/`
2. Create a Set of expected R2 keys from Drive files (using sanitized filenames)
3. For each R2 file, if it's not in the expected set, delete it
4. Track deletions and include in results
5. Add observability configuration to `wrangler.toml` for both production and demo environments

## Notes

- Deletion only happens if Drive folder has files (prevents accidental deletion of all files)
- Each deletion is logged for debugging
- Deletion errors are tracked but don't fail the entire sync
- Filename sanitization must match between sync and deletion logic

### To-dos

- [ ] Add filesDeleted field to SyncResult and SyncSummary interfaces
- [ ] Create listR2Files() function to list all files in R2 for a property slug
- [ ] Add deletion logic in syncProperty() to remove orphaned R2 files
- [ ] Update summary aggregation to include filesDeleted count