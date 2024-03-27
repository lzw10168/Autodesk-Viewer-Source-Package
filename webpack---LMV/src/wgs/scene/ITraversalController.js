/* Interface for controller logic on scene Traversal.
 *
 * The Traversal Controller's responsibilities are:
 * - Choosing the 'relevant' geometry to display for the current view.
 * - For defining 'relevance', view settings (camera, frustum) can be considered, as well as
 *   other criteria such as geometric error, memory capacity, and accuracy requirements.
 * - Trigger loading the geometry that is considered to be 'relevant'.
 * - Providing an efficient way to access and return 'relevant' geometry during rendering,
 *   including to decide for any data structure that pleases this requirement.
 * - Free memory from geometry not considered as 'relevant' for the current view, as much as possible.
 *
 */
export class ITraversalController {

    constructor() {}
    dtor() {}

    /**
     * Creates a new instance of a concrete traversal controller, with the same settings,
     * implementing this interface.
     * 
     * @returns {ITraversalController} A new instance of a concrete controller.
     */
    clone() {}

    /**
     * Computes the next set of scene objects to display
     * 
     * @returns {RenderBatch}
     */
    nextBatch() {}

    /**
     * Passes the latest frustum and camera settings,
     * to be taken into consideration for the next scene objects to display and to not display.
     * 
     * @param {FrustumIntersector} frustum 
     * @param {UnifiedCamera} camera 
     */
    reset(frustum, camera) {}

    /**
     * Returns all currently visible scene objects,
     * to be used for shadow computation for instance.
     * 
     * @returns {RenderBatch[]} An array of RenderBatches that are visible at the moment.
     */
    getGeomScenes() {}

    /**
     * Returns the number of all currently visible scene objects.
     * 
     * @returns {int} The number of currently visible scene objects.
     */
    getSceneCount() {}

    /**     
     * Computes the boundary for the currently relevant scene objects.
     * 
     * @param  {THREE.Box3} visibleBounds           The boundary of the currently visible scene objects.
     * @param  {THREE.Box3} visibleBoundsWithHidden The boundary of the currently visible scene objects +
     *                                              scene objects that are marked as 'hidden' if any.
     * @param  {bool}       includeGhosted          If true, include ghosted scene objects as well if any.
     */
    getVisibleBounds(visibleBounds, visibleBoundsWithHidden, includeGhosted) {}

    /**
     * Performs a raycast on all currently visible scene objects.
     * 
     * @param {THREE.Raycaster} raycaster 
     * @param {Object[]} intersects An object array that contains intersection result objects.
     *                              Each result r stores properties like
     *                              r.point, r.fragId, r.dbId.
     *                              (see VBIntersector.js for details)
     * @param {number[]} dbIds Array of dbIds. If specified, only fragments with dbIds inside the filter are checked.
     */
    rayCast(raycaster, intersects, dbIds) {}
}