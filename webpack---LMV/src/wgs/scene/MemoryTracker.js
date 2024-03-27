import * as globals from '../globals';
import {
    isMobileDevice
} from "../../compat";
import {
    EventDispatcher
} from "../../application/EventDispatcher";

const DEFAULT_GEOMETRY_MEM_LIMIT = Infinity;
const DEFAULT_MEM_HARD_LIMT_DIFF = 10 * 1024 * 1024; // 10 MB
export const RESOURCE_TYPES = {
    MEMORY: 1
};

export const RESOURCE_EVENTS = {
    /**
     * Fired when the memory limit is reached.
     * @event Autodesk.Viewing.Private#RESOURCE_EVENTS.LIMIT_REACHED_EVENT
     * @property {string} Resource Type
     */
    LIMIT_REACHED_EVENT: 'resLimitReached',

    /**
     * Fired when the memory usage goes below limit again.
     * @event Autodesk.Viewing.Private#RESOURCE_EVENTS.BELOW_LIMIT_EVENT
     * @property {string} Resource Type
     */
    BELOW_LIMIT_EVENT: 'belowResLimit'
};

// Define GPU memory limits for heuristics below
const GPU_MEMORY_LOW = globals.GPU_MEMORY_LIMIT;
const GPU_MEMORY_HIGH = 2 * GPU_MEMORY_LOW;
const GPU_MESH_MAX = globals.GPU_OBJECT_LIMIT;

export class MemoryTracker {

    // Global geometry memory stats.
    static geomMemory = 0;
    static geomCount = 0;
    static gpuGeomMemory = 0;
    static gpuGeomCount = 0;

    // Per Model / GeometryList geometry stats. GeometryLists reference this in their resource stats getters.
    // This counts all geometries of a model, independent of whether some geometries are shared with other models.
    // Note that this is only intended for internal statistics and analytics. Use global stats for resource management.
    // GeometryList instances are keys. Values are objects with the same properties that we track for the global stats
    // below. If a geometry list is deleted, it's removed from the WeakMap automatically.
    static geomListStats = new WeakMap();

    static# getOrCreateGeomListStats(geometryList) {
        let modelStats = this.geomListStats.get(geometryList);
        if (!modelStats) {
            modelStats = {
                geomMemory: 0,
                geomCount: 0,
                gpuGeomMemory: 0,
                gpuGeomCount: 0
            };
            this.geomListStats.set(geometryList, modelStats);
        }
        return modelStats;
    }

    static# geomSoftMemLimit = DEFAULT_GEOMETRY_MEM_LIMIT;
    static# geomHardMemLimit = DEFAULT_GEOMETRY_MEM_LIMIT + DEFAULT_MEM_HARD_LIMT_DIFF;
    static# limitSignaled = false;

    /**
     * Prints global resource usage
     */
    static printStats() {
        console.log('MemoryTracker Global Stats:');
        console.log('--------------------------');
        this.#printStatsHelper(this);
        if (!this.#globalMemoryLimits) {
            console.log('Available GPU resources are tracked per model.');
        }
    }

    /**
     * Prints resource usage per model.
     * @param {Model} model The model to print the stats for.
     */
    static printModelStats(model) {
        console.log('MemoryTracker Model Stats:');
        console.log('--------------------------');
        const geomList = model.getGeometryList();
        const modelStats = this.geomListStats.get(geomList);
        if (!modelStats) {
            console.log('No stats tracked for this model yet.');
            return;
        }
        this.#printStatsHelper(modelStats);
        if (!this.#globalMemoryLimits) {
            console.log('gpuGeomMemory remaining (low/high):', globals.GPU_MEMORY_LIMIT - modelStats.gpuGeomMemory, 2 * globals.GPU_MEMORY_LIMIT - modelStats.gpuGeomMemory);
            console.log('gpuGeomCount remaining:', globals.GPU_OBJECT_LIMIT - modelStats.gpuGeomCount);
        }
    }

    static# printStatsHelper(stats) {
        console.log('geomMemory:', stats.geomMemory);
        console.log('geomCount:', stats.geomCount);
        console.log('gpuGeomMemory:', stats.gpuGeomMemory);
        console.log('gpuGeomCount:', stats.gpuGeomCount);
        if (this.#globalMemoryLimits) {
            console.log('gpuGeomMemory remaining (low/high):', globals.GPU_MEMORY_LIMIT - this.gpuGeomMemory, 2 * globals.GPU_MEMORY_LIMIT - this.gpuGeomMemory);
            console.log('gpuGeomCount remaining:', globals.GPU_OBJECT_LIMIT - this.gpuGeomCount);
        }
    }

    // Determines whether the memory type of geometries is determined based on global or per-model stats.
    static# globalMemoryLimits = false;

    // TODO: numInstances may not be final, and does also not take sharing into account.
    /**
     * Chooses whether to store the geometry on the GPU or only in main memory.
     * @param {GeometryList} geometryList The GeometryList that the geometry belongs to.
     * @param {THREE.BufferGeometry} geometry The BufferGeometry whose storage is to
     * be determined. If the BufferGeometry is to be retained in the GPU memory, then
     * its 'streamingDraw' and 'streamingIndex' will be set to 'false'. Otherwise,
     * they will be set to 'true' to enable its streaming draw from system memory.
     * @param {number} numInstances Number of times this geometry is shared across fragments.
     */
    static setMemoryType(geometryList, geometry, numInstances) {
        const alreadyTracked = geometry.streamingDraw !== undefined;
        const useStreamingDraw = this.#chooseMemoryType(geometryList, geometry, numInstances);

        // TODO: (Per-model) GPU memory tracking doesn't work correctly for shared geometries, if different models make
        // different decisions about the streaming draw flag. If model 1 decided to upload a geometry, and model 2
        // decides to stream it, we don't have a way to untrack the memory in model 1 (and the already uploaded
        // geometry will probably leak on the GPU). Similarly, if model 1 decides to stream a geometry and model 2
        // decides to upload it, model 1 won't track it. The only two solutions (if SD decisions can change) are:
        // 1. Keep track of which model uses which geometry and update tracking states as required.
        // 2. Switch to global streaming draw decisions and drop per model GPU stats.
        // 1 is too expensive in terms of memory and implementation overhead, compared to the gain. Long-term, we need
        // a global heuristic anyway if we want to respect thresholds properly.
        // For now, we accept sub-optimal tracking. But this won't scale for frequent changes, e.g. constantly
        // (un-)loading parts of the scene and updating SD decisions.
        if (!alreadyTracked || !!geometry.streamingDraw !== useStreamingDraw) {
            geometry.streamingDraw = geometry.streamingIndex = useStreamingDraw;

            if (!useStreamingDraw) {
                this.#trackGeometryGPUMem(geometryList, geometry);
            } else if (alreadyTracked) {
                this.untrackGeometry(geometryList, geometry, false, true, true);
            }
        } else if (geometry.modelRefCount > 1 && alreadyTracked && !useStreamingDraw) {
            // Track per model memory only
            this.#trackGeometryGPUMem(geometryList, geometry, true);
        }
    }

    /**
     * Determines if a given BufferGeometry should be stored in system memory or on GPU.
     *
     * @param {GeometryList} geometryList The GeometryList that the geometry belongs to.
     * @param {THREE.BufferGeometry} geometry The BufferGeometry whose storage is to
     * be determined.
     * @param {number} numInstances The number of fragments that made up the Mesh
     * object that owns this BufferGeometry object.
     * @returns {boolean} True, if to be stored in system memory only
     */
    static# chooseMemoryType(geometryList, geometry, numInstances) {
        if (GPU_MEMORY_LOW === 0) {
            return true;
        }

        let gpuGeomMemory, gpuGeomCount;

        if (this.#globalMemoryLimits) {
            gpuGeomMemory = this.gpuGeomMemory;
            gpuGeomCount = this.gpuGeomCount;
        } else {
            const modelStats = this.#getOrCreateGeomListStats(geometryList);
            gpuGeomMemory = modelStats.gpuGeomMemory;
            gpuGeomCount = modelStats.gpuGeomCount;
        }

        //Heuristically determine if we want to load this mesh onto the GPU
        //or use streaming draw from system memory
        if (geometryList.disableStreaming || (gpuGeomMemory < GPU_MEMORY_LOW && gpuGeomCount < GPU_MESH_MAX)) {
            //We are below the lower limits, so the mesh automatically is
            //assigned to retained mode
            return false;
        } else if (gpuGeomMemory >= GPU_MEMORY_HIGH || gpuGeomCount >= GPU_MESH_MAX) {
            //We are above the upper limit, so mesh is automatically
            //assigned to streaming draw
            return true;
        } else {
            //Between the lower and upper limits,
            //Score mesh importance based on its size
            //and number of instances it has. If the score
            //is high, we will prefer to put the mesh on the GPU
            //so that we don't schlep it across the bus all the time.
            var weightScore;

            if (!geometryList.is2d) {
                weightScore = geometry.byteSize * (numInstances || 1);
            } else {
                //In the case of 2D, there are no instances, so we just keep
                //piling into the GPU until we reach the "high" mark.
                weightScore = 100001;
            }

            if (weightScore < 100000) {
                return true;
            } else {
                return false;
            }
        }
    }

    static# trackGeometryGPUMem(geometryList, geometry, modelOnly = false) {
        const modelStats = this.#getOrCreateGeomListStats(geometryList);

        if (isMobileDevice()) { // TODO Find out why this is done and whether we should keep it
            if (!modelOnly) {
                this.geomMemory += geometry.byteSize;
            }
            modelStats.geomMemory += geometry.byteSize;
        }

        if (!modelOnly) {
            this.gpuGeomMemory += geometry.byteSize;
            this.gpuGeomCount++;
        }

        modelStats.gpuGeomMemory += geometry.byteSize;
        modelStats.gpuGeomCount++;
    }

    /**
     * Tracks the geometry in main memory, both per model / geometryList, as well as globally.
     *
     * In case of SVF2 geometries, the modelRefCount value needs to be increased before calling this.
     *
     * NOTE: Only call this if the geometry is stored in main memory. If the geometry buffers are discarded after
     * uploaded them to the GPU, this function doesn't need to be called. Alternatively, call this and then call
     * untrackGeometry(geomList, geometry, true) as soon as the main memory buffers are discarded, to properly untrack
     * them again. GPU memory tracking is done implicitly when calling setMemoryType (still need to call
     * untrackGeometry(geomList, geometry, false) when removing geometries that are purely used on the GPU!).
     * @param {GeometryList} geometryList The GeometryList to track the geometry for.
     * @param {THREE.BufferGeometry} geometry The geometry to track.
     */
    static trackGeometry(geometryList, geometry) {
        const size = geometry.byteSize + globals.GEOMETRY_OVERHEAD;

        if (geometry.modelRefCount === undefined || geometry.modelRefCount === 1) {
            this.geomMemory += size;
            this.geomCount++;
        }

        const modelStats = this.#getOrCreateGeomListStats(geometryList);
        modelStats.geomMemory += size;
        modelStats.geomCount++;
        this.#checkResourceLimit(true);
    }

    /**
     * Untracks the given geometry, both per model / geometryList, as well as globally.
     *
     * In case of SVF2 geometries, the modelRefCount value needs to be decreased before calling this.
     *
     * @param {GeometryList} geometryList - The GeometryList to track the geometry for.
     * @param {THREE.BufferGeometry} geometry - Geometry to be untracked.
     * @param {boolean} [fromMemory=true] - Untrack from system memory. Defaults to true.
     * @param {boolean} [fromGPU=!geometry.streamingDraw] - Untrack from gpu memory.
     *  To be used when switching a geometry to streaming draw or deleting the geometry altogether.
     *  Defaults to true if the geometry is stored on the GPU, and false otherwise.
     * @param {boolean} [force=false] - Force untracking from global stats, even if the geometry is still used
     *  by another model. Defaults to false.
     * @returns Byte size of system memory that was untracked.
     */
    static untrackGeometry(geometryList, geometry, fromMemory = true, fromGPU, force = false) {
        let cpuSize = 0;

        const modelStats = this.geomListStats.get(geometryList);

        if (fromGPU === undefined) {
            fromGPU = (geometry.streamingDraw === false);
        }

        if (fromMemory) {
            cpuSize = geometry.byteSize + globals.GEOMETRY_OVERHEAD;

            modelStats.geomMemory -= cpuSize;
            modelStats.geomCount--;

            if (!geometry.modelRefCount || force) {
                this.geomMemory -= cpuSize;
                this.geomCount--;

                // When geometry is removed but remains in the OtgResourceCache, it might be loaded
                // again, and then setMemoryType will only track it again if these are undefined.
                geometry.streamingDraw = undefined;
                geometry.streamingIndex = undefined;
            } else {
                cpuSize = 0;
            }
        }

        if (fromGPU) {
            modelStats.gpuGeomMemory -= geometry.byteSize;
            modelStats.gpuGeomCount--;

            if (isMobileDevice()) { // TODO Find out why this is done and whether we should keep it
                if (!geometry.modelRefCount || force) {
                    cpuSize += geometry.byteSize;
                    this.geomMemory -= geometry.byteSize;
                }
                modelStats.geomMemory -= geometry.byteSize;
            }

            if (!geometry.modelRefCount || force) {
                this.gpuGeomMemory -= geometry.byteSize;
                this.gpuGeomCount--;
            }
        }

        this.#checkResourceLimit(false);

        return cpuSize;
    }

    /**
     * @returns {bool} True, if memory soft limit was reached
     */
    static memoryLimitReached() {
        return this.geomMemory >= this.#geomSoftMemLimit;
    }

    /**
     * Tests if memory hardlimit is reached or will be reached after adding byteSize
     * @param {number} [byteSize = 0] - Size of memory that is supposed to be added
     * @returns {bool} True, if memory hard limit is reached or will be reached after adding byteSize
     */
    static memoryHardLimitReached(byteSize = 0) {
        return (this.geomMemory + byteSize) >= this.#geomHardMemLimit;
    }

    /**
     * Retrieves memory size of buffer including assumed overhead
     * @param {THREE.BufferGeometry} geometry 
     * @returns {number} Size of memory used by geometry
     */
    static getGeometrySize(geometry) {
        return geometry.byteSize + globals.GEOMETRY_OVERHEAD;
    }

    static# checkResourceLimit(memIncreased) {
        if (memIncreased) {
            if (this.memoryLimitReached() && !this.#limitSignaled) {
                this.#limitSignaled = true;
                this.fireEvent({
                    type: RESOURCE_EVENTS.LIMIT_REACHED_EVENT,
                    resourceType: RESOURCE_TYPES.MEMORY
                });
            }
        } else {
            if (!this.memoryLimitReached()) {
                if (this.#limitSignaled) {
                    this.fireEvent({
                        type: RESOURCE_EVENTS.BELOW_LIMIT_EVENT,
                        resourceType: RESOURCE_TYPES.MEMORY
                    });
                }

                this.#limitSignaled = false;
            }
        }
    }

    static get memorySoftLimit() {
        return this.#geomSoftMemLimit;
    }
    static get memoryHardLimit() {
        return this.#geomHardMemLimit;
    }

    /**
     * Sets new memory limits. May trigger resource limit event.
     * @param {number} softLimit - Memory soft limit in bytes
     * @param {number} hardLimit - Memory hard limit in bytes
     */
    static setMemoryLimit(softLimit, hardLimit) {
        if (!hardLimit)
            hardLimit = softLimit + DEFAULT_MEM_HARD_LIMT_DIFF;

        const memLimitIncreased = softLimit > this.#geomSoftMemLimit;

        this.#geomSoftMemLimit = softLimit;
        this.#geomHardMemLimit = hardLimit;

        this.#checkResourceLimit(!memLimitIncreased);
    }
}

EventDispatcher.prototype.apply(MemoryTracker);