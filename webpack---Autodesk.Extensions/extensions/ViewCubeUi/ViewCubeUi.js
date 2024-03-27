'use strict';

import {
    ViewCube
} from './ViewCube';
import './ViewCubeUi.css';

const av = Autodesk.Viewing;
const avp = Autodesk.Viewing.Private;
const global = av.getGlobal();


/**
 * Create the UI for the view cube.
 * 
 * The extension id is: `Autodesk.ViewCubeUi`
 * 
 * @example
 *    viewer.loadExtension('Autodesk.ViewCubeUi');
 * 
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.ViewCubeUi
 * @class
 * @param {Autodesk.Viewing.Viewer3D} viewer - Viewer instance.
 * @param {object} options - Not used.
 */
export function ViewCubeUi(viewer, options) {
    av.Extension.call(this, viewer, options);
    // Keep the constructor LEAN
    // The actual initialization happens in create()
    this.container = null;
    this.cube = null; // Autocam.ViewCube
    this.viewcube = null;
    this.homeViewContainer = null;
    this._created = false;
    this._initTriadVisibility = false;
    this.refreshCube = this.refreshCube.bind(this);
    this.displayViewCube = this.displayViewCube.bind(this);
    this.setViewType = this.setViewType.bind(this);
    this._updateView = this._updateView.bind(this);
    this._onModelAdded = this._onModelAdded.bind(this);
}

ViewCubeUi.prototype = Object.create(Autodesk.Viewing.Extension.prototype);
ViewCubeUi.prototype.constructor = ViewCubeUi;

Object.assign(ViewCubeUi.prototype, {
    /**
     * @private
     */
    load: function() {
        this.create();

        this._displayViewCube(this.viewer.impl.is2d);

        this.localize();

        // Dispatch a view cube created event
        this.viewer.dispatchEvent({
            type: av.VIEW_CUBE_CREATED_EVENT
        });

        // Refresh the cube when resizing
        this.viewer.addEventListener(av.VIEWER_RESIZE_EVENT, this.refreshCube);

        // Register the displayViewCube function as the callback for the viewCube preference.
        this.viewer.prefs.addListeners(avp.Prefs3D.VIEW_CUBE, this.displayViewCube);

        // Change the view when the VIEW_TYPE preference is set.
        this.viewer.prefs.addListeners(avp.Prefs3D.VIEW_TYPE, this.setViewType);

        if (this.viewer.model) {
            // Add first model according to the current mode (2D or 3D)
            const models = this.viewer.getVisibleModels().filter(model => !!this.viewer.impl.is2d === model.is2d());
            this._onModelAdded({
                model: models[0]
            });
        }

        // Register an event handler to update the view cube (not just once for model unloading/loading use cases)
        this.viewer.addEventListener(av.MODEL_ADDED_EVENT, this._onModelAdded);

        // This needs to be called to ensure that the preference callback is called.
        // By the time the viewer.setProfile function is called in the viewer (which will set the preferences), this extension is not loaded.
        this._setDefaultView();

        return true;
    },

    /**
     * Destroy the view cube.
     *
     * @private
     */
    unload: function() {
        this.viewer.prefs.removeListeners(avp.Prefs3D.VIEW_CUBE, this.displayViewCube);
        this.viewer.prefs.removeListeners(avp.Prefs3D.VIEW_TYPE, this.setViewType);
        this.viewer.removeEventListener(av.VIEWER_RESIZE_EVENT, this.refreshCube);
        this.viewer.removeEventListener(av.MODEL_ADDED_EVENT, this._onModelAdded);

        if (this.container) {
            this.viewer.container.removeChild(this.container);
            this.viewcube = null;
        }

        if (this.cube) {
            this.cube.dtor();
            this.cube = null;
        }

        this.homeViewContainer = null;
        this.hideHomeViewMenu = null;
        this.viewer = null;
        return true;
    },

    /**
     * Initialize the view cube and the home button.
     * This method is called when the extension is loaded.
     */
    create: function() {
        if (this._created)
            return;
        this.initContainer();
        this.initHomeButton();
        this._created = true;
    },

    /**
     * @private
     */
    initContainer: function() {
        var _document = this.getDocument();
        this.container = _document.createElement('div');
        this.container.className = "viewcubeWrapper";
        this.viewer.container.appendChild(this.container);
    },

    /**
     * @private
     */
    initHomeButton: function() {
        if (this.homeViewContainer) {
            return;
        }

        var _document = this.getDocument();
        var homeViewContainer = _document.createElement('div');
        homeViewContainer.className = "homeViewWrapper";

        this.container.appendChild(homeViewContainer);
        this.homeViewContainer = homeViewContainer;

        var self = this;
        homeViewContainer.addEventListener("click", function() {
            self.viewer.navigation.setRequestHomeView(true);
        });
    },

    /**
     * Show or hide the view cube element. This also applies to the home button.
     *
     * @param {boolean} show - If set to false, the view cube and the home button will become invisible.
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#setVisible
     */
    setVisible: function(show) {
        this.container.style.display = show ? 'block' : 'none';
    },

    /**
     * Update the VIEW_TYPE preference's default value.
     *
     * @private
     */
    _setDefaultView: function() {
        if (this.viewer.impl.is2d) return;

        if (this.viewer.impl.getModelCamera(this.viewer.model)) {
            return;
        }

        this.viewer.prefs.dispatchEvent(avp.Prefs3D.VIEW_TYPE);
    },

    /**
     * Set the viewType for the VIEW_TYPE preference
     *
     * @param {number} viewType - view index. 
     * @private
     */
    _updateView: function(viewType) {
        if (this.viewer.impl.is2d) return;

        if (!this.viewer.prefs.set(avp.Prefs3D.VIEW_TYPE, viewType)) {
            // If the value was not changed, check with autocam as well, in case it was changed programmatically
            const autocamViewType = this.viewer.autocam.getViewType();
            if (viewType !== autocamViewType) {
                this.viewer.prefs.dispatchEvent(avp.Prefs3D.VIEW_TYPE);
            }
        }
    },

    /**
     * Set the viewCube view type. 
     *
     * @param {string} viewType - 1 for orthographic, 2 for perspective, 3 for orthoFaces
     */
    setViewType: function(viewType) {
        if (this.viewer.impl.is2d || !this.cube) return;
        this.cube.setViewType(viewType);
    },

    /**
     * Show the x,y,z axes of the view cube.
     *
     * @param {boolean} show - if set to true, the view cube axes will be shown.
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#showTriad
     */
    showTriad: function(show) {
        if (this.cube)
            this.cube.showTriad(show);
        else
            this._initTriadVisibility = show;
    },

    /**
     * Set the face of ViewCube and apply camera transformation according to it.
     *
     * @param {string} face - The face name of ViewCube. The name can contain multiple face names,
     * the format should be `"[front/back], [top/bottom], [left/right]"`.
     *
     * @example
     *    viewer.setViewCube('front top right');
     *    viewer.setViewCube('bottom left');
     *    viewer.setViewCube('back');
     * 
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#setViewCube
     */
    setViewCube: function(face) {
        if (this.cube) {
            this.cube.cubeRotateTo(face);
        }
    },

    /**
     * Hides the Home button next to the ViewCube.
     *
     * @param {boolean} show
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#displayHomeButton
     */
    displayHomeButton: function(show) { // show/hide home button.
        if (this.homeViewContainer)
            this.homeViewContainer.style.display = show ? '' : 'none';
    },

    /**
     * Display the view cube. This will not effect the home button.
     *
     * @param {boolean} display - if set to false the view cube element will be invisible
     * @param {boolean} updatePrefs - update the view cube preference
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#displayViewCube
     */
    displayViewCube: function(display, updatePrefs) {
        if (updatePrefs)
            this.viewer.prefs.set(avp.Prefs3D.VIEW_CUBE, display);

        if (display && !this.cube && !this.viewer.impl.is2d) {
            var _document = this.getDocument();
            this.viewcube = _document.createElement("div");
            this.viewcube.className = "viewcube";
            this.container.appendChild(this.viewcube);
            this.cube = new ViewCube("cube", this.viewer.autocam, this.viewcube, global.LOCALIZATION_REL_PATH);
            this.cube.registerOnViewTypeChangedCb(this._updateView);
            this.cube.setGlobalManager(this.globalManager);

            // Move sibling on top of the viewcube.
            this.container.appendChild(this.homeViewContainer);

            if (this._initTriadVisibility) {
                this.showTriad(true);
            }
            delete this._initTriadVisibility;
        } else if (!this.cube) {
            this._positionHomeButton();
            return; //view cube is not existent and we want it off? Just do nothing.
        }

        this.viewcube.style.display = (display ? "block" : "none");

        this._positionHomeButton();

        if (display) {
            this.viewer.autocam.refresh();
        }
    },

    /**
     * Localize the view cube
     *
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#localize
     */
    localize: function() {
        this.cube && this.cube.localize();
    },

    /**
     * @param {boolean} [show=true] show the compass
     */
    showCompass: function(show = true) {
        this.cube && this.cube.showCompass(show);
    },

    /**
     * 
     * @param {number} [radians=0] // Angle of north in radians wrt front
     */
    setCompassRotation: function(radians = 0) {
        this.cube && this.cube.setCompassRotation(radians);
    },

    /**
     * @param model
     * @private
     */
    _initCompass: function(model) {

        // calculate the north orientation angle
        const data = model && model.getData();
        const metadata = data && data.metadata;
        let projectNorthVector = metadata && metadata['world north vector'];
        projectNorthVector = projectNorthVector && projectNorthVector.XYZ;
        projectNorthVector = projectNorthVector && new THREE.Vector3(projectNorthVector[0], projectNorthVector[1], projectNorthVector[2]);

        // Skip initialization if the model doesn't have the north vector
        if (!projectNorthVector) {
            return;
        }

        // Calculate the N orientation

        //       Front Direction (usually same as project or world north)
        //             ^    
        //             | 
        //             |
        //  left <---- o  ----> Right
        //           /    
        //          /  
        //         /   
        //True North   

        const customValues = metadata && metadata['custom values'];

        // // If the model has a nwModelToWorldTransform, we can calculate the angle to 'true north'.
        // if (customValues && customValues.nwModelToWorldTransform) {
        //     const m = customValues.nwModelToWorldTransform;
        //     const right = new THREE.Vector3(m[0], m[1], m[2]);
        //     const angle = new THREE.Vector3(1, 0, 0).angleTo(right);
        //     customValues.angleToTrueNorth = 360.0 - angle *(180.0 / Math.PI);
        // }

        // frontDirection is the direction looking into the front face of the cube
        const frontDirection = this.viewer.autocam.sceneFrontDirection.clone();
        const upVector = this.viewer.autocam.sceneUpDirection.clone();
        let cross = new THREE.Vector3();
        cross.crossVectors(frontDirection, projectNorthVector);
        const projectNorthAngle = projectNorthVector.angleTo(frontDirection) * (cross.dot(upVector) < 0 ? -1 : 1);
        let trueNorthAngle = (customValues && customValues.angleToTrueNorth) || 0;
        trueNorthAngle = trueNorthAngle * (Math.PI / 180);

        // Project North + True North will give us the final angle to point the north
        // Do not rotate the compass in aggregated view which sets applyRefPoint
        const radians = data ? .loadOptions ? .applyRefPoint ? 0 : projectNorthAngle + trueNorthAngle;
        this.cube.initCompass();
        this.setCompassRotation(radians);

        // Only show compass if preference is set
        this.showCompass(!!this.viewer.prefs.get(avp.Prefs3D.VIEW_CUBE_COMPASS));
    },

    /**
     * @param is2d
     * @private
     */
    _displayViewCube: function(is2d) {
        // Do not display the ViewCube for 2d models
        const display = is2d ? false : this.viewer.prefs.get(avp.Prefs3D.VIEW_CUBE);
        this.displayViewCube(display);
    },

    /**
     * @param event
     * @private
     */
    _onModelAdded: function(event) {
        // As soon as we enter 2D mode, hide the viewcube
        this._displayViewCube(this.viewer.impl.is2d);

        if (this.cube && !this.cube.hasCompass && !this.viewer.impl.is2d) {
            this._initCompass(event.model);
        }
    },

    /**
     * @private
     */
    _positionHomeButton: function() {
        if (this.homeViewContainer) {
            var viewCubeVisible = this.cube && this.viewcube && (this.viewcube.style.display === 'block');
            if (viewCubeVisible) {
                this.homeViewContainer.classList.remove('no-viewcube');
            } else {
                this.homeViewContainer.classList.add('no-viewcube');
            }
        }
    },

    /**
     * Refresh the view cube
     *
     * @alias Autodesk.Viewing.Extensions.ViewCubeUi#refreshCube
     */
    refreshCube: function() {
        this.cube && this.cube.refreshCube();
    },
});


/**
 * Register the extension with the extension manager.
 */
av.theExtensionManager.registerExtension('Autodesk.ViewCubeUi', ViewCubeUi);