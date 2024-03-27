import * as globals from '../globals';
import {
    GeometryList
} from './GeometryList';
import {
    FragmentList
} from './FragmentList';
import {
    RenderBatch
} from './RenderBatch';
import {
    consolidateFragmentList
} from './consolidation/FragmentListConsolidation';

import {
    SceneTraversal
} from './SceneTraversal';
import {
    ModelIteratorBVH
} from './ModelIteratorBVH';

import {
    VBIntersector
} from './VBIntersector';
import * as THREE from "three";
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
    LmvMatrix4
} from "./LmvMatrix4";
import {
    DynamicGlobalOffset
} from "../../application/DynamicGlobalOffset";
import {
    getByteSize
} from './BufferGeometryUtils';
import {
    MemoryTracker
} from './MemoryTracker';

const av = Autodesk.Viewing;

// TODO: move the logic that decides whether or not to stream somewhere closer to SVF;
// Ideally, RenderModel and GeometryList should be agnostic to the file format.
/*
 * Helper function to determine whether we should enable streamingDraw or upload the whole model to GPU.
 *
 * This function uses values from an SVF package to estimate the expected GPU load. If it is
 * small enough, it returns false. This means that the whole model is uploaded to GPU.
 *
 * If the model size is larger or unknown, we use a heuristic to determine which models are uploaded
 * to GPU and which are rendered from CPU-memory using the (slower) streamingDraw.
 *  @param {number} packFileTotalSize
 *  @param {number} numPrimitives
 *  @param {number} numObjects
 */
function needsStreamingDraw(packFileTotalSize, numPrimitives, numObjects) {
    if (packFileTotalSize) {
        //In pack files, primitive indices use 4 byte integers,
        //while we use 2 byte integers for rendering, so make this
        //correction when estimating GPU usage for geometry
        var estimatedGPUMem = packFileTotalSize - numPrimitives * 3 * 2;

        //If the model is certain to be below a certain size,
        //we will skip the heuristics that upload some meshes to
        //GPU and keep other in system mem, and just push it all to the GPU.
        if (estimatedGPUMem <= globals.GPU_MEMORY_LIMIT && numObjects < globals.GPU_OBJECT_LIMIT) {
            // We don't need streaming draw - model is small enough
            return false;
        }
    }

    return true;
}

var isPointOutsidePlanecuts = (() => {
    const v = new THREE.Vector4();
    return (point, cutplanes) => {
        v.copy(point); // copy already sets w=1 when copying from a Vector3
        for (let i = 0; i < cutplanes.length; i++) {
            if (cutplanes[i].dot(v) > 1e-6) {
                return true;
            }
        }

        return false;
    };
})();

// Counter to assign individual numbers to RenderModel in order of their creation
var nextModelId = 1;

/** @class Represents functionality for WebGL rendering.
 *         Currently produced by loaders (F2DLoader, SvfLoader)
 */
export class RenderModel {
    // Cached bboxes.
    #
    visibleBounds = new THREE.Box3(); // excluding ghosted once
    #
    visibleBoundsWithHidden = new THREE.Box3(); // full bbox
    #
    tmpBox = new THREE.Box3(); // temp for internal use

    // triggers recomputation of _visibleBounds and _visibleBoundsWithHidden, e.g., if fragment visibility changes.
    visibleBoundsDirty = false;

    // currently ignored, see this.resetIterator()
    enforceBvh = false;

    // number of currently highlighted fragments.    
    #
    numHighlighted = 0;

    // use next free Model id
    id = nextModelId++;

    // {GeometryList} 
    #
    geoms = null;

    // {FragmentList}
    #
    frags = null;

    // Iterators used for scene traversal.
    #
    sceneTraversal = new SceneTraversal();#
    raycastIterator = null; // an optional iterator used for ray intersection tests

    // Only used for consolidated models.
    #
    consolidationMap = null; // cached intermediate results of consolidation pre-processing. Enables to quickly rebuild
    // _consolidationIterator when we had to temporarily remove it to free memory.

    // Maintained per scene traversal, initialized in ResetIterator()
    #
    renderCounter = 0; // number of batches rendered since last resetIterator() call. Used to indicate rendering progress for progressive rendering.
    #
    frustum = null; // {FrustumIntersector}. Assigned in this.ResetIterator(). Passed to RenderBatches for culling and depth-sorting. 
    #
    drawMode = RenderFlags.RENDER_NORMAL; // drawMode used in this traversal. See Viewer3DImpl.js

    // Cache for transform matrices
    #
    identityMatrix = null; // {LmvMatrix4}
    #
    modelAndPlacementTransform = null; // {LmvMatrix4}
    #
    invModelAndPlacementTransform = null; // {LmvMatrix4}

    // Dynamic Placement: These settings override the corresponding cameras and matrices in this.getData if placement or globalOffset are modified after loading.
    //                    Only used if dynamic placement or offset changes are actually done. Note that placementTransform and globalOffset in this.getData always
    //                    store the values applied during loading and are not affected by setGlobalOffset() or setPlacementTransform() calls.
    #
    placementTransform; // {LmvMatrix4}
    #
    globalOffset; // {Vector3}

    // Cached inverse of all loader-baked transforms
    #
    invPlacementWithOffset;

    // This will be used by the model iterators
    // to create batches. Limited memory will change it.
    RenderBatch = RenderBatch;

    // When enabled, cutplanes should not affect the visibility of the model
    #
    doNotCut = false;

    #
    idRemap;#
    reverseMap;

    // Manages visibility for selected sections/nodes of the model, hiding and showing them on-the-fly.
    // NOTE Viewer3D has its own visibility manager also, but this instance is independent, owned by RenderModel,
    // though initialized by the VisibilityManager from outside.
    visibilityManager = null;

    #
    plane = new THREE.Plane();#
    pointOnSheet = new THREE.Vector3();

    // The original model's bounding box without placement transform.
    #
    modelBBoxOriginal;

    // Bounding box baked with placement transform,
    // if for some reason 'modelBoxWithoutPlacementTf' does not exist (missing in loader).
    #
    modelBBox;

    // Placement transform containing the offset
    #
    placementTf;

    // TODO storing the whole manifest will become obsolete, once its constant properties are stored here (see config).
    #
    manifest;

    // Provides static information about the model format
    #
    modelFormat = {};

    /**
     * Creates a new RenderModel instance.
     * 
     * @param {Object} manifest 
     */
    constructor(manifest) {
        this.#manifest = manifest;

        this.#modelBBoxOriginal = manifest.modelSpaceBBox;
        this.#modelBBox = manifest.bbox;
        this.#placementTf = manifest.placementWithOffset;
    }

    dtor() {
        this.#dispose();
    }

    /**
     * Passes information about the model format:
     * - isOTG
     * - isSVF2
     * - is2d
     * 
     * @param {Object} modelFormat 
     */
    setModelFormat(modelFormat) {
        this.#modelFormat = modelFormat;
    }

    /**
     * Initializes the render-able data (RenderModel).
     *      
     */
    initialize() {
        // alloc GeometryList. Initially empty, but exposed via GetGeometryList().
        // The loaders use this to add LmvGeometryBuffers directly to the GeometryList later.
        // TODO Make RenderModel agnostic to the SVF file format.
        const numObjects = this.#manifest.numGeoms;
        const disableStreaming = !needsStreamingDraw(
            this.#manifest.packFileTotalSize,
            this.#manifest.primitiveCount,
            numObjects);

        this.#geoms = new GeometryList(numObjects, this.#modelFormat.is2d, disableStreaming, this.#modelFormat.isOTG);

        const num_materials = this.#manifest.metadata ? .stats ? .num_materials ? ? 0;
        const num_geoms = this.#manifest.metadata ? .stats ? .num_geoms ? ? 0;
        const fragments = this.#manifest.fragments;
        this.#frags = new FragmentList(
            fragments,
            this.getGeometryList(),
            this.id,
            num_materials,
            num_geoms,
            this.#modelFormat);

        const initialBbox = this.getModelBounds();
        if (initialBbox) {
            this.#visibleBounds.copy(initialBbox);
            this.#visibleBoundsWithHidden.copy(initialBbox);
        }
    }

    /**
     * Adds a new traversal controller, to be used depending on available data and other settings.
     * @param {String} id The unique identifier of this traversal controller.
     * @param {ITraversalController} traversalController The instance of the traversal controller.
     */
    addTraversalController(id, traversalController) {
        this.#sceneTraversal.addTraversalController(id, traversalController);

        // make sure that bbox is obtained from iterator
        this.visibleBoundsDirty = true;
    }

    // Note: GeometryList or FragmentList are maintained by the RenderModel and should not be modified from outside.
    //       E.g., setting visibility or highlighting flags on FragmentList directly would break some state tracking. (e.g. see this.setVisibility or this.setHighlighted)
    //       The only current exception is done by loaders that add geometry to _geoms directly.
    getGeometryList() {
        return this.#geoms;
    }

    getFragmentList() {
        return this.#frags;
    }

    getModelId() {
        return this.id;
    }

    getIterator() {
        return this.#sceneTraversal.getTraversalController();
    }

    isIdRemapValid() {
        return this.#idRemap != null;
    }

    #
    dispose() {
        if (this.#sceneTraversal.isEnabledConsolidation()) {
            this.untrackConsolidatedGeometry();
        }

        this.#sceneTraversal.dtor();

        this.#geoms = null;

        if (this.#frags) {
            this.#frags.dtor();
            this.#frags = null;
        }
    }

    /*
     * This function is only applicable for 1 iterator type, while other iterators (BVH) ignore it.
     */
    /** 
     * Activating a fragment means:
     *  - Store geometry in the FragmentList
     *  - Update summed RenderModel boxes
     *  - Add fragment to iterator, so that it is considered in next traversal
     * See FragmentList.setMesh(..) for param details.
     *
     * Note:
     *  - Can only be used with LinearIterator
     */
    activateFragment(fragId, meshInfo, overrideTransform) {
        if (!this.#frags) {
            return;
        }

        this.#frags.setMesh(fragId, meshInfo, overrideTransform);

        this.#sceneTraversal.addFragment(fragId);

        //update the world bbox
        {
            this.#frags.getWorldBounds(fragId, this.#tmpBox);
            this.#visibleBounds.union(this.#tmpBox);
            this.#visibleBoundsWithHidden.union(this.#tmpBox);
        }
    }

    /*
     * This method covers a product-specific case, used by the Fusion collaboration client.
     * TODO Revise this method for an extension or at least higher-level function, not sitting in the innermost core, such as RenderModel.
     */
    setFragment(fragId, mesh, retainMesh) {
        if (fragId === undefined) {
            fragId = this.getFragmentList().getNextAvailableFragmentId();
        }

        this.#frags.setMesh(fragId, mesh, true, retainMesh);

        this.#sceneTraversal.addFragment(fragId);

        //update the world bbox
        {
            this.#frags.getWorldBounds(fragId, this.#tmpBox);
            this.#visibleBounds.union(this.#tmpBox);
            this.#visibleBoundsWithHidden.union(this.#tmpBox);
        }

        return fragId;
    }

    setBVH(nodes, primitives, options) {
        const bvhTraversalController = new ModelIteratorBVH();
        bvhTraversalController.initialize(this, nodes, primitives, options);
        this.#sceneTraversal.addTraversalController("BVH", bvhTraversalController);

        // By default, the BVH contains boxes "as loaded", i.e. not considering any model matrix.
        // If a model transform is applied, we have to make sure that the bvh boxes are recomputed.
        if (this.#frags ? .matrix) {
            this.invalidateBBoxes();
        }
    }

    /** 
     *  Starts the scene draw traversal, so that nextBatch() will return the first batch to render.
     *   @param: {UnifiedCamera}      camera       - camera.position was needed for the heuristic to choose between linear iterator and BVH.
     *                                               [HB:] The code is currently commented out, so the param is currently unused.
     *   @param: {FrustumIntersector} frustum      - used by RenderBatches for frustum culling and z-sorting.
     *   @param: {number}             drawMode     - E.g., RENDER_NORMAL. See RenderFlags.js
     */
    resetIterator(camera, frustum, drawMode) {
        this.#renderCounter = 0;
        this.#drawMode = drawMode;
        this.#frustum = frustum;

        const fragmentsHaveBeenAdded = this.#frags ? .fragmentsHaveBeenAdded();
        this.#sceneTraversal.updateView(camera, frustum, drawMode, fragmentsHaveBeenAdded);

        return this.getIterator();
    }

    /**
     * Sets a dedicated iterator for ray intersections. This can be useful when models need to be intersected
     * frequently. The default iterator is optimized for rasterization, not ray casting.
     * @param {Iterator} iterator The iterator to use for ray intersections.
     */
    setRaycastIterator(iterator) {
        this.#raycastIterator = iterator;
        this.#raycastIterator ? .getVisibleBounds(this.#visibleBounds, this.#visibleBoundsWithHidden, true);
    }

    /**
     * Returns the dedicated iterator for ray intersections.
     * @returns {Iterator} The iterator used for ray intersections.
     */
    getRaycastIterator() {
        return this.#raycastIterator;
    }

    /** Returns the next RenderBatch for scene rendering traversal. Used in RenderScene.renderSome().
     *   Use this.resetIterator() to start traversal first.
     *
     *   @returns {RenderBatch|null} Next batch to render or null if traversal is finished.
     */
    nextBatch() {
        // If the next batch of the iterator is fully invisible, we inc it until we 
        // find a relevant batch to render or reach the end.
        while (true) {
            // update render progress counter
            this.#renderCounter++;

            // get next batch from iterator
            const renderBatch = this.#sceneTraversal.nextBatch();

            // stop if there are no further batches
            if (!renderBatch) {
                return null;
            }

            // Tag all produced scenes with modelId. This is used for cross-fading between models by rendering them to separate targets.
            renderBatch.modelId = this.id;

            // Some iterators return a ThreeJS scene instead of a RenderBatch, e.g., when cropping or consolidation is applied.
            // The code for fragment visibility and sorting is only defined if the scene is a RenderBatch.
            // For the case of THREE.Scene, we are done here, because:
            //   - Sorting in THREE.Scene is done by FireFlyRenderer.
            //   - Per-fragment visibility is not supported in this case.
            if (renderBatch instanceof THREE.Scene) {
                return renderBatch;
            }

            const sceneHasVisibleParts = this.applyVisibility(renderBatch, this.#drawMode, this.#frustum);
            if (sceneHasVisibleParts) {
                return renderBatch;
            }
        }
    }

    /**
     * Set the MESH_RENDERFLAG based on the current render phase while frustum culling the fragments in the scene.
     * @param {RenderBatch} scene The scene to calculate the visibility for
     * @param {number}             drawMode     - E.g., RENDER_NORMAL. See RenderFlags.js
     * @param {FrustumIntersector} frustum      - used by RenderBatches for frustum culling and z-sorting.
     * @return {boolean} True if any fragments in the scene are visible. False otherwise.
     */
    applyVisibility(scene, drawMode, frustum) {
        // TODO move this into the iterator?
        const isVisible = !scene.applyVisibility(drawMode, frustum);

        // Fragments of F2D scenes must be drawn in original order, so we do not sort it.
        if (this.#modelFormat.is2d) {
            return isVisible;
        }

        // No need to sort on something invisible
        if (!isVisible) {
            return false;
        }

        // TODO Move this to the iterator?
        // For 3D scenes, sort fragments of this batch:
        // Generally opaque batches are sorted once by material, 
        // while transparent batches are sorted back to front each frame.
        if (scene.sortObjects && !this.getFragmentList().useThreeMesh) {
            scene.sortByDepth(frustum);
            return true;
        }

        if (!scene.sortDone) {
            scene.sortByMaterial();
        }

        return true;
    }

    /**
     * Remove shadow geometry (if exists) from model bounds.
     * 
     * @param {THREE.Box3} bounds 
     */
    trimPageShadowGeometry(bounds) {
        if (this.hasPageShadow()) {
            const shadowRatio = Autodesk.Viewing.Private.F2dShadowRatio;
            bounds = bounds.clone();

            // If we have pageShadow, we must have page_dimensions & page_width.
            const pageWidth = this.getMetadata('page_dimensions', 'page_width');
            bounds.max.x -= pageWidth * shadowRatio;
            bounds.min.y += pageWidth * shadowRatio;
        }

        return bounds;
    }

    /**
     * @param:  {bool}        includeGhosted
     * @param:  {bool}        excludeShadow - Remove shadow geometry (if exists) from model bounds.
     * @returns {THREE.Box3} 
     *
     * NOTE: The returned box is just a pointer to a member, not a copy!
     */
    getVisibleBounds(includeGhosted, excludeShadow) {
        if (this.visibleBoundsDirty) {
            this.#visibleBounds.makeEmpty();
            this.#visibleBoundsWithHidden.makeEmpty();

            this.#sceneTraversal.getVisibleBounds(this.#visibleBounds, this.#visibleBoundsWithHidden, includeGhosted);

            this.#raycastIterator ? .getVisibleBounds(this.#visibleBounds, this.#visibleBoundsWithHidden, includeGhosted);

            this.visibleBoundsDirty = false;
        }

        let bounds = includeGhosted ? this.#visibleBoundsWithHidden : this.#visibleBounds;

        if (excludeShadow) {
            bounds = this.trimPageShadowGeometry(bounds);
        }

        return bounds;
    }

    rayIntersect2D(raycaster, dbIds, intersections, getDbIdAtPointFor2D) {
        // A sheet is assumed to be, when loaded, pointing z-up on 0,0;
        // Get original bounding box
        const bbox = this.getModelBounds(true);

        const center = bbox.getCenter(new THREE.Vector3());
        let point = new THREE.Vector3();
        this.#plane.normal.set(0, 0, 1);
        this.#plane.constant = -center.z;

        const tr = this.getModelToViewerTransform();
        if (tr) {
            this.#plane.applyMatrix4(tr);
        }

        point = raycaster.ray.intersectPlane(this.#plane, point);
        if (point) {
            this.#pointOnSheet.copy(point);
            const invTr = this.getInverseModelToViewerTransform();
            if (invTr) {
                this.#pointOnSheet.applyMatrix4(invTr);
                this.#pointOnSheet.z = center.z; // Avoid numerical problems
            }
            if (bbox.containsPoint(this.#pointOnSheet)) {
                const cutplanes = this.#frags ? .getMaterial(0) ? .cutplanes; // Get cutplanes from first material
                if (cutplanes && isPointOutsidePlanecuts(point, cutplanes)) {
                    return;
                }
                const distance = raycaster.ray.origin.distanceTo(point);
                if (distance < raycaster.near || distance > raycaster.far) {
                    return;
                }

                let dbId, fragId;
                if (getDbIdAtPointFor2D) { // This is an optional callback
                    const res = getDbIdAtPointFor2D(point);
                    dbId = res[0];
                    if (dbIds && dbIds.length > 0 && !dbIds.includes(dbId)) { // Filter according to passed array
                        return;
                    }

                    const modelId = res[1]; // modelId is 0 if the idtarget[1] is not used
                    if (modelId !== 0 && modelId !== this.id) {
                        // In the case where another model is in front of this one, the dbId we get here
                        // will be for that model instead, so just ignore this result
                        return;
                    } else {
                        fragId = this.#frags ? .fragments.dbId2fragId[dbId];
                    }
                }

                const intersection = {
                    intersectPoint: point, // Backwards compatibility
                    point,
                    distance,
                    dbId: dbId && this.remapDbIdFor2D(dbId),
                    fragId,
                    model: this,
                };

                if (intersections) {
                    intersections.push(intersection);
                }

                return intersection;
            }
        }

        return null;
    }

    /**
     * Performs a raytest and returns an object providing information about the closest hit. 
     * 
     * NOTE: We currently ignore hitpoints of fragments that are visible (MESH_VISIBLE==true) and not highlighted (MESH_HIGHLIGHTED==false). 
     *
     * @param {THREE.RayCaster} raycaster
     * @param {bool}            ignoreTransparent
     * @param {number[]}        [dbIds]             - Array of dbIds. If specified, only fragments with dbIds inside the filter are checked.
     *                                                If the model data has no instanceTree, this is just a whitelist of explicit fragment ids.
     *                                                Note that a hitpoint will also be returned if it's actually occluded by a fragment outside the filter.
     * @param {Array}           [intersections]     - Optional return array with all found intersections.
     * @param {function}        [getDbIdAtPointFor2D] - Optional callback. For 2D models, to return the dbId and modelId in an array.
     * @param {Object}          [options]           - Additional ray intersection options
     * @param {function}        [options.filter]    - Optional filter function (hitResult) => bool. (see VBIntersector for hitresult content)
     *
     * @returns {Object|null}   Intersection result object providing information about closest hit point. Properties:
     *                           - {number}   fragId
     *                           - {Vector3}  point
     *                           - {number}   dbId
     *                           - {model}    model - pointer to this RenderModel
     *                          (created/filled in VBIntersector.js, see for details)
     */
    // Add "meshes" parameter, after we get meshes of the object using id buffer,
    // then we just need to ray intersect this object instead of all objects of the model.
    rayIntersect(raycaster, ignoreTransparent, dbIds, intersections, getDbIdAtPointFor2D, options) {
        if (this.ignoreRayIntersect) {
            return null;
        }

        if (this.#modelFormat.is2d) {
            return this.rayIntersect2D(raycaster, dbIds, intersections, getDbIdAtPointFor2D);
        }
        // make sure that the cached overall bboxes are up-to-date.
        // [HB:] Why are they updated here, but not used in this method?
        if (this.visibleBoundsDirty)
            this.getVisibleBounds();

        // alloc array to collect intersection results
        var intersects = [];
        var i;

        // Restrict search to certain dbIds if specified...
        if (dbIds && dbIds.length > 0) {

            // Collect the mesh fragments for the given database ID node filter.
            var instanceTree = this.getInstanceTree();
            var fragIds = [];
            if (instanceTree) {
                for (i = 0; i < dbIds.length; i++) {
                    instanceTree.enumNodeFragments(dbIds[i], function(fragId) {
                        fragIds.push(fragId);
                    }, true);
                }
            } else {
                //No instance tree -- treat dbIds as fragIds
                fragIds = dbIds;
            }

            //If there are multiple fragments it pays to still use
            //the bounding volume hierarchy to do the intersection,
            //because it can cull away entire fragments by bounding box,
            //instead of checking every single fragment triangle by triangle
            if (fragIds.length > 2) { //2 is just an arbitrary value, assuming checking 2 fragments is still cheap than full tree traversal
                let iterator = this.#raycastIterator || this.getIterator();
                iterator.rayCast(raycaster, intersects, dbIds);
            } else {
                // The filter restricted the search to a very small number of fragments.
                // => Perform raytest on these fragments directly instead.
                for (i = 0; i < fragIds.length; i++) {
                    var mesh = this.#frags.getVizmesh(fragIds[i]);
                    if (!mesh)
                        continue;
                    var res = VBIntersector.rayCast(mesh, raycaster, intersects, options);
                    if (res) {
                        intersects.push(res);
                    }
                }
            }

        } else {
            // no filter => perform raytest on all fragments
            let iterator = this.#raycastIterator || this.getIterator();
            iterator.rayCast(raycaster, intersects, undefined, options);
        }

        // stop here if no hit was found
        if (!intersects.length)
            return null;

        // sort results by distance. 
        intersects.sort(function(a, b) {
            return a.distance - b.distance;
        });

        //pick the nearest object that is visible as the selected.
        var allIntersections = !!intersections;
        intersections = intersections || [];

        for (i = 0; i < intersects.length; i++) {

            var fragId = intersects[i].fragId;
            var isVisible = this.isFragVisible(fragId); //visible set,

            // [HB:] Since we skip all meshes that are not flagged as visible, shouldn't we 
            //       better exclude them from the raycast in the first place?
            if (isVisible) {

                // skip transparent hits if specified
                var material = this.#frags.getMaterial(fragId);
                if (ignoreTransparent && material.transparent)
                    continue;

                var intersect = intersects[i];

                // check against cutplanes
                var isCut = false;
                if (material && material.cutplanes) {
                    isCut = isPointOutsidePlanecuts(intersect.point, material.cutplanes);
                }

                if (!isCut) {
                    intersections.push(intersect);
                }

                intersect.model = this;

                if (!allIntersections && intersections.length > 0) {
                    // result is the closest hit that passed all tests => done.
                    break;
                }
            }
        }

        var result = intersections[0] || null;

        if (result) {
            // We might use multiple RenderModels => add this pointer as well.
            result.model = this;
        }

        return result;
    }


    /** Set highlighting flag for a fragment. 
     *   @param   {number} fragId
     *   @param   {bool}   value
     *   @returns {bool}   indicates if flag state changed
     */
    setHighlighted(fragId, value) {
        if (!this.#frags) {
            return false;
        }

        var changed = this.#frags.setFlagFragment(fragId, MeshFlags.MESH_HIGHLIGHTED, value);

        if (changed) {
            if (value)
                this.#numHighlighted++;
            else
                this.#numHighlighted--;
        }

        return changed;
    }

    /** Sets MESH_VISIBLE flag for a fragment (true=visible, false=ghosted) */
    // This function should probably not be called outside VisibilityManager
    // in order to maintain node visibility state.
    setVisibility(fragId, value) {
        if (this.#frags) {
            this.#frags.setVisibility(fragId, value);
        } else if (this.isLeaflet()) {
            this.#sceneTraversal.setVisibilityLeaflet(value);
        }

        this.invalidateBBoxes();
    }

    /** Sets MESH_VISIBLE flag for all fragments (true=visible, false=ghosted) */
    setAllVisibility(value) {
        if (this.#frags) {
            this.#frags.setAllVisibility(value);
        } else if (this.isLeaflet()) {
            this.#sceneTraversal.setVisibilityLeaflet(value);
        }

        this.invalidateBBoxes();
    }

    /** Sets the MESH_HIDE flag for all fragments that a flagged as line geometry. 
     *  Note that the MESH_HIDE flag is independent of the MESH_VISIBLE flag (which switches between ghosted and fully visible) 
     *
     *  @param {bool} hide - value to which the MESH_HIDE flag will be set. Note that omitting this param would SHOW the lines, so
     *                       that you should always provide it to avoid confusion.
     */
    hideLines(hide) {
        if (this.#frags) {
            this.#frags.hideLines(hide);
        }
    }

    /** Sets the MESH_HIDE flag for all fragments that a flagged as point geometry. 
     *  Note that the MESH_HIDE flag is independent of the MESH_VISIBLE flag (which switches between ghosted and fully visible) 
     *
     *  @param {bool} hide - value to which the MESH_HIDE flag will be set. Note that omitting this param would SHOW the points, so
     *                       that you should always provide it to avoid confusion.
     */
    hidePoints(hide) {
        if (this.#frags) {
            this.#frags.hidePoints(hide);
        }
    }

    /** Returns if one or more fragments are highlighted. 
     *   returns {bool}
     *
     * Note: This method will only work correctly as long as all highlighting changes are done via this.setHighlighted, not on FragmentList directly.
     */
    hasHighlighted() {
        return !!this.#numHighlighted;
    }

    /** Returns true if a fragment is tagged as MESH_VISIBLE and not as MESH_HIGHLIGHTED. */
    // 
    // [HB:] It's seems a bit unintuitive that the MESH_HIGHLIGHTED flag is checked here, but not considered by the other visibility-related methods.
    //       For instance, consider the following scenarios:
    //        - After calling setVisibility(frag, true), isFragVisible(frag) will still return false if frag was highlighted.
    //        - If areAllVisible() returns true, there may still be fragments for which isFragVisible(frag) returns false.
    isFragVisible(frag) {
        return this.#frags.isFragVisible(frag);
    }

    /** Returns true if MESH_VISIBLE flag is set for all fragments. */
    areAllVisible() {

        // When using a custom iterator, we don't have per-fragment visibility control. 
        // We assume constantly true in this case.
        if (!this.#frags) {
            return true;
        }

        return this.#frags.areAllVisible();
    }

    /** Direct access to all RenderBatches. Used by ground shadows and ground reflection.
     * @returns {RenderBatch[]}
     */
    getGeomScenes() {
        return this.#sceneTraversal.getScenes();
    }

    /** Get progress of current rendering traversal.
     *  @returns {number} in [0,1]
     */
    getRenderProgress() {
        const progress = this.#renderCounter / this.#sceneTraversal.getSceneCount();

        // the renderCounter can become > scene count.
        return (progress > 1.0) ? 1.0 : progress;
    }

    /**
     *  @params  {number} timeStamp
     *  @returns {bool}   true if the model is a leaflet scene and it needs a redraw, false otherwise.
     */
    update(timeStamp) {
        const needsRedraw = this.#sceneTraversal.needsRedrawLeaflet(timeStamp);
        return needsRedraw;
    }


    /** Highlight an object with a theming color that is blended with the original object's material.
     *   @param {number}        dbId
     *   @param {THREE.Vector4} themingColor (r, g, b, intensity), all in [0,1]
     *   @param {boolean} [recursive] - Should apply theming color recursively to all child nodes.
     */
    setThemingColor(dbId, color, recursive) {
        if (this.#frags) {
            // When using 2d with Otg db, we need to remap, because the vertex-buffers still contain otg.
            dbId = this.reverseMapDbIdFor2D(dbId);

            const it = this.getInstanceTree();
            if (recursive && it) {
                it.enumNodeChildren(dbId, childDbId => {
                    this.#frags.setThemingColor(childDbId, color);
                }, true);
                return;
            }

            this.#frags.setThemingColor(dbId, color);
            return;
        }

        if (this.#sceneTraversal.setThemingColorLeaflet(color)) {
            return;
        }

        logger.warn("Theming colors are not supported by this model type.");
    }

    /** Revert all theming colors.
     */
    clearThemingColors() {
        if (this.#frags) {
            this.#frags.clearThemingColors();
        } else {
            this.#sceneTraversal.clearThemingColorsLeaflet();
        }
    }

    /** Access to leaflet-specific functionality. Returns null if RenderModel is no leaflet. */
    getLeaflet() {
        return this.#sceneTraversal.getLeafletIterator();
    }

    /**
     * For internal use only.
     *
     * Determines for each geometry whether to store it on GPU or only CPU-side. The heuristic is the same that is
     * always used by GeometryList. However, when using consolidation, we first spend GPU Ram for the consolidated
     * meshes (with are used more for rendering). The original fragment geometry is only stored on GPU
     * if enough budget is left.
     * @private
     */
    chooseMemoryTypes() {
        const consolidation = this.#sceneTraversal.getConsolidation();
        var geomList = this.getGeometryList();

        // some geometries are shared by consolidation and original fragments. We track their ids to
        // make sure that we don't process them twice.
        var geomShared = [];

        // Untrack geometries first. GPU usage is reevaluated below.
        // In case of consolidation, this frees up GPU budget for the consolidated geometry, which has higher priority.
        for (i = 1; i < geomList.getCount(); i++) { // skip index 0, because it is reserved for "invalid geom id"
            geom = geomList.getGeometry(i);
            if (geom) {
                // Force-untrack geometry on the GPU, even if it is shared with other models
                MemoryTracker.untrackGeometry(geomList, geom, false, !geom.streamingDraw, true);
                geom.streamingDraw = geom.streamingIndex = undefined; // flag geometry as untracked
            }
        }

        if (consolidation) {
            for (var i = 0; i < consolidation.meshes.length; i++) {

                var mesh = consolidation.meshes[i];
                var geom = mesh.geometry;

                // compute byteSize if not available.
                if (!geom.byteSize) {
                    geom.byteSize = getByteSize(geom);
                }

                // If the mesh has a well-defined fragId, this geometry is shared with a fragment that could
                // not be consolidated with others.
                var isSharedFragmentGeometry = Number.isInteger(mesh.fragId);

                // Look at shared geometry only once
                if (isSharedFragmentGeometry) {
                    // We cannot use the svfid for SVF2 geometries, because it's not necessarily unique within a model
                    const key = geom.id !== undefined ? geom.id : geom.svfid;
                    if (geomShared[key]) {
                        continue;
                    } else {
                        geomShared[key] = true;
                    }
                }

                MemoryTracker.setMemoryType(geomList, geom, geom.numInstances || 1);

                if (isSharedFragmentGeometry) {
                    continue;
                }

                if (geom.streamingDraw) {
                    // CPU data won't be discarded, so we have to track it.
                    MemoryTracker.trackGeometry(geomList, geom);
                } else {
                    // consolidated meshes are purely used for rendering. So, we can discard
                    // the CPU-side copy as soon as the data are on GPU. Note that we must not
                    // do this for shared original fragment geometry - which is exposed to the client.
                    geom.discardAfterUpload = true;
                }
            }
        }

        // Finally, revise the memory type for the original GeometryList again. This time, we consider
        // the workload that we already spent on for the consolidation and only allow geometry to be stored on GPU if
        // our budget is not consumed yet.
        for (i = 1; i < geomList.getCount(); i++) { // skip index 0, because it is reserved for "invalid geom id"

            // get next geom
            geom = geomList.getGeometry(i);
            if (!geom) {
                continue;
            }

            // if this geometry is shared by the consolidation, the memory type has already been set in the loop above.
            const key = geom.id !== undefined ? geom.id : i;
            if (!geomShared[key]) {
                MemoryTracker.setMemoryType(geomList, geom, geomList.getInstanceCount(i));
            }

            if (geom.streamingDraw) {
                // A geometry might already have been GPU-uploaded and displayed during progressive loading.
                // If we now decided to keep this geometry CPU side, make sure that we don't keep any of these on GPU anymore.
                geom.dispose();
            }
        }
    }

    /**
     * This function creates an internal copy of the FragmentList that is consolidated to reduce the
     * shape count as far as possible. This takes more memory, but may strongly accelerate rendering
     * for models with many small shapes.
     *
     * NOTE: For making consolidation effective, it should ideally be activated via the load options already.
     *       This will automatically adjust the depth of the spatial hierarchy. Without that, the scene traversal
     *       may still be slow and the performance gain much smaller.
     *
     * @param {MaterialManager} materials
     * @param {number}          [byteLimit]             - Merging geometries is the most efficient technique in terms
     *                                                    of rendering performance. But, it can strongly increase
     *                                                    the memory consumption, particularly because merged
     *                                                    geometry cannot be shared, i.e. multiple instances of
     *                                                    a single geometry must be replicated per instance for merging.
     *                                                    Therefore, the memory spent for merging is restricted.
     *                                                    A higher value may make rendering faster, but increases (also GPU) memory
     *                                                    workload.
     * @param {FireFlyWebGLRenderer} glRenderer
     * @param {boolean}         [useDeferredConsolidation] - Optional: If true, consolidation will only compute some initial data 
     *                                                       and leave the actual data crunching to the first time a consolidated
     *                                                       mesh needs to get rendered. Note: the intent is to verify the proper
     *                                                       function of this option and make it the only implementation then.
     */
    consolidate(materials, byteLimit, glRenderer, useDeferredConsolidation = false) {
        // consolidate fragment list
        const consolidation = consolidateFragmentList(
            this,
            materials,
            byteLimit,
            useDeferredConsolidation,
            glRenderer,
            this.#consolidationMap);

        this.#sceneTraversal.enableConsolidation(this.#frags, consolidation);

        // determine which geometries we upload to GPU. All remaining ones are stored CPU-side
        // and rendered using streaming-draw (slower, but better than GPU memory overload)
        this.chooseMemoryTypes();

        // cache some intermediate results. Consolidations are memory-intensive, so it can be necessary to temporarily
        // remove them to free memory. By caching intermediate results, we can rebuild them faster.
        this.#consolidationMap = consolidation.consolidationMap;
    }

    /**
     * For internal use only.
     * @private
     */
    untrackConsolidatedGeometry() {
        const consolidation = this.#sceneTraversal.getConsolidation();
        for (let i = 0; i < consolidation.meshes.length; i++) {
            const mesh = consolidation.meshes[i];
            const geom = mesh.geometry;
            // If the mesh has a fragId, it is also used in the original fragment list, so don't untrack it.
            const isSharedFragmentGeometry = Number.isInteger(mesh.fragId);
            if (!isSharedFragmentGeometry) {
                MemoryTracker.untrackGeometry(this.getGeometryList(), geom, geom.streamingDraw);
            }
        }
    }

    /**
     * Removes consolidation to free memory. Just some compact intermediate results are cached, so that the
     * consolidation can be rebuilt quickly.
     *
     * @param {Boolean} [updateGPUMemoryAssignment=false] - If true, GPU resource usage is re-evaluated and geometries
     *  might be moved out of or into the GPU.
     * @param {Boolean} [deleteMap=false] - If true, the consolidation map is removed.
     */
    unconsolidate(updateGPUMemoryAssignment = false, deleteMap = false) {
        if (!this.#sceneTraversal.isEnabledConsolidation()) {
            return;
        }

        this.untrackConsolidatedGeometry();

        this.#sceneTraversal.disableConsolidation();

        // if we remove the consolidation map, consolidation will start from scratch next time
        if (deleteMap)
            this.#consolidationMap = null;

        // unconsolidating can free up gpu memory, so we should reevaluate memory usage
        if (updateGPUMemoryAssignment)
            this.chooseMemoryTypes();
    }

    isConsolidated() {
        return this.#sceneTraversal.isEnabledConsolidation();
    }

    getConsolidation() {
        return this.#sceneTraversal.getConsolidation();
    }

    // Store mapping of F2D/PDF/SVF dbids to OTG property database v2 dbids
    setDbIdRemap(dbidOldToNew) {
        this.#idRemap = dbidOldToNew;
    }

    // Map old SVF dbId to actual dbId as used
    //by v2/OTG property databases.
    remapDbId(dbId) {
        if (this.#idRemap && dbId > 0 && dbId < this.#idRemap.length)
            return this.#idRemap[dbId];

        return dbId;
    }

    //F2D only -- maps ID stored in F2D vertex buffers to actual dbId as used
    //by v2/OTG property databases.
    remapDbIdFor2D(dbId) {
        if (this.#modelFormat.is2d) return this.remapDbId(dbId);

        return dbId;
    }

    reverseMapDbId(dbId) {
        if (!this.#idRemap || dbId <= 0)
            return dbId;

        if (!this.#reverseMap) {
            this.#reverseMap = {};
            for (var i = 0; i < this.#idRemap.length; i++)
                this.#reverseMap[this.#idRemap[i]] = i;
        }

        return this.#reverseMap[dbId];
    }

    reverseMapDbIdFor2D(dbId) {
        if (this.#modelFormat.is2d) return this.reverseMapDbId(dbId);

        return dbId;
    }

    updateRenderProxy(proxy, fragId) {
        this.#sceneTraversal.updateRenderProxy(proxy, fragId);
    }

    skipOpaqueShapes() {
        this.#sceneTraversal.skipOpaqueShapes();
    }

    // Call this whenever you modified shapes, e.g., by setting/changing an animation transform.
    // This makes sure that all hierarchical bboxes are updated.
    // Without this, shapes may incorrectly classified as invisble, so that they may disappear or are missed by selection.
    invalidateBBoxes() {
        this.visibleBoundsDirty = true;
    }

    /**
     * Change the paper visibility for a 2D sheet
     */
    changePaperVisibility(show) {
        if (this.#modelFormat.is2d) {
            this.#frags ? .setObject2DVisible(-1, show);
        }
    }

    hasPaperTransparency() {
        if (!this.#modelFormat.is2d) {
            return false;
        }

        const paperOpacity = this.#frags ? .dbIdOpacity[-1] ? ? 1;

        return paperOpacity > 0 && paperOpacity < 1;
    }

    /** Set a new model transform.
     *
     * @param {THREE.Matrix4} [matrix] - If null, model matrix is cleared.
     */
    setModelTransform(matrix) {
        this.#sceneTraversal.setModelTransformLeaflet(matrix);

        if (!this.isLeaflet()) {
            this.#frags.setModelMatrix(matrix);
            this.#sceneTraversal.updateModelTransformConsolidation();
        }

        // Recompute all bboxes
        this.invalidateBBoxes();
        this.getVisibleBounds(true);
        this.#modelAndPlacementTransform = null;
        this.#invModelAndPlacementTransform = null;
    }

    getModelTransform() {
        const matrix = this.#sceneTraversal.getModelTransformLeaflet();
        if (matrix) {
            return matrix;
        }

        return this.#frags ? .matrix;
    }

    /**
     * Returns the model boundary, customized by the given options.
     *      
     * @param {boolean?}[ignoreTransform] - Set to true to return the original bounding box in model space coordinates.
     * @param {boolean?}[excludeShadow] - Remove shadow geometry (if exists) from model bounds.
     * @param {THREE.Box3}[modelBoxOriginal] - The original model's bounding box without placement transform.
     * 
     * @returns {THREE.Box3} - Bounding box of the model if available, otherwise null.
     */
    getModelBounds(ignoreTransform, excludeShadow) {
        if (!this.#modelBBoxOriginal && !this.#modelBBox) {
            return null;
        }

        const modelBBoxOut = new THREE.Box3();

        modelBBoxOut.copy(this.#modelBBoxOriginal || this.#modelBBox);

        // Remove shadow geometry if needed.
        if (excludeShadow) {
            modelBBoxOut.copy(this.trimPageShadowGeometry(modelBBoxOut));
        }

        // If ignore transform is set, we are done.
        if (ignoreTransform) {
            return modelBBoxOut;
        }

        // Apply placement transform only if the modelSpace bounding box was used.
        if (this.#placementTf && this.#modelBBoxOriginal) {
            modelBBoxOut.applyMatrix4(this.#placementTf);
        }

        // Apply dynamic model transform.
        const modelMatrix = this.getModelTransform();
        if (modelMatrix) {
            modelBBoxOut.applyMatrix4(modelMatrix);
        }

        return modelBBoxOut;
    }

    /**
     * Passes the latest model boundary, excluding the offset transform.
     * Note this value may be changing, as loading progresses, so we want to get the latest one always if available.
     * 
     * @param {THREE.Box3}[modelBoxOriginal] - The original model's bounding box without placement transform.
     */
    updateModelBBoxOriginal(modelBoxOriginal) {
        this.#modelBBoxOriginal = modelBoxOriginal;
    }

    getInverseModelTransform() {
        const matrix = this.#sceneTraversal.getInverseModelTransformLeaflet();
        if (matrix) {
            return matrix;
        }

        return this.#frags ? .getInverseModelMatrix();
    }

    /*
     * Returns current placementTransform. By default, this is the placementMatrix applied at load time,
     * but may be overwritten if resetPlacement was called after loading.
     * Returned value must not be modified from outside.
     */
    getPlacementTransform() {
        this.#identityMatrix = this.#identityMatrix || new LmvMatrix4(true);
        return this.#placementTransform || this.getData().placementTransform || this.#identityMatrix;
    }

    /*
     * Returns the globalOffset applied to the model. This may be the one applied at load time or
     * a dynamic globalOffset applied afterwards.
     *  @returns {Vector3}
     */
    getGlobalOffset() {
        return this.#globalOffset || this.getData().globalOffset;
    }

    /**
     * Change the placement matrix of the model. This overrides the placement transform applied at loadTime.
     *  @param {LmvMatrix4} matrix         - Note that you need 64-Bit precision for large values.
     *  @param {Vector3}    [globalOffset] - Optionally, the globalOffset can be reset in the same step.
     */
    setPlacementTransform(matrix) {

        // Create/Set override placementTransform
        this.#placementTransform = (this.#placementTransform || new LmvMatrix4(true)).copy(matrix);

        // Update dynamic model matrix based on current placementMatrix and globalOffset
        DynamicGlobalOffset.updateModelMatrix(this, matrix, this.getGlobalOffset());
    }

    /**
     * Change globalOffset that is applied to transform this model from global to viewer coordinates.
     */
    setGlobalOffset(newOffset) {
        this.#globalOffset = this.#globalOffset || new THREE.Vector3();
        this.#globalOffset.copy(newOffset);

        // Update dynamic model matrix based on current placementMatrix and globalOffset
        var pt = this.getPlacementTransform();
        DynamicGlobalOffset.updateModelMatrix(this, pt, newOffset);
    }

    /**
     * Returns the model transform combined with placementWithOffset.
     * It converts the source model coordinate system to viewer coordinates
     * (the coordinates used for rendering, also including subtracted globalOffset)
     * @returns {THREE.Matrix4|null}
     */
    getModelToViewerTransform() {
        if (this.#modelAndPlacementTransform) { // Return cached value if available
            return this.#modelAndPlacementTransform;
        }

        const modelTransform = this.getModelTransform();
        const placementWithOffset = this.getData() ? .placementWithOffset;

        if (modelTransform || placementWithOffset) {
            this.#modelAndPlacementTransform = new THREE.Matrix4();

            if (modelTransform) {
                this.#modelAndPlacementTransform.multiply(modelTransform);
            }
            if (placementWithOffset) {
                this.#modelAndPlacementTransform.multiply(placementWithOffset);
            }
        }

        return this.#modelAndPlacementTransform;
    }

    /**
     * Returns the inverse of the model transform combined with placementWithOffset.
     * @returns {THREE.Matrix4|null}
     */
    getInverseModelToViewerTransform() {
        if (this.#invModelAndPlacementTransform) { // Return cached value if available
            return this.#invModelAndPlacementTransform;
        }

        const tr = this.getModelToViewerTransform();
        if (tr) {
            this.#invModelAndPlacementTransform = tr.clone().invert();
        }

        return this.#invModelAndPlacementTransform;
    }

    /**
     * Returns the inverse of placementWithOffset. Left-multiplying with this transform inverts
     * all transforms that are 'baked' into the mesh transforms by the loader. This excludes the dynamic model transform.
     * May return null if placementWithOffset is null as well.
     */
    getInversePlacementWithOffset() {
        if (!this.myData.placementWithOffset) {
            return null;
        }

        if (!this.#invPlacementWithOffset) {
            this.#invPlacementWithOffset = new LmvMatrix4(true).copy(this.myData.placementWithOffset).invert();
        }
        return this.#invPlacementWithOffset;
    }

    // Overrides inner state of RenderModel.
    setInnerAttributes(attributes) {
        this.id = attributes._id;
        this.#visibleBounds = attributes._visibleBounds;
        this.#visibleBoundsWithHidden = attributes._visibleBoundsWithHidden;
        this.#tmpBox = attributes._tmpBox;
        this.enforceBvh = attributes._enforceBvh;
        this.#numHighlighted = attributes._numHighlighted;
        this.#geoms = attributes._geoms;
        this.#frags = attributes._frags;
        this.#consolidationMap = attributes._consolidationMap;
        this.#renderCounter = attributes._renderCounter;
        this.#frustum = attributes._frustum;
        this.#drawMode = attributes._drawMode;
        this.#idRemap = attributes._idRemap;
        this.#reverseMap = attributes._reverseMap;

        const iterators = {
            _iterator: attributes._iterator,
            _linearIterator: attributes._linearIterator,
            _bvhIterator: attributes._bvhIterator,
            _consolidationIterator: attributes._consolidationIterator,
            _bvhOn: attributes._bvhOn
        };

        this.#sceneTraversal.setInnerAttributes(iterators);
    }

    // Get inner state of RenderModel.
    getInnerAttributes() {
        const sceneTraversalAttributes = this.#sceneTraversal.getInnerAttributes();

        return {
            _id: this.id,
            _visibleBounds: this.#visibleBounds,
            _visibleBoundsWithHidden: this.#visibleBoundsWithHidden,
            _tmpBox: this.#tmpBox,
            _enforceBvh: this.enforceBvh,
            _numHighlighted: this.#numHighlighted,
            _geoms: this.#geoms,
            _frags: this.#frags,
            _linearIterator: sceneTraversalAttributes.linearIterator,
            _bvhIterator: sceneTraversalAttributes.bvhIterator,
            _iterator: sceneTraversalAttributes.currentIterator,
            _consolidationIterator: sceneTraversalAttributes.consolidationIterator,
            _consolidationMap: this.#consolidationMap,
            _renderCounter: this.#renderCounter,
            _frustum: this.#frustum,
            _drawMode: this.#drawMode,
            _bvhOn: sceneTraversalAttributes.bvhOn,
            _idRemap: this.#idRemap,
            _reverseMap: this.#reverseMap
        };
    }

    /**
     * Changes whether cutplanes should affect the visibility of the model.
     * Works only for 2D models (in OTG the materials are shared).
     * @param {MaterialManager} materialsManager
     * @param {boolean}         doNotCut
     */
    setDoNotCut(materialsManager, doNotCut) {
        if (this.#doNotCut === doNotCut) {
            return;
        }

        this.#doNotCut = doNotCut;
        if (this.#frags) {
            this.#frags.setDoNotCut(doNotCut);
        } else if (this.isLeaflet()) {
            this.#sceneTraversal.setDoNotCut(doNotCut);
        }

        const cb = material => {
            material.doNotCut = doNotCut;
            const updateNeeded = (material.cutplanes ? .length > 0) === doNotCut;
            if (updateNeeded) {
                materialsManager._applyCutPlanes(material);
                material.needsUpdate = true;
            }
        };

        materialsManager.forEachInModel(this, false, cb);
    }

    getDoNotCut() {
        return this.#doNotCut;
    }

    /**
     * Sets the viewport bounds for a model, effectively cropping it. Relevant for sheets.
     * @param {MaterialManager} materialsManager 
     * @param {THREE.Box3|THREE.Box2|null} bounds - passing null resets the viewport
     */
    setViewportBounds(materialsManager, bounds) {
        if (this.isLeaflet()) {
            this.#sceneTraversal.setViewportBoundsLeaflet(bounds);
        } else if (this.#frags) {
            // For PDFs, there's always a viewport bounds which is the original bounding box (see LmvCanvasContext)
            bounds = bounds || (this.isPdf() && this.getModelBounds(true, true));

            // Set bounds in fragment list to update visibility bounds
            this.#frags.setViewBounds(bounds);

            // Set in materials since actual cropping is done in the shader
            materialsManager.setViewportBoundsForModel(this, bounds);
        }

        this.invalidateBBoxes();
    }

    getViewportBounds() {
        return this.isLeaflet() ? this.#sceneTraversal.getViewportBoundsLeaflet() : this.#frags ? .getViewBounds();
    }

    /**
     * Loads the given fragments on demand if supported by the loader
     * Autodesk.Viewing.FRAGMENTS_LOADED_EVENT will be fired when all fragments are loaded
     *
     * @private
     * @param {Iterable.<number>} fragIds - IDs of fragments to load
     * @returns {number} Number of fragments that are actually loaded (not counting already loaded fragments) 
     */
    load(fradIds) {
        let fragsLoaded = 0;
        if (this.#modelFormat.isSVF2 || this.#modelFormat.isOTG) {
            fragsLoaded = this.loader.loadFragments(fradIds);
        }

        return fragsLoaded;
    }

    /**
     * Unloads given fragments and their geometry if not needed anymore
     * Fires Autodesk.Viewing.FRAGMENTS_UNLOADED_EVENT when all fragments are unloaded
     *
     * @private
     * @param {Iterable.<number>} fragIds - IDs of fragments to unload
     * @returns {number} Number of fragments unloaded. Doesn't mean their geometry is unloaded as well if shared
     */
    unload(fragIds) {
        let fragsUnloaded = 0;
        if (this.#modelFormat.isSVF2 || this.#modelFormat.isOTG) {
            fragsUnloaded = this.getFragmentList().unload(fragIds);
            if (fragsUnloaded > 0) {
                this.getData().fragsLoaded -= fragsUnloaded;
                this.#dispatchEvent({
                    type: av.FRAGMENTS_UNLOADED_EVENT,
                    model: this
                });
            }
        }

        return fragsUnloaded;
    }

    #
    dispatchEvent(e) {
        this.loader.viewer3DImpl.api.dispatchEvent(e);
    }
}