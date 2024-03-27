/// <reference lib="webworker" />

import { binToPackedString, packedToBin } from './HashStrings';

// Metadata file layout:
// 4 bytes: last access timestamp
// 20 bytes hash + 4 bytes size of the first blob in the data file
// same for the second blob etc
const METADATA_OFFSET = 4;
const HASH_SIZE = 20;
const METADATA_STRIDE = HASH_SIZE + 4;

const METADATA_SUFFIX = '_metadata';

const BUCKET_OPEN_FAILED = 'Placeholder value for buckets that failed to open';
type BucketOpenFailed = typeof BUCKET_OPEN_FAILED;

const EVICTION_CUTOFF = 3 * 30 * 24 * 60 * 60 * 1000; // Evict everything older than 3 months

const WRITE_LOCK_PREFIX = 'opfs-cache-write-lock-';

const QUOTA_EXCEEDED_ERROR = 'QuotaExceededError'; // from https://webidl.spec.whatwg.org/#quotaexceedederror

type Bucket = {
    dataHandle: FileSystemSyncAccessHandle; // Synchronous file handle to the data storage file
    metadataHandle: FileSystemSyncAccessHandle; // Synchronous file handle to the metadata storage file
    offsets: Map<string, [number, number]>; // <hash, [offset, size]>
    writeLock?: () => void; // Function to release the write lock
};

type Statistics = {
    entries: number; // Number of cache entries
    dataSize: number; // Size of data stored in cache. Doesn't have to match actual disc usage
    metadataSize: number; // Size of metadata information stored in OPFS.
};

// TS is missing some API, https://github.com/microsoft/TypeScript-DOM-lib-generator/issues/1639
// See also https://github.com/whatwg/fs/blob/main/proposals/MultipleReadersWriters.md#modes-of-creating-a-filesystemsyncaccesshandle
declare global {
    interface FileSystemFileHandle {
        createSyncAccessHandle(options: { mode: string }): Promise<FileSystemSyncAccessHandle>;
    }
    interface FileSystemDirectoryHandle {
        [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
        keys(): AsyncIterableIterator<string>;
        values(): AsyncIterableIterator<FileSystemHandle>;
    }
}

async function getFiles(dir: FileSystemDirectoryHandle): Promise<Array<[string, File]>> {
    const results: Array<Promise<[string, File]>> = [];
    for await (const [key, handle] of dir) {
        if (handle.kind === 'file') {
            results.push((handle as FileSystemFileHandle).getFile().then((file) => [key, file]));
        }
    }
    return Promise.all(results);
}

function makeFilenameSafe(s: string) {
    // List of disallowed characters comes from https://stackoverflow.com/questions/1976007/what-characters-are-forbidden-in-windows-and-linux-directory-names
    return s.replaceAll(/<|>|:|"|\/|\\|\||\?\*/g, '_');
}

/**
 * Implements an asset cache using the Origin Private File System (OPFS).
 * It has arbitrarily many buckets which are identified by arbitrary names. Each bucket is stored as two files.
 * The first file contains only the concatenated asset blobs, the second file contains metadata, i.e. hashes and sizes of the blobs.
 * @class
 */
export class OPFSCache {
    #analyticsCallback: ((name: string, properties: unknown) => void) | undefined;
    #quotaExceededAnalyticsCallbackExecuted = false;
    #initPromise: Promise<void> | undefined;
    #evictPromise: Promise<boolean> | undefined;
    #cacheDir: FileSystemDirectoryHandle | null = null;
    #buckets = new Map<string, Bucket | BucketOpenFailed>();
    #initializingBuckets = new Map<string, Promise<Bucket | BucketOpenFailed>>();
    #cacheDirectoryName = '';

    /** Creates a new OPFSCache instance. Creates the cache directory if it doesn't exist yet. */
    constructor(analyticsCallback?: (name: string, properties: unknown) => void, cacheDirectoryName = 'otg_cache') {
        this.#cacheDirectoryName = cacheDirectoryName;
        this.#initPromise = this.#init();
        this.#analyticsCallback = analyticsCallback;
    }

    async #init() {
        try {
            // this throws on firefox and safari in private browsing mode
            const root = await navigator.storage.getDirectory();
            // this throws when the quota is exceeded
            this.#cacheDir = await root.getDirectoryHandle(this.#cacheDirectoryName, { create: true });
        } catch (e) {
            console.warn('Failed to open cache directory', e);
            this.#analyticsCallback?.('viewer.opfsCache.cacheOpenFailed', {
                errorName: e.name,
                errorMessage: e.message,
            });
        }
        this.#initPromise = undefined;
    }

    async open(bucketName: string): Promise<Bucket | BucketOpenFailed> {
        const bucket = this.#buckets.get(bucketName);
        if (bucket) {
            return bucket;
        }

        let p = this.#initializingBuckets.get(bucketName);
        if (p) {
            return p;
        }
        p = (async (): Promise<Bucket | BucketOpenFailed> => {
            await this.#initPromise;

            let dataAccessHandle, metadataAccessHandle;
            let bucket: Bucket | undefined;
            const bucketFileName = makeFilenameSafe(bucketName);
            const writeLockName = WRITE_LOCK_PREFIX + bucketFileName;

            try {
                if (!this.#cacheDir) {
                    throw new Error('Cache directory not initialized');
                }

                const dataDraftHandle = await this.#cacheDir.getFileHandle(bucketFileName, { create: true });
                dataAccessHandle = await dataDraftHandle.createSyncAccessHandle({ mode: 'readwrite-unsafe' });

                const metadataDraftHandle = await this.#cacheDir.getFileHandle(bucketFileName + METADATA_SUFFIX, {
                    create: true,
                });
                metadataAccessHandle = await metadataDraftHandle.createSyncAccessHandle({ mode: 'readwrite-unsafe' });

                const timestampBuffer = new Uint32Array(1);
                // Update the file's lastModified value to avoid eviction
                timestampBuffer[0] = new Date().valueOf();
                metadataAccessHandle.write(timestampBuffer, { at: 0 });
                bucket = {
                    dataHandle: dataAccessHandle,
                    offsets: new Map(),
                    metadataHandle: metadataAccessHandle,
                };
                this.#buckets.set(bucketName, bucket);

                navigator.locks.request(writeLockName, { ifAvailable: true, mode: 'exclusive' }, (lock) => {
                    if (!lock) {
                        return;
                    }
                    // https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API#advanced_use
                    return new Promise<void>((res) => {
                        (bucket as Bucket).writeLock = res;
                    });
                });

                // Read metadata and file size sanity check
                const expectedDataSize = this.#loadMetadata(bucket);
                if (expectedDataSize !== bucket.dataHandle.getSize()) {
                    console.warn('Data file has unexpected size, clearing cache for', bucketName);
                    bucket.offsets.clear();
                    bucket.dataHandle.truncate(0);
                    bucket.metadataHandle.truncate(METADATA_OFFSET);
                }

                return bucket;
            } catch (error) {
                if (error.name === 'NoModificationAllowedError') {
                    console.log(error.message);
                    console.warn(
                        `Failed to acquire lock on cache for ${bucketName}. It is probably open in another tab. Disabling cache.`
                    );
                } else {
                    console.warn('Failed to initialize cache bucket', bucketName, error);
                }
                // cache dir open failures have their own event above
                if (this.#cacheDir) {
                    this.#analyticsCallback?.('viewer.opfsCache.bucketOpenFailed', {
                        bucketName,
                        errorName: error.name,
                        errorMessage: error.message,
                    });
                }

                dataAccessHandle?.close();
                metadataAccessHandle?.close();
                bucket?.writeLock?.();
                this.#buckets.set(bucketName, BUCKET_OPEN_FAILED);
                return BUCKET_OPEN_FAILED;
            } finally {
                this.#initializingBuckets.delete(bucketName);
            }
        })();
        this.#initializingBuckets.set(bucketName, p);
        return p;
    }

    #loadMetadata(bucket: Bucket) {
        bucket.offsets.clear();

        const metadataSize = bucket.metadataHandle.getSize() - METADATA_OFFSET;
        const data = new Uint8Array(metadataSize);
        const data32 = new Uint32Array(data.buffer);
        bucket.metadataHandle.read(data, { at: METADATA_OFFSET });

        const stride = METADATA_STRIDE;
        let currentDataOffset = 0;
        for (let offset = 0; offset < data.byteLength; offset += stride) {
            const hash = binToPackedString(data, offset, HASH_SIZE);
            const size = data32[(offset + HASH_SIZE) / 4];
            bucket.offsets.set(hash, [currentDataOffset, size]);
            currentDataOffset += size;
        }
        return currentDataOffset;
    }

    /**
     * Stores data associated with the given hash. Attempts one round of cache eviction if the quota is exceeded.
     * Note this does not check whether the hashes are already cached. It will ignore requests for buckets that are not open yet.
     * @param {string[]} hashes - 20 byte hashes of datas
     * @param {string[]} bucketNames - Names of the buckets in which the hashes should be stored. Must have same length as hashes.
     * @param {Uint8Array[]} datas - Array of data to store
     * @throws - Any error thrown by the underlying write function except QuotaExceededError
     */
    store(hashes: string[], bucketNames: string[], datas: Uint8Array[]) {
        // split hashes, bucketNames and datas by bucketName
        const buckets = new Map<string, [string[], Uint8Array[]]>();
        for (let i = 0; i < hashes.length; i++) {
            const bucketName = bucketNames[i];
            let bucket = buckets.get(bucketName);
            if (!bucket) {
                bucket = [[], []];
                buckets.set(bucketName, bucket);
            }
            bucket[0].push(hashes[i]);
            bucket[1].push(datas[i]);
        }
        for (const [bucketName, [hashes, datas]] of buckets) {
            this.#storeInner(hashes, bucketName, datas);
        }
    }

    async #storeInner(hashes: string[], bucketName: string, datas: Uint8Array[]): Promise<undefined> {
        // Collect data into two buffers for data and metadata
        // This is done first because if we go async (eviction),
        // we must have copied the buffers before because the caller might transfer them.
        const bucket = this.#buckets.get(bucketName);
        if (!bucket || bucket === BUCKET_OPEN_FAILED || !bucket.writeLock) {
            return;
        }

        const lengths = datas.map((d) => d.length); // lengths become 0 on transfer
        const metadataBuffer = new Uint8Array(hashes.length * METADATA_STRIDE);
        const metadataBuffer32 = new Uint32Array(metadataBuffer.buffer);
        const dataBuffer = new Uint8Array(lengths.reduce((acc, d) => acc + d, 0));
        let dataBufferOffset = 0;
        for (let i = 0; i < hashes.length; i++) {
            const data = datas[i];
            packedToBin(hashes[i], metadataBuffer, i * METADATA_STRIDE);
            metadataBuffer32[(i * METADATA_STRIDE + HASH_SIZE) / 4] = data.length;
            dataBuffer.set(data, dataBufferOffset);
            dataBufferOffset += data.length;
        }

        // go async to let the caller continue processing (e.g. send the data to the decoder threads)
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Write the buffers
        if (!this.#writeBatchWithRollback(bucket, dataBuffer, metadataBuffer)) {
            await this.#evict();
            if (!this.#writeBatchWithRollback(bucket, dataBuffer, metadataBuffer)) {
                return;
            }
        }

        // Update the in-memory index
        let offset = bucket.dataHandle.getSize() - dataBuffer.length;
        for (let i = 0; i < hashes.length; i++) {
            bucket.offsets.set(hashes[i], [offset, lengths[i]]);
            offset += lengths[i];
        }
    }

    /**
     * Appends data and metadata to the bucket. Tries to roll back writes on any error.
     * @param {Bucket} bucket - Bucket to write to
     * @param {Uint8Array} dataBuffer - Data to write
     * @param {number} metadataBuffer - Metadata to write
     * @returns {boolean} - true, if data was written successfully, false if the quota was exceeded
     * @throws - any error thrown by the underlying write function except QuotaExceededError
     */
    #writeBatchWithRollback(bucket: Bucket, dataBuffer: Uint8Array, metadataBuffer: Uint8Array): boolean {
        const dataSize = bucket.dataHandle.getSize();
        const metadataSize = bucket.metadataHandle.getSize();

        try {
            this.#write(bucket.dataHandle, dataBuffer, { at: dataSize });
            this.#write(bucket.metadataHandle, metadataBuffer, { at: metadataSize });
        } catch (error) {
            // Every error could come with a partial write, so we try to roll it back.
            // In theory, truncating can also fail, but we can't do anything about it. The next cache open will clear the cache in that case.
            bucket.dataHandle.truncate(dataSize);
            bucket.metadataHandle.truncate(metadataSize);
            if (error.name !== QUOTA_EXCEEDED_ERROR) {
                throw error;
            }
            this.#sendQuotaExceededAnalytics();
            return false;
        }
        return true;
    }

    /**
     * Wrapper around FileSystemSyncAccessHandle.write to turn partial writes into an exception and to handle a chrome bug
     */
    #write(handle: FileSystemSyncAccessHandle, data: Uint8Array, options: FileSystemReadWriteOptions): void {
        const bytesWritten = handle.write(data, options);
        // Chrome bug workaround: When exceeding the quota in incognito mode, it does a partial write,
        // throws no QuotaExceededError, and returns something like 0xFFFFFF00, maybe an internal error code.
        // Not having this code here and just throwing a generic exception like below would work,
        // but turning this into a QuotaExceededError allows playwright tests to continue using incognito mode.
        if (bytesWritten > data.length) {
            throw new DOMException('Quota Exceeded in Chrome Incognito mode', QUOTA_EXCEEDED_ERROR);
        }
        // The spec allows partial writes, see https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-write.
        // We'll handle that as an error.
        // Note that when `write` throws some other error, it could also have performed a partial write.
        if (bytesWritten !== data.length) {
            throw new DOMException('Partial write detected');
        }
    }

    /** Retrieves data associated with the given hashes.
     * @param {string[]} hashes - Array of 20 byte hashes of the data
     * @param {string[]} bucketNames - Names of the buckets in which the hashes should be looked up. Must have same length as hashes.
     * @returns {Uint8Array[]} Array of data associated with the hashes. If a hash is not found in the specified bucket, the array contains null instead.
     */
    async get(hashes: string[], bucketNames: string[]): Promise<(Uint8Array | null)[]> {
        const result = new Array<Uint8Array | null>(hashes.length).fill(null);
        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            const bucketName = bucketNames[i];
            const bucket = this.#buckets.get(bucketName) || (await this.open(bucketName));
            if (!bucket || bucket === BUCKET_OPEN_FAILED) {
                continue;
            }
            const fileOffset = bucket.offsets.get(hash);
            if (!fileOffset) {
                continue;
            }
            const data = new Uint8Array(fileOffset[1]);
            bucket.dataHandle.read(data, { at: fileOffset[0] });
            result[i] = data;
        }
        return result;
    }

    /**
     * Removes data from the cache to make room for new.
     * Always removes everything with an LRU-date older than EVICTION_CUTOFF, and then tries to remove more if necessary to hit minFraction.
     * @param {number} minFraction - Minimal fraction of data that should to be removed. E.g. 0.1 means at least 10% of the cache should be evicted.
     * @returns {boolean} True if the requested amount of data or more was evicted from the cache
     */
    async #evict(minFraction = 0.1): Promise<boolean> {
        if (this.#evictPromise) {
            return this.#evictPromise;
        }
        this.#evictPromise = this.#evictImpl(minFraction);
        const result = await this.#evictPromise;
        this.#evictPromise = undefined;
        return result;
    }

    async #evictImpl(minFraction: number): Promise<boolean> {
        await this.#initPromise;
        if (!this.#cacheDir) {
            return false;
        }
        const files = new Array<File>();
        let totalSize = 0;
        for (const [, file] of await getFiles(this.#cacheDir)) {
            totalSize += file.size;

            if (!file.name.endsWith(METADATA_SUFFIX)) {
                continue;
            }
            files.push(file);
        }

        const minBytes = totalSize * minFraction;

        // We do write a last access timestamp into the files, but we use the .lastModified property here,
        // which should be equivalent and doesn't require opening the file. We still have to write *something*
        // to the file to update lastModified though as there is no touch API, and a timestamp seemed only fitting.
        const filesSorted = files.sort((a, b) => a.lastModified - b.lastModified);
        let deletedBytes = 0;
        const cutoff = Date.now() - EVICTION_CUTOFF;
        for (const metadataFile of filesSorted) {
            if (metadataFile.lastModified > cutoff && deletedBytes >= minBytes) {
                break;
            }
            try {
                await this.#cacheDir.removeEntry(metadataFile.name);
                deletedBytes += metadataFile.size;

                const bucketFileName = metadataFile.name.slice(0, -METADATA_SUFFIX.length);
                const dataFile = await (await this.#cacheDir.getFileHandle(bucketFileName)).getFile();
                await this.#cacheDir.removeEntry(bucketFileName);
                deletedBytes += dataFile.size;
            } catch (e) {
                // The currently open files will throw this
                if (e.name !== 'NoModificationAllowedError') {
                    console.warn('Error during cache eviction', e);
                }
            }
        }
        return deletedBytes >= minBytes;
    }

    /** Closes all open file handles. Since the handles are exclusive, this should be called as soon as possible.
     * Note that calling this while initialization is running will make this asynchronous,
     * and attempting any other operation while the close is in progress might break things.
     * Also, calling close while e.g. an asynchronous store is in progress will probably break.
     */
    async close() {
        this.#initPromise && (await this.#initPromise);
        this.#initializingBuckets.size && (await Promise.all(this.#initializingBuckets.values()));
        for (const bucket of this.#buckets.values()) {
            if (!bucket || bucket === BUCKET_OPEN_FAILED) {
                return;
            }
            if (bucket.dataHandle) {
                bucket.dataHandle.flush();
                bucket.dataHandle.close();
            }

            if (bucket.metadataHandle) {
                bucket.metadataHandle.flush();
                bucket.metadataHandle.close();
            }

            // release all write locks
            bucket.writeLock?.();
        }
        this.#buckets.clear();
        await this.#evict(0.0);
    }

    /** Deletes all buckets */
    async clear() {
        await this.close();
        await this.#evict(1.0);
    }

    async getStats(): Promise<Statistics> {
        await this.#initPromise;
        let entries = 0;
        let dataSize = 0;
        let metadataSize = 0;

        if (this.#cacheDir) {
            for (const [key, file] of await getFiles(this.#cacheDir)) {
                if (key.endsWith(METADATA_SUFFIX)) {
                    metadataSize += file.size;
                    entries += (file.size - METADATA_OFFSET) / METADATA_STRIDE;
                } else {
                    dataSize += file.size;
                }
            }
        }

        return {
            entries,
            dataSize,
            metadataSize,
        };
    }

    #sendQuotaExceededAnalytics() {
        if (this.#quotaExceededAnalyticsCallbackExecuted) {
            return;
        }
        this.#quotaExceededAnalyticsCallbackExecuted = true;
        navigator.storage
            .estimate()
            .then((estimate) => {
                this.#analyticsCallback?.('viewer.opfsCache.quotaExceeded', estimate);
            })
            .catch((error) => {
                console.error('Failed to get storage estimate', error);
            });
    }
}
