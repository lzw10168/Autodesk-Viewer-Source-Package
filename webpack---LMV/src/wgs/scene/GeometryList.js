import * as THREE from "three";

import {
    MemoryTracker
} from './MemoryTracker';

/**
 * Maintains a list of buffer geometries and running totals of their memory usage, etc.
 * Each geometry gets an integer ID to be used as reference in packed fragment lists.
 * @param {number} numObjects Number of objects (may be 0 if not known in advance).
 * @param {boolean} is2d True for 2D datasets.
 * @param {boolean} [disableStreaming] Set to true for small models to enforce full GPU upload.
 * @constructor
 */
export function GeometryList(numObjects, is2d, disableStreaming, isUnitBoxes) {
    // array of BufferGeometry instances. Indexed by svfid.
    this.geoms = [null]; //keep index 0 reserved for invalid id

    this.geomPolyCount = 0; // summed number of polygons, where geometries with mulitple instances are counted only once.
    this.instancePolyCount = 0; // summed number of polygons, counted per instance
    this.is2d = is2d;

    // 6 floats per geometry
    this.geomBoxes = isUnitBoxes ? null : new Float32Array(Math.max(1, numObjects + 1) * 6);
    this.numObjects = numObjects;

    // If false, we use a heuristic to determine which shapes are uploaded to GPU and which
    // ones we draw from CPU memory using (slower) streaming draw.
    this.disableStreaming = !!disableStreaming;

    this.instanceCount = [null]; //keep index 0 reserved for invalid id
}

GeometryList.prototype._getMemoryStat = function(stat) {
    const stats = MemoryTracker.geomListStats.get(this);
    if (!stats) {
        return 0;
    }
    return stats[stat];
};

// total number of geoms added via addGeometry(..) (may be <this.geoms.length)
Object.defineProperty(GeometryList.prototype, 'numGeomsInMemory', {
    get() {
        return this._getMemoryStat('geomCount');
    }
});

// total memory in bytes of all geoms
Object.defineProperty(GeometryList.prototype, 'geomMemory', {
    get() {
        return this._getMemoryStat('geomMemory');
    }
});

// total number of geometries that we fully upload to GPU for drawing
Object.defineProperty(GeometryList.prototype, 'gpuNumMeshes', {
    get() {
        return this._getMemoryStat('gpuGeomCount');
    }
});

// total memory in bytes of all geoms, exluding those that we draw from system memory
Object.defineProperty(GeometryList.prototype, 'gpuMeshMemory', {
    get() {
        return this._getMemoryStat('gpuGeomMemory');
    }
});

GeometryList.prototype.getGeometry = function(svfid) {
    return this.geoms[svfid];
};

GeometryList.prototype.hasGeometry = function(svfid) {
    return !!this.geoms[svfid];
};

GeometryList.prototype.getCount = function() {
    return this.geoms.length;
};

GeometryList.prototype._addBbox = function(svfid, bb) {
    if (this.geomBoxes) {
        // resize this.geombboxes if necessary
        var fill = (this.geomBoxes.length / 6) | 0;
        if (fill < this.getCount()) {
            var end = (this.getCount() * 3 / 2) | 0;
            var nb = new Float32Array(6 * end);
            nb.set(this.geomBoxes);
            // Make all of the new bounds empty
            var empty = new THREE.Box3();
            empty.makeEmpty();
            while (fill < end) {
                nb[fill * 6] = empty.min.x;
                nb[fill * 6 + 1] = empty.min.y;
                nb[fill * 6 + 2] = empty.min.z;
                nb[fill * 6 + 3] = empty.max.x;
                nb[fill * 6 + 4] = empty.max.y;
                nb[fill++ * 6 + 5] = empty.max.z;
            }
            this.geomBoxes = nb;
        }

        // copy geometry bbox to this.geomBoxes
        this.geomBoxes[svfid * 6] = bb.min.x;
        this.geomBoxes[svfid * 6 + 1] = bb.min.y;
        this.geomBoxes[svfid * 6 + 2] = bb.min.z;
        this.geomBoxes[svfid * 6 + 3] = bb.max.x;
        this.geomBoxes[svfid * 6 + 4] = bb.max.y;
        this.geomBoxes[svfid * 6 + 5] = bb.max.z;
    }
};

GeometryList.prototype._getPolygonCount = function(geometry) {
    // @todo: magic number based polygon count guessing - this should be an information
    // provided using a dedicated layout descriptor, consolidated geometry util, or part of
    // the geometry itself.
    const ib = geometry.ib;
    var perPoly = geometry.isLines ? 2 : 3;
    var polyCount;
    if (ib) {
        polyCount = ib.length / perPoly;
    } else if (geometry.vb) {
        polyCount = geometry.vb.length / (perPoly * geometry.vbstride);
    } else {
        polyCount = geometry.attributes['position'].array.length / (3 * perPoly);
    }
    return polyCount;
};

/**
 * Adds a BufferGeometry object to this GeometryList while also update the
 * BufferGeometry in the following ways:
 *
 *  - Sets its 'streamingDraw' and 'streamingIndex' properties to determine if
 *    it should be stored in the system or GPU memory.
 *  - Sets its 'svfid' property so that each BufferGeometry knows its index in
 *    the internal array 'this.geoms'.
 *  - Deletes its bounding box and bounding sphere to conserve memory.
 *
 * Note that this method is not meant to be called multiple times for the same
 * svfid, as doing so would mess up the statistics.
 *
 * @param {THREE.BufferGeometry} geometry A mandatory parameter that must not
 * be null. The same BufferGeometry cannot be added to more than one GeometryList.
 * @param {number} numInstances The number of fragments that reference the given geometry.
 * Additional instances can be added via 'addInstance', if the final count isn't known when adding the geometry.
 * The default value is 1 if the parameter is not supplied.
 * @param {number} svfid The index of the BufferGeometry when it is stored in
 * the internal list 'this.geoms'. If this parameter is not defined, equals to
 * zero, or is a negative number, the BufferGeometry is appended to the end of
 * 'this.geoms' array.
 *
 * @todo: svfid should not be called svfid! And if it is an index, we should prefer idx.
 */
GeometryList.prototype.addGeometry = function(geometry, numInstances, svfid) {
    if (geometry.hash) {
        geometry.modelRefCount++;
    }

    MemoryTracker.trackGeometry(this, geometry);
    MemoryTracker.setMemoryType(this, geometry, numInstances);

    // if no svfid is defined
    if (svfid === undefined || svfid <= 0)
        svfid = this.geoms.length;

    // store geometry (may increase array length)
    this.geoms[svfid] = geometry;

    if (!geometry.boundingBox && !geometry.hash) {
        console.error("Mesh without bbox and without hash should not be."); // OTGs (with hashes) are expected to have no bbox. Everything else should have it.
    }

    this._addBbox(svfid, geometry.boundingBox);

    //Free the bbx objects if we don't want them.
    if (!this.is2d) {
        geometry.boundingBox = null;
        geometry.boundingSphere = null;
    }

    // track polygon count
    //TODO: Asssignment into the svf is temporary until the dependencies
    //are unentangled
    // Record the count that can be decrease properly when geometry removed.
    geometry.polyCount = this._getPolygonCount(geometry);
    this.instanceCount[svfid] = (numInstances || 1);

    this.geomPolyCount += geometry.polyCount;
    this.instancePolyCount += geometry.polyCount * this.instanceCount[svfid];

    geometry.svfid = svfid;

    return svfid;
};

/**
 * Increase usage count of geometry
 * @param {number} idx - geometry index
 */
GeometryList.prototype.addInstance = function(idx) {
    const geom = this.getGeometry(idx);
    if (geom) {
        this.instancePolyCount += geom.polyCount || 0;
        ++this.instanceCount[idx];
    }
};

/**
 * Decrease usage count of geometry and remove geometry when unused
 * @param {number} idx - geometry index
 */
GeometryList.prototype.removeInstance = function(idx) {
    const geom = this.getGeometry(idx);
    if (geom) {
        this.instancePolyCount -= geom.polyCount || 0;

        if (--this.instanceCount[idx] === 0)
            this.removeGeometry(idx);
    }
};

/**
 * Get usage count of geometry
 * @param {number} idx - geometry index
 * @returns Number of usages
 */
GeometryList.prototype.getInstanceCount = function(idx) {
    return this.instanceCount[idx];
};

/**
 * Removes the geometry with svfid 'idx' from the list.
 * @param {int} idx - Geometry ID.
 * @returns {int} Size of the removed geometry, or 0.
 */
GeometryList.prototype.removeGeometry = function(idx) {
    // if there is no geom assigned, just return 0
    var geometry = this.getGeometry(idx);
    if (!geometry) {
        return 0;
    }

    if (geometry.hash) {
        if (geometry.modelRefCount === 1) {
            geometry.dispose();
        }
        geometry.modelRefCount--;
    } else {
        geometry.dispose();
    }

    const size = MemoryTracker.untrackGeometry(this, geometry);

    // remove geometry from the list
    this.geoms[idx] = null;

    // decrease its related counts
    this.geomPolyCount -= geometry.polyCount;

    this.instancePolyCount -= this.instanceCount[idx] * geometry.polyCount;
    this.instanceCount[idx] = 0;

    return size;
};

/**
 * Returns bounding box of a geometry.
 * @param {number} geomid - Geometry ID.
 * @param {THREE.Box3|LmvBox3} dst - Set to empty is there is no geometry of this id.
 */
GeometryList.prototype.getModelBox = function(geomid, dst) {

    //In case of OTG models, we do not store the geometry bounds, because
    //they are all unit boxes.
    if (!this.geomBoxes) {
        // Note: Since 0 is reserved as invalid geometry-index, the geometries start at 1
        //       and this.numObjects itself is still a valid index. Therefore <=.
        if (geomid >= 1 && geomid <= this.numObjects) {
            dst.min.x = -0.5;
            dst.min.y = -0.5;
            dst.min.z = -0.5;
            dst.max.x = 0.5;
            dst.max.y = 0.5;
            dst.max.z = 0.5;
        } else {
            dst.makeEmpty();
        }
        return;
    }

    // return empty box if geomid is out of bounds. If the id is in bounds
    // then the stored bbox is empty if the geometry hasn't been loaded
    if (geomid === 0 || this.geomBoxes.length / 6 <= geomid) {
        dst.makeEmpty();
        return;
    }

    // extract bbox values from Float32Array this.geomboxes
    var off = geomid * 6;
    var bb = this.geomBoxes;
    dst.min.x = bb[off];
    dst.min.y = bb[off + 1];
    dst.min.z = bb[off + 2];
    dst.max.x = bb[off + 3];
    dst.max.y = bb[off + 4];
    dst.max.z = bb[off + 5];
};

/**
 * Tell renderer to release all GPU buffers.
 * This will only be done if a geometry is not shared with another model (only for SVF2).
 */
GeometryList.prototype.dispose = function() {
    let geometry;
    for (var i = 0, iEnd = this.geoms.length; i < iEnd; i++) {
        geometry = this.geoms[i];
        if (!geometry) {
            return;
        }

        if (geometry.hash) {
            if (geometry.modelRefCount === 1) {
                geometry.dispose();
            }
        } else {
            geometry.dispose();
        }
    }
};

GeometryList.prototype.dtor = function() {
    for (var i = 1; i < this.geoms.length; i++) {
        this.removeGeometry(i);
    }

    this.geoms = null;
    this.instanceCount = null;
    this.geomBoxes = null;
};

GeometryList.prototype.printStats = function() {
    console.log("Total geometry size: " + (this.geomMemory / (1024 * 1024)) + " MB");
    console.log("Number of meshes: " + (this.getCount() - 1));
    console.log("Num Meshes on GPU: " + this.gpuNumMeshes);
    console.log("Net GPU geom memory used: " + this.gpuMeshMemory);
};