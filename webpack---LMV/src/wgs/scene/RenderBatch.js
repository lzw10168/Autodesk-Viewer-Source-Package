import {
    VBIntersector
} from './VBIntersector';
import {
    FrustumIntersector
} from './FrustumIntersector';
import {
    MeshFlags
} from "./MeshFlags";
import {
    RenderFlags
} from "./RenderFlags";
import {
    logger
} from "../../logger/Logger";
import {
    LmvBox3 as Box3
} from './LmvBox3';
import {
    ENABLE_PIXEL_CULLING
} from '../globals';

var _tmpBox = new Box3();
var _depths = null;

/**
 * Represents a subset of objects from a larger list, for e.g. a draw call batch
 * to send to the renderer. It's like a small view into an ordered FragmentList.
 */
export class RenderBatch {
    frags;

    // may be a typed array (usually, Int32Array) or generic Array containing the actual typed array in index 0, see getIndices(). May be null, which means indices[i]==i.
    indices;

    start;
    count;

    // Defines the (exclusive) range end used in this.forEach(). If a batch is complete, i.e. all fragments are added, 
    // we usually have this.lastItem = this.start + this.count. But it may be smaller if dynamic adding is being used.
    // The final value of this.lastItem is set from outside by the creator (see e.g., ModelIteratorLinear or ModelIteratorBVH)
    // NOTE: this.lastItem must be set before this.forEach() has any effect.
    lastItem;

    // Compatibility with THREE.Scene. Optional override material (instanceof THREE.ShaderMaterial) temporarily used by renderers.
    overrideMaterial = null;

    // Whether sort by material ID has been done
    sortDone = false;

    // number of added batches since last material sort
    numAdded = 0;

    // Average time spent for rendering this batch. Maintained externally by RenderScene.renderSome()
    avgFrameTime = undefined;

    // Optional: Unique index of this RenderBatch (used by modelIteratorBVH/ConsolidationIterator)
    nodeIndex = undefined;

    // Summed worldBoxes
    // First 6 terms are the visible bounds, second 6 terms are the hidden bounds
    bboxes = new Array(12);

    //Tells the renderer whether to sort by Z before drawing.
    //We only set this for RenderBatches containing transparent objects.
    sortObjects = false;

    sortByShaderDone = false;

    //Tells the renderer whether to do per-mesh frustum culling.
    //In some cases when we know the whole batch is completely
    //contained in the viewing frustum, we turn this off.
    frustumCulled = true;

    //Used by ground shadow code path
    forceVisible = false;

    renderImmediate;

    //Set per frame during scene traversal
    renderImportance = 0.0;

    /**
     * frags     -- FragmentList of all available meshes (1:1 correspondence with LMV fragments)
     * fragOrder -- Array of indices, pointing into the array of fragments
     * start     -- start index in the array of indices
     * count     -- how many mesh indices (after start index) are contained in the subset.
     * @constructor
     */
    constructor(frags, fragOrder, start, count) {
        this.frags = frags;
        this.indices = fragOrder;
        this.start = start;
        this.count = count;
        this.lastItem = start;

        this.bboxes[0] = this.bboxes[1] = this.bboxes[2] = Infinity;
        this.bboxes[3] = this.bboxes[4] = this.bboxes[5] = -Infinity;
        this.bboxes[6] = this.bboxes[7] = this.bboxes[8] = Infinity;
        this.bboxes[9] = this.bboxes[10] = this.bboxes[11] = -Infinity;

        // FragmentList do not always contain THREE.Meshes for each shape. They may also just contain plain BufferGeometry 
        // and THREE.ShaderMaterial. In this case, the renderer must handle the this batch using immediate mode rendering.
        // (see FragmentList.getVizmesh() and WebGLRenderer.render() for details)
        this.renderImmediate = !frags.useThreeMesh;
    }

    clone() {
        const renderBatch = new RenderBatch(this.frags, this.indices, this.start, this.count);
        renderBatch.sortDone = this.sortDone;
        renderBatch.sortByShaderDone = this.sortByShaderDone;
        renderBatch.lastItem = this.lastItem;
        renderBatch.visibleStats = this.visibleStats;
        renderBatch.numAdded = this.numAdded;
        renderBatch.bboxes = this.bboxes.slice();

        return renderBatch;
    }

    getIndices() {
        // Note that isArray returns false for typed arrays like Int32Array.
        // isArray() is used to here to check whether indices is
        //  a) a typed array itself or
        //  b) a generic array containing the actual typed array in index 0.
        return Array.isArray(this.indices) ? this.indices[0] : this.indices;
    }

    sortByMaterial() {
        //Render batch must be complete before we can sort it
        if (this.numAdded < this.count) {
            return;
        }

        var frags = this.frags;
        var indices = this.getIndices();

        if (!indices) {
            logger.warn("Only indexed RenderSubsets can be sorted.");
            return;
        }

        // apply sort only to the range used by this batch
        var tmp = indices.subarray(this.start, this.start + this.count);
        Array.prototype.sort.call(tmp, function(a, b) {
            var ma = frags.getMaterialId(a);
            var mb = frags.getMaterialId(b);

            if (ma === undefined)
                return mb ? 1 : 0;
            if (mb === undefined)
                return -1;

            return ma - mb;
        });

        //indices.set(tmp, this.start); // not needed because tmp already points to the same buffer

        // indicate that indices are sorted by material and no batches have been added since then.
        this.numAdded = 0;
        this.sortDone = true;
    }

    // Sorts meshes in the render batch by shader ID, to avoid unnecessary shader switching in the renderer when looping over a batch.
    // This can only be performed once the RenderBatch is full/complete and all shaders are known.
    sortByShader() {
        //Render batch must be complete before we can sort it
        if (!this.sortDone || this.sortByShaderDone)
            return;

        var frags = this.frags;
        var indices = this.getIndices();

        var tmp = indices.subarray(this.start, this.start + this.count);

        Array.prototype.sort.call(tmp, function(a, b) {
            var ma = frags.getMaterial(a);
            var mb = frags.getMaterial(b);

            var pd = ma.program.id - mb.program.id;
            if (pd)
                return pd;

            return ma.id - mb.id;
        });

        this.numAdded = 0;
        this.sortByShaderDone = true;
    }

    // Sorts this.indices by increasing depth for the current view.
    // Input: frustumIn instanceof FrustumIntersector
    sortByDepth(frustumIn) {
        var frags = this.frags;
        var indices = this.getIndices();
        var frustum = frustumIn;
        var bbox = _tmpBox;

        if (!indices) {
            logger.warn("Only indexed RenderSubsets can be sorted.");
            return;
        }

        // allocate this.depth to store a depth value for each fragment index in indicesView
        if (!_depths || _depths.length < this.count)
            _depths = new Float32Array(this.count);

        var depths = _depths;
        var start = this.start;

        // For each fragId indicesView[i], compute the depth and store it in depth[i]
        this.forEachNoMesh(
            (fragId, i) => { // use frustum to calculate depth per fragment
                if (!frags.hasGeometry(fragId))
                    depths[i] = -Infinity;
                else {
                    frags.getWorldBounds(fragId, bbox);
                    depths[i] = frustum.estimateDepth(bbox);
                }
            }
        );

        // Insertion sort appears to be about 7x or more faster
        // for lists of 64 or less objects vs. defining a sort() function.
        // TODO Asking if there's a faster way. Traian mentioned quicksort > 8 objects; I might give this a try.
        var tempDepth, tempIndex;
        for (var j = 1; j < this.count; j++) {
            var k = j;
            while (k > 0 && depths[k - 1] < depths[k]) {

                // swap elem at position k one position backwards (for indices and depths)
                tempDepth = depths[k - 1];
                depths[k - 1] = depths[k];
                depths[k] = tempDepth;

                tempIndex = indices[start + k - 1];
                indices[start + k - 1] = indices[start + k];
                indices[start + k] = tempIndex;

                k--;
            }
        }
    }

    // Adds the given THREE.Box3 to the renderBatch bounding box or hidden object bounding box
    addToBox(box, hidden) {
        var offset = hidden ? 6 : 0;
        var bb = this.bboxes;
        bb[0 + offset] = Math.min(bb[0 + offset], box.min.x);
        bb[1 + offset] = Math.min(bb[1 + offset], box.min.y);
        bb[2 + offset] = Math.min(bb[2 + offset], box.min.z);

        bb[3 + offset] = Math.max(bb[3 + offset], box.max.x);
        bb[4 + offset] = Math.max(bb[4 + offset], box.max.y);
        bb[5 + offset] = Math.max(bb[5 + offset], box.max.z);
    }

    getBoundingBox(dst) {
        dst = dst || _tmpBox;
        var bb = this.bboxes;
        dst.min.x = bb[0];
        dst.min.y = bb[1];
        dst.min.z = bb[2];

        dst.max.x = bb[3];
        dst.max.y = bb[4];
        dst.max.z = bb[5];

        return dst;
    }

    getBoundingBoxHidden(dst) {
        dst = dst || _tmpBox;
        var bb = this.bboxes;
        var offset = 6;
        dst.min.x = bb[0 + offset];
        dst.min.y = bb[1 + offset];
        dst.min.z = bb[2 + offset];

        dst.max.x = bb[3 + offset];
        dst.max.y = bb[4 + offset];
        dst.max.z = bb[5 + offset];

        return dst;
    }

    // Use only for incremental adding to linearly ordered (non-BVH) scenes!
    onFragmentAdded(fragId) {
        // update bbox
        this.frags.getWorldBounds(fragId, _tmpBox);
        this.addToBox(_tmpBox, false);

        // mark 
        this.sortDone = false;

        // NOTE: This only works with trivial fragment ordering (linear render queues).
        // Otherwise the item index does not necessarily match the fragId due to the reordering jump table (this.indices).
        if (this.lastItem <= fragId) {
            this.lastItem = fragId + 1;
            if (this.visibleStats !== undefined)
                this.visibleStats = 0; // reset visibility, since a new fragment might change it
        }
        this.numAdded++;
    }

    /**
     * Iterates over fragments.
     * @param {function} callback - function(mesh, id) called for each fragment geometry.
     *      - mesh: instanceof THREE.Mesh (as obtained from FragmentList.getVizmesh)
     *      - id:   fragment id
     * @param {number} drawMode - Optional flag (see FragmentList.js), e.g., MESH_VISIBLE. If specified, we only traverse fragments for which this flag is set.
     * @param {bool} includeEmpty - Default: false, i.e. fragments are skipped if they have no mesh available via getVizmesh().
     */
    forEach(callback, drawMode, includeEmpty) {
        var indices = this.getIndices();

        var frags = this.frags;
        var sortByShaderPossible = !this.sortByShaderDone;

        // If the most likely rendering flags are true, use a shortened version of the for-loop.
        var i, iEnd, idx, m;
        if (!drawMode && !includeEmpty && !sortByShaderPossible) {
            for (i = this.start, iEnd = this.lastItem; i < iEnd; i++) {
                idx = indices ? indices[i] : i;

                m = frags.getVizmesh(idx);

                if (m && m.geometry) {
                    callback(m, idx);
                }
            }
        } else {
            const hasDrawStart = Object.prototype.hasOwnProperty.call(this, "drawStart");
            for (i = (drawMode === MeshFlags.MESH_RENDERFLAG && hasDrawStart) ? this.drawStart : this.start, iEnd = this.lastItem; i < iEnd; i++) {
                idx = indices ? indices[i] : i;

                m = frags.getVizmesh(idx);

                if (sortByShaderPossible && (!m || !m.material || !m.material.program))
                    sortByShaderPossible = false;

                // if drawMode is given, iterate vizflags that match
                if ((includeEmpty || (m && m.geometry)) &&
                    (!drawMode || frags.isFlagSet(idx, drawMode))) {
                    callback(m, idx);
                }
            }
        }

        // If all materials shaders are already available, we can sort by shader to minimize shader switches during rendering.
        // This sort will only execute once and changing materials later will break the sorted order again.
        if (sortByShaderPossible) {
            this.sortByShader();
        }
    }

    /**
     * Iterates over fragments. Like forEach(), but takes a different callback.
     * @param {function} callback - function(fragId, idx) called for each fragment geometry.
     *      - fragId:   fragment id
     *      - idx:      running index from 0 .. (lastItem-start)
     * @param {number} drawMode - Optional flag (see FragmentList.js), e.g., MESH_VISIBLE. If specified, we only traverse fragments for which this flag is set.
     * @param {bool} includeEmpty - Default: false, i.e. fragments are skipped if they have no mesh available via getVizmesh().
     */
    forEachNoMesh(callback, drawMode, includeEmpty) {
        var indices = this.getIndices();
        var frags = this.frags;

        for (var i = this.start, iEnd = this.lastItem; i < iEnd; i++) {
            var fragId = indices ? indices[i] : i;

            // if drawMode is given, iterate vizflags that match
            if ((includeEmpty || frags.hasGeometry(fragId)) && (!drawMode || frags.isFlagSet(fragId, drawMode))) {
                callback(fragId, i - this.start);
            }
        }
    }

    /**
     * Checks if given ray hits a bounding box of any of the fragments.
     * @param {THREE.RayCaster} raycaster
     * @param {Object[]}        intersects - An object array that contains intersection result objects.
     *                                       Each result r stores properties like r.point, r.fragId, r.dbId. (see VBIntersector.js for details)
     * @param {number[]}       [dbIdFilter] - Array of dbIds. If specified, only fragments with dbIds inside the filter are checked.
     * @param {Object}         [options]    - Raycast options.
     */
    raycast(raycaster, intersects, dbIdFilter, options) {
        // Assumes bounding box is up to date.
        if (raycaster.ray.intersectsBox(this.getBoundingBox()) === false) {
            return;
        }

        // traverse all visible meshes
        this.forEach((m, fragId) => {
            // Don't intersect hidden objects
            if (this.frags.isFlagSet(fragId, MeshFlags.MESH_HIDE)) {
                return;
            }

            // Check the dbIds filter if given
            if (dbIdFilter && dbIdFilter.length) {
                //Theoretically this can return a list of IDs (for 2D meshes)
                //but this code will not be used for 2D geometry intersection.
                var dbId = 0 | this.frags.getDbIds(fragId);

                // dbIDs will almost always have just one integer in it, so indexOf should be fast enough.
                if (dbIdFilter.indexOf(dbId) === -1) {
                    return;
                }
            }

            // raycast worldBox first.
            this.frags.getWorldBounds(fragId, _tmpBox);

            // Expand bounding box a bit, to take into account axis aligned lines
            _tmpBox.expandByScalar(0.5);

            if (raycaster.ray.intersectsBox(_tmpBox)) {
                // worldbox was hit. do raycast with actual geometry.
                VBIntersector.rayCast(m, raycaster, intersects, options);
            }

        }, MeshFlags.MESH_VISIBLE);
    }

    /**
     * Checks if a given FrustumIntersector hits the bounding box of any of the fragments. Calls the callback if it does.
     * @param {FrustumIntersector}  frustumIntersector
     * @param {Function}            callback - callback function to receive fragment IDs which intersect or are contained by the frustum
     * @param {Boolean}             [containmentKnown] - true if it's already known that the RenderBatch is fully contained by the frustum
     */
    intersectFrustum(frustumIntersector, callback, containmentKnown) {
        if (!containmentKnown) {
            let result = frustumIntersector.intersectsBox(this.getBoundingBox());
            if (result === FrustumIntersector.OUTSIDE) {
                return;
            }
            if (result === FrustumIntersector.CONTAINS) {
                containmentKnown = true;
            }
        }

        // traverse all visible meshes
        this.forEach((m, fragId) => {
            // Don't intersect hidden objects
            if (this.frags.isFlagSet(fragId, MeshFlags.MESH_HIDE))
                return;

            if (containmentKnown) {
                callback(fragId, containmentKnown);
                return;
            }

            // raycast worldBox first.
            this.frags.getWorldBounds(fragId, _tmpBox);

            let result = frustumIntersector.intersectsBox(_tmpBox);
            if (result !== FrustumIntersector.OUTSIDE) {
                callback(fragId, result === FrustumIntersector.CONTAINS);
            }
        }, MeshFlags.MESH_VISIBLE);
    }

    /**
     * Computes/updates the bounding boxes of this batch.
     */
    calculateBounds() {
        // init boxes for visible and ghosted meshes
        this.bboxes[0] = this.bboxes[1] = this.bboxes[2] = Infinity;
        this.bboxes[3] = this.bboxes[4] = this.bboxes[5] = -Infinity;
        this.bboxes[6] = this.bboxes[7] = this.bboxes[8] = Infinity;
        this.bboxes[9] = this.bboxes[10] = this.bboxes[11] = -Infinity;

        // Why including null geometry?: If we would exclude fragments whose geometry is not loaded yet, we would need to refresh all bboxes permanently during loading.
        // Since we know bboxes earlier than geometry (for SFF at FragmentList construction time and for Otg as soon as BVH data is available), including empty meshes
        // ensures that the bbox result is not affected by geometry loading state for 3D.
        this.forEachNoMesh(fragId => {
            // adds box of a fragment to bounds or bounds, depending on its vizflags.
            this.frags.getWorldBounds(fragId, _tmpBox);

            const vizflags = this.frags.vizflags;
            var f = vizflags[fragId];

            this.addToBox(_tmpBox, !(f & 1 /*MESH_VISIBLE*/ ));
        }, 0, true);
    }

    /**
     * Updates visibility for all fragments of this RenderBatch. 
     * This means:
     *  1. It returns true if all meshes are hidden (false otherwise)
     *
     *  2. If the whole batch box is outside the frustum, nothing else is done.
     *     (using this.getBoundingBox() or this.getBoundingBoxHidden(), depending on drawMode)
     *
     *  3. For all each checked fragment with fragId fid and mesh m, the final visibility is stored...
     *      a) In the m.visible flag.
     *      b) In the MESH_RENDERFLAG of the vizflags[fid]
     *     This is only done for fragments with geometry.   
     * @param {number} drawMode - One of the modes defined in RenderFlags.js, e.g. RENDER_NORMAL
     * @param {FrustumIntersector} frustum
     * @returns {bool} True if all meshes are hidden (false otherwise).
     */
    applyVisibility(drawModeIn, frustumIn) {
        let frags;
        let vizflags;
        let frustum;
        let drawMode;
        let checkContainment; // indicates if the batch is completely inside the frustum
        let allHidden;
        let doNotCut; // do not apply cutplanes

        /**
         * Checks if fragment is outside the frustum.
         * @param {number} idx - index into frags.
         * @returns {bool} True if the given fragment is outside the frustum and culling is enabled.
         */
        function evalCulling(idx) {
            var culled = false;

            frags.getWorldBounds(idx, _tmpBox);
            if (checkContainment && !frustum.intersectsBox(_tmpBox)) {
                culled = true;
            }

            if (ENABLE_PIXEL_CULLING && !culled && frustum.estimateProjectedDiameter(_tmpBox) < frustum.areaCullThreshold) {
                culled = true;
            }

            // apply cutplane culling
            // TODO We ignore checkContainment, because checkContainment is set to false if the RenderBatch is fully inside the frustum - which still tells nothing about the cutplanes.
            // Ideally, we should a corresponding hierarchical check per cutplane too.
            if (!culled && !doNotCut && frustum.boxOutsideCutPlanes(_tmpBox)) {
                culled = true;
            }

            return culled;
        }

        /**
         * Sets the MESH_RENDERFLAG for a single fragment, depending on the drawMode and the other flags of the fragment.
         * @param {number} idx - index into vizflags, for which we want to determine the MESH_RENDERFLAG.
         * @param {bool} hideLines
         * @param {bool} hidePoints
         * @returns {bool} Final, evaluated visibility.
         */
        function evalVisibility(idx, hideLines, hidePoints) {
            let isFragVisible = false;

            // Strange bug in MS Edge when the debugger is active. Down below where we or in the MESH_RENDERFLAG, ~MESH_RENDERFLAG was getting used in stead.
            // Copying the value to a local variable fixed the issue.
            const rflag = MeshFlags.MESH_RENDERFLAG;
            const vfin = vizflags[idx] & ~rflag;

            switch (drawMode) {
                case RenderFlags.RENDER_HIDDEN:
                    // visible (bit 0 on)
                    isFragVisible = !(vfin & MeshFlags.MESH_VISIBLE);
                    break;
                case RenderFlags.RENDER_HIGHLIGHTED:
                    // highlighted (bit 1 on)
                    isFragVisible = vfin & MeshFlags.MESH_HIGHLIGHTED;
                    break;
                default:
                    // visible but not highlighted, and not a hidden line (bit 0 on, bit 1 off, bit 2 off)
                    isFragVisible = (vfin & (MeshFlags.MESH_VISIBLE | MeshFlags.MESH_HIGHLIGHTED | MeshFlags.MESH_HIDE)) == 1;
                    break;
            }

            if (hideLines) {
                const isLine = vfin & (MeshFlags.MESH_ISLINE | MeshFlags.MESH_ISWIDELINE);
                isFragVisible = isFragVisible && !isLine;
            }

            if (hidePoints) {
                const isPoint = (vfin & MeshFlags.MESH_ISPOINT);
                isFragVisible = isFragVisible && !isPoint;
            }

            // Store evaluated visibility into bit 7 of the vizflags to use for immediate rendering
            vizflags[idx] = vfin | (isFragVisible ? rflag : 0);

            return isFragVisible;
        }

        // Callback to apply visibility for a single fragment
        //
        // Input: Geometry and index of a fragment, i.e.
        //  m:   instanceof THREE.Mesh (see FragmentList.getVizmesh). May be null.
        //  idx: index of the fragment in the fragment list. 
        //
        // What is does:
        //  1. bool m.visible is updated based on flags and frustum check (if m!=null)
        //  2. The MESH_RENDERFLAG flag is updated for this fragment, i.e., is true for meshes with m.visible==true
        //  3. If there is no geometry and there is a custom callback (checkCull) 
        //  4. Set allHidden to false if any mesh passes as visible.
        function applyVisCB(mesh, idx) {
            // if there's no mesh or no geometry, just call the custom callback.
            // TODO it would be clearer to remove the frags.useThreeMesh condition here.
            // It's not really intuitive that for (m==0) the callback is only called for frags.useThreeMesh.
            // Probably the reason is just that this code section has just been implemented for the useThreeMesh case and the other one was irrelevant.
            if ((!mesh && frags.useThreeMesh) || (!mesh.geometry)) {
                return;
            }

            // apply frustum check for this fragment
            const culled = evalCulling(idx);

            // if outside, set m.visible and the MESH_RENDERFLAG of the fragment to false
            if (culled) {
                if (mesh) {
                    mesh.visible = false;
                } else {
                    logger.warn("Unexpected null mesh");
                }
                // unset MESH_RENDERFLAG
                vizflags[idx] = vizflags[idx] & ~MeshFlags.MESH_RENDERFLAG;

                return;
            }

            // frustum check passed. But it might still be invisible due to vizflags and/or drawMode. 
            // Note that evalVisibility also updates the MESH_RENDERFLAG already.
            const visible = evalVisibility(idx, frags.linesHidden, frags.pointsHidden);

            if (mesh) {
                mesh.visible = !!visible;
            }

            // Set to false if any mesh passes as visible
            allHidden = allHidden && !visible;
        }

        // Similar to applyVisCB above, but without geometry param, so that we don't set any m.visible property.
        function applyVisCBNoMesh(idx, idx2) {
            // if no geometry is assigned, just call custom cb (if specified) and stop here.
            const isGeometryAssigned = frags.getGeometryId(idx);
            if (!isGeometryAssigned) {
                return;
            }

            // apply frustum check for this fragment
            const culled = evalCulling(idx);

            // if culled, set visflags MESH_RENDERFLAG to false 
            if (culled) {
                vizflags[idx] = vizflags[idx] & ~MeshFlags.MESH_RENDERFLAG;
                return;
            }

            // frustum check passed. But it might still be invisible due to vizflags and/or drawMode. 
            // Note that evalVisibility also updates the MESH_RENDERFLAG already.
            const visible = evalVisibility(idx, frags.linesHidden, frags.pointsHidden);

            // Set to false if any mesh passes as visible
            allHidden = allHidden && !visible;
        }

        // Used when parts of the same scene have to draw in separate passes (e.g. during isolate).
        // TODO Consider maintaining two render queues instead if the use cases get too complex, because this approach is not very scalable as currently done:
        // It traverses the entire scene twice, plus the flag flipping for each item.

        allHidden = true;
        frustum = frustumIn;
        drawMode = drawModeIn;

        var bbox = (drawMode === RenderFlags.RENDER_HIDDEN) ? this.getBoundingBoxHidden() : this.getBoundingBox();

        // Check if the entire render batch is contained inside  the frustum. This will save per-object checks.
        var containment = frustum.intersectsBox(bbox);
        if (containment === FrustumIntersector.OUTSIDE) {
            return allHidden; // nothing to draw
        }

        // check if the whole batch is too small
        if (ENABLE_PIXEL_CULLING && frustum.estimateProjectedDiameter(bbox) < frustum.areaCullThreshold) {
            return allHidden;
        }

        doNotCut = this.frags.doNotCut;
        if (!doNotCut && frustumIn.boxOutsideCutPlanes(bbox)) {
            return allHidden;
        }

        vizflags = this.frags.vizflags;
        frags = this.frags;
        checkContainment = containment !== FrustumIntersector.CONTAINS;

        // The main difference between applyVisCB and applyVisCBNoMesh is that applyVisCB also updates mesh.visible for each mesh.
        // This does only make sense when using THREE.Mesh. Otherwise, the mesh containers are volatile anyway (see FragmentList.getVizmesh)
        if (!frags.useThreeMesh) {
            // Use callback that does not set mesh.visible
            this.forEachNoMesh(applyVisCBNoMesh, 0, false);
        } else {
            // Use callback that also sets mesh.visible.
            // Skip fragments without geometry unless a custom callback is defined (fragIdCB)
            this.forEach(applyVisCB, null);
        }

        frags = null;

        return allHidden;
    }
}