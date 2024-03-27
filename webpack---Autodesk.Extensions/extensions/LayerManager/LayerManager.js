import {
    ViewerLayersPanel
} from "./ui/ViewerLayersPanel";

const av = Autodesk.Viewing;
const avu = Autodesk.Viewing.UI;
const avp = Autodesk.Viewing.Private;

/**
 * Use its `activate()` method to open the LayersPanel UI.
 * Layers are usually present in 2D models, but some 3D models may support
 * layers as well, for example: AutoCAD.
 *
 * The extension id is: `Autodesk.LayerManager`
 *
 * @param {Viewer3D} viewer - Viewer instance
 * @param {object} options - Configurations for the extension
 * @example 
 * viewer.loadExtension('Autodesk.LayerManager')
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.LayerManagerExtension
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @class
 */
export function LayerManagerExtension(viewer, options = {}) {
    av.Extension.call(this, viewer, options);
    this.viewer = viewer;
    this.options = options;
    this.name = "layermanager";

    // event callbacks
    this.onModelLayersInit = this.onModelLayersInit.bind(this);
    this.onModelAdded = this.onModelAdded.bind(this);

    // ui
    this.layersPanel = null;
}
LayerManagerExtension.prototype = Object.create(av.Extension.prototype);
LayerManagerExtension.prototype.constructor = LayerManagerExtension;

const proto = LayerManagerExtension.prototype;

/**
 * Invoked by the Viewer when when loading the extension.
 *
 * @returns {boolean} true if the extension is loaded successfully.
 */
proto.load = function() {
    this.viewer.addEventListener(av.MODEL_ADDED_EVENT, this.onModelAdded);
    if (this.viewer.model) {
        this.onModelAdded({
            model: this.viewer.model
        });
    }

    return true;
};

/**
 * Invoked by the Viewer when when unloading the extension.
 */
proto.unload = function() {
    this.destroyUI();

    this.viewer.removeEventListener(av.MODEL_LAYERS_LOADED_EVENT, this.onModelLayersInit);
    this.viewer.removeEventListener(av.MODEL_ADDED_EVENT, this.onModelAdded);

    return true;
};

proto.addToolbarButton = function() {
    if (this.viewer.settingsTools.layerButton) {
        if (this.layersPanel) {
            const isVisible = this.viewer.settingsTools.layerButton.getState() === avu.Button.State.ACTIVE;
            this.layersPanel.setVisible(isVisible);
        }
        return;
    }

    const layerButton = new avu.Button('toolbar-layers-tool');
    layerButton.setToolTip('Layer Manager');
    layerButton.setIcon("adsk-icon-layers");
    layerButton.onClick = () => {
        // Toggle
        this.layersPanel.setVisible(!this.layersPanel.isVisible());
        avp.analytics.track('viewer.layers', {
            from: 'Panel',
            action: 'View List',
        });
    };

    let index = this.viewer.settingsTools.indexOf('toolbar-modelStructureTool');
    index = index !== -1 ? index : 0;

    this.viewer.settingsTools.addControl(layerButton, {
        index: index + 1
    });
    this.viewer.settingsTools.layerButton = layerButton;

};

proto.createUI = function() {
    this.setLayersPanel(new ViewerLayersPanel(this.viewer));
    this.addToolbarButton();
};

proto.removeLayersPanel = function() {
    if (this.layersPanel) {
        this.viewer.removePanel(this.layersPanel);

        this.layersPanel.uninitialize();
        this.layersPanel = null;
    }
};

proto.removeToolbarButton = function() {
    if (this.viewer.settingsTools && this.viewer.settingsTools.layerButton) {
        this.viewer.settingsTools.removeControl(this.viewer.settingsTools.layerButton.getId());
        this.viewer.settingsTools.layerButton = null;
    }
};

proto.destroyUI = function() {
    this.removeLayersPanel();
    this.removeToolbarButton();
};

/**
 * Callback function MODEL_ADDED_EVENT
 *
 * @param evt
 * @private
 */
proto.onModelAdded = function(evt) {
    // 2D models are already added through addModel in Viewer3DImpl. Only 3D is deferred to this extension
    // See addModel in ModelLayers.js
    if (evt.model.is3d()) {
        const layers = this.viewer.impl.layers;
        layers && layers.addModel(evt.model);
    }
};

/**
 * @private
 */
proto.onToolbarCreated = function() {
    if (!this.viewer.hasEventListener(av.MODEL_LAYERS_LOADED_EVENT, this.onModelLayersInit)) {
        this.viewer.addEventListener(av.MODEL_LAYERS_LOADED_EVENT, this.onModelLayersInit);
    }
    if (this.viewer.impl.layers && this.viewer.impl.layers.initialized) {
        this.onModelLayersInit();
    }
};

/**
 * Set the layerspanel and initialize it
 *
 * @param {object} layersPanel Instance of ViewerLayersPanel
 * @private
 */
proto.setLayersPanel = function(layersPanel) {
    this.layersPanel = layersPanel;
    this.viewer.addPanel(layersPanel);
    layersPanel.addVisibilityListener(visible => {
        if (visible) {
            this.viewer.onPanelVisible(layersPanel, this.viewer);
        }
        this.viewer.settingsTools.layerButton.setState(
            visible ? avu.Button.State.ACTIVE : avu.Button.State.INACTIVE
        );
    });
};

/**
 * Initialize model layers panel
 *
 * @private
 */
proto.onModelLayersInit = function() {
    // Disable UI in case of external UI used, such as Alloy component
    if (this.options.disableLayersUi) {
        return;
    }
    var layersRoot = this.viewer.impl.layers.getRoot();
    if (layersRoot && layersRoot.childCount > 0) {
        this.removeLayersPanel();
        this.createUI();
    } else {
        this.destroyUI();
    }
};

/**
 * Opens the Layers Panel UI.
 * 
 * @memberof Autodesk.Viewing.Extensions.LayerManagerExtension
 * @alias Autodesk.Viewing.Extensions.LayerManagerExtension#activate
 */
proto.activate = function() {
    if (this.layersPanel) {
        this.layersPanel.setVisible(true);
        return true;
    }

    return false;
};

/**
 * Closes the Layers Panel UI.
 * 
 * @memberof Autodesk.Viewing.Extensions.LayerManagerExtension
 * @alias Autodesk.Viewing.Extensions.LayerManagerExtension#deactivate
 */
proto.deactivate = function() {
    if (this.layersPanel) {
        this.layersPanel.setVisible(false);
    }
    return true;
};

/**
 * Checks whether the Layers Panel UI is opened.
 * 
 * @returns {boolean} true if the Layers Panel UI is currently opened.
 * 
 * @memberof Autodesk.Viewing.Extensions.LayerManagerExtension
 * @alias Autodesk.Viewing.Extensions.LayerManagerExtension#isActive
 */
proto.isActive = function() {
    return !!this.layersPanel && this.layersPanel.isVisible();
};

av.theExtensionManager.registerExtension('Autodesk.LayerManager', LayerManagerExtension);