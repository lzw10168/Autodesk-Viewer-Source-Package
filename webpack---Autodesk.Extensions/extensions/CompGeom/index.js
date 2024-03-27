var av = Autodesk.Viewing;
var avecg = AutodeskNamespace('Autodesk.Viewing.Extensions.CompGeom');

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

_export(require("./contour-set"), avecg);
_export(require("./edge-set"), avecg);
_export(require("./dcel"), avecg);
_export(require("./fuzzy-math"), avecg);
_export(require("./quad-tree"), avecg);
_export(require("./x-box-box"), avecg);
_export(require("./x-box-plane"), avecg);
_export(require("./x-line-box"), avecg);
_export(require("./x-line-line"), avecg);
_export(require("./x-mesh-plane"), avecg);
_export(require("./x-plane-segment"), avecg);
_export(require("./x-triangle-plane"), avecg);
_export(require("./interval-tree"), avecg);
_export(require("./complex-polygon"), avecg);
_export(require("./point-list"), avecg);
_export(require("./ThirdParty/lmv_poly2tri"), avecg);
_export(require("./ellipse"), avecg);
_export(require("./bezier"), avecg);
_export(require("./LmvCanvasContext"), avecg);
_export(require("./path2d"), avecg);

/**
 * Computational geometry library extension
 */
class CompGeomExtension extends av.Extension {

    constructor(viewer, options) {
        super(viewer, options);
    }

    load() {
        return true;
    }
    unload() {
        return true;
    }
    activate() {
        return true;
    }
    deactivate() {
        return false;
    }
}

// The ExtensionManager requires an extension to be registered.
av.theExtensionManager.registerExtension('Autodesk.CompGeom', CompGeomExtension);