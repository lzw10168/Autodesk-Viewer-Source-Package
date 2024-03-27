import {
    EventDispatcher
} from "./EventDispatcher";
import {
    pathToURL
} from "../file-loaders/net/Xhr";
import {
    isMobileDevice
} from "../compat";

import {
    LmvMatrix4
} from "../wgs/scene/LmvMatrix4";
import {
    FragmentPointer
} from "../wgs/scene/FragmentList";
import {
    RenderModel
} from "../wgs/scene/RenderModel";
import {
    ModelIteratorLinear
} from '../wgs/scene/ModelIteratorLinear';

import {
    UnifiedCamera
} from "../tools/UnifiedCamera";
import {
    getUnitData,
    fixUnitString,
    convertUnits,
    ModelUnits
} from "../measurement/UnitFormatter";
import {
    PropertySet
} from "./PropertySet";
import crc32 from 'crc/crc32';

/**
 * Core class representing the geometry.
 *
 * @memberof Autodesk.Viewing
 * @alias Autodesk.Viewing.Model
 */
export class Model extends RenderModel {
    myData;
    topology = null;
    topologyPromise = null;
    svfUUID = null;
    defaultCameraHash = null;

    loader = undefined;

    constructor(modelData) {
        super(modelData);
        this.myData = modelData;
        EventDispatcher.prototype.apply(this);

        const modelFormat = {};
        modelFormat.isSVF2 = this.isSVF2();
        modelFormat.isOTG = this.isOTG();
        modelFormat.is2d = this.is2d();
        super.setModelFormat(modelFormat);
    }

    initialize() {
        super.initialize();

        const modelIteratorLinear = new ModelIteratorLinear(this);
        this.addTraversalController("Linear", modelIteratorLinear);
    }

    /**
     * @returns {InstanceTree} Instance tree of the model if available, otherwise null.
     * @alias Autodesk.Viewing.Model#getInstanceTree
     */
    getInstanceTree() {
        if (this.myData)
            return this.myData.instanceTree;
        return null;
    }

    /**
     * Computes Bounding box of all fragments, but excluding outliers.
     *
     * @param {Object} [options]
     * @param {float}  [options.quantil=0.75] - in [0,1]. Relative amount of fragments that we consider computation.
     *     By default, we consider the 75% of fragments that are closest to the center.
     * @param {float} [options.center] - Center from which we collect the closest shapes. By default, we use the center of mass.
     * @param {boolean} [options.ignoreTransforms] - Ignore modelMatrix and animation transforms
     * @param {Array<number>} [options.allowlist] - Fragments to include in fuzzybox, by index.
     *
     * @returns {THREE.Box3}
     * @alias Autodesk.Viewing.Model#getFuzzyBox
     */
    getFuzzyBox(options = {}) {

        var ignoreTransforms = Boolean(options.ignoreTransforms);
        var frags = this.getFragmentList();

        // For 2D models, just return regular bounding box.
        // Verify frags exist - there are formats without fragments, like Leaflet.
        if (!frags || this.is2d()) {
            return this.getBoundingBox(ignoreTransforms);
        }

        // Decide which function to use to obtain fragBoxes
        var getFragBounds = null;
        if (ignoreTransforms) {
            // get original fragment bbox without transforms
            var tmpArray = new Array(6);

            const pt = this.getData().placementWithOffset;
            const invPt = pt ? pt.clone().invert() : undefined;

            getFragBounds = function(fragId, dstBox) {
                frags.getOriginalWorldBounds(fragId, tmpArray);
                dstBox.min.fromArray(tmpArray);
                dstBox.max.fromArray(tmpArray, 3);

                if (invPt) {
                    dstBox.applyMatrix4(invPt);
                }
            };
        } else {
            // get bounds including model or fragment animation transforms
            getFragBounds = function(fragId, dstBox) {
                frags.getWorldBounds(fragId, dstBox);
            };
        }

        function centerOfMass() {
            var box = new THREE.Box3();
            var center = new THREE.Vector3();
            var size = new THREE.Vector3();
            var total = new THREE.Vector3();
            var mass = 0;

            function processOneFragment(f) {
                if (options.allowlist && !options.allowlist.includes(f)) {
                    return;
                }

                // get bbox center
                getFragBounds(f, box);
                box.getCenter(center);

                // sum centers weighted by bbox size
                var weight = box.getSize(size).length();
                total.add(center.multiplyScalar(weight));

                mass += weight;
            }

            for (var i = 0; i < frags.getCount(); i++) {
                processOneFragment(i);
            }

            total.multiplyScalar(1 / mass);
            return total;
        }

        var center = options.center || centerOfMass();
        var quantil = options.quantil || 0.75;
        var fragBox = new THREE.Box3();

        // Compute distances of each frag bbox from center
        var fragInfos = [];
        const tmpCenter = new THREE.Vector3();
        for (let i = 0; i < frags.getCount(); i++) {
            if (options.allowlist && !options.allowlist.includes(i)) {
                continue;
            }

            // Skip any empty boxes
            getFragBounds(i, fragBox);
            if (fragBox.isEmpty()) {
                continue;
            }

            // get fragBox->center distance
            var dist = fragBox.distanceToPoint(center);

            // If fragBox contains the center, use fragBox center.
            if (dist === 0) {
                dist = center.distanceTo(fragBox.getCenter(tmpCenter));
            }

            fragInfos.push({
                fragId: i,
                distance: dist
            });
        }

        // sort by increasing order
        fragInfos.sort(function(a, b) {
            return a.distance - b.distance;
        });

        // union of all fragBoxes, excluding the ones with largest distance to center
        var box = new THREE.Box3();
        for (let i = 0; i < fragInfos.length * quantil; i++) {
            var fi = fragInfos[i];
            getFragBounds(fi.fragId, fragBox);
            box.union(fragBox);
        }
        return box;
    }

    /**
     * @param {boolean}[ignoreTransform]  - Set to true to return the original bounding box in model space coordinates.
     * @param {boolean}[excludeShadow]    - Remove shadow geometry (if exists) from model bounds.
     * @returns {THREE.Box3} Bounding box of the model if available, otherwise null.
     * @alias Autodesk.Viewing.Private.Model#getBoundingBox*
     */
    getBoundingBox(ignoreTransform, excludeShadow) {
        super.updateModelBBoxOriginal(this.getData().modelSpaceBBox);

        return super.getModelBounds(ignoreTransform, excludeShadow);
    }

    /**
     * @returns {boolean} Whether the model is 2D.
     * @alias Autodesk.Viewing.Model#is2d
     */
    is2d() {
        return !!(this.myData && this.myData.is2d);
    }

    /**
     * @returns {boolean} Whether the model is 3D.
     * @alias Autodesk.Viewing.Model#is3d
     */
    is3d() {
        return !this.is2d();
    }

    /**
     * @private
     * @returns {boolean} True if the model is an OTG file - which supports sharing of materials and geometry.
     */
    isOTG() {
        return (this.myData && !!this.myData.isOTG);
    }

    /**
     * @returns {boolean} True if the model is an SVF2 file - which supports sharing of materials and geometry.
     * @alias Autodesk.Viewing.Model#isSVF2
     */
    isSVF2() {
        const node = this.getDocumentNode();
        return node ? node.isSVF2() : false;
    }

    /**
     * @param {boolean} onlyPdfSource - Set to true in order to verify that the source file of the model is PDF.
     *                                   Some design files can get extracted to PDFs for example, and in that case,
     *                                   when using the flag, we'll get false as a result.
     *
     * @returns {boolean} True if the model is created from a PDF file.
     * @alias Autodesk.Viewing.Model#isPdf
     */
    isPdf(onlyPdfSource) {
        return !!(
            this.myData &&
            this.myData.isPdf &&
            (!onlyPdfSource || !this.isSmartPdf())
        );
    }

    /**
     * @returns {boolean} True if the model is a PDF that was created from a Revit source file.
     * @alias Autodesk.Viewing.Model#isRevitPdf
     */
    isRevitPdf() {
        return !!this.getDocumentNode() ? .isRevitPdf();
    }

    /**
     * @returns {boolean} True if the model is a Smart PDF that was created by our translation pipeline.
     * @alias Autodesk.Viewing.Model#isSmartPdf
     */
    isSmartPdf() {
        return !!this.getDocumentNode() ? .isSmartPdf();
    }

    /**
     * @returns {boolean} True if the model is created from an image file.
     *
     * @alias Autodesk.Viewing.Model#isLeaflet
     */
    isLeaflet() {
        return !!(this.myData && this.myData.isLeaflet);
    }

    /**
     * By default, Leaflet documents are being loaded in a normalized coordinate system. Only when
     * using `fitPaperSize` load option, the model will be loaded in page coordinates, like every other 2D model.
     * @returns {boolean} True if the model is loaded in page coordinates.
     *
     * @alias Autodesk.Viewing.Model#isPageCoordinates
     */
    isPageCoordinates() {
        return this.is2d() && (!this.isLeaflet() || this.loader ? .isPageCoordinates());
    }

    /**
     * @returns {boolean} True if the model is created using Autodesk.Viewing.SceneBuilder extension
     *
     * @alias Autodesk.Viewing.Model#isSceneBuilder
     */
    isSceneBuilder() {
        return !!(this.myData && this.myData.isSceneBuilder);
    }

    /**
     * Returns the geometry data.
     * @returns {Object} Data that represents the geometry.
     *
     * @alias Autodesk.Viewing.Model#getData
     */
    getData() {
        return this.myData;
    }

    /**
     * Set a UUID to identify the SVF model
     * @param {string} urn - Data that represents the geometry.
     */
    setUUID(urn) {
        this.svfUUID = btoa(encodeURI(pathToURL(urn)));
    }

    /**
     * Returns an object wrapping the bubble/manifest entry for the
     * loaded geometry. Contains data such as the viewableID, guid, role...
     * @returns {?Autodesk.Viewing.BubbleNode}
     *
     * @alias Autodesk.Viewing.Model#getDocumentNode
     */
    getDocumentNode() {
        return this.getData() ? .loadOptions ? .bubbleNode ? ? null;
    }

    /**
     * Returns the root of the geometry node graph.
     * @returns {object} The root of the geometry node graph. Null if it doesn't exist.
     *
     * @alias Autodesk.Viewing.Model#getRoot
     */
    getRoot() {
        var data = this.getData();
        if (data && data.instanceTree)
            return data.instanceTree.root;
        return null;
    }

    /**
     * Returns the root of the geometry node graph.
     * @returns {number} The ID of the root or null if it doesn't exist.
     *
     * @alias Autodesk.Viewing.Model#getRootId
     */
    getRootId() {
        var data = this.getData();
        return (data && data.instanceTree && data.instanceTree.getRootId()) || 0;
    }

    /**
     * Returns an object that contains the standard unit string (unitString) and the scale value (unitScale).
     * @param {string} unit - Unit name from the metadata
     * @returns {object} This object contains the standardized unit string (unitString) and a unit scaling value (unitScale)
     *
     * @alias Autodesk.Viewing.Model#getUnitData
     */
    getUnitData(unit) {
        console.warn("Model.getUnitData is deprecated and will be removed in a future release, use Autodesk.Viewing.Private.getUnitData() instead.");
        return getUnitData(unit);
    }

    /**
     * Returns the scale factor of model's distance unit to meters.
     * @returns {number} The scale factor of the model's distance unit to meters or unity if the units aren't known.
     *
     * @alias Autodesk.Viewing.Model#getUnitScale
     */
    getUnitScale() {
        return convertUnits(this.getUnitString(), ModelUnits.METER, 1, 1);
    }

    /**
     * Returns a standard string representation of the model's distance unit.
     * @returns {string} Standard representation of model's unit distance or null if it is not known.
     *
     * @alias Autodesk.Viewing.Model#getUnitString
     */
    getUnitString() {
        var unit;

        if (!this.is2d()) {
            // Check if there's an overridden model units in bubble.json (this happens in Revit 3D files)
            var data = this.getData();
            if (data && data.overriddenUnits) {
                // explicit override trumps all
                unit = data.overriddenUnits;
            } else if (data && data.scalingUnit) {
                unit = data.scalingUnit; // only using if scaling was actually applied
            } else {
                unit = this.getMetadata('distance unit', 'value', null);
            }
        } else {
            // Model units will be used for calculating the initial distance.
            unit = this.getMetadata('page_dimensions', 'model_units', null) || this.getMetadata('page_dimensions', 'page_units', null);
        }

        return fixUnitString(unit);
    }

    /**
     * Returns a standard string representation of the model's display unit.
     * @returns {string} Standard representation of model's display unit or null if it is not known.
     *
     * @alias Autodesk.Viewing.Model#getDisplayUnit
     */
    getDisplayUnit() {
        var unit;

        if (!this.is2d()) {
            var data = this.getData();
            if (data && data.scalingUnit) {
                unit = data.scalingUnit; // only using if scaling was actually applied
            } else {
                unit = this.getMetadata('default display unit', 'value', null) || this.getMetadata('distance unit', 'value', null);
            }
        } else {

            // When model units is not set, it should be assumed to be the same as paper units.
            unit = this.getMetadata('page_dimensions', 'model_units', null) || this.getMetadata('page_dimensions', 'page_units', null);
        }

        return fixUnitString(unit);
    }

    /**
     * Returns source file's units.
     * @returns {string} Source file's units.
     */
    getSourceFileUnits() {
        const node = this.getDocumentNode();
        return node ? .getSourceFileUnits();
    }

    /**
     * Return metadata value.
     * @param {string} itemName - Metadata item name.
     * @param {string} [subitemName] - Metadata subitem name.
     * @param {*} [defaultValue] - Default value.
     * @returns {*} Metadata value, or defaultValue if no metadata or metadata item/subitem does not exist.
     * @alias Autodesk.Viewing.Model#getMetadata
     */
    getMetadata(itemName, subitemName, defaultValue) {
        var data = this.getData();
        if (data) {
            var metadata = data.metadata;
            if (metadata) {
                var item = metadata[itemName];
                if (item !== undefined) {
                    if (subitemName) {
                        var subitem = item[subitemName];
                        if (subitem !== undefined) {
                            return subitem;
                        }
                    } else {
                        return item;
                    }
                }
            }
        }
        return defaultValue;
    }

    /**
     * Returns the default camera.
     *
     * @alias Autodesk.Viewing.Model#getDefaultCamera
     */
    getDefaultCamera() {
        var myData = this.getData();
        if (!myData) {
            return null;
        }

        var defaultCamera = null;
        var numCameras = myData.cameras ? myData.cameras.length : 0;
        if (0 < numCameras) {
            // Choose a camera.
            // Use the default camera if specified by metadata.
            //
            var defaultCameraIndex = this.getMetadata('default camera', 'index', null);
            if (defaultCameraIndex !== null && myData.cameras[defaultCameraIndex]) {
                defaultCamera = myData.cameras[defaultCameraIndex];

            } else {

                // No default camera. Choose a perspective camera, if any.
                //
                for (var i = 0; i < numCameras; i++) {
                    var camera = myData.cameras[i];
                    if (camera.isPerspective) {
                        defaultCamera = camera;
                        break;
                    }
                }

                // No perspective cameras, either. Choose the first camera.
                //
                if (!defaultCamera) {
                    defaultCamera = myData.cameras[0];
                }
            }
        }

        // Consider model matrix if specified
        var matrix = this.getModelTransform();
        if (defaultCamera && matrix) {

            // Create or reuse copy of the default camera
            const transformedDefaultCamera = UnifiedCamera.copyViewParams(defaultCamera);

            // Apply matrix to camera params
            UnifiedCamera.transformViewParams(transformedDefaultCamera, matrix);

            // Apply some traditional auto-repair magic if necessary.
            //
            // Note: Actually, this is already done by Viewer3DImpl.setViewFromCamera. However,
            //       this only fixes the viewer main camera, but later calls to getDefaultCamera
            //       would still get the unfixed one. In the past, this problem was just hidden,
            //       because this function returned a pointer to the internal camera which was
            //       then modified from outside.
            UnifiedCamera.adjustOrthoCamera(transformedDefaultCamera, this.getBoundingBox());

            return transformedDefaultCamera;
        }

        return defaultCamera;
    }

    /**
     * @returns {boolean} True when the "AEC" loader settings were used when loading the model
     *
     * @alias Autodesk.Viewing.Model#isAEC
     */
    isAEC() {
        return !!this.getData().loadOptions.isAEC;
    }

    /**
     * @returns {boolean} True when a 2D model has a page shadow
     *
     * @alias Autodesk.Viewing.Model#hasPageShadow
     */
    hasPageShadow() {
        return this.getData().hasPageShadow;
    }

    /**
     * Returns up vector as an array of 3.
     *
     * @alias Autodesk.Viewing.Model#getUpVector
     */
    getUpVector() {
        return this.getMetadata('world up vector', 'XYZ', null);
    }

    /**
     * Returns north vector as an array of 3.
     *
     * @alias Autodesk.Viewing.Model#getNorthVector
     */
    getNorthVector() {
        return this.getMetadata('world north vector', 'XYZ', null);
    }

    /**
     * Returns front vector as an array of 3.
     *
     * @alias Autodesk.Viewing.Model#getFrontVector
     */
    getFrontVector() {
        return this.getMetadata('world front vector', 'XYZ', null);
    }

    /**
     * Returns the polygon count.
     * @returns {number}
     *
     * @alias Autodesk.Viewing.Model#geomPolyCount
     */
    geomPolyCount() {
        var geomList = this.getGeometryList();
        if (!geomList) {
            return null;
        }

        return geomList.geomPolyCount;
    }

    /**
     * Returns the instanced polygon count.
     * @returns {number}
     *
     * @alias Autodesk.Viewing.Model#instancePolyCount
     */
    instancePolyCount() {
        var geomList = this.getGeometryList();
        if (!geomList) {
            return null;
        }

        return geomList.instancePolyCount;
    }

    /**
     * Returns true if the model with all its geometries has loaded.
     *
     * @param {boolean} [checkTextures] - Ensures that the model's textures were completely loaded.
     *
     * @returns {boolean}
     *
     * @alias Autodesk.Viewing.Model#isLoadDone
     */
    isLoadDone(checkTextures) {
        const data = this.getData();

        // Specifically verify texLoadDone is not `false` - since undefined means that textures are not relevant for the loader type.
        const texturesDone = !checkTextures || data.texLoadDone !== false;
        return !!(data && data.loadDone && texturesDone);
    }

    /**
     * @returns {boolean} True if the frag to node id mapping is done.
     *
     * @alias Autodesk.Viewing.Model#isObjectTreeCreated
     */
    isObjectTreeCreated() {
        return !!(this.getData().instanceTree);
    }

    /**
     * Returns an instance of {@link PropDbLoader|PropertyDatabase Loader},
     * responsible for communicating with the PropertyDatabase instance hosted in a browser worker thread.
     * @returns {PropDbLoader}
     *
     * @alias Autodesk.Viewing.Model#getPropertyDb
     */
    getPropertyDb() {
        const data = this.getData();
        return data && data.propDbLoader;
    }

    /**
     * Enumerates all attributes (types of properties) used for the given model. If the property database is
     * available, for each property a triple with the property's hash, name, and category is created and added to
     * the result array. In addition, regular expression can be used to filter by name and/or category.
     *
     * @example
     *  const properties = await model.getPropertyHashes(/category/i);
     *  // -> Array(8) [ (3) […], (3) […], (3) […], (3) […], (3) […], (3) […], (3) […], (3) […] ]
     *  //     0: Array(3) [ "p5eddc473", "Category", "__category__" ]
     *  //     1: Array(3) [ "pa7275c45", "CategoryId", "__categoryId__" ]
     *  //     2: Array(3) [ "p3ed85946", "Subcategory", "Identity Data" ]
     *  //     ...
     *
     * @param {RegExp} nameRE - Regular expression to use for filtering properties by their name.
     * @param {RegExp} categoryRE - Regular expression to use for filtering properties by their category.
     * @returns {Array} Array with triples of the properties' hashes, names, and categories.
     *
     * @alias Autodesk.Viewing.Model#getPropertyHashes
     */
    async getPropertyHashes(nameRE = undefined, categoryRE = undefined) {
        /**
         * Duplicate: @see Filter.getPropertyHash (extensions/Filter/Filter.js)
         * @private
         */
        function createPropertyHash(name, category, dataType, dataTypeContext) {
            const identifier = (name + category + dataType + (dataTypeContext ? ? '')).toUpperCase();
            return `p${crc32(identifier).toString(16).padStart(8, '0')}`;
        }

        const pdbLoader = this.getPropertyDb();
        if (pdbLoader === undefined || pdbLoader.isLoadDone() !== true) {
            return undefined;
        }

        /**
         * The user function needs to be passed as a string to correctly work in the minified/production build.
         * Using different function names, lambdas, etc. is not working or especially not working after
         * uglification. Only the following syntax appeared to work in production:
         * ```'function userFunction(pdb) { ... }'```
         */
        let properties = await pdbLoader.executeUserFunction(`function userFunction(pdb) {
                const properties = new Set();
                pdb.enumAttributes((i, attribute, raw) => {
                properties.add([ attribute.name, attribute.category, attribute.dataType, attribute.dataTypeContext ]);
            });
            return Array.from(properties); }`);

        // The filtering could be done within the userFunction using userData, but lets keep it clean and debuggable.
        if (typeof nameRE !== 'undefined' && nameRE instanceof RegExp) {
            properties = properties.filter(element => nameRE.test(element[0]));
        }
        if (typeof categoryRE !== 'undefined' && categoryRE instanceof RegExp) {
            properties = properties.filter(element => categoryRE.test(element[1]));
        }

        for (const property of properties) {
            const hash = createPropertyHash(property[0], property[1], property[2], property[3]);
            property.unshift(hash);
            property.pop(); // remove dataType
            property.pop(); // remove dataTypeContext
        }
        return properties;
    }

    /**
     * Asynchronous method that gets object properties
     * @deprecated Use getProperties2 instead - which makes sure that externalId table is only loaded if really needed.
     *
     * @param {number} dbId - The database identifier.
     * @param {Callbacks#onPropertiesSuccess} [onSuccessCallback] - Callback for when the properties are fetched.
     * @param {Callbacks#onGenericError} [onErrorCallback] - Callback for when the properties are not found or another error occurs.
     *
     * @alias Autodesk.Viewing.Model#getProperties
     */
    getProperties(dbId, onSuccessCallback, onErrorCallback) {
        var pdb = this.getPropertyDb();

        // Negative dbIds will not have properties.
        // Negative dbIds are either paper (-1) or generated ids for 2d-texts
        // dbIds start at 1, so 0 can be skipped as well.
        if (!pdb || dbId <= 0) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getProperties(dbId, onSuccessCallback, onErrorCallback);
    }

    /**
     * Asynchronous method that gets object properties
     *
     * @param {number} dbId - The database identifier.
     * @param {Callbacks#onPropertiesSuccess} [onSuccessCallback] - Callback for when the properties are fetched.
     * @param {Callbacks#onGenericError} [onErrorCallback] - Callback for when the properties are not found or another error occurs.
     * @param {Object}  [options]
     * @param {boolean} [options.needsExternalId] - Ensures loading of externalID table if necessary. This may consume a lot of memory. Only use if you really need externalIds.
     *
     * @alias Autodesk.Viewing.Model#getProperties2
     */
    getProperties2(dbId, onSuccessCallback, onErrorCallback, options) {
        var pdb = this.getPropertyDb();

        // Negative dbIds will not have properties.
        // Negative dbIds are either paper (-1) or generated ids for 2d-texts
        // dbIds start at 1, so 0 can be skipped as well.
        if (!pdb || dbId <= 0) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getProperties2(dbId, onSuccessCallback, onErrorCallback, options);
    }

    /**
     * Returns properties for multiple objects with an optional filter on which properties to retrieve.
     * @deprecated Use getBulkProperties2 instead.
     *
     * @param {number[]} dbIds - IDs of the nodes to return the properties for.
     * @param {object|undefined} options - Dictionary with options.
     * @param {string[]} [options.propFilter] - Array of property names to return values for. Use null for no filtering.
     * Filter applies to "name" and "externalId" fields also.
     * @param {boolean} [options.ignoreHidden] - Ignore hidden properties
     * @param {function} onSuccessCallback - This method is called when request for property db succeeds.
     * @param {function} onErrorCallback - This method is called when request for property db fails.
     *
     * @alias Autodesk.Viewing.Model#getBulkProperties
     */
    getBulkProperties(dbIds, options, onSuccessCallback, onErrorCallback) {
        if (Array.isArray(options)) {
            // backwards compatibility for when options was actually propFilter.
            options = {
                propFilter: options
            };
        }

        options = options || {};
        var propFilter = options.propFilter || null;
        var ignoreHidden = options.ignoreHidden || false;

        var pdb = this.getPropertyDb();
        if (!pdb) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getBulkProperties(dbIds, propFilter, onSuccessCallback, onErrorCallback, ignoreHidden);
    }

    /**
     * Returns properties for multiple objects with an optional filter on which properties to retrieve.
     *
     * @param {int[]} dbIds - IDs of the nodes to return the properties for.
     * @param {object|undefined} options - Dictionary with options.
     * @param {string[]} [options.propFilter] - Array of property names to return values for. Use null for no filtering.
     * Filter applies to "name" and "externalId" fields also.
     * @param {string[]} [options.categoryFilter] - Array of category names to return values for. Use null for no filtering.
     * @param {boolean} [options.ignoreHidden] - Ignore hidden properties
     * @param {boolean} [options.needsExternalId] - Ensures loading of externalID table if necessary. This may consume a lot of memory. Only use if you really need externalIds.
     * @param {function} onSuccessCallback - This method is called when request for property db succeeds.
     * @param {function} onErrorCallback - This method is called when request for property db fails.
     *
     * @alias Autodesk.Viewing.Model#getBulkProperties2
     */
    getBulkProperties2(dbIds, options, onSuccessCallback, onErrorCallback) {
        var pdb = this.getPropertyDb();
        if (!pdb) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getBulkProperties2(dbIds, options, onSuccessCallback, onErrorCallback);
    }

    /**
     * Returns a Promise that resolves with {@link Autodesk.Viewing.PropertySet|PropertySet} for multiple objects.
     * An optional filter can be passed in to specify which properties to retrieve.
     *
     * @param {int[]} dbIds - IDs of the nodes to return the properties for.
     * @param {Object} [options] - Dictionary with options.
     * @param {string[]} [options.propFilter] - Array of property names to return values for. Use null for no filtering.
     * Filter applies to "name" and "externalId" fields also.
     * @param {boolean} [options.ignoreHidden] - Ignore hidden properties
     * @param {boolean} [options.needsExternalId] - Ensures loading of externalID table if necessary. This may consume a lot of memory. Only use if you really need externalIds.
     * @returns {Promise<Autodesk.Viewing.PropertySet>} A promise that resolves with an instance of a Autodesk.Viewing.PropertySet
     *
     * @alias Autodesk.Viewing.Model#getPropertySetAsync
     */
    getPropertySetAsync(dbIds, options) {
        return new Promise((resolve, reject) => {
            this.getPropertySet(dbIds, resolve, reject, options);
        });
    }

    /**
     * Gets the property {@link Autodesk.Viewing.PropertySet|PropertySet} for multiple objects.
     * An optional filter can be passed in to specify which properties to retrieve.
     *
     * For the async version see {@link Autodesk.Viewing.Model#getPropertySetAsync|getPropertySetAsync}
     *
     * @param {int[]} dbIds - IDs of the nodes to return the properties for.
     * @param {function} onSuccessCallback - This method is called when request for property db succeeds.
     * @param {function} onErrorCallback - This method is called when request for property db fails.
     * @param {Object} [options] - Dictionary with options.
     * @param {string[]} [options.propFilter] - Array of property names to return values for. Use null for no filtering.
     * Filter applies to "name" and "externalId" fields also.
     * @param {boolean} [options.ignoreHidden] - Ignore hidden properties
     * @param {boolean} [options.needsExternalId] - Ensures loading of externalID table if necessary. This may consume a lot of memory. Only use if you really need externalIds.
     * @returns {Promise<Autodesk.Viewing.PropertySet>} - Returns a promise that resolves with an instance of a Autodesk.Viewing.PropertySet
     *
     * @alias Autodesk.Viewing.Model#getPropertySet
     */
    getPropertySet(dbIds, onSuccessCallback, onErrorCallback, options) {
        var pdb = this.getPropertyDb();
        if (!pdb) {
            onErrorCallback && onErrorCallback('Properties failed to load.');
        }

        pdb.getPropertySet(
            dbIds,
            options,
            (result) => {
                onSuccessCallback(new PropertySet(result));
            },
            onErrorCallback
        );
    }

    /**
     * Returns an object with key values being dbNodeIds and values externalIds.
     * Useful to map LMV node ids to Fusion node ids.
     *
     * @param {function} onSuccessCallback - This method is called when request for property db succeeds.
     * @param {function} onErrorCallback - This method is called when request for property db fails.
     *
     * @alias Autodesk.Viewing.Model#getExternalIdMapping
     */
    getExternalIdMapping(onSuccessCallback, onErrorCallback) {
        var pdb = this.getPropertyDb();

        if (!pdb) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getExternalIdMapping(onSuccessCallback, onErrorCallback);
    }

    /**
     * Returns an object with key values being layer names, pointing to Arrays containing dbIds.
     *
     * @param {function} onSuccessCallback - This method is called when request for property db succeeds.
     * @param {function} onErrorCallback - This method is called when request for property db fails.
     *
     * @alias Autodesk.Viewing.Model#getLayerToNodeIdMapping
     */
    getLayerToNodeIdMapping(onSuccessCallback, onErrorCallback) {
        var pdb = this.getPropertyDb();
        if (!pdb) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getLayerToNodeIdMapping(onSuccessCallback, onErrorCallback);
    }

    /**
     * Asynchronous operation that gets a reference to the object tree.
     *
     * You can use the model object tree to get information about items in the model.  The tree is made up
     * of nodes, which correspond to model components such as assemblies or parts.
     *
     * @param {Callbacks#onObjectTreeSuccess} [onSuccessCallback] - Success callback invoked once the object tree is available.
     * @param {Callbacks#onGenericError} [onErrorCallback] - Error callback invoked when the object tree is not found available.
     *
     * @alias Autodesk.Viewing.Model#getObjectTree
     */
    getObjectTree(onSuccessCallback, onErrorCallback) {
        // Scene builder has an instance tree but no property database.
        const it = this.getData().instanceTree;
        if (it) {
            onSuccessCallback(it);
            return;
        }

        var pdb = this.getPropertyDb();
        if (!pdb) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.getObjectTree(onSuccessCallback, onErrorCallback);
    }

    /**
     * Returns ``true`` only when the object tree is loaded into memory.
     * Will return ``false`` while the object tree is still loading,
     * or when the object tree fails to load.
     *
     * @returns {boolean}
     * @alias Autodesk.Viewing.Model#isObjectTreeLoaded
     */
    isObjectTreeLoaded() {
        var pdb = this.getPropertyDb();
        if (!pdb) {
            return false;
        }

        return pdb.isObjectTreeLoaded();
    }

    /**
     * Async operation to search the object property database.
     *
     * @param {string} text - The search term (not case sensitive).
     * @param {Callbacks#onSearchSuccess} onSuccessCallback - Invoked when the search results are ready.
     * @param {Callbacks#onGenericError} onErrorCallback - Invoke when an error occured during search.
     * @param {string[]} [attributeNames] - Restricts search to specific attribute names.
     * @param {Object} [options] - Search options. Currently only supported option is searchHidden
     * @param {boolean} [options.searchHidden=false] - Set to true to also search hidden properties
     *
     * @alias Autodesk.Viewing.Model#search
     */
    search(text, onSuccessCallback, onErrorCallback, attributeNames, options = {
        searchHidden: false
    }) {
        var pdb = this.getPropertyDb();
        if (!pdb) {
            onErrorCallback && onErrorCallback();
            return;
        }

        pdb.searchProperties(text, attributeNames, onSuccessCallback, onErrorCallback, options);
    }

    /**
     * Searches the property database for all dbIds that contains a specific property name.
     *
     * @param {string} propertyName - The property name to search for (case sensitive).
     * @returns {Promise} that resolves with an Array of dbIds containing the specified property.
     *
     * @alias Autodesk.Viewing.Model#findProperty
     */
    findProperty(propertyName) {
        var pdb = this.getPropertyDb();

        if (!pdb) {
            return Promise.reject('Model doesn\'t have any properties.');
        }

        return pdb.findProperty(propertyName);
    }

    //========================================================
    // Utility functions used by page->model conversions below

    static# repairViewportMatrix(elements) {
        // Sometimes the rows of matrix are swapped
        var precision = 1e-3;
        var e = elements;
        if (Math.abs(e[0]) < precision) {
            if (Math.abs(e[4]) > precision) {
                // swap row 1 and row 2
                for (var i = 0; i < 4; i++) {
                    var temp = e[i];
                    e[i] = e[i + 4];
                    e[i + 4] = temp;
                }
            } else {
                // swap row 1 and row 3
                for (let i = 0; i < 4; i++) {
                    const temp = e[i];
                    e[i] = e[i + 8];
                    e[i + 8] = temp;
                }
            }
        }
        if (Math.abs(e[5]) < precision) {
            // swap row 2 and row 3
            for (let i = 4; i < 8; i++) {
                const temp = e[i];
                e[i] = e[i + 4];
                e[i + 4] = temp;
            }
        }
    }

    static# pointInContour(x, y, cntr, pts) {
        var yflag0, yflag1;
        var vtx0X, vtx0Y, vtx1X, vtx1Y;

        var inside_flag = false;

        // get the last point in the polygon
        vtx0X = pts[cntr[cntr.length - 1]].x;
        vtx0Y = pts[cntr[cntr.length - 1]].y;

        // get test bit for above/below X axis
        yflag0 = (vtx0Y >= y);

        for (var j = 0, jEnd = cntr.length; j < jEnd; ++j) {
            vtx1X = pts[cntr[j]].x;
            vtx1Y = pts[cntr[j]].y;

            yflag1 = (vtx1Y >= y);

            // Check if endpoints straddle (are on opposite sides) of X axis
            // (i.e. the Y's differ); if so, +X ray could intersect this edge.
            // The old test also checked whether the endpoints are both to the
            // right or to the left of the test point.  However, given the faster
            // intersection point computation used below, this test was found to
            // be a break-even proposition for most polygons and a loser for
            // triangles (where 50% or more of the edges which survive this test
            // will cross quadrants and so have to have the X intersection computed
            // anyway).  I credit Joseph Samosky with inspiring me to try dropping
            // the "both left or both right" part of my code.
            if (yflag0 != yflag1) {
                // Check intersection of pgon segment with +X ray.
                // Note if >= point's X; if so, the ray hits it.
                // The division operation is avoided for the ">=" test by checking
                // the sign of the first vertex wrto the test point; idea inspired
                // by Joseph Samosky's and Mark Haigh-Hutchinson's different
                // polygon inclusion tests.
                if (((vtx1Y - y) * (vtx0X - vtx1X) >=
                        (vtx1X - x) * (vtx0Y - vtx1Y)) == yflag1) {
                    inside_flag = !inside_flag;
                }
            }

            // move to the next pair of vertices, retaining info as possible
            yflag0 = yflag1;
            vtx0X = vtx1X;
            vtx0Y = vtx1Y;
        }

        return inside_flag;
    }

    static# pointInPolygon(x, y, contours, points) {
        var inside = false;
        for (var i = 0; i < contours.length; i++) {

            if (Model.#pointInContour(x, y, contours[i], points))
                inside = !inside;
        }

        return inside;
    }

    getPageToModelTransform(vpId) {
        var data = this.getData();
        if (data.pageToModelTransform) {
            return data.pageToModelTransform;
        }

        var f2d = data;
        var metadata = f2d.metadata;
        var pd = metadata.page_dimensions;

        var vp = f2d.viewports && f2d.viewports[vpId];
        if (!vp) {
            return new THREE.Matrix4();
        }

        if (!f2d.viewportTransforms)
            f2d.viewportTransforms = new Array(f2d.viewports.length);

        //See if we already cached the matrix
        var cached = f2d.viewportTransforms[vpId];
        if (cached)
            return cached;

        //Do the matrix composition in double precision using LmvMatrix,
        //which supports that optionally
        var pageToLogical = new LmvMatrix4(true).set(
            pd.logical_width / pd.page_width, 0, 0, pd.logical_offset_x,
            0, pd.logical_height / pd.page_height, 0, pd.logical_offset_y,
            0, 0, 1, 0,
            0, 0, 0, 1
        );

        var modelToLogicalArray = vp.transform ? .slice() || [1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ];

        Model.#repairViewportMatrix(modelToLogicalArray);

        var modelToLogical = new LmvMatrix4(true);
        modelToLogical.elements.set(modelToLogicalArray);

        var logicalToModel = new LmvMatrix4(true);
        logicalToModel.copy(modelToLogical).invert();

        logicalToModel.multiply(pageToLogical);

        //Cache for future use
        f2d.viewportTransforms[vpId] = logicalToModel;

        return logicalToModel;
    }

    /**
     * Paper coordinates to Model coordinates
     */
    pageToModel(point1, point2, vpId, inverse) {
        let vpXform = this.getPageToModelTransform(vpId);
        if (inverse) {
            vpXform = vpXform.clone().invert();
        }

        function applyToPoint(point) {
            if (point) {
                var modelPt = new THREE.Vector3().set(point.x, point.y, 0).applyMatrix4(vpXform);
                point.x = modelPt.x;
                point.y = modelPt.y;
                point.z = modelPt.z;
            }
        }

        applyToPoint(point1);
        applyToPoint(point2);
    }

    /**
     * Find the viewports that point lies in its bounds.
     */
    pointInClip(point, vpId) {
        var clips = this.getData().clips;
        var clipIds = []; // This will store ids of clip where point lies in

        // clip index starts at 1
        for (var i = 1; i < clips.length; i++) {
            // Don't need to check the point's own viewport's clip, it must be in that clip.
            if (i === vpId)
                continue;

            var contour = [];
            var contours = [];
            var contourCounts = clips[i].contourCounts;
            var points = clips[i].points;
            var index = 0;
            var pts = [];

            // Reorganize contour data
            for (var j = 0; j < contourCounts.length; j++) {
                for (var k = 0; k < contourCounts[j]; k++) {
                    contour.push(index);
                    index++;
                }
                contours.push(contour);
                contour = [];
            }
            for (let j = 0; j < points.length; j += 2) {
                var pt = {
                    x: points[j],
                    y: points[j + 1]
                };
                pts.push(pt);
            }

            var inside = Model.#pointInPolygon(point.x, point.y, contours, pts);
            if (inside)
                clipIds.push(i);
        }

        return clipIds;
    }

    getClip(vpId) {
        var clips = this.getData().clips;

        var contour = [];
        var contours = [];
        var contourCounts = clips[vpId].contourCounts;
        var points = clips[vpId].points;
        var index = 0;
        var pts = [];

        // Reorganize contour data
        for (var j = 0; j < contourCounts.length; j++) {
            for (var k = 0; k < contourCounts[j]; k++) {
                contour.push(index);
                index++;
            }
            contours.push(contour);
            contour = [];
        }
        for (let j = 0; j < points.length; j += 2) {
            var pt = {
                x: points[j],
                y: points[j + 1]
            };
            pts.push(pt);
        }

        return {
            "contours": contours,
            "points": pts
        };
    }

    /**
     * Return topology index of the fragment.
     * @param {number} fragId - Fragment ID.
     * @returns {number} Topology index.
     */
    getTopoIndex(fragId) {
        var data = this.getData();
        if (data && data.fragments) {
            var topoIndexes = data.fragments.topoIndexes;
            if (topoIndexes) {
                return topoIndexes[fragId];
            }
        }
    }

    /**
     * Return topology data of one fragment.
     *
     * Requires topology data to have been fetched with
     * {@link Autodesk.Viewing.Model#fetchTopology|fetchTopology()}.
     *
     * @param {number} index - Topology index.
     * @returns {object} Topology data.
     *
     * @alias Autodesk.Viewing.Model#getTopology
     */
    getTopology(index) {
        if (this.topology) {
            return this.topology[index];
        }
        return null;
    }

    /**
     * See also {@link Autodesk.Viewing.Model#fetchTopology|fetchTopology()}.
     * @returns {boolean} true if topology data has been downloaded and is available in memory
     *
     * @alias Autodesk.Viewing.Model#hasTopology
     */
    hasTopology() {
        return !!this.topology;
    }

    /**
     * Downloads the topology file, if one is available.
     * The file may not get downloaded if the topology content size in memory is bigger
     * than a specified limit (100 MB by default, 20 MB for mobile).
     *
     * @param {number} [maxSizeMB] - Maximum uncompressed topology size allowed (in MegaBytes).
     * @returns {Promise} A Promise that resolves with the topology object.
     *
     * @alias Autodesk.Viewing.Model#fetchTopology
     */
    fetchTopology(maxSizeMB) {
        if (this.topology) // Already downloaded
            return Promise.resolve(this.topology);

        var data = this.getData();
        if (!data.topologyPath) // No path from where to download it
            return Promise.reject({
                error: "no-topology"
            });

        var maxTopologyFileSizeMB = maxSizeMB || (isMobileDevice() ? 20 : 100); // MegaBytes; Non-gzipped
        if (data.topologySizeMB > maxTopologyFileSizeMB) // File is too big to download.
            return Promise.reject({
                error: "topology-too-big",
                limitMB: maxTopologyFileSizeMB,
                topologyMB: data.topologySizeMB
            });

        if (!this.topologyPromise) // Fetch it!
        {
            var that = this;
            this.topologyPromise = new Promise(function(resolve, reject) {
                that.loader.fetchTopologyFile(that.getData().topologyPath, function onComplete(topoData) {
                    if (topoData && topoData.topology) {
                        that.topology = topoData.topology;
                        resolve(topoData.topology);
                    } else {
                        reject(topoData);
                    }
                });
            });
        }

        return this.topologyPromise;
    }

    /**
     * @returns {boolean} True if the model loaded contains at least 1 fragment.
     *
     * @alias Autodesk.Viewing.Model#hasGeometry
     */
    hasGeometry() {
        var data = this.getData();
        if (data) {
            if (data.isLeaflet) { // see LeafletLoader.js
                return true;
            }
            if (data.isSceneBuilder) {
                return true; // We claim scene builder scenes are never empty, even if it contains no geometry
            }
            return data.fragments.length > 0;
        }
        return false;
    }

    /**
     * Returns the FragmentPointer of the specified fragId in the model.
     * This method returns null if the fragId is not passed in.
     *
     * @param {number} fragId - fragment id in the model
     * @returns {?Autodesk.Viewing.Private.FragmentPointer} The FragmentPointer
     *
     * @alias Autodesk.Viewing.Model#getFragmentPointer
     */
    getFragmentPointer(fragId) {
        if (!fragId) return null;
        return new FragmentPointer(this.getFragmentList(), fragId);
    }

    /**
     * Returns a shallow copy of the model.
     * All the inner state (Fragments, Geometries etc.) are shared.
     *
     * @returns {Autodesk.Viewing.Model} A shallow copy of the model.
     *
     * @alias Autodesk.Viewing.Model#clone
     */
    clone() {
        const clone = new Model(this.myData);
        clone.topology = this.topology;
        clone.topologyPromise = this.topologyPromise;
        clone.svfUUID = this.svfUUID;
        clone.defaultCameraHash = this.defaultCameraHash;
        clone.loader = this.loader;
        clone.setInnerAttributes(this.getInnerAttributes());

        return clone;
    }

    /**
     * Returns the URN of the document model.
     * @returns {string} Model URN.
     */
    getSeedUrn() {
        return this.loader ? .svfUrn || "";
    }

    /**
     * Check if node exist in instance tree or fragment list.
     * @param {number} dbId - can be a single dbId or node with children (as appears in Model Browser)
     * @return {boolean} False if no elements were found.
     */
    isNodeExists(dbId) {
        let dbIdExists;
        const it = this.getInstanceTree();

        if (it) {
            it.enumNodeChildren(dbId, function(dbId) {
                it.enumNodeFragments(dbId, function() {
                    dbIdExists = true;
                });
            }, true);
        } else {
            const fragments = this.getFragmentList().fragments;
            if (fragments.dbId2fragId ? .[dbId]) {
                dbIdExists = true;
            }
        }
        return !!dbIdExists;
    }

    getModelKey() {
        const documentNode = this.getDocumentNode();
        if (documentNode) {
            return documentNode.getModelKey();
        } else {
            return this.getData().urn;
        }
    }

    dtor() {
        super.dtor();
        this.#dispose();
    }

    #
    dispose() {
        const instanceTree = this.getInstanceTree();
        instanceTree ? .dtor();

        this.myData = null;
        this.topology = null;
        this.topologyPromise = null;
    }

    setFragmentBoundingBoxes(boxArray, stride) {
        const frags = this.getFragmentList().fragments;
        const fboxes = frags.boxes;

        // Note that the loaded boxes can be mixed with flags, so we need to copy them and skip the other data
        const boxCount = boxArray.length / stride;

        for (let fragId = 0, srcOffset = 0, dstOffset = 0; fragId < boxCount; fragId++, srcOffset += stride, dstOffset += 6) {
            fboxes[dstOffset + 0] = boxArray[srcOffset + 0];
            fboxes[dstOffset + 1] = boxArray[srcOffset + 1];
            fboxes[dstOffset + 2] = boxArray[srcOffset + 2];
            fboxes[dstOffset + 3] = boxArray[srcOffset + 3];
            fboxes[dstOffset + 4] = boxArray[srcOffset + 4];
            fboxes[dstOffset + 5] = boxArray[srcOffset + 5];
        }

        // Make sure that subsequent setMesh() calls don't overwrite the boxes with computed ones.
        // This would happen otherwise as soon as more geometry is loaded.
        frags.boxesLoaded = true;

        // Make sure that model box does not keep outdated values
        this.visibleBoundsDirty = true;

        this.fireEvent({
            type: Autodesk.Viewing.MODEL_FRAGMENT_BOUNDING_BOXES_SET_EVENT,
            model: this
        });
    }
}