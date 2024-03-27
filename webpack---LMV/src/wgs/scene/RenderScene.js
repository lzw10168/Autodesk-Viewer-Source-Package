import * as globals from '../globals';
import {
    FrustumIntersector
} from './FrustumIntersector';
import * as THREE from "three";
import {
    RenderFlags
} from "./RenderFlags";
import {
    ResetFlags
} from "./ResetFlags";
import {
    ModelExploder
} from "./ModelExploder";

/*
 * Keep these threeJs objects file local for performance reasons,
 * as these are changed frequently, so we keep expensive object creation minimal.
 */
const tmpBox = new THREE.Box3(); // Reused for return values of getVisibleBounds()

/**
 * RenderScene
 * Represents the full graphical scene.
 * Used for iterating through the scene for progressive rendering,
 * hit testing, etc.
 */
export class RenderScene {
    // true indicates that progressive rendering has finished
    // since last reset call, i.e. all batches have been traversed.
    #
    done = false;

    // {RenderModel[]} - All RenderModels to be rendered.
    #
    models = [];

    // {RenderBatch[]} - points to the next batch to be rendered from _models[i]. Same length as _models.
    #
    candidateRenderBatches = [];

    // {RenderBatch[]} - points to the previous batch rendered from _models[i]. Same length as _models.
    #
    previousRenderBatches = [];

    // {RenderModel[]} - All models that are currently loaded, but excluded from rendering/selection etc.
    #
    hiddenModels = [];

    // updated for current camera in this.reset().
    #
    frustum = new FrustumIntersector();

    #
    raycaster = new THREE.Raycaster();

    // During motion, we usually restart rendering at any frame, i.e. a frame is never resumed. When setting this
    // option, we exploit this to render transparent shapes earlier. (and skip less important opaque ones)
    enableNonResumableFrames = false;

    // Determines how much of the render budget is reserved for transparent shapes.
    // E.g., a value of 0.1 means that 10% of the render budget is spent for transparent shapes.
    budgetForTransparent = 0.1;

    // If true, we assume the current frame not to be resumed and
    // render some transparent shapes before the opaque ones are done.
    #
    frameWillNotBeResumed = false;

    // If frameWillNotBeResumed is true, this array collects transparent renderbatches and renders them
    // back-to-front at the end of a frame.
    #
    transparentRenderBatches = [];

    // needed for back-to-front sorting of transparent objects (see renderTransparentRenderBatches)
    #
    camera = null;

    constructor() {}

    frustum() {
        return this.#frustum;
    }

    #
    findById(models, modelId) {
        for (let i = 0; i < models.length; i++) {
            const model = models[i];
            if (model && model.id === modelId) {
                return model;
            }
        }
        return null;
    }

    findModel(modelId) {
        return this.#findById(this.#models, modelId);
    }

    findHiddenModel(modelId) {
        return this.#findById(this.#hiddenModels, modelId);
    }

    addModel(renderModel) {
        if (this.#models.indexOf(renderModel) !== -1) {
            return;
        }

        this.#models.push(renderModel);
        this.#candidateRenderBatches.length = this.#models.length;
        this.#previousRenderBatches.length = this.#models.length;
        this.recomputeLinePrecision();
    }

    removeModel(renderModel) {
        const idx = this.#models.indexOf(renderModel);
        if (idx >= 0) {
            this.#models.splice(idx, 1);
        }

        this.#candidateRenderBatches.length = this.#models.length;
        this.#previousRenderBatches.length = this.#models.length;
        this.recomputeLinePrecision();

        return idx >= 0;
    }

    addHiddenModel(renderModel) {
        const idx = this.#hiddenModels.indexOf(renderModel);
        if (idx < 0) {
            this.#hiddenModels.push(renderModel);
        }
        return idx < 0;
    }

    removeHiddenModel(renderModel) {
        const idx = this.#hiddenModels.indexOf(renderModel);
        if (idx >= 0) {
            this.#hiddenModels.splice(idx, 1);
        }
        return idx >= 0;
    }

    isEmpty() {
        return this.#models.length === 0;
    }

    recomputeLinePrecision() {
        let value = 1;
        const sizeTarget = new THREE.Vector3();

        for (let i = 0, len = this.#models.length; i < len; ++i) {
            const modelBox = this.#models[i].getData().bbox;

            // Skip empty boxes, as they lead to a zero threshold
            if (modelBox.getSize(sizeTarget).length() === 0) {
                continue;
            }

            // Note that modelBox.getBoundingSphere() may not exist if the box is an LmvBox3. 
            const modelValue = THREE.Box3.prototype.getBoundingSphere.call(modelBox, new THREE.Sphere()).radius * 0.001;
            value = Math.min(value, modelValue);
        }

        this.#raycaster.params.Line.threshold = value;
    }

    /**
     *  For each sub-scene, keep a running average of how long it took to render over the
     *  last few frames.
     *   @param {THREE.Scene|RenderBatch} renderbatch
     *   @param {number}                  frameTime - last measured rendering time in ms
     */
    #
    updateAvgFrameTime(renderBatch, frameTime) {
        if (renderBatch.avgFrameTime === undefined) {
            renderBatch.avgFrameTime = frameTime;
            return;
        }
        renderBatch.avgFrameTime = 0.8 * renderBatch.avgFrameTime + 0.2 * frameTime;
    }

    /**
     *  Renders transparent renderbatches in back-to-front order.
     *
     *  @param {RenderCB}      renderObjectsCB - Called for each element of the renderbatches array
     *  @param {UnifiedCamera} camera
     *  @param {RenderBatch[]} renderbatches   - Array of RenderBatches (or THREE.Scene with .boundingBox property)
     */
    #
    renderTransparentRenderBatches(renderBatches, camera, renderBatchCB) {
        let i;
        let renderBatch;

        // compute camera distance for each renderbatch        
        for (i = 0; i < renderBatches.length; i++) {
            renderBatch = renderBatches[i];
            const bbox = renderBatch.boundingBox || renderBatch.getBoundingBox();
            renderBatch.cameraDistance = bbox.distanceToPoint(camera.position);
        }

        // sort by decreasing camera distance
        function sortOrder(a, b) {
            return b.cameraDistance - a.cameraDistance;
        }
        renderBatches.sort(sortOrder);

        // render each renderBatch and update average frame time
        let t0 = performance.now();
        for (i = 0; i < renderBatches.length; i++) {
            renderBatch = renderBatches[i];
            renderBatchCB(renderBatch);

            // measure elapsed time
            const t1 = performance.now();
            const delta = t1 - t0;
            t0 = t1;

            // track average frame time
            this.#updateAvgFrameTime(renderBatch, delta);
        }
    }

    /**
     * Indicates if the current traversal is done with the assumption that this frame will not be resumed.
     *  @returns {boolean}
     */
    frameResumePossible() {
        return !this.#frameWillNotBeResumed;
    }

    /**
     * Incrementally render some meshes until we run out of time.
     *  @param {RenderBatchCB} renderBatchCB - Called that does the actual rendering. Called for each RenderBatch to be rendered.
     *  @param {number}   timeRemaining       - Time in milliseconds that can be spend in this function call.
     *  @returns {number} Remaining time left after the call. Usually <=0.0 if the frame could not be fully finished yet.
     * 
     * @callback RenderScene~renderBatchCB
     * @param {RenderBatch} finalRenderBatch
     */
    renderSome(renderBatchCB, timeRemaining) {
        let t0 = performance.now();
        let t1 = t0;


        // reserve some time for transparent shapes.
        const timeForTransparent = this.budgetForTransparent * timeRemaining;

        let model = null;

        // repeat until time budget is consumed...
        while (true) {
            // Find the best candidate render batch to render now -- in case there are multiple models.
            // TODO In case a huge number of models is loaded, we may have to rethink the linear loop below and use some priority heap or somesuch.
            let candidateIdx = 0;
            let finalRenderBatch = null;
            for (let iq = 0; iq < this.#candidateRenderBatches.length; iq++) {

                // candidate is the next RenderBatch to be processed from this._models[q] 
                let candidateRenderBatch = this.#candidateRenderBatches[iq];
                model = this.#models[iq];

                if (!candidateRenderBatch) {
                    this.#candidateRenderBatches[iq] = candidateRenderBatch = model.nextBatch();
                }

                // If the camera is in motion and the time for opaque renderbatches is over, continue with transparent shapes.
                const skipOpaque = this.#frameWillNotBeResumed && timeRemaining < timeForTransparent;
                if (skipOpaque) {
                    // check if the next candidate is still an opaque one. Note that the .sortObjects
                    // flag indicates whether a RenderBatch contains transparent objects.
                    const isOpaque = candidateRenderBatch && !candidateRenderBatch.sortObjects;
                    if (isOpaque) {
                        // skip current candidate and use the first available transparent renderbatch instead
                        model.skipOpaqueShapes();
                        this.#candidateRenderBatches[iq] = candidateRenderBatch = model.nextBatch();
                    }
                }

                // No more batches to render from this model
                if (candidateRenderBatch === null) {
                    continue;
                }

                // If all previous candidates were null, candidateRenderBatch is obviously the best one so far.
                if (!finalRenderBatch) {
                    candidateIdx = iq;
                    finalRenderBatch = candidateRenderBatch;
                }

                // If final renderbatch and candidate have the same transparency, choose current candidate only if its renderImportance is higher.
                // The renderImportance of RenderBatches is set by model iterators.
                const chooseByRenderImportance = candidateRenderBatch.sortObjects == finalRenderBatch.sortObjects && candidateRenderBatch.renderImportance > finalRenderBatch.renderImportance;

                // if the renderbatch is transparent and the candidate is opaque, choose the candidate
                const mustReplaceTransparentRenderBatch = !candidateRenderBatch.sortObjects && finalRenderBatch.sortObjects;
                if (chooseByRenderImportance || mustReplaceTransparentRenderBatch) {
                    candidateIdx = iq;
                    finalRenderBatch = candidateRenderBatch;
                }
            }

            // Render the batch we chose above and determine whether to continue the loop
            if (finalRenderBatch) {
                //Fetch a new render batch from the model that we took the current batch from.
                this.#candidateRenderBatches[candidateIdx] = this.#models[candidateIdx].nextBatch();

                // If we are in a non-resumable frame, we try to get the most important ones of opaque and transparent renderbatches.
                // Therefore, the traversal of transparent renderbatches will also be ordered by decreasing priority just like for opaque ones. 
                // For correct rendering, however, we cannot render them directly here. Instead, we must collect them first and render them back-to-front at the end of the function.
                if (finalRenderBatch.sortObjects && this.#frameWillNotBeResumed) {
                    // defer to the end of the frame
                    this.#transparentRenderBatches.push(finalRenderBatch);

                    // reserve frame time based on past rendering times. Just for the very first use, we use an initial guess value as fallback.
                    timeRemaining -= finalRenderBatch.avgFrameTime === undefined ? 0.05 : finalRenderBatch.avgFrameTime;
                } else {
                    // do the actual rendering
                    renderBatchCB(finalRenderBatch);

                    if (Object.prototype.hasOwnProperty.call(finalRenderBatch, "drawEnd")) {
                        finalRenderBatch.drawEnd = finalRenderBatch.lastItem;
                    }

                    // get time that we spent for rendering of the last batch
                    t1 = performance.now();
                    const delta = t1 - t0; // in milliseconds
                    t0 = t1;


                    // For each sub-scene, keep a running average of how long it took to render over the last few frames.
                    this.#updateAvgFrameTime(finalRenderBatch, delta);

                    // update remaining time
                    // Note that we don't do accurate timing here, but compute with average values instead.
                    // In this way, the number of rendered batches is more consistent across different frames
                    timeRemaining -= finalRenderBatch.avgFrameTime;
                }

                // Check if we should exit the loop...
                if (timeRemaining <= 0) {
                    break;
                }

            } else {
                // No more batches => Frame rendering finished, if all models are loaded
                this.#done = true;
                break;
            }
        }

        // Render some deferred transparent shapes (this._transparentShapes). Note that this array will
        // usually be empty if this._frameWillNotBeResumed is false
        if (this.#transparentRenderBatches.length > 0) {
            this.#renderTransparentRenderBatches(this.#transparentRenderBatches, this.#camera, renderBatchCB);

            // all scenes processed. Clear array.
            this.#transparentRenderBatches.length = 0;
        }

        return timeRemaining;
    }

    // TODO This method needs to be revisited as on demand loading is removed from the code base  
    /** Resets the renderBatch traversal 
     *   @param  {UnifiedCamera} camera
     *   @param  {number}        drawMode     - E.g., RENDER_NORMAL. See RenderFlags.js
     *   @param: {number}        [resetType]  - Must be one of RESET_NORMAL, RESET_REDRAW or RESET_RELOAD.
     *                                          Only used when on demand loading is enabled. RESET_RELOAD will reload and redraw geometry.
     *                                          RESET_REDRAW will redraw geometry. RESET_NORMAL will only redraw geometry that hasn't already been drawn. 
     *                                          If undefined RESET_NORMAL is used.
     */
    reset(camera, drawMode, resetType, cutPlanes, cutplanesHideInterior = false) {
        this.#done = false;

        // Calculate the viewing frustum
        // TODO same math is done in the renderer also. We could unify
        this.#frustum.reset(camera, cutPlanes, cutplanesHideInterior);
        this.#frustum.areaCullThreshold = globals.PIXEL_CULLING_THRESHOLD;

        if (!this.#models.length) {
            return;
        }

        // If the camera is in-motion, we assume the frame not to be resumed.
        // This allows us to render transparent shapes earlier. This special treatment is only used/needed for the main renderBatch pass.
        this.#frameWillNotBeResumed = this.enableNonResumableFrames && resetType == ResetFlags.RESET_RELOAD && drawMode === RenderFlags.RENDER_NORMAL;

        this.#camera = camera;

        // Begin the frustum based renderBatch iteration process per model.
        // A "Model" is all the objects to display. There's typically one model in a scene, so length is 1.
        for (let i = 0; i < this.#models.length; i++) {
            // decide what iterator to use, usually the BVH iterator
            this.#models[i].resetIterator(camera, this.#frustum, drawMode, resetType);

            // get the first RenderBatch (some set of fragments) to render.
            this.#candidateRenderBatches[i] = this.#models[i].nextBatch();

            this.#previousRenderBatches[i] = null;
        }
    }

    isDone() {
        return this.#done || this.isEmpty();
    }

    ///////////////////////////////////////////////////////////////////////
    // Visibility and highlighting methods: see RenderModel.js for details.

    setAllVisibility(value) {
        for (let i = 0; i < this.#models.length; i++)
            this.#models[i].setAllVisibility(value);
    }

    hideLines(hide) {
        for (let i = 0; i < this.#models.length; i++)
            this.#models[i].hideLines(hide);
    }

    hidePoints(hide) {
        for (let i = 0; i < this.#models.length; i++)
            this.#models[i].hidePoints(hide);
    }

    hasHighlighted() {
        for (let i = 0; i < this.#models.length; i++)
            if (this.#models[i].hasHighlighted())
                return true;

        return false;
    }

    areAllVisible() {
        for (let i = 0; i < this.#models.length; i++)
            if (!this.#models[i].areAllVisible())
                return false;

        return true;
    }

    ///////////////////////////////////////////////////////////////////////

    areAll2D() {
        for (let i = 0; i < this.#models.length; i++)
            if (!this.#models[i].is2d())
                return false;

        return true;
    }

    areAll3D() {
        for (let i = 0; i < this.#models.length; i++)
            if (!this.#models[i].is3d())
                return false;

        return true;
    }

    /** Trigger bbox recomputation. See RenderModel.js for details. */
    invalidateVisibleBounds() {
        for (let i = 0; i < this.#models.length; i++)
            this.#models[i].visibleBoundsDirty = true;
    }

    /**
     * @param {bool}            includeGhosted
     * @param {function(model)} [modeFilter]
     * @param {bool}            excludeShadow - Remove shadow geometry (if exists) from model bounds.
     * @returns {THREE.Box3} 
     *
     * NOTE: The returned box object is always the same, i.e. later calls
     *       affect previously returned values. E.g., for
     *        let box1 = getVisibleBounds(true);
     *        let box2 = getVisibleBounds(false);
     *       the second call would also change box1.
     */
    getVisibleBounds(includeGhosted, bboxFilter, excludeShadow) {
        tmpBox.makeEmpty();
        for (let i = 0; i < this.#models.length; i++) {
            const model = this.#models[i];
            const modelBox = model.getVisibleBounds(includeGhosted, excludeShadow);

            // Consider bboxFilter
            let skipModel = bboxFilter && !bboxFilter(modelBox);
            if (skipModel) {
                continue;
            }

            tmpBox.union(modelBox);
        }
        return tmpBox;
    }

    /**
     * @param {THREE.Vector3} position            - Ray origin.
     * @param {THREE.Vector3} direction           - Ray direction.
     * @param {bool}          [ignoreTransparent] - Shoot trough transparent objects.
     * @param {number[]|number[][]} [dbIds]       - Optional filter of dbIds to be considered for testing. see RenderModel.rayIntersect().
     *                                              If modelIds is set, dbIds[i] must provide a separate dbId array for modelIds[i].
     * @param {number[]}      [modelIds]          - Optional list of modelIds to be considered for rayIntersection. (default is to consider all)
     * @param {Array}         [intersections]     - Optional return array with all found intersections.
     * @param {function}      [getDbIdAtPointFor2D] - Optional callback. For 2D models, to return the dbId and modelId in an array.
     * @param {Object}        [options]             - Rayintersection options (see RenderModel.rayIntersect)
     * 
     * @returns {Object|null} Intersection result object (see RenderModel.rayIntersect)
     */
    // Add "meshes" parameter, after we get meshes of the object using id buffer,
    // then we just need to ray intersect this object instead of all objects of the model.
    rayIntersect(position, direction, ignoreTransparent, dbIds, modelIds, intersections, getDbIdAtPointFor2D, options) {
        // Init raycaster
        this.#raycaster.set(position, direction);

        // For multiple RenderModels, perform raytest on each of them and find the closest one.
        if (this.#models.length > 1) {
            // Collect raytest result objects from each 3D model
            const modelHits = [];

            if (modelIds) {
                for (let i = 0; i < modelIds.length; i++) {
                    const model = this.findModel(modelIds[i]);
                    if (model) {
                        const modelDbIds = dbIds && dbIds[i];
                        const res = model.rayIntersect(this.#raycaster, ignoreTransparent, modelDbIds, intersections, getDbIdAtPointFor2D, options);
                        if (res) {
                            modelHits.push(res);
                        }
                    }
                }
            } else {
                for (let i = 0; i < this.#models.length; i++) {
                    // Perform raytest on model i
                    const res = this.#models[i].rayIntersect(this.#raycaster, ignoreTransparent, dbIds, intersections, getDbIdAtPointFor2D, options);

                    if (res) {
                        modelHits.push(res);
                    }
                }
            }

            if (!modelHits.length)
                return null;

            // Return closest hit
            modelHits.sort(function(a, b) {
                return a.distance - b.distance;
            });
            return modelHits[0];
        } else {
            // If we don't have any RenderModel, just return null.
            if (!this.#models.length)
                return null;

            // Apply modelIds filter
            const model = this.#models[0];
            if (modelIds && modelIds.indexOf(model.id) === -1) {
                return null;
            }

            // If we only have a single RenderModel, just call rayIntersect() on it.
            return model.rayIntersect(this.#raycaster, ignoreTransparent, dbIds, intersections, getDbIdAtPointFor2D, options);
        }
    }

    /**
     *  Progress of current frame rendering. 
     *  @returns {number} Value in [0,1], where 1 means finished.
     */
    getRenderProgress() {
        return this.#models[0].getRenderProgress();
    }

    /** @returns {RenderModel[]} */
    getModels() {
        return this.#models;
    }

    /** @returns {RenderModel[]} */
    getHiddenModels() {
        return this.#hiddenModels;
    }

    /** @returns {RenderModel[]} */
    getAllModels() {
        return this.#models.concat(this.#hiddenModels);
    }

    // ----------------------------
    // Warning: The methods in the section below assume that there is exactly one RenderModel.
    //          They will ignore any additional models and cause an exception if the model list is empty.
    // 

    // Direct access to FragmentList, GeometryList, and total number of RenderBatches.
    //
    // Note: 
    //  - The methods do only care for model 0 and ignore any additional ones.
    //  - Will cause an error when called if the RenderModel array is empty.
    getFragmentList() {
        return this.#models[0].getFragmentList();
    }

    getGeometryList() {
        return this.#models[0].getGeometryList();
    }

    getSceneCount() {
        return this.#models[0].getSceneCount();
    }

    //Used by ground shadow update, ground reflection update, and screenshots
    getGeomScenes() {
        let scenes = [];
        for (let i = 0; i < this.#models.length; i++) {
            // Collect all scenes from next model
            const modelScenes = this.#models[i].getGeomScenes();
            for (let j = 0; j < modelScenes.length; j++) {
                // Some scenes may not exist. E.g., if it corresponds to an empty BVH node.
                const scene = modelScenes[j];
                if (scene) {
                    scenes.push(scene);
                }
            }
        }
        return scenes;
    }

    // Used by ground shadow update, ground reflection update,
    getGeomScenesPerModel() {
        return this.#models.reduce((acc, m) => {
            acc.push(m.getGeomScenes());
            return acc;
        }, []);
    }

    // ---------------- End of section of functions without support for multiple RenderModels

    /** Sets animation transforms for all fragments to create an "exploded view": Each fragment is displaced  
     * away from the model bbox center, so that you can distuinguish separate components. 
     *
     * If the model data provides a model hierarchy (given via model.getData().instanceTree), it is also considered for the displacement.
     * In this case, we recursively shift each object away from the center of its parent node's bbox. 
     *
     * @param {number} scale - In [0,1]. 0 means no displacement (= reset animation transforms). 
     *                                   1 means maximum displacement, where the shift distance of an object varies 
     *                                   depending on distance to model center and hierarchy level.
     * @param {Object} options - Additional setting for STRATEGY_HIERARCHY.
     * @param {Number} options.magnitude - Controls the spread of explode.
     * @param {Number} options.depthDampening - Controls the reduction of the explode effect with
     *                                          depth of the object in the hierarchy.  
     */
    explode(scale, options = {}) {
        if (!this.#models.length) {
            return;
        }

        for (let q = 0; q < this.#models.length; q++) {
            const model = this.#models[q];
            ModelExploder.explode(model, scale, options);
        }

        this.invalidateVisibleBounds();
    }

    /** 
     *  @params  {number} timeStamp
     *  @returns {bool}   true if any of the models needs a redraw
     */
    update(timeStamp) {
        // call update for all RenderModels and track
        // if any of these needs a redraw
        let needsRedraw = false;
        for (let q = 0; q < this.#models.length; q++) {
            const model = this.#models[q];
            needsRedraw = needsRedraw || model.update(timeStamp);
        }
        return needsRedraw;
    }

    /*
     *  Move model from visible models to hidden models
     *   @param {number} modelId - id of a currently visible model
     *   @returns {bool} true on success
     */
    hideModel(modelId) {
        // find model in the list of visible ones
        for (let i = 0; i < this.#models.length; i++) {
            const model = this.#models[i];
            if (model && model.id === modelId) {
                // move model from visible to hidden models
                this.removeModel(model);
                this.#hiddenModels.push(model);
                return true;
            }
        }
        // modelID does not refer to any visible model
        return false;
    }

    /*
     * Move previously hidden model to the array of rendered models.
     *  @param {number} modelId - id of a RenderModel in hiddenModels array
     *  @returns {bool} true on success
     */
    showModel(modelId) {
        // find model in list of hidden models
        for (let i = 0; i < this.#hiddenModels.length; ++i) {
            const model = this.#hiddenModels[i];
            if (model && model.id === modelId) {
                // mode model from hidden to visible models
                this.addModel(model);
                this.#hiddenModels.splice(i, 1);
                return true;
            }
        }
        // modelId does not refer to a hidden model
        return false;
    }
}