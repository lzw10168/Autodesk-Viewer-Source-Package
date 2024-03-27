'use strict';

import {
    buildClustersFromAttribute,
    Cluster,
    createShapeId,
    hasVisibleFragments
} from './Cluster.js';
import {
    createClusterSetLayout
} from './RowLayoutBuilder.js';
import AnimController from './AnimController.js';
import ShapeBoxes from './ShapeBoxes.js';
import {
    ObjectAnimState,
    ModelAnimState,
    SceneAnimState
} from './AnimState.js';
import {
    ClusterGizmoController
} from './ClusterGizmo.js';
import {
    RotationAlignment,
    getBoxCorner,
    findAlignmentRotation,
    computeObjectAlignment
} from './RotationAlignment.js';

const av = Autodesk.Viewing;
const avu = av.UI;

const namespace = AutodeskNamespace('Autodesk.Viewing.Extensions.VisualClusters');

// Name of the animation state that organizes all objects in clusters based on Category attribute.
const ClusteredStateName = 'ByCategory';

const createClusterIcon = () => {
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 143 135">',
        '<g fill="currentColor">',
        '<polygon points="29.275 51 9.725 51 0 68.05 9.725 85 29.275 85 39 68.05"/>',
        '<polygon points="133.275 51 113.725 51 104 68.05 113.725 85 133.275 85 143 68.05"/>',
        '<polygon points="89.05 0 55.05 0 38 29.55 55.05 59 89.05 59 106 29.55"/>',
        '<polygon points="89.05 76 55.05 76 38 105.45 55.05 135 89.05 135 106 105.45"/>',
        '</g>',
        '</svg>'
    ].join('');
};

// Create a clustering layout that forms clusters of objects based on Category attribute.
const createDefaultLayout = async (models, alignShapeRotation, attribName, searchAncestors) => {

    // Make sure that we only work on supported models
    const modelSupported = model => model.is3d() && Boolean(model.getInstanceTree());
    models = models.filter(modelSupported);

    // build clusters
    let clusters = await buildClustersFromAttribute(models, attribName, searchAncestors);

    // Exclude topography & rooms
    const filter = c => (c.name != 'Revit Topography' && c.name != 'Revit Rooms' && c.name != 'Revit <Sketch>');
    clusters = clusters.filter(filter);

    // Use RotationLayout to orient all shapes in a way that the projected x/y-extent is small
    const rotationAlignment = alignShapeRotation ? new RotationAlignment(models) : null;

    // Create helper for bbox access
    const shapeBoxes = new ShapeBoxes(models, rotationAlignment);

    // Compute layouts
    return createClusterSetLayout(clusters, shapeBoxes, rotationAlignment);
};

/**
 * Purpose of VisualClusters extension is to group objects into clusters.
 * 
 * This means:
 *  1. Categories: Form categories by assigning each shape in a model (or multiple) to a unique category, e.g. based on values of a database property.
 *  2. Layout:     Compute a "layout" that places all shapes in a way that shapes of the same group are located closeby.
 *  3. Animation:  Animate between original shape positions and new positions according to cluster layout.
 * 
 * Example: By default, the clustering extension forms clusters based on the "Category" Given a building model and 2 groups - windows and doors - the result is that all windows and doors are moved away from their
 *          original positions, so that you have one cluster of windows and one cluster of doors located outside the original building.
 * 
 * The extension id is: `Autodesk.VisualClusters`
 * 
 * @example
 *   viewer.loadExtension('Autodesk.VisualClusters')
 * 
 *   If you have a 3D model with propertyDb loaded, you should now see a button in the toolbar to trigger clustering based on Category attribute.
 *  
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.VisualClusters
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @constructor
 */
export default class VisualClustersExtension extends av.Extension {
    constructor(viewer, options) {
        super(viewer, options);

        // If true, the toggle button for the layout is pressed and all objects
        // are arranged in clusters (or being computed or animating towards that state)
        this.layoutActive = false;

        // Used to detect if an async layout computation is meanwhile outdated.
        this.layoutTimeStamp = 0;

        // Controls transitions between clustered and original state
        this.animController = new AnimController(this.viewer);

        // Controls gizmos and labels for clusters
        this.gizmoController = new ClusterGizmoController(this.viewer);

        // Bind event listener callbacks
        this.onModelAddedCb = this.onModelAdded.bind(this);
        this.onModelRemovedCb = this.onModelRemoved.bind(this);
        this.dbLoadedCb = this.onDbLoaded.bind(this);
        this.onTransitionEndedCb = this.onTransitionEnded.bind(this);
    }

    async load() {

        await this.viewer.loadExtension('Autodesk.Edit3D');

        if (this.options.skipDefaultListeners) {
            return true;
        }

        this.viewer.addEventListener(av.MODEL_ADDED_EVENT, this.onModelAddedCb);
        this.viewer.addEventListener(av.MODEL_REMOVED_EVENT, this.onModelRemovedCb);
        this.viewer.addEventListener(av.OBJECT_TREE_CREATED_EVENT, this.dbLoadedCb);
        this.viewer.addEventListener(av.ANIM_ENDED, this.onTransitionEndedCb);
        return true;
    }

    unload() {
        if (!this.options.skipDefaultListeners) {
            this.viewer.removeEventListener(av.MODEL_ADDED_EVENT, this.onModelAddedCb);
            this.viewer.removeEventListener(av.MODEL_REMOVED_EVENT, this.onModelRemovedCb);
            this.viewer.removeEventListener(av.OBJECT_TREE_CREATED_EVENT, this.onDbLoaded);
            this.viewer.removeEventListener(av.ANIM_ENDED, this.onTransitionEndedCb);
        }

        // Revert all anim transform changes.
        this.animController.reset();

        this._destroyUI();
        return true;
    }

    // Reset to initial state.
    reset() {
        this.animController.reset();
        this.gizmoController.reset();
        this.layoutActive = false;
        this.updateButton();
    }

    onModelAdded() {
        this.updateButton();
    }

    onModelRemoved() {
        this.updateButton();

        // Auto-reset: When reset all animation transforms and extension state.
        // This avoids leaking any state information when switching between views.
        //
        // Note: When temporarily switching all models off in a multi-model scenario, auto-reset might
        //       not be wanted. If we need to support that case, we need a concept to tell the extension
        //       explicitly whether a view-switch occurred or leave the reset to the client.
        const lastModelRemoved = !this.viewer.getVisibleModels().length;
        if (lastModelRemoved) {
            this.reset();
        }
    }

    onDbLoaded() {
        this.updateButton();
    }

    onToolbarCreated() {
        if (this.options.skipDefaultButton) {
            return;
        }

        this.clusterButton = new avu.Button("toolbar-clusterTool");
        this.clusterButton.icon.innerHTML = createClusterIcon();

        // add button to toolbar section 'Model Tools'
        let toolbar = this.viewer.getToolbar && this.viewer.getToolbar();
        if (toolbar) {
            let modelTools = toolbar.getControl(av.TOOLBAR.MODELTOOLSID);

            // Add our button to the toolbar
            if (modelTools) {
                modelTools.addControl(this.clusterButton);
            }
        }

        this.clusterButton.onClick = () => {
            this.setLayoutActive(!this.layoutActive);
        };

        this.updateButton();
    }

    onTransitionStarted() {
        // check if animation state is available and whether there are clusters
        // (models with clusters have an animStates array with length bigger than 0)
        if (ClusteredStateName in this.animController.states &&
            this.animController.states[ClusteredStateName].animStates.filter(Boolean)[0].animStates.length > 0) {
            this.viewer.fireEvent({
                type: av.TRANSITION_STARTED,
                sceneAnimState: this.animController.states[ClusteredStateName]
            });
        } else {
            this.viewer.fireEvent({
                type: av.TRANSITION_STARTED,
                sceneAnimState: null
            });
        }
    }

    onTransitionEnded() {
        if (ClusteredStateName in this.animController.states &&
            this.animController.states[ClusteredStateName].animStates.filter(Boolean)[0].animStates.length > 0) {
            this.viewer.fireEvent({
                type: av.TRANSITION_ENDED,
                sceneAnimState: this.animController.states[ClusteredStateName]
            });
        } else {
            this.viewer.fireEvent({
                type: av.TRANSITION_ENDED,
                sceneAnimState: null
            });
        }
    }

    _destroyUI() {
        // Remove button from toolbar
        if (this.clusterButton) {
            const toolbar = this.viewer.getToolbar && this.viewer.getToolbar();
            const modelTools = toolbar && toolbar.getControl(av.TOOLBAR.MODELTOOLSID);
            if (modelTools) {
                modelTools.removeControl(this.clusterButton);
            }
            this.clusterButton = null;
        }
        this.setLayoutActive(false);
    }

    setLayoutActive(active, attributeName) {
        if (this.layoutActive === active) {
            return;
        }

        // Indicate that layout is activated
        this.layoutActive = active;

        this.updateButton();

        // Layout disabled: Animate back to original state
        if (!active) {
            this.onTransitionStarted();
            this.animController.animateTo(null);
            this.gizmoController.onLayoutChanged(null);
            return;
        }

        this.applyLayout(attributeName);
    }

    async applyLayout(attributeName) {

        // get currently visible/loaded models
        const models = this.viewer.getVisibleModels();

        // If a layout computation is active, mark it as outdated.
        this.layoutTimeStamp++;

        // Remember timestamp so that we can check later if result is still wanted
        const layoutTimeStamp = this.layoutTimeStamp;

        const sceneLayout = this.customSceneLayout ?
            this.customSceneLayout :
            await createDefaultLayout(
                models,
                true,
                attributeName ? attributeName : this.options.attribName,
                this.options.searchAncestors
            );

        // If this.layoutTimeStamp has changed, the result is outdated.
        if (!this.layoutActive || layoutTimeStamp !== this.layoutTimeStamp) {
            return;
        }

        this.sceneLayout = sceneLayout;

        // Create animation state that represents this layout
        this.sceneAnimState = sceneLayout.createSceneState(models);

        // Make animation state available
        this.animController.registerState(ClusteredStateName, this.sceneAnimState);

        this.onTransitionStarted();

        // Animate to clustered layout
        this.animController.animateTo(ClusteredStateName);
        this.gizmoController.onLayoutChanged(this.sceneLayout);
    }

    updateButton() {
        if (!this.clusterButton) {
            return;
        }

        const models = this.viewer.getVisibleModels();

        // Only show button if we have >=1 3D model. Note that we cannot rely on this.viewer.impl.is2d, because it
        // is set after addModel event is fired.
        const showButton = models.some(model => model.is3d());
        this.clusterButton.setVisible(showButton);
        if (!showButton) {
            return;
        }

        // Disable button if some propDb is still loading or if we don't have any propDb at all.
        const propDbLoading = (model) => model.getPropertyDb() && !model.getPropertyDb().isLoadDone();
        const propDbMissing = (model) => !propDbLoading(model) && !model.getInstanceTree();
        const waitForDb = models.some(propDbLoading);
        const noPropDb = models.some(propDbMissing);
        const disable = waitForDb || noPropDb;

        // Choose button tooltip. If we disable, explain why.
        let tooltip = 'Form Clusters by Category';
        if (disable) {
            tooltip = waitForDb ? 'Waiting for database to load' : 'Visual Clustering can only be used if a database is available';
        }
        this.clusterButton.setToolTip(tooltip);

        // Set button state
        if (disable) {
            this.clusterButton.setState(avu.Button.State.DISABLED);
        } else {
            this.clusterButton.setState(this.layoutActive ? avu.Button.State.ACTIVE : avu.Button.State.INACTIVE);
        }
    }
}

av.theExtensionManager.registerExtension('Autodesk.VisualClusters', VisualClustersExtension);

namespace.buildClustersFromAttribute = buildClustersFromAttribute;
namespace.Cluster = Cluster;
namespace.createShapeId = createShapeId;
namespace.createClusterSetLayout = createClusterSetLayout;
namespace.ShapeBoxes = ShapeBoxes;
namespace.AnimConstroller = AnimController;
namespace.hasVisibleFragments = hasVisibleFragments;
namespace.ObjectAnimState = ObjectAnimState;
namespace.ModelAnimState = ModelAnimState;
namespace.SceneAnimState = SceneAnimState;
namespace.getBoxCorner = getBoxCorner;
namespace.findAlignmentRotation = findAlignmentRotation;
namespace.computeObjectAlignment = computeObjectAlignment;
namespace.RotationAlignment = RotationAlignment;