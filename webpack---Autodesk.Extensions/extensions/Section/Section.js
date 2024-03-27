import {
    SectionTool
} from './SectionTool';
import './Section.css';

const avp = Autodesk.Viewing.Private;
const AVU = Autodesk.Viewing.UI;
const analytics = avp.analytics;

/**
 * The SectionExtension provides ways to cut the geometry using planes or a cube.
 * The extension adds a toolbar button to access the feature.
 *
 * The extension id is: `Autodesk.Section`
 *
 * @param {Viewer3D} viewer - Viewer instance
 * @param {object} options - Configurations for the extension
 * @example 
 * viewer.loadExtension('Autodesk.Section')
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.SectionExtension
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @class
 */
export var SectionExtension = function(viewer, options) {
    Autodesk.Viewing.Extension.call(this, viewer, options);
    this.viewer = viewer;
    this.name = 'section';
    this.modes = ['x', 'y', 'z', 'box'];
    this.buttons = {};

    this.onViewerSetView = this.onViewerSetView.bind(this);
    this._onCutPlanesChanged = this._onCutPlanesChanged.bind(this);
    this._onShowAll = this._onShowAll.bind(this);
};

SectionExtension.prototype = Object.create(Autodesk.Viewing.Extension.prototype);
SectionExtension.prototype.constructor = SectionExtension;

var proto = SectionExtension.prototype;

/**
 * Registers the SectionTool, hotkeys and event handlers.
 *
 * @returns {boolean}
 */
proto.load = function() {
    var that = this;
    var viewer = this.viewer;

    this.tool = new SectionTool(viewer, {
        tintColor: {
            r: 1,
            g: 1,
            b: 0
        },
        tintIntensity: 0.2
    });

    viewer.toolController.registerTool(this.tool, this.setActive.bind(this));
    this.sectionStyle = null;
    this.supportedStyles = ["X", "Y", "Z", "BOX"];

    this.displaySectionHatches = this.displaySectionHatches.bind(this);

    this.viewer.prefs.addListeners(avp.Prefs3D.DISPLAY_SECTION_HATCHES, this.displaySectionHatches);

    viewer.addEventListener(Autodesk.Viewing.SET_VIEW_EVENT, this.onViewerSetView);

    // consider cutplane changes of other tools, so that cap meshes consider them too
    viewer.addEventListener(Autodesk.Viewing.CUTPLANES_CHANGE_EVENT, this._onCutPlanesChanged);
    viewer.addEventListener(Autodesk.Viewing.SHOW_ALL_EVENT, this._onShowAll);
    viewer.addEventListener(Autodesk.Viewing.RENDER_OPTION_CHANGED_EVENT, that.tool.notifyRenderOptionChanged);

    this.HOTKEYS_ID = "Autodesk.Section.Hotkeys";
    var hotkeys = [{
        keycodes: [
            Autodesk.Viewing.KeyCode.ESCAPE
        ],
        onRelease: function() {
            if (that.viewer.getAggregateSelection().length === 0)
                return that.deactivate();
        }
    }];
    viewer.getHotkeyManager().pushHotkeys(this.HOTKEYS_ID, hotkeys);

    // Invoked when the context menu is about to get opened.
    this.viewer.registerContextMenuCallback('Autodesk.Section', (menu, status) => {
        onContextMenu(this, menu, status);
    });

    //Load the required dependency (and return the pending load as the load completion Promise)
    return this.viewer.loadExtension('Autodesk.CompGeom');
};

/**
 * Unregisters the SectionTool, hotkeys and event handlers.
 *
 * @returns {boolean}
 */
proto.unload = function() {
    var viewer = this.viewer;

    viewer.unregisterContextMenuCallback('Autodesk.Section');

    // remove hotkey
    viewer.getHotkeyManager().popHotkeys(this.HOTKEYS_ID);

    this.destroyUI();

    viewer.removeEventListener(Autodesk.Viewing.SET_VIEW_EVENT, this.onViewerSetView);
    viewer.removeEventListener(Autodesk.Viewing.CUTPLANES_CHANGE_EVENT, this._onCutPlanesChanged);
    viewer.removeEventListener(Autodesk.Viewing.SHOW_ALL_EVENT, this._onShowAll);
    viewer.removeEventListener(Autodesk.Viewing.RENDER_OPTION_CHANGED_EVENT, this.tool.notifyRenderOptionChanged);

    this.viewer.prefs.removeListeners(avp.Prefs3D.DISPLAY_SECTION_HATCHES, this.displaySectionHatches);

    viewer.toolController.deregisterTool(this.tool);
    this.tool = null;

    return true;
};

/**
 * Toggles activeness of section planes.
 *
 * @returns {boolean} Whether the section plane is active or not.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#toggle
 */
proto.toggle = function() {
    if (this.isActive()) {
        this.enableSectionTool(false);
    } else {
        var style = this.sectionStyle || "X";
        this.setSectionStyle(style, true);
    }
    return this.isActive(); // Need to check for isActive() again.
};

/**
 * Returns the current type of plane that will cut-though the geometry.
 *
 * @returns {null | string} Either "X" or "Y" or "Z" or "BOX" or null.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#getSectionStyle
 */
proto.getSectionStyle = function() {
    return this.sectionStyle;
};

/**
 * Sets the Section plane style.
 *
 * @param {string} style - Accepted values are 'X', 'Y', 'Z' and 'BOX' (in Caps)
 * @param {boolean} [preserveSection] - Whether sending the current style value resets the cut planes.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#setSectionStyle
 */
proto.setSectionStyle = function(style, preserveSection) {

    if (this.supportedStyles.indexOf(style) === -1) {
        return false;
    }

    var bActive = this.isActive();
    var bNewStyle = (this.sectionStyle !== style) || !preserveSection;
    this.sectionStyle = style;

    if (bActive && bNewStyle) {
        this.tool.setSection(style);
    } else if (!bActive) {
        this.enableSectionTool(true);
        if (bNewStyle) {
            this.tool.setSection(style);
        } else {
            this.tool.attachControl(true);
        }
    }
    return true;
};

/**
 * Use to set the section from an externally defined plane. For showing with line pattern
 * Tool itself will be disabled when setting the plane
 *
 * @param {THREE.Vector4} cutplane - send null to clear the section
 */
proto.setSectionFromPlane = function(cutplane) {
    this.deactivate();

    if (cutplane) {
        this.tool.setSectionFromPlane(cutplane);
        this.tool.attachControl(false);
        // LMV-5299
        if (!this.isActive()) {
            this.tool.showPlane(false);
        }
    } else {
        this.tool.clearSection();
        var prevLock = this.viewer.toolController.setIsLocked(false);
        this.enableSectionTool(false);
        this.viewer.toolController.setIsLocked(prevLock);
    }
};

/**
 * Returns the planes belonging only to the Section tool's set*
 */
proto.getSectionPlanes = function() {
    return this.tool.getSectionPlanes();
};

/**
 *
 * @param enable
 * @param keepCutPlanes - keep existing cut planes when deactivating the tool.
 * @returns {boolean}
 * @private
 */
proto.enableSectionTool = function(enable, keepCutPlanes = false) {
    var toolController = this.viewer.toolController,
        isActive = this.tool.isActive();

    if (enable && !isActive) {
        toolController.activateTool("section");
        if (this.sectionToolButton) {
            this.sectionToolButton.setState(Autodesk.Viewing.UI.Button.State.ACTIVE);
        }
        return true;

    } else if (!enable && isActive) {
        const prevKeepCutPlanes = this.tool.keepCutPlanesOnDeactivate;
        this.tool.keepCutPlanesOnDeactivate = keepCutPlanes;
        toolController.deactivateTool("section");
        this.tool.keepCutPlanesOnDeactivate = prevKeepCutPlanes;

        if (this.sectionToolButton) {
            this.sectionToolButton.setState(Autodesk.Viewing.UI.Button.State.INACTIVE);
        }
        return true;
    } else if (enable) {
        toolController.activateToolModality("section");
    }
    return false;
};

/**
 * Returns an object that reperesents the state of the section planes
 * currently applied to the viewer by this extension.
 * 
 * @param {THREE.Vector3 | object} [ignoreGlobalOffset=false]
 * 
 * @returns {object | null}
 */
proto.getViewValues = function(ignoreGlobalOffset) {

    var boxValues = this.tool.getSectionBoxValues(ignoreGlobalOffset);
    if (boxValues)
        return boxValues;

    var planeValues = this.tool.getSectionPlaneValues(ignoreGlobalOffset);
    if (planeValues)
        return planeValues;

    return null;
};

/**
 * Gets the extension state as a plain object. Invoked automatically by viewer.getState()
 *
 * @param {object} viewerState - Object to inject extension values.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#getState
 */
proto.getState = function(viewerState) {
    const model = this.viewer.getFirstModel();
    if (!model || model.is2d()) {
        return;
    }

    viewerState.cutplanes = viewerState.cutplanes || [];
    var planes = this.tool.getSectionPlaneSet();
    for (var i = 0; i < planes.length; i++) {
        viewerState.cutplanes.push(planes[i].toArray());
    }
};

/**
 * Restores the extension state from a given object. Invoked automatically by viewer.restoreState()
 *
 * @param {object} viewerState - Viewer state.
 * @returns {boolean} True if restore operation was successful.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#restoreState
 */
proto.restoreState = function(viewerState) {
    // If viewerState doesn't contain cutplanes, we should leave it as is.
    if (!viewerState.cutplanes) {
        return;
    }
    const cutplanes = this.getSectionPlanes();
    this.setSectionFromPlane(null); // Unload any existing planes first
    if (cutplanes.length === 1) {
        this.setSectionFromPlane(cutplanes[0]);
    }

    return true;
};

/**
 * @private
 */
proto._onCutPlanesChanged = function( /*event*/ ) {
    this.tool.notifyCutplanesChanged();
};


/**
 * @private
 */
proto._onShowAll = function( /*event*/ ) {
    this.deactivate();
};

/**
 * Set a section box around the passed in THREE.Box3.
 * This method will also enable the section tool.
 *
 * @param {THREE.Box3} box - used to set the section box.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#setSectionBox
 */
proto.setSectionBox = function(box) {
    if (!box) return;
    this.enableSectionTool(true);
    if (this.tool.setSectionBox(box)) {
        this.activeStatus = true;
        this.viewer.clearSelection();

        // Update current mode and button state.
        this.mode = 'box';
        this.buttons[this.mode] ? .setState(AVU.Button.State.ACTIVE);
    } else {
        this.enableSectionTool(false);
    }
};

/**
 * Place a section plane on the Intersection.
 * This method will also enable the section tool.
 *
 * @param {THREE.Vector3} normal - plane normal.
 * @param {THREE.Vector3} point - position to place the plane.
 * @param enableRotationGizmo
 * @alias Autodesk.Viewing.Extensions.SectionExtension#setSectionPlane
 */
proto.setSectionPlane = function(normal, point, enableRotationGizmo) {
    if (!normal || !point) return;
    this.enableSectionTool(true);
    if (this.tool.setSectionPlane(normal, point, enableRotationGizmo)) {
        this.activeStatus = true;
        this.viewer.clearSelection();

        // Update current mode and button state.
        this.mode = this.calculateNearestAxis(normal);
        this.buttons[this.mode] ? .setState(AVU.Button.State.ACTIVE);
    } else {
        this.enableSectionTool(false);
    }
};

/**
 * Given a normal, return the x, y or z, according to the nearest world axis.
 * 
 * @param {THREE.Vector3} normal - plane normal.
 */
proto.calculateNearestAxis = function(normal) {
    // absolute values for direction cosines, bigger value equals closer to basis axis
    const xn = Math.abs(normal.x);
    const yn = Math.abs(normal.y);
    const zn = Math.abs(normal.z);

    if ((xn >= yn) && (xn >= zn)) {
        return 'x';
    } else if ((yn > xn) && (yn >= zn)) {
        return 'y';
    } else {
        return `z`;
    }
};

/**
 * @private
 */
proto.onViewerSetView = function( /*event*/ ) {
    this.deactivate();
};

/**
 * @param toolbar
 */
proto.onToolbarCreated = function(toolbar) {

    this.sectionToolButton = new AVU.ComboButton("toolbar-sectionTool");
    this.sectionToolButton.setToolTip('Section analysis');
    this.sectionToolButton.setIcon("adsk-icon-section-analysis");
    this.createSubmenu(this.sectionToolButton);

    // make sure inspect tools is visible
    var modelTools = toolbar.getControl(Autodesk.Viewing.TOOLBAR.MODELTOOLSID);

    // place section tool before reset tool
    if (modelTools) {
        var resetTool = modelTools.getControl("toolbar-resetTool");
        if (resetTool) {
            modelTools.addControl(this.sectionToolButton, {
                index: modelTools.indexOf(resetTool.getId())
            });
        } else {
            modelTools.addControl(this.sectionToolButton, {
                index: 0
            });
        }
    }
};

/**
 *
 * @param parentButton
 * @private
 */
proto.createSubmenu = function(parentButton) {
    var that = this;
    var viewer = this.viewer;

    /**
     * @param button
     * @param name
     * @private
     */
    function createNavToggler(button, name) {
        that.buttons[name] = button;

        return function() {
            var state = button.getState();
            var enable = function() {
                if (button instanceof AVU.ComboButton === false) {
                    that.activate(name);
                } else {
                    that.enableSectionTool(true);
                    that.tool.attachControl(true);
                }
            };

            const sectionType = name.toLowerCase().indexOf('box') !== -1 ? 'Box' : 'Plane';

            if (state === AVU.Button.State.INACTIVE) {
                button.setState(AVU.Button.State.ACTIVE);
                // Long initialization may cause issues on touch enabled devices, make it async
                if (Autodesk.Viewing.isMobileDevice()) {
                    setTimeout(enable, 1);
                } else {
                    enable();
                }
                analytics.track('viewer.section', {
                    from: 'Toolbar',
                    type: sectionType,
                    action: 'Enable',
                });
            } else if (state === AVU.Button.State.ACTIVE) {
                button.setState(AVU.Button.State.INACTIVE);
                that.deactivate();
                analytics.track('viewer.section', {
                    from: 'Toolbar',
                    type: sectionType,
                    action: 'Disable',
                });
            }
            that.sectionStyle = name.toUpperCase();
        };
    }

    /**
     *
     */
    function updateSectionButtons() {
        var areVectorsEqual = (function() {
            var v = new THREE.Vector3();
            return function(a, b, sqtol) {
                v.subVectors(a, b);
                return v.lengthSq() < sqtol;
            };
        })();

        var unitx = new THREE.Vector3(1, 0, 0);
        var unity = new THREE.Vector3(0, 1, 0);
        var unitz = new THREE.Vector3(0, 0, 1);
        var right = viewer.autocam.getWorldRightVector();
        var up = viewer.autocam.getWorldUpVector();
        var front = viewer.autocam.getWorldFrontVector();

        var tol = 0.0001;
        if (areVectorsEqual(up, unitx, tol)) {
            that.sectionYButton.setIcon("adsk-icon-plane-x");
        } else if (areVectorsEqual(up, unitz, tol)) {
            that.sectionYButton.setIcon("adsk-icon-plane-z");
        } else {
            that.sectionYButton.setIcon("adsk-icon-plane-y");
        }

        if (areVectorsEqual(right, unity, tol)) {
            that.sectionXButton.setIcon("adsk-icon-plane-y");
        } else if (areVectorsEqual(right, unitz, tol)) {
            that.sectionXButton.setIcon("adsk-icon-plane-z");
        } else {
            that.sectionXButton.setIcon("adsk-icon-plane-x");
        }

        if (areVectorsEqual(front, unitx, tol)) {
            that.sectionZButton.setIcon("adsk-icon-plane-x");
        } else if (areVectorsEqual(front, unity, tol)) {
            that.sectionZButton.setIcon("adsk-icon-plane-y");
        } else {
            that.sectionZButton.setIcon("adsk-icon-plane-z");
        }

    }

    var sectionXButton = this.sectionXButton = new AVU.Button("toolbar-sectionTool-x");
    sectionXButton.setToolTip('Add X plane');
    sectionXButton.setIcon("adsk-icon-plane-x");
    sectionXButton.onClick = createNavToggler(sectionXButton, 'x');
    parentButton.addControl(sectionXButton);

    var sectionYButton = this.sectionYButton = new AVU.Button("toolbar-sectionTool-y");
    sectionYButton.setToolTip('Add Y plane');
    sectionYButton.setIcon("adsk-icon-plane-y");
    sectionYButton.onClick = createNavToggler(sectionYButton, 'y');
    parentButton.addControl(sectionYButton);

    var sectionZButton = this.sectionZButton = new AVU.Button("toolbar-sectionTool-z");
    sectionZButton.setToolTip('Add Z plane');
    sectionZButton.setIcon("adsk-icon-plane-z");
    sectionZButton.onClick = createNavToggler(sectionZButton, 'z');
    parentButton.addControl(sectionZButton);

    var sectionBoxButton = this.sectionBoxButton = new AVU.Button("toolbar-sectionTool-box");
    sectionBoxButton.setToolTip('Add box');
    sectionBoxButton.setIcon("adsk-icon-box");
    sectionBoxButton.onClick = createNavToggler(sectionBoxButton, 'box');
    parentButton.addControl(sectionBoxButton);

    const model = viewer.getFirstModel();
    if (model ? .is3d()) {
        updateSectionButtons();
    } else {
        viewer.addEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, updateSectionButtons, {
            once: true
        });
    }
};

/**
 * @private
 */
proto.destroyUI = function() {

    if (this.sectionToolButton) {
        this.sectionToolButton.removeFromParent();
        this.sectionToolButton = null;

        this.buttons = {};
    }
};

/**
 * Activates a section plane for user to interact with.
 * It performs the same action as the UI button.
 * 
 * @param {string} mode - Accepted values are 'x', 'y', 'z' and 'box' (in lowercase)
 * @returns {boolean} - true if the activation was successful.
 * @alias Autodesk.Viewing.Extensions.SectionExtension#activate
 */
proto.activate = function(mode) {
    if (this.activeStatus && this.mode === mode) {
        return;
    }
    this.enableSectionTool(true);
    switch (mode) {
        default:
            case 'x':
            this.tool.setSection('X');
        this.mode = 'x';
        break;
        case 'y':
                this.tool.setSection('Y');
            this.mode = 'y';
            break;
        case 'z':
                this.tool.setSection('Z');
            this.mode = 'z';
            break;
        case 'box':
                this.tool.setSection('BOX');
            this.mode = 'box';
            break;
    }
    this.activeStatus = true;
    return true;
};

/**
 * Removes the section plane/box from the 3D canvas.
 * 
 * @param keepCutPlanes - keep existing cut planes when deactivating the tool. Default is false.
 *
 * @alias Autodesk.Viewing.Extensions.SectionExtension#deactivate
 * @returns {boolean} - returns true if deactivated, false otherwise.
 */
proto.deactivate = function(keepCutPlanes) {
    if (this.activeStatus) {
        this.tool.setActiveMode("");
        this.enableSectionTool(false, keepCutPlanes);
        this.activeStatus = false;
        return true;
    }
    return false;
};

/**
 * Turns display hatches on or off.
 * @param {boolean} value - if true all section planes will get the hatches applied, otherwise, the section planes will not have the hatches.
 */
proto.displaySectionHatches = function(value) {

    this.tool.setDisplaySectionHatches(value);

    if (this.activeStatus) {
        const planes = this.getSectionPlanes();
        this.tool.clearSection();
        // update the hatches for each existing plane
        planes.forEach((plane) => {
            this.tool.updateCapMeshes(new THREE.Plane().setComponents(plane.x, plane.y, plane.z, plane.w));
        });
    }
};


/**
 * Invoked when the context menu is about to be created.
 * Adds additional entries to the context menu.
 *
 * @param section
 * @param menu
 * @param status
 * @private
 */
function onContextMenu(section, menu, status) {

    if (!status.hasSelected)
        return;

    const viewer = section.viewer;

    const aggregateSelection = viewer.getAggregateSelection();

    // This case is relevant mostly for hypermodel viewing, when there are 2D planes living in a 3D scene.
    // In this case, it make no sense to allow "section-box" to a plane.
    if (aggregateSelection.length === 1 && aggregateSelection[0].model.is2d()) {
        return;
    }

    const bbox = viewer.impl.selector.getSelectionBounds();

    const menuEntry = {
        title: "Section",
        target: []
    };

    menuEntry.target.push({
        title: 'Section Box',
        target: () => {
            section.setSectionBox(bbox);
            analytics.track('viewer.section', {
                from: 'Contextual',
                type: 'Box',
                action: 'Enable',
            });
        }
    });

    const selected = aggregateSelection.map(selectionObject => selectionObject.selection).flat();
    const modelIds = aggregateSelection.map(selectionObject => selectionObject.model.id);
    const intersection = viewer.impl.hitTest(status.canvasX, status.canvasY, false, selected, modelIds);

    // Ensure that the selected object is the on that recieved the context click.
    if (intersection ? .face ? .normal && intersection.model && selected.indexOf(intersection.dbId) !== -1) {

        const worldMatrix = new THREE.Matrix4();
        intersection.model.getFragmentList() ? .getWorldMatrix(intersection.fragId, worldMatrix);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
        const normal = intersection.face.normal.clone().applyMatrix3(normalMatrix).normalize();

        menuEntry.target.push({
            title: 'Section Plane',
            target: () => {
                section.setSectionPlane(normal, intersection.point, false);
                analytics.track('viewer.section', {
                    from: 'Contextual',
                    type: 'Plane',
                    action: 'Enable',
                });
            }
        });
    }

    menu.push(menuEntry);
}


// Make the extension available
Autodesk.Viewing.theExtensionManager.registerExtension('Autodesk.Section', SectionExtension);