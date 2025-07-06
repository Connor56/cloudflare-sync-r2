# R2 Sync Script

This TypeScript script syncs all objects from your remote Cloudflare R2 bucket to your local development environment (Miniflare) using the **AWS SDK v3** for remote operations and **direct SQLite database access** for local operations.

## Why Use This Script?

As of Wrangler v4, the R2 CLI commands have changed significantly and can be unreliable:

- `wrangler r2 object` commands now default to local mode
- Remote operations require the `--remote` flag
- This script bypasses these CLI issues by:
  - Using the R2 S3-compatible API directly for remote operations
  - Reading directly from Miniflare's SQLite database for local operations
  - Providing robust error handling and detailed logging

## Prerequisites

1. **Node.js 18+** (required for ES modules and AWS SDK v3)
2. **TypeScript/tsx** (for running TypeScript files)
3. **Cloudflare R2 API credentials** (not wrangler auth)
4. **A running local development server** with R2 bindings

## Setup

### 1. Install Dependencies

```bash
npm install
```

This will install the required dependencies including:

- `@aws-sdk/client-s3` for remote R2 operations
- `sqlite3` for reading local Miniflare database
- `tsx` for TypeScript execution

### 2. Create R2 API Credentials

1. Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **R2 Object Storage**
3. Click **Manage R2 API tokens**
4. Create a new API token with permissions to read your bucket
5. Save the **Access Key ID** and **Secret Access Key**

### 3. Set Environment Variables

Create a `.env` file in your project root:

```bash
# Cloudflare R2 Credentials
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
CLOUDFLARE_ACCESS_KEY_ID=your_access_key_id_here
CLOUDFLARE_SECRET_ACCESS_KEY=your_secret_access_key_here
```

Or set them directly in your shell:

```bash
export CLOUDFLARE_ACCOUNT_ID="your_account_id"
export CLOUDFLARE_ACCESS_KEY_ID="your_access_key_id"
export CLOUDFLARE_SECRET_ACCESS_KEY="your_secret_access_key"
```

## Usage

### Basic Usage (sync only missing objects)

```bash
npm run sync-r2 your-bucket-name
```

### Advanced Usage with Options

**Force sync all objects** (overwrite existing):

```bash
npm run sync-r2 your-bucket-name -- --force
```

**Clean local bucket first** (delete all local objects before syncing):

```bash
npm run sync-r2 your-bucket-name -- --clean
```

**Use custom .wrangler directory location**:

```bash
npm run sync-r2 your-bucket-name -- --wrangler-dir=../path/to/.wrangler
```

**Combine options** (clean and force):

```bash
npm run sync-r2 your-bucket-name -- --clean --force
```

#### Available Options

- `--force`: Force sync all objects, overwriting existing ones
- `--clean`: Clean the local bucket before syncing (removes all local objects)
- `--wrangler-dir=<directory>`: Custom location of .wrangler directory (default: ./.wrangler)
- `--help` or `-h`: Show help information

## What the Script Does

### Core Functionality

1. **Lists all objects** in your remote R2 bucket using the AWS SDK v3
2. **Reads local objects** directly from Miniflare's SQLite database (`.wrangler/state/v3/r2/miniflare-R2BucketObject/`)
3. **Compares** remote and local objects to determine what needs syncing
4. **Downloads** missing objects to a temporary directory
5. **Uploads** objects to your local Miniflare R2 bucket using `wrangler r2 object put`
6. **Cleans up** temporary files when done

### SQLite Database Integration

The script reads local objects directly from Miniflare's SQLite database instead of relying on `wrangler r2 object list` commands. This provides:

- **Better reliability** - No more shell command failures
- **Faster performance** - Direct database access
- **Enhanced debugging** - Detailed database inspection logging
- **Cross-platform compatibility** - Works consistently on Windows, macOS, and Linux

### Smart Sync Logic

- **Normal mode**: Only syncs missing objects
- **Force mode** (`--force`): Syncs all objects, overwriting existing ones
- **Clean mode** (`--clean`): Removes all local objects before syncing

## Expected Output

### Normal Sync Mode

```
ℹ️  Using wrangler directory: ./.wrangler
ℹ️  Using bucket name: fullstackgaming-images-prod
ℹ️  🔄 Normal mode - will sync only missing objects
ℹ️  Environment variables checked
✅ Wrangler CLI is available
ℹ️  Wrangler available
🚀 Starting R2 sync to local Wrangler...
🔄 Initializing remote R2 client...
🔄 Listing objects in remote bucket: fullstackgaming-images-prod...
✅ Found 15 objects in remote bucket
🔄 Listing objects in local Wrangler R2...
ℹ️  Reading from SQLite database: .wrangler\state\v3\r2\miniflare-R2BucketObject\69d025a62469192289be9b837d21e1cbb5f8f8e5eb7294fa998e1aff862170f7.sqlite
ℹ️  Database tables: _mf_objects, _mf_multipart_uploads, _mf_multipart_parts
ℹ️  Reading objects from table: _mf_objects
ℹ️  Table columns: key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata
ℹ️  Found 12 rows in _mf_objects table
✅ Found 12 objects in local database
ℹ️  Sample objects: images/photo1.jpg, images/photo2.png, videos/demo.mp4...
ℹ️  Need to sync 3 objects
🔄 [1/3] Processing: images/new-photo.jpg
✅ Downloaded: images/new-photo.jpg
✅ Uploaded to local: images/new-photo.jpg
🔄 [2/3] Processing: documents/readme.pdf
✅ Downloaded: documents/readme.pdf
✅ Uploaded to local: documents/readme.pdf
🔄 [3/3] Processing: videos/tutorial.mp4
✅ Downloaded: videos/tutorial.mp4
✅ Uploaded to local: videos/tutorial.mp4
✅ 🎉 Successfully synced 3 objects to local Wrangler!
🔄 Cleaning up temporary files...
✅ Cleaned up directory: ./temp-r2-sync
```

### When Objects Are Already Synced

```
ℹ️  Using wrangler directory: ./.wrangler
ℹ️  Using bucket name: fullstackgaming-images-prod
ℹ️  🔄 Normal mode - will sync only missing objects
...
✅ Found 15 objects in remote bucket
✅ Found 15 objects in local database
✅ 🎉 All objects are already in sync!
```

## Configuration

### Required Arguments

The script now requires the **bucket name** as the first argument:

```bash
npm run sync-r2 your-bucket-name
```

### Custom .wrangler Directory Location

If your `.wrangler` directory is located somewhere other than the default location (`./.wrangler`), you can specify a custom path:

```bash
npm run sync-r2 your-bucket-name -- --wrangler-dir=../path/to/.wrangler
```

This is useful when:

- Your `.wrangler` directory is in a parent directory
- You're running the script from a subdirectory
- You have multiple project configurations

## Troubleshooting

### Missing Environment Variables

```
✗ Missing required environment variables:
  - CLOUDFLARE_ACCOUNT_ID
  - CLOUDFLARE_ACCESS_KEY_ID
  - CLOUDFLARE_SECRET_ACCESS_KEY
```

**Solution:** Make sure all three environment variables are set correctly.

### SQLite Database Not Found

```
⚠️  Miniflare R2 directory does not exist for bucket: your-bucket-name
```

**Solution:** Make sure `wrangler dev` has been run at least once to create the SQLite database, or upload an object to the local bucket first.

### SQLite Database Access Error

```
❌ Failed to open SQLite database: SQLITE_CANTOPEN
```

**Solution:**

1. Ensure `wrangler dev` is not running (it may lock the database)
2. Check file permissions on the `.wrangler` directory
3. Verify the database file exists and isn't corrupted

### Connection Refused to Local Server

```
✗ Failed to upload object.jpg to local: connect ECONNREFUSED 127.0.0.1:8787
```

**Solution:** Make sure `wrangler dev` is running and accessible on the expected port.

### Access Denied from Remote R2

```
✗ Failed to list objects: Access Denied
```

**Solution:** Check that your R2 API credentials have the correct permissions for your bucket.

### Bucket Not Found

```
✗ Failed to list objects: NoSuchBucket: The specified bucket does not exist
```

**Solution:** Verify the bucket name you provided as an argument matches your actual R2 bucket name.

### Missing Bucket Name

```
❌ Bucket name is required
```

**Solution:** Provide the bucket name as the first argument to the script:

```bash
npm run sync-r2 your-bucket-name
```

## Advanced Usage

### Custom Metadata Handling

The script preserves object metadata during sync. To add custom handling, modify the `uploadObjectToLocal` function in `scripts/sync-r2-to-local.ts`.

### Filtering Objects

To sync only specific objects, modify the `listRemoteObjects` function to filter based on key patterns:

```typescript
// Example: Only sync images
const filteredObjects = remoteObjects.filter((obj) =>
	obj.Key?.match(/\.(jpg|jpeg|png|gif|webp)$/i)
);
```

### Custom SQLite Queries

The script automatically discovers the database schema, but you can customize the SQLite queries in the `listLocalObjectsFromDatabase` function:

```typescript
// Example: Add custom WHERE clause
db.all(`SELECT * FROM ${tableName} WHERE key LIKE 'images/%'`, (err, rows) => {
	// Custom filtering logic
});
```

### Parallel Processing

For better performance with many objects, you can modify the script to use `Promise.all()` with batched downloads.

### Multiple Buckets

To sync multiple buckets, run the script multiple times with different bucket names:

```bash
npm run sync-r2 bucket-1
npm run sync-r2 bucket-2
npm run sync-r2 bucket-3
```

## Notes

- The script uses temporary storage to avoid memory issues with large files
- All temporary files are cleaned up automatically
- The sync preserves original object metadata
- Objects are processed sequentially to avoid overwhelming the local server
- SQLite database is accessed in read-only mode to prevent corruption
- The script automatically discovers database schema changes in future Wrangler versions
