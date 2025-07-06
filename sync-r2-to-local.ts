#!/usr/bin/env node
import {
	S3Client,
	ListObjectsV2Command,
	GetObjectCommand,
	ListObjectsV2CommandOutput,
	GetObjectCommandOutput,
	_Object
} from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import crypto from 'crypto';

// Load environment variables from .env file
dotenv.config();

// Configuration
const TEMP_DIR = './temp-r2-sync';

// Cloudflare R2 configuration
const ACCOUNT_ID: string | undefined = process.env.CLOUDFLARE_ACCOUNT_ID;
const ACCESS_KEY_ID: string | undefined = process.env.CLOUDFLARE_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY: string | undefined = process.env.CLOUDFLARE_SECRET_ACCESS_KEY;

// Parse command line arguments
const args = process.argv.slice(2);
const forceSync = args.includes('--force');
const cleanSync = args.includes('--clean');

// Check for a custom wrangler directory
let wranglerDir = './.wrangler';
const wranglerDirArg = args.find((arg) => arg.startsWith('--wrangler-dir='));
if (wranglerDirArg) {
	wranglerDir = wranglerDirArg.split('=')[1];
}

// Miniflare key is used to generate database names and as the directory name
// for the local sqlite databases.
const MINIFLARE_KEY = 'miniflare-R2BucketObject';
const MINIFLARE_DIR = path.join(wranglerDir, 'state', 'v3', 'r2', MINIFLARE_KEY);
const BUCKET_NAME = args[0];

// Colors for console output
const colors = {
	green: '\x1b[32m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
	reset: '\x1b[0m'
} as const;

function log(message: string, color: string = colors.blue): void {
	console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message: string): void {
	log(`✅ ${message}`, colors.green);
}

function logError(message: string): void {
	log(`❌ ${message}`, colors.red);
}

function logWarning(message: string): void {
	log(`⚠️  ${message}`, colors.yellow);
}

function logInfo(message: string): void {
	log(`ℹ️  ${message}`, colors.cyan);
}

function logStep(message: string): void {
	log(`🔄 ${message}`, colors.magenta);
}

// Create remote R2 client
function createRemoteClient(): S3Client {
	if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
		throw new Error(
			'Missing required environment variables: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_KEY_ID, CLOUDFLARE_SECRET_ACCESS_KEY'
		);
	}

	return new S3Client({
		region: 'auto',
		endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY
		},
		// Fix for AWS SDK v3 compatibility with Cloudflare R2
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
}

/**
 * Executes a shell command and returns its output as a Promise
 * @param command The command to execute (e.g. 'wrangler')
 * @param args Array of command arguments (e.g. ['--version'])
 * @returns Promise that resolves with stdout if successful, rejects with error if command fails
 */
function execCommand(command: string, args: string[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		// Spawn child process with piped stdio
		const child = spawn(command, args, { stdio: 'pipe', shell: true });

		// Collect stdout and stderr
		let stdout = '';
		let stderr = '';

		// Handle stdout data
		child.stdout?.on('data', (data) => {
			stdout += data.toString();
		});

		// Handle stderr data
		child.stderr?.on('data', (data) => {
			stderr += data.toString();
		});

		// Handle process completion
		child.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`Command failed with code ${code}: ${stderr}`));
			}
		});
	});
}

// Utility functions
async function ensureDirectoryExists(dir: string): Promise<void> {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
		logSuccess(`Created directory: ${dir}`);
	}
}

async function cleanupDirectory(dir: string): Promise<void> {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
		logSuccess(`Cleaned up directory: ${dir}`);
	}
}

/**
 * Generates the database ID name for a durable object based on the bucket name,
 * and the unique miniflare key, which for R2 is 'miniflare-R2BucketObject'.
 *
 * This code is lifted straight out of the miniflare source code. Hence the
 * strange name. You can find the source code here:
 *
 * https://github.com/cloudflare/workers-sdk/blob/7c55f9e1eac4fb0d53f9180a011172328296be16/packages/miniflare/src/plugins/shared/index.ts#L236
 *
 * Miniflare uses a combination of the unique key, which you'll notice is the
 * name of the folder for the R2 sqlite databases, and the bucket name to
 * create a hash that uniquely identifies the database looking after a
 * particular bucket.
 *
 * This makes a lot of sense, otherwise you could have two sqlite databases
 * looking after different resource types that happen to share the same
 * name. If this were the case the databases would also have identical names
 * which could be confusing.
 * @param uniqueKey - The unique key for R2 bucket objects in miniflare.
 * @param name - The name of the bucket to generate the namespace ID for.
 * @returns The namespace ID for the durable object.
 */
function durableObjectNamespaceIdFromName(uniqueKey: string, name: string) {
	const key = crypto.createHash('sha256').update(uniqueKey).digest();
	const nameHmac = crypto.createHmac('sha256', key).update(name).digest().subarray(0, 16);
	const hmac = crypto.createHmac('sha256', key).update(nameHmac).digest().subarray(0, 16);
	return Buffer.concat([nameHmac, hmac]).toString('hex');
}

/**
 * Converts a Readable stream into a Buffer by collecting all chunks
 *
 * This function takes a Readable stream and returns a Promise that resolves with
 * the complete contents as a Buffer. It works by:
 *
 * 1. Creating an array to collect all chunks of data
 * 2. Listening for 'data' events and pushing each chunk into the array
 * 3. Handling any errors by rejecting the promise
 * 4. When the stream ends, concatenating all chunks into a single Buffer
 *
 * This is useful for cases where you need to work with the complete contents
 * of a stream in memory, rather than processing it chunk by chunk.
 *
 * @param stream - A Readable stream to convert to a Buffer
 * @returns Promise<Buffer> - Resolves with a Buffer containing all stream data
 * @throws Will reject the promise if the stream emits an error
 *
 * @example
 * const buffer = await streamToBuffer(someReadableStream);
 * // buffer now contains the complete contents of the stream
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	return new Promise((resolve, reject) => {
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

/**
 * Lists all objects in a remote R2 bucket using pagination
 * @param s3Client - The S3 client instance to use for requests
 * @param bucketName - Name of the R2 bucket to list objects from
 * @returns Array of S3 objects from the bucket
 */
async function listRemoteObjects(s3Client: S3Client, bucketName: string): Promise<_Object[]> {
	// Store all objects from bucket
	const objects: _Object[] = [];
	// Token used for pagination through results
	let continuationToken: string | undefined;

	do {
		// Configure parameters for the list operation
		const params: {
			Bucket: string;
			MaxKeys: number;
			ContinuationToken?: string;
		} = {
			Bucket: bucketName,
			MaxKeys: 1000 // Fetch 1000 objects per request
		};

		if (continuationToken) {
			params.ContinuationToken = continuationToken;
		}

		try {
			const response: ListObjectsV2CommandOutput = await s3Client.send(
				new ListObjectsV2Command(params)
			);

			// Add any returned objects to our collection
			if (response.Contents) {
				objects.push(...response.Contents);
			}

			// Get token for next page of results
			continuationToken = response.NextContinuationToken;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logError(`Failed to list remote objects: ${errorMessage}`);
			throw error;
		}
	} while (continuationToken);

	return objects;
}

/**
 * Reads and extracts object keys from the local Miniflare SQLite database used
 * by Wrangler for R2 storage.
 *
 * Uses better-sqlite3 to read the database, accessing the _mf_objects table.
 * There is a built in assumption that the database name derivation remains
 * unchanged, and the the table name remains _mf_objects.
 *
 * @param bucketName - Name of the R2 bucket to look up in the database
 * @returns string[] Array of object keys found in the database
 * @throws Will not throw, but returns empty array and logs errors if any step fails
 */
function listLocalObjectsFromDatabase(bucketName: string): string[] {
	try {
		// Look for the SQLite database in Wrangler's state directory
		// This is where Wrangler/Miniflare stores local R2 bucket data,
		// including the names of stored objects.
		if (!fs.existsSync(MINIFLARE_DIR)) {
			logWarning(`Miniflare R2 directory does not exist for bucket`);
			return [];
		}

		// Get the database name for the bucket
		const databaseName = durableObjectNamespaceIdFromName(MINIFLARE_KEY, bucketName);
		const dbPath = `${MINIFLARE_DIR}/${databaseName}.sqlite`;

		// Look for the database file
		if (!fs.existsSync(dbPath)) {
			logWarning('No SQLite database file found in Miniflare directory');
			return [];
		}

		logInfo(`Reading from SQLite database: ${dbPath}`);

		// Open database in read-only mode to prevent any accidental modifications
		const db = new Database(dbPath, { readonly: true }, (err) => {
			if (err) {
				logError(`Failed to open SQLite database: ${err.message}`);
				return;
			}
		});

		// Get the objects from the database
		const objects = db.prepare('SELECT * FROM _mf_objects').all();

		// Extract the keys from the objects
		const keys: string[] = [];
		for (const object of objects) {
			keys.push(object.key as string);
		}

		return keys;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Failed to list local objects: ${errorMessage}`);
		return [];
	}
}

// List all objects in local Wrangler R2
function listLocalObjects(bucketName: string): string[] {
	try {
		return listLocalObjectsFromDatabase(bucketName);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logWarning(`Failed to list local objects: ${errorMessage}`);
		logWarning("This might be normal if the local R2 bucket is empty or doesn't exist yet");
		return [];
	}
}

/**
 * Downloads an object from a remote R2 bucket to the local filesystem
 * @param s3Client - The configured S3 client for R2 access
 * @param bucketName - Name of the R2 bucket to download from
 * @param key - Object key/path in the R2 bucket
 * @param localPath - Destination path on local filesystem
 * @throws Will throw if download or file write fails
 */
async function downloadObject(
	s3Client: S3Client,
	bucketName: string,
	key: string,
	localPath: string
): Promise<void> {
	try {
		// Create and execute command to get object from R2
		const command = new GetObjectCommand({
			Bucket: bucketName,
			Key: key
		});

		const response: GetObjectCommandOutput = await s3Client.send(command);

		if (!response.Body) {
			throw new Error('No body in response');
		}

		// Convert streaming response to buffer
		const buffer = await streamToBuffer(response.Body as Readable);

		// Ensure directory exists before writing file
		const dir = path.dirname(localPath);
		await ensureDirectoryExists(dir);

		// Write downloaded content to local file
		fs.writeFileSync(localPath, buffer);
		logSuccess(`Downloaded: ${key}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Failed to download ${key}: ${errorMessage}`);
		throw error;
	}
}

/**
 * Uploads an object from the local filesystem to a remote R2 bucket
 * @param bucketName - Name of the R2 bucket to upload to
 * @param key - Object key/path in the R2 bucket
 * @param filePath - Path to the local file to upload
 * @throws Will throw if upload fails
 */
async function uploadObjectToLocal(
	bucketName: string,
	key: string,
	filePath: string
): Promise<void> {
	try {
		await execCommand('wrangler', [
			'r2',
			'object',
			'put',
			`${bucketName}/${key}`,
			'--file',
			filePath
		]);
		logSuccess(`Uploaded to local: ${key}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Failed to upload ${key} to local: ${errorMessage}`);
		throw error;
	}
}

/**
 * Cleans up the local R2 bucket by removing the .wrangler/r2 directory
 * This function assumes .wrangler is in the root of the project, and that the
 * command is being run from the root of the project.
 * @throws Will throw if cleanup fails
 */
async function cleanLocalBucket(): Promise<void> {
	try {
		logStep('Cleaning local R2 bucket...');

		const wranglerPath = '.wrangler/state/v3/r2';

		// Clean up the local R2 Directory if it exists
		if (fs.existsSync(wranglerPath)) {
			logSuccess('Cleaning local R2 bucket...');
			await cleanupDirectory(wranglerPath);
		} else {
			logWarning('Local R2 bucket does not exist');
			return;
		}

		logSuccess(`Cleaned local bucket`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Failed to clean local bucket: ${errorMessage}`);
		throw error;
	}
}

/**
 * Syncs objects from a remote R2 bucket to a local Wrangler R2 instance.
 *
 * Assumes the client has been correctly defined, and the bucket and all
 * objects exist.
 * @param remoteClient - The configured S3 client for R2 access
 * @param bucketName - Name of the R2 bucket to sync from
 * @param objectsToSync - Array of objects names to sync
 * @throws Will throw if any part of the sync process fails
 */
async function syncObjects(
	remoteClient: S3Client,
	bucketName: string,
	objectsToSync: _Object[]
): Promise<void> {
	// Process each object
	let processed = 0;
	for (const object of objectsToSync) {
		const key = object.Key;
		if (!key) continue;

		processed++;
		logStep(`[${processed}/${objectsToSync.length}] Processing: ${key}`);

		// Download from remote
		const tempFilePath = path.join(TEMP_DIR, key);
		await downloadObject(remoteClient, bucketName, key, tempFilePath);

		// Upload to local Wrangler
		await uploadObjectToLocal(bucketName, key, tempFilePath);

		// Clean up temp file
		if (fs.existsSync(tempFilePath)) {
			fs.unlinkSync(tempFilePath);
		}
	}
}

/**
 * Main function to synchronize objects from a remote R2 bucket to a local Wrangler R2 instance.
 *
 * This function:
 * - Initializes the remote R2 client
 * - Creates a temporary directory for downloads
 * - Optionally cleans the local bucket if --clean flag is set
 * - Lists objects in both remote and local buckets
 * - Downloads missing/required objects from remote to temp directory
 * - Uploads objects from temp directory to local Wrangler
 * - Cleans up temporary files when complete
 *
 * The sync behavior is controlled by two flags:
 * - cleanSync: If true, removes all local objects before syncing
 * - forceSync: If true, syncs all objects regardless of local state
 *
 * @throws Will throw if any part of the sync process fails
 * @returns Promise<void>
 */
async function syncR2ToLocal(): Promise<void> {
	log('🚀 Starting R2 sync to local Wrangler...', colors.blue);

	try {
		// Initialize remote client
		logStep('Initializing remote R2 client...');
		const remoteClient = createRemoteClient();

		// Ensure temp directory exists
		await ensureDirectoryExists(TEMP_DIR);

		// Handle clean mode
		if (cleanSync) {
			logStep('Clean mode enabled - removing all local objects...');
			await cleanLocalBucket();
		}

		// List remote objects
		logStep(`Listing objects in remote bucket: ${BUCKET_NAME}...`);
		const remoteObjects = await listRemoteObjects(remoteClient, BUCKET_NAME);

		if (remoteObjects.length === 0) {
			logWarning('No objects found in remote bucket');
			return;
		}

		logSuccess(`Found ${remoteObjects.length} objects in remote bucket`);

		// List local objects (unless clean mode or force mode)
		let localObjects: string[] = [];

		if (!cleanSync && !forceSync) {
			logStep('Listing objects in local Wrangler R2...');
			localObjects = listLocalObjects(BUCKET_NAME);
			logSuccess(`Found ${localObjects.length} objects in local bucket`);
		}

		// Determine what needs to be synced
		const objectsToSync = remoteObjects.filter((obj) => {
			const key = obj.Key;
			if (!key) return false;

			if (forceSync || cleanSync) {
				return true; // Sync everything
			}

			return !localObjects.includes(key); // Only sync missing objects
		});

		if (objectsToSync.length === 0) {
			logSuccess('🎉 All objects are already in sync!');
			return;
		}

		logInfo(`Need to sync ${objectsToSync.length} objects`);

		await syncObjects(remoteClient, BUCKET_NAME, objectsToSync);

		logSuccess(`🎉 Successfully synced ${objectsToSync.length} objects to local Wrangler!`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Sync failed: ${errorMessage}`);
		throw error;
	} finally {
		// Cleanup temp directory
		logStep('Cleaning up temporary files...');
		await cleanupDirectory(TEMP_DIR);
	}
}

// Check for required environment variables
function checkEnvironmentVariables(): void {
	const required = [
		'CLOUDFLARE_ACCOUNT_ID',
		'CLOUDFLARE_ACCESS_KEY_ID',
		'CLOUDFLARE_SECRET_ACCESS_KEY'
	];
	const missing = required.filter((env) => !process.env[env]);

	if (missing.length > 0) {
		logError('Missing required environment variables:');
		missing.forEach((env) => logError(`  - ${env}`));
		logError('\nPlease set these in your environment or in a .env file');
		process.exit(1);
	}
}

// Check if Wrangler is available
async function checkWranglerAvailable(): Promise<void> {
	try {
		await execCommand('npx', ['wrangler', '--version']);
		logSuccess('Wrangler CLI is available');
	} catch {
		logError('Wrangler CLI is not available or not in PATH');
		logError('Please install Wrangler: npm install -g wrangler');
		process.exit(1);
	}
}

// Print usage information
function printUsage(): void {
	console.log(`
📦 R2 Sync Tool

Usage: npm run sync-r2-ts <bucket-name> [options]

Arguments:
  bucket-name                     Name of the R2 bucket to sync

Options:
  --force                        Force sync all objects (overwrite existing)
  --clean                        Clean local bucket before syncing (delete all local objects first)
  --wrangler-dir <directory>     Custom location of .wrangler directory (default: ./.wrangler)

Examples:
  npm run sync-r2-ts my-bucket                     # Sync only missing objects
  npm run sync-r2-ts my-bucket --force             # Force sync all objects
  npm run sync-r2-ts my-bucket --clean             # Clean local bucket and sync all objects
  npm run sync-r2-ts my-bucket --wrangler-dir ../  # Use custom .wrangler location

Environment Variables Required:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ACCESS_KEY_ID
  CLOUDFLARE_SECRET_ACCESS_KEY
`);
}

// Main execution
async function main(): Promise<void> {
	try {
		// Show usage if help requested
		if (args.includes('--help') || args.includes('-h')) {
			printUsage();
			return;
		}

		if (!BUCKET_NAME) {
			logError('Bucket name is required');
			printUsage();
			return;
		}

		logInfo(`Using wrangler directory: ${wranglerDir}`);

		logInfo(`Using bucket name: ${BUCKET_NAME}`);

		// Show current mode
		if (cleanSync) {
			logInfo('🧹 Clean mode enabled - will delete all local objects first');
		} else if (forceSync) {
			logInfo('🔄 Force mode enabled - will overwrite all objects');
		} else {
			logInfo('🔄 Normal mode - will sync only missing objects');
		}

		checkEnvironmentVariables();

		logInfo('Environment variables checked');

		await checkWranglerAvailable();

		logInfo('Wrangler available');

		await syncR2ToLocal();
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Script failed: ${errorMessage}`);
		process.exit(1);
	}
}

// Run the script
main();
