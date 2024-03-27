import {
    BimWalkTool
} from './BimWalkTool';
import {
    metersToModel
} from './BimWalkUtils';

var avp = Autodesk.Viewing.Private;
const analytics = avp.analytics;

const WORKER_COMPUTE_BVH = "COMPUTE_BVH";

/**
 * First Person navigation tool, similar to those found in videogames.
 * Supports keyboard and mouse input.
 *
 * The extension id is: `Autodesk.BimWalk`
 *
 * @param {Viewer3D} viewer - Viewer instance
 * @param {object} options - Configurations for the extension
 * @example 
 * viewer.loadExtension('Autodesk.BimWalk')
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.BimWalkExtension
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @class
 */
export function BimWalkExtension(viewer, options = {}) {

    Autodesk.Viewing.Extension.call(this, viewer, options);
    this.options = options;
    this.name = "bimwalk";
    this._updateButtonState = this._updateButtonState.bind(this);
    this._updateToolNavigator = this._updateToolNavigator.bind(this);
    this._createRaycastIterator = this._createRaycastIterator.bind(this);
    this._setAsDefault = this._setAsDefault.bind(this);
    this._onEscape = this._onEscape.bind(this);
    this._onFitToView = this._onFitToView.bind(this);
    this._isDefault = false;
    this._enableGravityCheckBoxID = null;

}

BimWalkExtension.prototype = Object.create(Autodesk.Viewing.Extension.prototype);
BimWalkExtension.prototype.constructor = BimWalkExtension;

var proto = BimWalkExtension.prototype;


proto.load = function() {

    var viewer = this.viewer;

    // Register tool
    this.tool = new BimWalkTool(viewer, this.options, this);

    viewer.toolController.registerTool(this.tool, this.setActive.bind(this));
    viewer.prefs.addListeners(avp.Prefs3D.DEFAULT_NAVIGATION_TOOL_3D, this._setAsDefault);
    viewer.addEventListener(Autodesk.Viewing.AGGREGATE_FIT_TO_VIEW_EVENT, this._onFitToView);
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, this._createRaycastIterator);
    viewer.addEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, this._createRaycastIterator);

    // Compute Raycasting BVH for all loaded models
    const models = this.viewer.impl.get3DModels();
    for (let i = 0; i < models.length; ++i) {
        this._createRaycastIterator(models[i]);
    }

    return true;
};


proto.unload = function() {

    var viewer = this.viewer;

    // Remove listeners
    viewer.removeEventListener(Autodesk.Viewing.TOOL_CHANGE_EVENT, this._updateButtonState);
    viewer.removeEventListener(Autodesk.Viewing.MODEL_REMOVED_EVENT, this._updateButtonState);
    viewer.removeEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, this._updateButtonState);
    viewer.removeEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, this._createRaycastIterator);
    viewer.removeEventListener(Autodesk.Viewing.ESCAPE_EVENT, this._onEscape);
    viewer.removeEventListener(Autodesk.Viewing.AGGREGATE_FIT_TO_VIEW_EVENT, this._onFitToView);
    viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, this._createRaycastIterator);
    viewer.prefs.removeListeners(avp.Prefs3D.BIM_WALK_NAVIGATOR_TYPE, this._updateToolNavigator);
    viewer.prefs.removeListeners(avp.Prefs3D.DEFAULT_NAVIGATION_TOOL_3D, this._setAsDefault);

    this.onToolChanged = undefined;

    // Remove hotkey
    viewer.getHotkeyManager().popHotkeys(this.HOTKEYS_ID);

    // Remove the UI
    if (this.bimWalkToolButton) {
        this.bimWalkToolButton.removeFromParent();
        this.bimWalkToolButton = null;
    }

    if (viewer.getDefaultNavigationToolName() === this.tool.getName()) {
        viewer.setDefaultNavigationTool("orbit");
    }

    //Uh, why does the viewer need to keep track of this in addition to the tool stack?
    if (viewer.getActiveNavigationTool() == this.tool.getName())
        viewer.setActiveNavigationTool();

    // Remove settings from Viewer Settings Panel
    if (this._enableGravityCheckBoxID && viewer.viewerSettingsPanel) {
        const control = this.viewer.viewerSettingsPanel.getControl(this._enableGravityCheckBoxID);
        if (control) viewer.viewerSettingsPanel.removeCheckbox(control);
    }

    // Deregister tool
    viewer.toolController.deregisterTool(this.tool);
    this.tool = null;

    this._isDefault = false;

    return true;
};

proto.set = function(configuration, value) {

    if (this.tool.set(configuration, value)) {
        avp.logger.log('BimWalk ' + configuration + ' was set to: ' + this.tool.get(configuration));
    }
};

proto.get = function(configuration) {

    return this.tool.get(configuration);
};

proto.setJoystickPosition = function(x, y) {

    this.tool.setJoystickPosition(x, y);
};

proto.setJoystickRelativePosition = function(x, y) {

    this.tool.setJoystickRelativePosition(x, y);
};

proto.setJoystickSize = function(backgroundRadius, handleRadius) {

    this.tool.setJoystickSize(backgroundRadius, handleRadius);
};

/**
 * Enables the walk tool.
 * 
 * @memberof Autodesk.Viewing.Extensions.BimWalkExtension
 * @alias Autodesk.Viewing.Extensions.BimWalkExtension#activate
 */
proto.activate = function() {
    if (!this.activeStatus) {
        this.viewer.setActiveNavigationTool(this.tool.getName());
        this.activeStatus = true;

        const isSectionActive = this.viewer.isExtensionActive('Autodesk.Section');
        const isAecModelData = this.viewer.model ? .getDocumentNode() ? .getAecModelData();
        analytics.track('viewer.first_person.enable', {
            aec_model_data: !!isAecModelData,
            active_section: !!isSectionActive
        });
    }
    return true;
};

/**
 * Deactivates the walk tool.
 * 
 * @memberof Autodesk.Viewing.Extensions.BimWalkExtension
 * @alias Autodesk.Viewing.Extensions.BimWalkExtension#deactivate
 */
proto.deactivate = function() {
    if (this.activeStatus) {
        this.activeStatus = false;
        this.viewer.setActiveNavigationTool();
        if (this.viewer.model) { // We might get here when switching models, so check that model exists
            this.setPivotPointAfterBimWalk(this.viewer.getCamera());
        }
    }
    return true;
};

/**
 * Set a Pivot point for camera once BimWalk deactivated.
 * This way we discard previous Pivot point which can cause unpredictable orbiting.
 *
 * @param {object} camera - input camera
 * @private
 */
proto.setPivotPointAfterBimWalk = function(camera) {

    // Pivot point set to 1 meter from camera
    const mtsToModel = metersToModel(1, this.viewer);
    const direction = camera.target.clone().sub(camera.position).normalize();
    camera.pivot.copy(camera.position);
    camera.pivot.add(direction.multiplyScalar(mtsToModel));
    camera.dirty = true;
};

/**
 * @param {object} toolbar - toolbar
 * @private
 */
proto.onToolbarCreated = function(toolbar) {

    var viewer = this.viewer;
    var avu = Autodesk.Viewing.UI;
    var navTools = toolbar.getControl(Autodesk.Viewing.TOOLBAR.NAVTOOLSID);

    // Create a button for the tool.
    var extension = this;
    extension.bimWalkToolButton = new avu.Button('toolbar-bimWalkTool');
    extension.bimWalkToolButton.setToolTip('First person');
    extension.bimWalkToolButton.onClick = function() {
        const activeNavToolName = extension.viewer.getActiveNavigationTool();
        const defaultNavTool = extension.viewer.getDefaultNavigationToolName();
        const bimwalkToolName = extension.tool.getName();

        // Make sure that the bimwalk tool is set as the default
        if (extension._isDefault && defaultNavTool !== bimwalkToolName) {
            extension._setAsDefault(extension.viewer.prefs.get(avp.Prefs3D.DEFAULT_NAVIGATION_TOOL_3D));
            return;
        }

        if (extension.activeStatus) {
            // Deactivate the tool if it is not the default tool.
            if (!extension._isDefault && activeNavToolName === bimwalkToolName) {
                extension.deactivate();
            }
        } else {
            extension.activate();
        }
    };

    extension.bimWalkToolButton.setIcon("adsk-icon-first-person");

    var cameraSubmenuTool = navTools.getControl('toolbar-cameraSubmenuTool');
    if (cameraSubmenuTool) {
        navTools.addControl(extension.bimWalkToolButton, {
            index: navTools.indexOf(cameraSubmenuTool.getId())
        });
    } else {
        navTools.addControl(extension.bimWalkToolButton);
    }

    // Add settings to Viewer Settings Panel
    const navTab = Autodesk.Viewing.Extensions.ViewerSettingTab.Navigation;
    this._enableGravityCheckBoxID = viewer.viewerSettingsPanel.addCheckbox(navTab,
        "Enable Gravity",
        "Toggles gravity while in first person mode",
        this.tool.navigator.gravityEnabled,
        checked => this.tool.navigator.enableGravity(checked),
        avp.Prefs3D.BIM_WALK_GRAVITY
    );

    viewer.addEventListener(Autodesk.Viewing.TOOL_CHANGE_EVENT, this._updateButtonState);
    viewer.addEventListener(Autodesk.Viewing.MODEL_REMOVED_EVENT, this._updateButtonState);
    viewer.addEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, this._updateButtonState);
    viewer.addEventListener(Autodesk.Viewing.ESCAPE_EVENT, this._onEscape);
    viewer.prefs.addListeners(avp.Prefs3D.BIM_WALK_NAVIGATOR_TYPE, this._updateToolNavigator);

    // Check to see if this tool needs to be set as the default.
    this._setAsDefault(viewer.prefs.get(avp.Prefs3D.DEFAULT_NAVIGATION_TOOL_3D));
};

proto._makeBVHInWorker = function(model) {
    const scope = this;
    // Good trade off between memory consumption and performance
    const options = {
        'frags_per_leaf_node': 16,
        'frags_per_inner_node': 0,
        'frags_per_leaf_node_transparent': 16,
        'frags_per_inner_node_transparent': 0,
        'max_polys_per_node': Infinity
    };

    if (!scope._bvhWorker) {
        scope._rayCastComputations = 0;
        scope._bvhWorker = avp.createWorker();

        const onBvhWorkerEvent = function(e) {
            const bvh = e.data.bvh;
            const model = scope.viewer.impl ? .findModel(e.data.modelId);

            if (model) {
                const iterator = new avp.ModelIteratorBVH();
                iterator.initialize(model, new avp.NodeArray(bvh.nodes, bvh.useLeanNodes), bvh.primitives, options);
                model.setRaycastIterator(iterator);
            }

            scope._rayCastComputations--;
            if (scope._rayCastComputations === 0) {
                scope._bvhWorker.terminate();
                scope._bvhWorker = null;
            }
        };

        scope._bvhWorker.addEventListener('message', onBvhWorkerEvent);
    }

    const fragments = model.getFragmentList().fragments;

    const workerContext = {
        operation: WORKER_COMPUTE_BVH,
        raiseError: null,
        onFailureCallback: null,
        onLoaderEvent: null,
        onOperationComplete: null,
        bvhOptions: options,
        modelId: model.id,
        fragments: {
            boxes: fragments.boxes,
            polygonCounts: fragments.polygonCounts,
            length: fragments.length,
            wantSort: !(model.isOTG() || model.isSVF2())
        }
    };

    scope._rayCastComputations++;
    scope._bvhWorker.doOperation(workerContext);
};

/**
 * Try to create a raycast iterator for the given model or install handler to do that later if necessary
 * @param {Autodesk.Viewing.Model} model 
 */
proto._createRaycastIterator = function(model) {
    if (model.model)
        model = model.model;

    // Only create Raycast iterator if non is available and only for static 3D designs
    if (!model.getRaycastIterator() && !model.is2d() && !model.isSceneBuilder()) {
        const frags = model.getFragmentList().fragments;

        // Either the model has to be fully loaded or the final bounding boxes have to be available
        if (model.isLoadDone() || frags.boxesLoaded) {
            this._makeBVHInWorker(model);
        } else {
            if (!model.hasEventListener(Autodesk.Viewing.MODEL_FRAGMENT_BOUNDING_BOXES_SET_EVENT, this._createRaycastIterator))
                model.addEventListener(Autodesk.Viewing.MODEL_FRAGMENT_BOUNDING_BOXES_SET_EVENT, this._createRaycastIterator, {
                    once: true
                });
        }
    }
};

// Reflect active/enabled state in BimWalk button
proto._updateButtonState = function() {
    // BimWalk requires a model to initialize metersPerUnit
    var viewer = this.viewer;
    var isEnabled = !!viewer.model;
    var self = this;
    var avu = Autodesk.Viewing.UI;

    if (self.bimWalkToolButton) {
        var isActive = isEnabled && self.tool && self.tool.isActive();
        var state = isActive ? avu.Button.State.ACTIVE :
            (isEnabled ? avu.Button.State.INACTIVE : avu.Button.State.DISABLED);
        self.bimWalkToolButton.setState(state);
    }

    // If we had to disable it on model-remove, we must deactivate the tool too
    // for consistentcy.
    if (self.activeStatus && !isEnabled) {
        self.deactivate();
    }

    // If we had to disable it on model-remove, we must deactivate the tool too
    // for consistentcy.
    if (self.activeStatus && !isEnabled) {
        self.deactivate();
    }
};

/**
 * Updates the tool's navigator
 *
 * @param type
 * @private
 */
proto._updateToolNavigator = function(type) {
    // Just deactivate the tool and then set the navigator
    this.deactivate();
    this.tool.setNavigator(type);
};

/**
 * Sets the default tool depending on the type is passed in.
 * The bimwalk tool will be set as the default for the following two cases:
 * 1. if the `type` is set to 'extractor_defined' and the 'navigation hint' (from metadata.json) is set to 'walk'
 * or
 * 2. if the `type` is set to 'bimwalk'
 *
 * @param {string} type - 'extractor_defined' / 'bimwalk'
 * @private
 */
proto._setAsDefault = function(type) {
    switch (type) {
        case 'extractor_defined':
            var navModeHint = this.viewer.model.getMetadata('navigation hint', 'value', null);
            if (!navModeHint || navModeHint.toLowerCase() !== 'walk') {
                // If the metadata does not contain the 'walk' hint,
                // then this should break before the bimwalk tool is activated and set as the default in the 'bimwalk' case.
                break;
            }
            // falls through
        case 'bimwalk':
            if (this.viewer.getDefaultNavigationToolName() !== this.tool.getName()) {
                // This will set the default tool to bimwalk and it will activate BimWalk's tool.
                // Note that it will not call the activate function of the extension.
                this.viewer.setDefaultNavigationTool(this.tool.getName());
                // Because the this.activate is not called, we still want to set the activeStatus of this extension.
                // NOTE: Calling this.activate() here would make the ui of the orbit tool active while having the bimwalk tool as the default tool.
                this.activeStatus = true;
                this._isDefault = true;
            }
            break;
        default:
            // Activate the default navigation tools (pan or orbit) if the bimwalk was the default tool before.
            if (this._isDefault) {
                this.viewer.activateDefaultNavigationTools(this.viewer.model.is2d());
            }
            // The BimWalk tool should not be the default
            this._isDefault = false;
            break;
    }
};

/**
 * Handler for the escape key.
 *
 * @private
 */
proto._onEscape = function() {
    // When selecting a different navigation tool (zoom, pan), the orbit tool will be set as the default.
    // When the user presses the escape key, we want to bring them back to the bimwalk tool.
    // The logic for checking if the bimwalk tool should be the default tool is done in the _setAsDefault function
    this._setAsDefault(this.viewer.prefs.get(avp.Prefs3D.DEFAULT_NAVIGATION_TOOL_3D));
};

proto._onFitToView = async function() {
    // When focusing on an element, fitToView is used, so the AGGREGATE_FIT_TO_VIEW_EVENT is fired.
    this.disableGravityUntilNextMove();
};

proto.disableGravityUntilNextMove = async function() {
    await Autodesk.Viewing.EventUtils.waitUntilTransitionEnded(this.viewer);
    const nav = this.tool ? .navigator;
    if (nav) {
        // We fake that the user is over floor so they don't fall after choosing to focus.
        // After making a walking movement this is rechecked, so if not actually over the floor they will fall.
        nav.userOverFloor = true;
    }
};

// Allow others to relocate the info button to avoid overlap with other widgets
proto.getInfoButton = function() {
    var nav = this.tool && this.tool.navigator;
    var ui = nav && nav.ui;
    return ui && ui.infoIcon;
};

/**
 * Jump to a specific floor.
 * 
 * @param {number} floorIndex - Index of the floor to jump to.
 */
proto.jumpToFloor = function(floorIndex) {
    this.tool.navigator.jumpToFloor(floorIndex);
};

Autodesk.Viewing.theExtensionManager.registerExtension('Autodesk.BimWalk', BimWalkExtension);