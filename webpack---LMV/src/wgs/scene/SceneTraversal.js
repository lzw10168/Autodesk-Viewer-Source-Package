import {
    ConsolidationIterator
} from './consolidation/ConsolidationIterator';
import {
    NoOpTraversalController
} from './NoOpTraversalController';

import {
    RenderBatch
} from './RenderBatch';

/**
 * Holds strategies on how to traverse the scene in portions, i.e., batches to render,
 * depending on the data format and its provided hierarchical structures (e.g., BVH, 3D Tiles),
 * as well as on Viewer settings, e.g., if consolidation is enabled.
 */
export class SceneTraversal {
    // A map holding all available traversal controllers, mapped to their id:
    // { string, ITraversalController }
    #
    traversalControllerRegistry = new Map();

    // The id of the currently used traversal controller
    #
    currentTraversalControllerId = "NoOp";

    // Processes render batches, and creates a consolidated version from these, to replace them.
    #
    consolidationIterator = null;

    // Frustum Intersector
    #
    frustum = undefined;

    // Integer representing the current draw mode
    #
    drawMode = undefined;

    constructor() {
        this.addTraversalController("NoOp", new NoOpTraversalController());
    }

    /**
     * Adds a new traversal controller, to be used depending on available data and other settings.
     * @param {String} id The unique identifier of this traversal controller.
     * @param {ITraversalController} traversalController The instance of the traversal controller.
     */
    addTraversalController(id, traversalController) {
        this.#traversalControllerRegistry.set(id, traversalController);
        this.#chooseTraversalController();
    }

    getTraversalController() {
        const traversalController = this.#traversalControllerRegistry.get(this.#currentTraversalControllerId);
        return traversalController;
    }

    /**
     * Updates the current strategy of scene traversal,
     * depending on the data available or custom settings if any.
     * 
     * @param {bool} fragmentsHaveBeenAdded True if fragments have been added explicitly since the last call.
     */
    #
    chooseTraversalController(fragmentsHaveBeenAdded = false) {
        // preferred - traversal based on BVH
        if (!fragmentsHaveBeenAdded) {
            if (this.#traversalControllerRegistry.has("BVH")) {
                this.#currentTraversalControllerId = "BVH";
                return;
            }
        }

        // if available - linear traversal
        if (this.#traversalControllerRegistry.has("Linear")) {
            this.#currentTraversalControllerId = "Linear";
            return;
        }

        // check for a custom traversal
        if (this.#traversalControllerRegistry.has("Custom")) {
            this.#currentTraversalControllerId = "Custom";
            return;
        }

        // if nothing else is applicable, pause traversal, until that changes
        this.#currentTraversalControllerId = "NoOp";
    }

    dtor() {
        // If this model was consolidated, dispose GPU memory of consolidation
        if (this.#consolidationIterator) {
            this.#consolidationIterator.dispose();
            this.#consolidationIterator = null;
        }

        this.#traversalControllerRegistry.forEach(controller => {
            controller.dtor();
        });

        this.#traversalControllerRegistry = null;
        this.#currentTraversalControllerId = null;
    }

    nextBatch() {
        const renderBatch = this.getTraversalController().nextBatch();

        // no further batches available - we are done with rendering everything for the current view
        if (!renderBatch) {
            return null;
        }

        // return consolidated scene if available for this renderbatch (= individual fragments)
        if (this.#consolidationIterator && renderBatch instanceof RenderBatch) {
            const consolidatedRenderBatch = this.#consolidationIterator.consolidateNextBatch(
                renderBatch,
                this.#frustum,
                this.#drawMode);

            // if everything was hidden, we take the render batch we already have
            if (!consolidatedRenderBatch) {
                return renderBatch;
            }

            return consolidatedRenderBatch;
        }

        return renderBatch;
    }

    /**
     * Updates scene traversal by current camera and frustum settings.     
     *
     * @param {UnifiedCamera} [camera] The current camera.
     * @param {FrustumIntersector} [frustum] The current frustum.
     * @param {int} [drawMode] The current draw mode index.
     * @param {bool} [fragmentsHaveBeenAdded] True if fragments have been added since the last call.
     */
    updateView(camera, frustum, drawMode, fragmentsHaveBeenAdded) {
        this.#frustum = frustum;
        this.#drawMode = drawMode;

        this.#chooseTraversalController(fragmentsHaveBeenAdded);

        this.getTraversalController().reset(frustum, camera);

        // notify consolidation iterator that a new traversal has started
        if (this.#consolidationIterator) {
            this.#consolidationIterator.reset();
        }
    }

    getVisibleBounds(visibleBounds, visibleBoundsWithHidden, includeGhosted) {
        this.getTraversalController().getVisibleBounds(visibleBounds, visibleBoundsWithHidden, includeGhosted);
    }

    /** Returns all render batches considered as 'relevant' to display for the current view.
     *  Used by ground shadows and ground reflection.
     * 
     * @returns {RenderBatch[]}
     */
    getScenes() {
        const traversalController = this.getTraversalController();

        // leaflet does not have scenes
        if (traversalController.isModelIteratorTexQuad) {
            return [];
        }

        return traversalController.getGeomScenes();
    }

    getSceneCount() {
        const sceneCount = this.getTraversalController().getSceneCount();
        return sceneCount;
    }

    getInnerAttributes() {
        const attributes = {
            currentIterator: this.getTraversalController(),
            linearIterator: this.#traversalControllerRegistry.get("Linear"),
            bvhIterator: this.#traversalControllerRegistry.get("BVH"),
            consolidationIterator: this.#consolidationIterator,
            bvhOn: this.#isBVHUsed()
        };
        return attributes;
    }

    setInnerAttributes(attributes) {
        // add linear iterator and set it to default if it is according to settings
        if (!this.#traversalControllerRegistry.has("Linear") && attributes._linearIterator) {
            this.#traversalControllerRegistry.set("Linear", attributes._linearIterator.clone());
            if (attributes._linearIterator === attributes._iterator) {
                this.#currentTraversalControllerId = "Linear";
            }
        }

        // add BVH iterator and set it to default if it is according to settings
        if (!this.#traversalControllerRegistry.has("BVH") && attributes._bvhIterator) {
            this.#traversalControllerRegistry.set("BVH", attributes._bvhIterator.clone());
            if (attributes._bvhIterator === attributes._iterator) {
                this.#currentTraversalControllerId = "BVH";
            }
        }

        // initialize consolidation iterator if any
        if (!this.#consolidationIterator && attributes._consolidationIterator) {
            this.#consolidationIterator = attributes._consolidationIterator.clone();
        }

        // If both linearIterator & bvhIterator aren't available, it means that we used a custom iterator.
        // For example, ModelIteratorTexQuad. In this case, try cloning it if is has a clone method.
        // Otherwise, shallow copy is good enough.
        if (!this.#currentTraversalControllerId == "NoOp") {
            this.#traversalControllerRegistry.set("Custom", attributes._iterator ? .clone ? attributes._iterator.clone() : attributes._iterator);
            this.#currentTraversalControllerId = "Custom";
        }
    }

    #
    isBVHUsed() {
        return this.#currentTraversalControllerId == "BVH";
    }

    // Adds a fragment to the list of the linear model iterator.
    // NOTE that other iterators do not support this function.
    // @param int [fragId] The Fragment's ID to be added.
    addFragment(fragId) {
        // The linear iterator can be updated to add meshes incrementally.
        // The BVH iterator is not mutable, yet.
        if (this.#currentTraversalControllerId == "Linear") {
            this.getTraversalController().addFragment(fragId);
        }
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Leaflet specific functionality

    // Sets the MESH_VISIBLE flag for a fragment (true=visible, false=ghosted).
    // NOTE that is only supported by the Leaflet iterator.
    setVisibilityLeaflet(value) {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            this.getTraversalController().setVisibility(value);
        }
    }

    /**
     * Returns true if the Leaflet Model needs a redraw.
     * 
     * @params  {number} timeStamp
     * @returns {bool}   true if the model is a leaflet and it needs a redraw
     */
    needsRedrawLeaflet(timeStamp) {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            return this.getTraversalController().update(timeStamp);
        }

        // assume constant scene otherwise
        return false;
    }

    clearThemingColorsLeaflet() {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            this.getTraversalController().clearThemingColor();
        }
    }

    setThemingColorLeaflet(color) {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            // dbId is ignored in this case, as well as intensity. Apply theming to whole model
            this.getTraversalController().setThemingColor(color);
            return true;
        }
        return false;
    }

    getLeafletIterator() {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            return this.getTraversalController();
        }
        return null;
    }

    setModelTransformLeaflet(matrix) {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            this.getTraversalController().setModelMatrix(matrix);
        }
    }

    getModelTransformLeaflet() {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            return this.getTraversalController().getModelMatrix();
        }
        return undefined;
    }

    getInverseModelTransformLeaflet() {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            return this.getTraversalController().getInverseModelMatrix();
        }

        return undefined;
    }

    setViewportBoundsLeaflet(bounds) {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            this.getTraversalController().setViewBounds(bounds);
        }
        return undefined;
    }

    getViewportBoundsLeaflet() {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            return this.getTraversalController().getViewBounds();
        }
        return undefined;
    }

    setDoNotCutLeaflet(doNotCut) {
        if (this.getTraversalController().isModelIteratorTexQuad) {
            this.getTraversalController().setDoNotCut(doNotCut);
        }
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Consolidation specific functionality

    updateModelTransformConsolidation() {
        this.#consolidationIterator && this.#consolidationIterator.modelMatrixChanged();
    }

    /**
     * Enables and initializes consolidation.
     * 
     * @params  {FragmentList} [fragmentList] The current FragmentList.
     * @params  {Consolidation} [consolidation] The results of consolidation.
     */
    enableConsolidation(fragmentList, consolidation) {
        // make BVHIterator use the consolidation when possible
        this.#consolidationIterator = new ConsolidationIterator(fragmentList, consolidation);
    }

    disableConsolidation() {
        this.#consolidationIterator.dispose();
        this.#consolidationIterator = null;
    }

    getConsolidation() {
        const consolidation = this.#consolidationIterator ? .getConsolidation();
        return consolidation;
    }

    isEnabledConsolidation() {
        return !!this.#consolidationIterator;
    }

    /**
     * This function is only needed if...
     *
     *   1. You want to draw a fragment to an overlay scene that overdraws the original fragment, and
     *   2. Consolidation is used for this model.
     *
     *  To avoid flickering artifacts, the geometry used for the overlay scene must exactly match with the
     *  one used for the main scene rendering. However, when consolidation is used, this geometry may vary
     *  and (slightly) differ from the original fragment geometry.
     *
     *  This function updates the given render proxy to make it exactly match with the geometry used for the
     *  the last main scene rendering. This involves to replace geometry, material, and matrix when necessary.
     *
     *  NOTE: An updated proxy can exclusively be used for rendering. Do not use this function if you want to
     *        access any vertex data directly.
     *
     *   @param {THREE.Mesh} proxy  - currently used proxy mesh to represent the fragment
     *   @param {Number}     fragId - fragment represented by this proxy */
    updateRenderProxy(proxy, fragId) {
        if (!this.isEnabledConsolidation()) {
            // nothing to do - rendering will always use the original geometry anyway.
            return;
        }

        // fragment might be consolidated
        this.#consolidationIterator.updateRenderProxy(proxy, fragId);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    skipOpaqueShapes() {
        if (this.getTraversalController().skipOpaqueShapes) {
            this.getTraversalController().skipOpaqueShapes();
        }
    }
}