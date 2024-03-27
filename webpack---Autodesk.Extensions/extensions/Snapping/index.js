var av = Autodesk.Viewing;

/**
 * @namespace Autodesk.Viewing.Extensions.Snapping
 */
var namespace = AutodeskNamespace('Autodesk.Viewing.Extensions.Snapping');

/**
 * @param m
 * @param ns
 * @private
 */
function _export(m, ns) {
    for (var prop in m) {
        if (Object.prototype.hasOwnProperty.call(m, prop)) {
            //Export directly into the module (e.g. for node.js use, where LMV is used via require instead from global namespace)
            module.exports[prop] = m[prop];

            //Export into the desired viewer namespace
            ns[prop] = m[prop];
        }
    }
}

_export(require("./SnapMath.js"), namespace);
_export(require("./Snapper.js"), namespace);
_export(require("./SnapperIndicator.js"), namespace);


/**
 * Utility extension that provides access to the {@link Autodesk.Viewing.Extensions.Snapping.Snapper} tool.
 * 
 * The extension id is: `Autodesk.Snapping`
 * 
 * @example
 *   viewer.loadExtension('Autodesk.Snapping')
 *  
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.SnappingExtension
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @class
 */
class SnappingExtension extends av.Extension {

    /**
     * @param {Viewer3D} viewer - Viewer instance
     * @param {object} options - Configurations for the extension
     * @alias Autodesk.Viewing.Extensions.SnappingExtension
     * @class
     */
    constructor(viewer, options) {
        super(viewer, options);
    }

    /**
     * Load the extension.
     *
     * @returns {Promise} that resolves when dependent extension finishes loading.
     * 
     * @alias Autodesk.Viewing.Extensions.SnappingExtension#load
     */
    load() {
        // Load the required dependency (and return the pending load as the load completion Promise)
        return this.viewer.loadExtension('Autodesk.CompGeom');
    }

    /**
     * Unloads the extension.
     * It does not unload dependent extensions.
     *
     * @returns {boolean} Always returns true
     * 
     * @alias Autodesk.Viewing.Extensions.SnappingExtension#unload
     */
    unload() {
        return true;
    }


    /**
     * Unused method.
     *
     * @returns {boolean} Always returns true
     * 
     * @alias Autodesk.Viewing.Extensions.SnappingExtension#activate
     */
    activate() {
        return true;
    }

    /**
     * Unused method.
     *
     * @returns {boolean} Always returns false
     * 
     * @alias Autodesk.Viewing.Extensions.SnappingExtension#deactivate
     */
    deactivate() {
        return false;
    }
}

// The ExtensionManager requires an extension to be registered.
av.theExtensionManager.registerExtension('Autodesk.Snapping', SnappingExtension);