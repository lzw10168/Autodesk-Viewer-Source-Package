import {
    LmvMatrix4 as Matrix4
} from '../../wgs/scene/LmvMatrix4';
import {
    LmvBox3 as Box3
} from '../../wgs/scene/LmvBox3';
import {
    logger
} from "../../logger/Logger";
import {
    TextureLoader
} from "./TextureLoader";
import {
    NodeArray
} from "../../wgs/scene/BVHBuilder";
import {
    MeshFlags
} from '../../wgs/scene/MeshFlags';
import {
    PropDbLoader
} from "./PropDbLoader";
import {
    initWorkerScript,
    createWorker
} from "./WorkerCreator";
import {
    initLoadContext
} from "../net/endpoints";
import {
    pathToURL,
    ViewingService
} from "../net/Xhr";
import {
    OtgPackage,
    FLUENT_URN_PREFIX,
    DS_OTG_CDN_PREFIX
} from "../lmvtk/otg/Otg";
import {
    FileLoaderManager
} from "../../application/FileLoaderManager";
import {
    Model
} from "../../application/Model";
import {
    BubbleNode
} from "../../application/bubble";
import * as et from "../../application/EventTypes";
import {
    ProgressState
} from '../../application/ProgressState';
import {
    isMobileDevice
} from "../../compat";
import {
    MESH_RECEIVE_EVENT,
    MESH_FAILED_EVENT,
    MATERIAL_RECEIVE_EVENT,
    MATERIAL_FAILED_EVENT,
    PENDING_REQUESTS_FINISHED_EVENT
} from "./OtgResourceCache";
import {
    MemoryTracker,
    RESOURCE_TYPES,
    RESOURCE_EVENTS
} from "../../wgs/scene/MemoryTracker.js";
import {
    blobToJson
} from "../lmvtk/common/StringUtils";
//import { createWireframe } from "../../wgs/scene/DeriveTopology;

import {
    SelectiveLoadingController
} from '../selective/SelectiveLoadingController';


var WORKER_LOAD_OTG_BVH = "LOAD_OTG_BVH";
const av = Autodesk.Viewing;
const avp = Autodesk.Viewing.Private;

/** @constructor */
export function OtgLoader(parent) {
    this.viewer3DImpl = parent;
    this.loading = false;
    this.tmpMatrix = new Matrix4();
    this.tmpBox = new Box3();

    this.logger = logger;
    this.loadTime = 0;

    this.pendingMaterials = {};
    this.pendingMaterialsCount = 0;

    this.pendingMeshes = {};
    this.pendingMeshesCount = 0;

    this.pendingRequests = 0;

    this.operationsDone = 0;
    this.viewpointMatHashes = new Set();

    this.notifiesFirstPixel = true;

    this._selectiveLoadingController = new SelectiveLoadingController(OtgLoader.prototype.evaluate.bind(this));

    this._lineageUrn = null;
}


OtgLoader.prototype.dtor = function() {
    // Cancel all potential process on loading a file.

    // 1. init worker script can be cancelled.
    //
    if (this.initWorkerScriptToken) {
        this.initWorkerScriptToken.cancel();
        this.initWorkerScriptToken = null;
        logger.debug("SVF loader dtor: on init worker script.");
    }

    // 2. load model root (aka. svf) can be cancelled.
    //
    if (this.bvhWorker) {
        this.bvhWorker.terminate();
        this.bvhWorker = null;
        logger.debug("SVF loader dtor: on svf worker.");
    }


    if (this.svf) {

        if (!this.svf.loadDone)
            console.log("stopping load before it was complete");

        this.svf.abort();

        if (this.svf.propDbLoader) {
            this.svf.propDbLoader.dtor();
            this.svf.propDbLoader = null;
        }
    }


    // 5. Cancel all running requests in shared geometry worker
    //
    if (this.viewer3DImpl.geomCache() && this.model) {
        if (this.loading)
            this.viewer3DImpl.geomCache().cancelRequests(this.svf.geomMetadata.hashToIndex);

        this.pendingRequests = 0;
        this.removeMeshReceiveListener();
    }

    if (this.memoryLimitReached)
        MemoryTracker.removeEventListener(RESOURCE_EVENTS.LIMIT_REACHED_EVENT, this.memoryLimitReached);

    // and clear metadata.
    this.viewer3DImpl = null;
    this.model = null;
    this.svf = null;
    this.logger = null;
    this.tmpMatrix = null;

    this.loading = false;
    this.loadTime = 0;
};

OtgLoader.prototype.isValid = function() {
    return this.viewer3DImpl != null;
};

OtgLoader.prototype.removeMeshReceiveListener = function() {
    if (!this.meshReceivedListener) {
        return;
    }
    this.viewer3DImpl.geomCache().loaderRemoved();
    this.viewer3DImpl.geomCache().removeEventListener(MESH_RECEIVE_EVENT, this.meshReceivedListener);
    this.viewer3DImpl.geomCache().removeEventListener(MESH_FAILED_EVENT, this.meshFailedListener);
    this.viewer3DImpl.geomCache().removeEventListener(MATERIAL_RECEIVE_EVENT, this.materialReceiveListener);
    this.viewer3DImpl.geomCache().removeEventListener(MATERIAL_FAILED_EVENT, this.materialReceiveListener);
    this.meshReceivedListener = null;
    this.meshFailedListener = null;
};

function getBasePath(path) {
    var basePath = "";
    var lastSlash = path.lastIndexOf("/");
    if (lastSlash != -1)
        basePath = path.substr(0, lastSlash + 1);
    return basePath;
}

function getQueryParams(options) {
    return options.acmSessionId ? "acmsession=" + options.acmSessionId : "";
}

function createLoadContext(options, basePath, queryParams) {
    var loadContext = {
        basePath: basePath,
        objectIds: options.ids,
        globalOffset: options.globalOffset,
        fragmentTransformsDouble: options.fragmentTransformsDouble,
        placementTransform: options.placementTransform,
        applyRefPoint: options.applyRefPoint,
        queryParams: queryParams,
        bvhOptions: options.bvhOptions || {
            isWeakDevice: isMobileDevice()
        },
        applyScaling: options.applyScaling,
        applyPlacementInModelUnits: options.applyPlacementInModelUnits,
        loadInstanceTree: options.loadInstanceTree,
        // avoidNwcRotation: options.avoidNwcRotation,
    };

    return initLoadContext(loadContext);
}

OtgLoader.prototype.loadFile = function(path, options, onDone, onWorkerStart) {
    if (!this.viewer3DImpl) {
        logger.log("SVF loader was already destructed. So no longer usable.");
        return false;
    }

    this.viewer3DImpl._signalNoMeshes();

    if (this.loading) {
        logger.log("Loading of SVF already in progress. Ignoring new request.");
        return false;
    }

    // Mark it as loading now.
    this.loading = true;

    //For OTG server, the URN of the manifest is used as part of the ACM session token
    if (options.acmSessionId) {
        //TODO: initWorker should be updated to also send the acmsession when authorizing the web worker,
        //in a followup change.
        this.svfUrn = options.acmSessionId.split(",")[0];
    } else {
        //If the URN is not supplied, we can derive it from the storage path,
        //but that will only work for URNs that are not shallow copies.
        console.warn("DEPRECATED: Automatic derivation of URN will be removed in a future release. Please set the acmSessionId parameter when loading OTG data.");

        var idx = path.indexOf(FLUENT_URN_PREFIX);
        if (idx === -1) {
            idx = path.indexOf(DS_OTG_CDN_PREFIX);
        }

        if (idx !== -1) {

            //This will work for WIP URNs but probably not OSS ones, where
            //the URN is an encoding of the OSS file name or something equally arbitrary
            var parts = path.split("/");
            var seed = parts[1];
            var version = parts[2];
            var urn = seed + "?version=" + version;
            var encoded = av.toUrlSafeBase64(urn);

            this.svfUrn = encoded;
        }
    }

    this.sharedDbPath = options.sharedPropertyDbPath;

    this.currentLoadPath = path;

    this.basePath = getBasePath(path);
    this.acmSessionId = options.acmSessionId;

    this.options = options;
    this.queryParams = getQueryParams(options);

    this.loadContext = createLoadContext(options, this.basePath, this.queryParams);

    // The request failure parameters received by onFailureCallback (e.g. httpStatusCode) cannot just be forwarded to onDone().
    // Instead, we have to pass them through ViewingService.defaultFailureCallback, which converts them to error parameters
    // and calls loadContext.raiseError with them.
    this.loadContext.raiseError = function(code, msg, args) {
        var error = {
            "code": code,
            "msg": msg,
            "args": args
        };
        onDone && onDone(error);
    };
    this.loadContext.onFailureCallback = ViewingService.defaultFailureCallback.bind(this.loadContext);

    this._selectiveLoadingController.prepare(options);

    this.loadModelRoot(this.loadContext, onDone);

    //We don't use a worker for OTG root load, so we call this back immediately
    //We will use the worker for heavy tasks like BVH compute after we get the model root file.
    onWorkerStart && onWorkerStart();

    return true;
};

// This is a separate function because we can override it in the SVF2+ loader this way.
OtgLoader.prototype._createPackage = function() {
    return new OtgPackage();
};

OtgLoader.prototype._workerScriptReadyCb = function() {
    for (var id in this._pendingMessages) {
        if (Object.prototype.hasOwnProperty.call(this._pendingMessages, id)) {
            this._pendingMessages[id].forEach((data) => {
                this.loadContext.onLoaderEvent(id, data);
            });
        }
    }
    this._pendingMessages = {};
};

OtgLoader.prototype._requestRepaint = function() {
    if (!this.viewer3DImpl ? .modelVisible(this.model.id)) {
        return;
    }
    this.viewer3DImpl.api.dispatchEvent({
        type: av.LOADER_REPAINT_REQUEST_EVENT,
        loader: this,
        model: this.model
    });
};

OtgLoader.prototype.loadModelRoot = function(loadContext, onDone) {
    this.t0 = new Date().getTime();
    this.firstPixelTimestamp = null;
    this._pendingMessages = {};
    var scope = this;

    var WORKER_SCRIPT_READY = false;

    this.initWorkerScriptToken = initWorkerScript(function() {
        WORKER_SCRIPT_READY = true;

        scope._workerScriptReadyCb();
    });

    var svf = this.svf = this._createPackage();

    svf.basePath = loadContext.basePath;

    //Those events happen on the main thread, unlike SVF loading where
    //everything happens in the svfWorker
    loadContext.onLoaderEvent = function(whatIsDone, data) {

        if (!scope.svf) {
            console.error("load callback called after load was aborted");
            return;
        }

        // Make sure that the worker script is ready by the time the messages are processed.
        // This is related to LMV-4719
        if (!WORKER_SCRIPT_READY) {
            if (!Object.prototype.hasOwnProperty.call(scope._pendingMessages, whatIsDone))
                scope._pendingMessages[whatIsDone] = [];
            scope._pendingMessages[whatIsDone].push(data);
            return;
        }

        if (whatIsDone === "otg_root") {

            scope.onModelRootLoadDone(svf);

            if (onDone)
                onDone(null, scope.model);

            scope.makeBVHInWorker();

            // init shared cache on first use
            var geomCache = scope.viewer3DImpl.geomCache();

            if (!geomCache) {
                // If this loader would create an own cache, it could be a hidden memory waste.
                // So it's better to complain.
                logger.error("geomCache is required for loading OTG models.");
            }

            geomCache.loaderAdded(scope.options.acmSessionId, scope._lineageUrn);


            scope.memoryLimitReached = (event) => {
                if (event.resourceType === RESOURCE_TYPES.MEMORY) {
                    // Cancel all pending requests, cleanup afterwards and signal load to be done
                    scope.viewer3DImpl.geomCache().cancelRequests(scope.svf.geomMetadata.hashToIndex);
                    scope.viewer3DImpl.geomCache().addEventListener(PENDING_REQUESTS_FINISHED_EVENT, () => {
                        for (const [geomHash, frags] of Object.entries(scope.pendingMeshes)) {
                            for (var i = 0; i < frags.length; i++) {
                                scope.model.getFragmentList().setFlagFragment(frags[i], MeshFlags.MESH_NOTLOADED, true);
                                scope.model.getFragmentList().setFragOff(frags[i], true);

                                scope.pendingRequests--;
                                scope.trackGeomLoadProgress(scope.svf, frags[i], false);
                            }

                            delete scope.svf.geomMetadata.hashToIndex[geomHash];
                            delete scope.pendingMeshes[geomHash];

                            scope.pendingMeshesCount--;
                        }
                    }, {
                        once: true
                    });
                }
            };
            MemoryTracker.addEventListener(av.Private.RESOURCE_EVENTS.LIMIT_REACHED_EVENT, scope.memoryLimitReached);

            scope.meshReceivedListener = (event) => scope.onMeshReceived(event.geom);
            scope.meshFailedListener = (event) => scope.onMeshError(event.hash);
            geomCache.addEventListener(MESH_RECEIVE_EVENT, scope.meshReceivedListener);
            geomCache.addEventListener(MESH_FAILED_EVENT, scope.meshFailedListener);

            scope.materialReceiveListener = function(data) {
                if (!data.material || !data.material.length) {
                    scope.onMaterialLoaded(null, data.hash);
                } else {
                    scope.onMaterialLoaded(blobToJson(data.material), data.hash);
                }
            };

            geomCache.addEventListener(MATERIAL_RECEIVE_EVENT, scope.materialReceiveListener);
            geomCache.addEventListener(MATERIAL_FAILED_EVENT, scope.materialReceiveListener);

            scope.svf.loadDone = false;

        } else if (whatIsDone === "fragment") {

            if (!scope.options.skipMeshLoad) {
                const fragmentID = data;
                if (scope._selectiveLoadingController.isActive) {
                    scope._selectiveLoadingController.onFragmentReady(fragmentID);
                } else {
                    scope.tryToActivateFragment(fragmentID, "fragment");
                }
            }

            // Optional: Track fragment load progress separately
            if (scope.options.onFragmentListLoadProgress) {
                scope.trackFragmentListLoadProgress();
            }

        } else if (whatIsDone === "all_fragments") {

            //For 3D models, we can start loading the property database as soon
            //as we know the fragment list which contains the fragId->dbId map.
            if (!scope.options.skipPropertyDb) {
                scope.loadPropertyDb();
                scope._selectiveLoadingController.onPropertiesReady();
            }

            // If this flag is false, some data is not ready yet. E.g. fragments.fragId2DbId is initially
            // filled with zeros and is only be usable after root looad. Note that fragDataLoaded = true
            // does NOT mean yet that geometry and materials are all loaded.
            scope.fragmentDataLoaded = true;

            scope._selectiveLoadingController.onFragmentListReady();

            scope.viewer3DImpl.api.fireEvent({
                type: et.MODEL_ROOT_LOADED_EVENT,
                svf: svf,
                model: scope.model
            });

            if (scope.options.skipMeshLoad || !scope.svf.fragments.length) {
                scope.onGeomLoadDone();
            } else {
                scope.onOperationComplete();
            }

        } else if (whatIsDone === "bvh") {
            var bvh = data;
            if (scope.model) {

                scope.model.setBVH(bvh.nodes, bvh.primitives, scope.options.bvhOptions);
                scope._selectiveLoadingController.onBoundingVolumeHierarchyReady();
                scope._requestRepaint();
            }

            scope.onOperationComplete();

        } else if (whatIsDone === "viewpointData") {
            // Load extra materials if viewpoints enabled as some materials are needed for override Sets
            if (scope.svf.needExtraMaterials) {
                let matHashes = Object.values(scope.svf.extraMatHashes);
                matHashes.forEach(matHash => scope.viewpointMatHashes.add(matHash));
                scope.tryToLoadExtraMaterials();
            } else {
                scope.onOperationComplete();
            }

            if (scope.svf.viewpointTreeRoot && scope.options.addViews) {
                scope.options.addViews(scope.svf.viewpointTreeRoot, scope.model);
            }
        }
    };

    loadContext.onOperationComplete = function() {
        scope.onOperationComplete();
    };

    this.beginLoad();

    return true;
};

OtgLoader.prototype.beginLoad = function() {
    this.svf.beginLoad(this.loadContext, pathToURL(this.currentLoadPath));
};

OtgLoader.prototype.makeBVHInWorker = function() {

    var scope = this;

    scope.bvhWorker = createWorker();

    var onOtgWorkerEvent = function(e) {

        console.log("Received BVH from worker");

        var bvh = e.data.bvh;
        if (scope.model) {

            scope.svf.bvh = bvh;
            scope.model.setBVH(new NodeArray(bvh.nodes, bvh.useLeanNodes), bvh.primitives, scope.options.bvhOptions);
            scope.model.setFragmentBoundingBoxes(e.data.boxes, e.data.boxStride);

            scope._selectiveLoadingController.onBoundingVolumeHierarchyReady();
            scope._requestRepaint();
        }

        scope.bvhWorker.terminate();
        scope.bvhWorker = null;

        scope.onOperationComplete();
    };

    scope.bvhWorker.addEventListener('message', onOtgWorkerEvent);

    //We can kick off the request for the fragments-extra file, needed
    //for the BVH build as soon as we have the metadata (i.e. placement transform)
    //Do this on the worker thread, because the BVH build can take a while.
    var workerContext = Object.assign({}, scope.loadContext);
    workerContext.operation = WORKER_LOAD_OTG_BVH;
    workerContext.raiseError = null;
    workerContext.onFailureCallback = null;
    workerContext.onLoaderEvent = null;
    workerContext.onOperationComplete = null;
    workerContext.fragments_extra = pathToURL(scope.basePath) + scope.svf.manifest.assets.fragments_extra;
    workerContext.placementTransform = scope.svf.placementTransform;
    workerContext.placementWithOffset = scope.svf.placementWithOffset;
    workerContext.fragmentTransformsOffset = scope.svf.metadata.fragmentTransformsOffset;
    workerContext.globalOffset = scope.svf.globalOffset;

    if (workerContext.fragments_extra) {
        scope.bvhWorker.doOperation(workerContext);
    } else {
        // If the model does not reference a fragment_extra file, the worker would not do anything.
        // This is okay for empty models. For this case, just skip the BVH phase to avoid the load progress from hanging.
        scope.onOperationComplete();
    }
};

//Attempts to turn on display of a received fragment.
//If the geometry or material is missing, issue requests for those
//and delay the activation. Once the material or mesh comes in, they
//will attempt this function again.
OtgLoader.prototype.tryToActivateFragment = function(fragId, whichCaller) {

    var svf = this.svf;
    var rm = this.model;

    //Was loading canceled?
    if (!rm)
        return;

    const flags = svf.fragments.visibilityFlags[fragId];
    const skipLoad = (flags & MeshFlags.MESH_NOTLOADED) ||
        (this._selectiveLoadingController.isActive && !this._selectiveLoadingController.isFragmentPassing(fragId));
    const isHidden = !!(flags & MeshFlags.MESH_HIDE);

    // Keep it identical to SvfLoader, where skipHiddenFragments is false by default
    const skipHiddenFragments = svf.loadOptions.skipHiddenFragments ? ? false;

    // Skip fragments with hide-flag. (e.g. hidden room geometry)
    // These are not intended for display, but rather for custom tools.
    //TODO: Check if not loading of hidden meshes causes side effects downstream,
    //like in the diff tool which waits for specific meshes to load.
    if (skipLoad || (isHidden && skipHiddenFragments)) {
        rm.getFragmentList().setFlagFragment(fragId, MeshFlags.MESH_NOTLOADED, true);
        rm.getFragmentList().setFragOff(fragId, true);
        this.trackGeomLoadProgress(svf, fragId, false);
        return;
    }

    //Also restore the hide flag
    if (isHidden) {
        // Use MESH_VISIBLE flag in favor of MESH_HIDE as Model Browser controls visibility using MESH_VISIBLE
        rm.getFragmentList().setFlagFragment(fragId, MeshFlags.MESH_HIDE, false);
        rm.getFragmentList().setFlagFragment(fragId, MeshFlags.MESH_VISIBLE, false);
    }

    var haveToWait = false;

    //The tryToActivate function can be called up to three times, until all the
    //needed parts are received.
    // Before we can safely consider a fragment as finished, we must make sure that there are no pending
    // tryToActivate(fragId, "material") or "geometry" calls that will come later.

    //1. Check if the material is done

    var materialId = svf.fragments.materials[fragId];
    var matHash = svf.getMaterialHash(materialId);
    var material = this.findOrLoadMaterial(rm, matHash);
    if (!material) {

        if (whichCaller === "fragment") {
            //Material is not yet available, so we will delay turning on the fragment until it arrives
            this.pendingMaterials[matHash].push(fragId);
            this.pendingRequests++;
        }

        if (whichCaller !== "material") {
            haveToWait = true;
        } else {
            //it means the material failed to load, so we won't wait for it.
        }
    }


    //2. Check if the mesh is done

    // Note that otg translation may assign geomIndex 0 to some fragments by design.
    // This happens when the source fragment geometry was degenerated.
    // Therefore, we do not report any warning or error for this case.
    //don't block overall progress because of this -- mark the fragment as success.
    var geomId = svf.fragments.geomDataIndexes[fragId];
    if (geomId === 0) {
        if (material || whichCaller === "material") {
            // A fragment with null-geom may still have a material. If so, we wait for the material before we consider it as finished.
            // This makes sure that we don't count this fragment twice. Note that we cannot just check whichCaller==="fragment" here:
            // This would still cause errors if the material comes in later after onGeomLoadDone().
            this.trackGeomLoadProgress(svf, fragId, false);
        }
        return;
    }

    var geom = rm.getGeometryList().getGeometry(geomId);
    if (!geom) {

        if (whichCaller === "fragment") {
            //Mesh is not yet available, so we will request it and
            //delay turning on the fragment until it arrives
            if (!this.loadGeometry(geomId, fragId)) {
                // if we run into a resource limit, we will mark the fragment as not loaded and continue
                rm.getFragmentList().setFlagFragment(fragId, MeshFlags.MESH_NOTLOADED, true);
                this.trackGeomLoadProgress(svf, fragId, false);
                return;
            }
        }

        haveToWait = true;
    } else {
        if (whichCaller === "fragment") {
            rm.getGeometryList().addInstance(geomId);
        }
    }

    if (haveToWait)
        return;

    //if (this.options.createWireframe)
    //    createWireframe(geom, this.tmpMatrix);

    //We get the matrix from the fragments and we pass it back into setupMesh
    //with the activateFragment call, but this is to maintain the
    //ability to add a plain THREE.Mesh -- otherwise it could be simpler
    rm.getFragmentList().getOriginalWorldMatrix(fragId, this.tmpMatrix);

    var m = this.viewer3DImpl.setupMesh(rm, geom, matHash, this.tmpMatrix);

    // provide correct geometry id. (see GeometryList.setMesh). Note that we cannot use
    // geom.svfid, because geomIds are model-specific and geometries may be shared.
    m.geomId = geomId;

    //If there is a placement transform, we tell activateFragment to also recompute the
    //world space bounding box of the fragment from the raw geometry model box, for a tighter
    //fit compared to what we get when loading the fragment list initially.
    rm.activateFragment(fragId, m, !!svf.placementTransform);

    // pass new fragment to Geometry cache to update priority
    // TODO: Check if we can determine the bbox earlier, so that we can also use it to prioritize load requests
    //       from different OtgLoaders.
    this.viewer3DImpl.geomCache().updateGeomImportance(rm, fragId);

    this.trackGeomLoadProgress(svf, fragId, false);

};

OtgLoader.prototype.tryToLoadExtraMaterials = function() {

    var svf = this.svf;
    var rm = this.model;

    // Was loading canceled?
    if (!rm)
        return;

    // Was extra materials loading kicked off already?
    if (svf.extraMaterialLoaded)
        return;

    svf.extraMaterialLoaded = true;
    for (const matHash of Object.values(svf.extraMatHashes)) {
        this.findOrLoadMaterial(rm, matHash);
    }

};

OtgLoader.prototype.onModelRootLoadDone = function(svf) {

    // Mark svf as Oscar-file. (which uses sharable materials and geometry)
    svf.isOTG = true;

    svf.geomMetadata.hashToIndex = {};

    svf.failedFrags = {};
    svf.failedMeshes = {};
    svf.failedMaterials = {};

    // counts fully loaded fragments (including geometry and material)
    svf.fragsLoaded = 0;

    // number of loaded fragments (also the ones for which we didn't load material and geom yet)
    svf.fragsLoadedNoGeom = 0;

    svf.nextRepaintPolys = 0;
    svf.numRepaints = 0;

    svf.urn = this.svfUrn;
    svf.acmSessionId = this.acmSessionId;

    svf.basePath = this.basePath;

    svf.loadOptions = this.options || {};

    var t1 = Date.now();
    logger.log("SVF load: " + (t1 - this.t0));

    // Create the API Model object and its render proxy
    var model = this.model = new Model(svf);
    model.loader = this;

    model.initialize();

    this._selectiveLoadingController.onModelRootReady(model);

    this.t1 = t1;

    logger.log("scene bounds: " + JSON.stringify(svf.bbox));

    var metadataStats = {
        category: "metadata_load_stats",
        urn: svf.urn,
        has_topology: !!svf.topology,
        has_animations: !!svf.animations,
        materials: svf.metadata.stats.num_materials,
        is_mobile: isMobileDevice()
    };
    logger.track(metadataStats);

    this.viewer3DImpl.signalProgress(5, ProgressState.ROOT_LOADED, this.model);

    svf.handleHashListRequestFailures(this.loadContext);

    svf.propDbLoader = new PropDbLoader(this.sharedDbPath, this.model, this.viewer3DImpl.api);

    // Ideally this would be just this._lineageUrn = model.getDocumentNode().lineageUrn(), but:
    // getDocumentNode() can be null (there was a customer report, we don't know how that happened, see also https://git.autodesk.com/A360/firefly.js/pull/6349),
    // in which we use the identical svf.urn. However, we can not simply always use svf.urn, because it is not set when loading models locally (e.g. DiffTool tests)
    // Also models uploaded directly to OSS (not via WipDM) don't have a lineage, so lineageUrn returns null.
    this._lineageUrn = model.getDocumentNode() ? .lineageUrn();
    if (!this._lineageUrn) {
        this._lineageUrn = BubbleNode.parseLineageUrnFromDecodedUrn(Autodesk.Viewing.fromUrlSafeBase64(svf.urn));
    }

    // We don't call invalidate here: At this point, the model is not added to the viewer yet (see onSuccess()
    // in Viewer3D.loadModel). So, invalidating would just let other models flicker.
};


// Returns geometry loading progress in integer percent
function getProgress(svf) {
    return Math.floor(100 * svf.fragsLoaded / svf.metadata.stats.num_fragments);
}

// Called whenever a geom load request is finished or or has failed.
OtgLoader.prototype.trackGeomLoadProgress = function(svf, fragId, failed) {

    if (failed) {
        //TODO: failedFrags can be removed, once we make sure
        //that we are not calling this function with the same fragment twice.
        if (svf.failedFrags[fragId]) {
            console.log("Double fail", fragId);
            return;
        }

        svf.failedFrags[fragId] = 1;
    }

    // Inc geom counter and track progress in percent
    var lastPercent = getProgress(svf);

    svf.fragsLoaded++;

    var curPercent = getProgress(svf);

    // Signal progress, but not for each single geometry. Just if the percent value actually changed.
    if (curPercent > lastPercent) {
        this.viewer3DImpl.signalProgress(curPercent, ProgressState.LOADING, this.model);
        //console.log(curPercent, "%");
        //console.log(svf.fragsLoaded, svf.metadata.stats.num_fragments);
    }

    //repaint every once in a while -- more initially, less as the load drags on.
    var geomList = this.model.getGeometryList();
    if (geomList.geomPolyCount > svf.nextRepaintPolys) {
        //logger.log("num loaded " + numLoaded);
        this.firstPixelTimestamp = this.firstPixelTimestamp || Date.now();
        svf.numRepaints++;
        svf.nextRepaintPolys += 100000 * Math.pow(1.5, svf.numRepaints);
        this._requestRepaint();
    }

    //console.log(svf.fragsLoaded, svf.metadata.stats.num_fragments);

    // If this was the last geom to receive...
    if (svf.fragsLoaded === svf.metadata.stats.num_fragments) {
        // Signal that we are done with mesh loading
        this.onOperationComplete();
    }

    this.trackOnDemandLoadProgress();
};

OtgLoader.prototype.trackFragmentListLoadProgress = function() {

    var svf = this.svf;

    function getFragListLoadProgress(svf) {
        return Math.floor(100 * svf.fragsLoadedNoGeom / svf.metadata.stats.num_fragments);
    }
    var lastPercent = getFragListLoadProgress(svf);
    svf.fragsLoadedNoGeom++;
    var percent = getFragListLoadProgress(svf);

    if (percent > lastPercent) {
        this.options.onFragmentListLoadProgress(this.model, percent);
    }
};

OtgLoader.prototype.onOperationComplete = function() {
    this.operationsDone++;

    //Destroy the loader if everything we are waiting to load is done
    if (this.operationsDone === 4)
        this.onGeomLoadDone();
};


OtgLoader.prototype.onMaterialLoaded = async function(matObj, matHash, matId) {

    if (!this.loading) {
        // This can only happen if dtor was called while a loadMaterial call is in progress.
        // In this case, we can just ignore the callback.
        return;
    }

    // get fragIds that need this material
    var fragments = this.pendingMaterials[matHash];

    // Note that onMaterialLoaded is triggered by an EvenListener on geomCache. So, we may also receive calls
    // for materials that we are not wait for, just because other loaders have requested them in parallel.
    // In this case, we must ignore the event.
    if (!fragments) {
        return;
    }

    var matman = this.viewer3DImpl.matman();

    if (matObj) {

        matObj.hash = matHash;
        try {
            var surfaceMat = await matman.convertSharedMaterial(this.model, matObj, matHash);

            TextureLoader.loadMaterialTextures(this.model, surfaceMat, this.viewer3DImpl);

            if (matman.hasTwoSidedMaterials()) {
                this.viewer3DImpl.renderer().toggleTwoSided(true);
            }
        } catch (e) {
            this.svf.failedMaterials[matHash] = 1;
        }

    } else {

        this.svf.failedMaterials[matHash] = 1;

    }

    for (var i = 0; i < fragments.length; i++) {
        this.pendingRequests--;
        this.tryToActivateFragment(fragments[i], "material");
    }

    this.pendingMaterialsCount--;
    delete this.pendingMaterials[matHash];

    // All materials including the override materials due to viewpoints have also been loaded
    if (this.viewpointMatHashes.has(matHash)) {
        this.viewpointMatHashes.delete(matHash);
        if (this.viewpointMatHashes.size === 0) {
            this.onOperationComplete();
        }
    }
};

OtgLoader.prototype.findOrLoadMaterial = function(model, matHash) {

    //check if it's already requested, but the request is not complete
    //
    // NOTE: If another OTG loader adds this material during loading, matman.findMaterial(..) may actually succeed already - even if we have a pending request.
    //       However, we consider the material as missing until the request is finished. In this way, only 2 cases are possible:
    //        a) A material was already loaded on first need => No material requests
    //        b) We requested the material => Once the request is finished, tryToActivate() will be triggered
    //           for ALL fragments using the material - no matter whether the material was added meanwhile by someone else or not.
    //
    //       If we would allow to get materials earlier, it would get very confusing to find out when a fragment is actually finished:
    //       Some fragments would be notified when the load request is done, but some would not - depending on timing.
    if (this.pendingMaterials[matHash]) {
        return false;
    }

    var svf = this.svf;

    //Check if it's already in the material manager
    var matman = this.viewer3DImpl.matman();
    var mat = matman.findMaterial(model, matHash);

    if (mat)
        return true;

    //If it's not even requested yet, kick off the request
    this.pendingMaterialsCount++;
    this.pendingMaterials[matHash] = [];

    var isCDN = !!this.loadContext.otg_cdn;

    var url = svf.makeSharedResourcePath(this.loadContext.otg_cdn, "materials", matHash);

    // load geometry or get it from cache
    var geomCache = this.viewer3DImpl.geomCache();
    geomCache.requestMaterial(url, isCDN, matHash, undefined, this.queryParams, this._lineageUrn);

    return false;
};

OtgLoader.prototype.loadGeometry = function(geomIdx, fragId) {

    var svf = this.svf;

    //get the hash string that points to the geometry
    var geomHash = svf.getGeometryHash(geomIdx);

    ++this.pendingRequests;

    //check if it's already requested, but the request is not complete
    if (this.pendingMeshes[geomHash]) {
        this.pendingMeshes[geomHash].push(fragId);
        return true;
    }

    const geomCache = this.viewer3DImpl.geomCache();
    if (MemoryTracker.memoryLimitReached() && !geomCache.getGeometry(geomHash)) {
        --this.pendingRequests;

        return false;
    }

    //If it's not even requested yet, kick off the request
    this.pendingMeshesCount++;
    this.pendingMeshes[geomHash] = [fragId];

    var isCDN = !!this.loadContext.otg_cdn;


    svf.geomMetadata.hashToIndex[geomHash] = geomIdx;

    var url = svf.makeSharedResourcePath(this.loadContext.otg_cdn, "geometry", geomHash);

    // load geometry or get it from cache
    geomCache.requestGeometry(url, isCDN, geomHash, geomIdx, this.queryParams, this._lineageUrn);

    return true;
};

OtgLoader.prototype.onMeshError = function(geomHash) {

    this.svf.failedMeshes[geomHash] = 1;

    var frags = this.pendingMeshes[geomHash];

    if (!frags) {
        // The failed mesh has been requested by other loaders, but not by this one.
        return;
    }

    for (var i = 0; i < frags.length; i++) {
        this.trackGeomLoadProgress(this.svf, frags[i], true);
        this.pendingRequests--;
    }

    delete this.svf.geomMetadata.hashToIndex[geomHash];
    delete this.pendingMeshes[geomHash];

    this.pendingMeshesCount--;
};

OtgLoader.prototype.onMeshReceived = function(geom) {

    var rm = this.model;

    if (!rm) {
        console.warn("Received geometry after loader was done. Possibly leaked event listener?", geom.hash);
        return;
    }

    var gl = rm.getGeometryList();

    var geomId = this.svf.geomMetadata.hashToIndex[geom.hash];

    //It's possible this fragment list does not use this geometry
    if (geomId === undefined)
        return;

    var geomAlreadyAdded = gl.hasGeometry(geomId);

    var frags = this.pendingMeshes[geom.hash];

    //TODO: The instance count implied by frags.length is not necessarily correct
    //because the fragment list is loaded progressively and the mesh could be received
    //before all the fragments that reference it. Here we don't need absolute correctness.
    if (!geomAlreadyAdded)
        gl.addGeometry(geom, (frags && frags.length) || 1, geomId);
    else
        return; //geometry was already received, possibly due to sharing with the request done by another model loader in parallel

    if (this.svf.loadDone && !this.options.onDemandLoading && !this._selectiveLoadingController.isActive) {
        console.error("Geometry received after load was done");
    }

    this.viewer3DImpl._signalMeshAvailable();

    for (var i = 0; i < frags.length; i++) {
        this.pendingRequests--;
        this.tryToActivateFragment(frags[i], "geom");
    }

    delete this.svf.geomMetadata.hashToIndex[geom.hash];
    delete this.pendingMeshes[geom.hash];
    this.pendingMeshesCount--;
};


OtgLoader.prototype.onGeomLoadDone = function() {
    // Unless selective loading is active, stop listening to geometry receive events.
    // Since all our geometry is loaded, any subsequent geom receive
    // events are just related to requests from other loaders.
    if (!this.options.onDemandLoading && !this._selectiveLoadingController.isActive) {
        this.removeMeshReceiveListener();
    }
    this.svf.loadDone = true;

    //Note that most materials are probably done already as their geometry
    //is received, so this logic will most likely just trigger the textureLoadComplete event.
    TextureLoader.loadModelTextures(this.model, this.viewer3DImpl);

    //If we were asked to just load the model root / metadata, bail early.
    if (this.options.skipMeshLoad) {
        this.currentLoadPath = null;
        this.viewer3DImpl.onLoadComplete(this.model);
        return;
    }

    // We need to keep a copy of the original fragments
    // transforms in order to restore them after explosions, etc.
    // the rotation/scale 3x3 part.
    // TODO: consider only keeping the position vector and throwing out
    //
    //delete this.svf.fragments.transforms;

    // Release that won't be used. the on demand loading won't call this anyway.
    this.svf.fragments.entityIndexes = null;
    this.svf.fragments.mesh2frag = null;
    if (!this.options.onDemandLoading && !this._selectiveLoadingController.isActive) {
        this.svf.geomMetadata.hashes = null;
    }

    var t2 = Date.now();
    var msg = "Fragments load time: " + (t2 - this.t1);
    this.loadTime = t2 - this.t0;

    var firstPixelTime = this.firstPixelTimestamp - this.t0;
    msg += ' (first pixel time: ' + firstPixelTime + ')';

    logger.log(msg);

    // Run optional consolidation step
    if (this.options.useConsolidation) {
        this.viewer3DImpl.consolidateModel(this.model, this.options.consolidationMemoryLimit);
    }

    var modelStats = {
        category: "model_load_stats",
        is_f2d: false,
        has_prism: this.viewer3DImpl.matman().hasPrism,
        load_time: this.loadTime,
        geometry_size: this.model.getGeometryList().geomMemory,
        meshes_count: this.svf.metadata.stats.num_geoms,
        fragments_count: this.svf.metadata.stats.num_fragments,
        urn: this.svfUrn
    };
    if (firstPixelTime > 0) {
        modelStats['first_pixel_time'] = firstPixelTime; // time [ms] from SVF load to first geometry rendered
    }
    logger.track(modelStats, true);

    const geomList = this.model.getGeometryList();
    const dataToTrack = {
        load_time: this.loadTime,
        polygons: geomList.geomPolyCount,
        fragments: this.model.getFragmentList().getCount(),
        mem_usage: geomList.gpuMeshMemory,
        time_to_first_pixel: this.firstPixelTimestamp - this.t0,
        viewable_type: '3d',
    };
    avp.analytics.track('viewer.model.loaded', dataToTrack);





    this.currentLoadPath = null;

    this.viewer3DImpl.onLoadComplete(this.model);
};

OtgLoader.prototype.loadPropertyDb = function() {
    this.svf.propDbLoader.load();
};


OtgLoader.prototype.is3d = function() {
    return true;
};

// Returns promise that resolves to null on failure.
OtgLoader.loadOnlyOtgRoot = function(path, options) {

    // create loadContext
    const basePath = getBasePath(path);
    const queryParams = getQueryParams(options);
    const loadContext = createLoadContext(options, basePath, queryParams);

    // init otg package
    const otg = new OtgPackage();
    otg.basePath = basePath;

    // Just load root json and process its metadata
    const url = pathToURL(path);
    return new Promise((resolve, reject) => {

        loadContext.onFailureCallback = () => resolve(null);
        otg.loadAsyncResource(loadContext, url, "json", function(data) {
            otg.metadata = data;
            otg.manifest = data.manifest;

            // Set numGeoms. Note that this must happen before creating the GeometryList.
            otg.numGeoms = otg.metadata.stats.num_geoms;

            otg.processMetadata(loadContext);

            resolve(otg);
        });
    });
};

// Right after model loading, some fragment data are not available yet.
// E.g. fragments.fragId2DbId will initially contain only zeros and graudally filled afterwards.
// Note that waiting for fragment data doesn't guarantee yet that geometry and materials are already loaded too.
//  @returns {boolean} True when finished, false when canceled or failed.
OtgLoader.prototype.waitForFragmentData = async function() {
    if (this.fragmentDataLoaded) {
        return true;
    }

    const viewer = this.viewer3DImpl.api;
    const scope = this;
    return await new Promise(function(resolve) {

        const clearListeners = () => {
            viewer.removeEventListener(av.MODEL_ROOT_LOADED_EVENT, onLoad);
            viewer.removeEventListener(av.MODEL_UNLOADED_EVENT, onUnload);
        };

        const onLoad = (e) => {
            if (e.model.loader !== scope) {
                return;
            }

            clearListeners();
            resolve(true);
        };

        const onUnload = (e) => {
            if (e.model.loader !== scope) {
                return;
            }

            clearListeners();
            resolve(false);
        };

        // Use the following method.
        // av.waitForCompleteLoad(viewer, options)
        viewer.addEventListener(av.MODEL_ROOT_LOADED_EVENT, onLoad);
        viewer.addEventListener(av.MODEL_UNLOADED_EVENT, onUnload);
    });
};

/**
 * Check if on demand loading is done and send event in that case
 * Fires Autodesk.Viewing.FRAGMENTS_LOADED_EVENT if loading is done
 */
OtgLoader.prototype.trackOnDemandLoadProgress = function() {
    if (this.svf.loadDone && this.fragLoadingInProgress === false && this.pendingRequests === 0)
        this.viewer3DImpl.api.dispatchEvent({
            type: av.FRAGMENTS_LOADED_EVENT,
            loader: this,
            model: this.model
        });
};

/**
 * Interface called by SelectiveLoadingController
 */
OtgLoader.prototype.evaluate = function(fragmentID) {
    if (!this.model || this.options.skipMeshLoad) {
        return;
    }
    // This case is used if fragments are evaluated as they come in.
    if (fragmentID !== undefined) {
        this.tryToActivateFragment(fragmentID, 'fragment');
        return;
    }
    // This branch is used if filtering is deferred, i.e. if we need to wait for the property db.
    // TODO: This only works for the initial filter execution at the moment. Filter updates are not supported yet.
    const fragmentList = this.model.getFragmentList();
    const fragmentLength = fragmentList.fragments.length;
    for (let fragmentID = 0; fragmentID < fragmentLength; ++fragmentID) {
        this.tryToActivateFragment(fragmentID, 'fragment');
    }
};

/**
 * Activates given fragments and loads their referenced geometries and materials if necessary.
 * Already activated fragments are skipped and calls are ignored during initial load
 *
 * @param {number[]} fragIds - IDs of fragments to load
 * @returns {number} Number of loaded fragments
 */
OtgLoader.prototype.loadFragments = function(fragIds) {
    // TODO: Make this work while initial load is happening
    if (!this.svf.loadDone) {
        logger.warn("Trying to call loadFragments while model is not fully loaded yet.");
        return 0;
    }

    if (MemoryTracker.memoryLimitReached())
        return 0;

    // Reset to get repaints while loading
    this.svf.nextRepaintPolys = 0;
    this.svf.numRepaints = 0;

    let fragsLoaded = 0;
    const fl = this.model.getFragmentList();

    this.fragLoadingInProgress = true;
    for (const fragId of fragIds) {
        if (fl.isFlagSet(fragId, avp.MeshFlags.MESH_NOTLOADED)) {
            fl.setFlagFragment(fragId, avp.MeshFlags.MESH_NOTLOADED, false);
            fl.setFragOff(fragId, false);
            fl.setVisibility(fragId, true);

            this.tryToActivateFragment(fragId, 'fragment');
            ++fragsLoaded;
        }
    }
    this.fragLoadingInProgress = false;

    // trigger load event in case no materials or geometries need to be fetched
    if (fragsLoaded)
        this.trackOnDemandLoadProgress();

    return fragsLoaded;
};

FileLoaderManager.registerFileLoader("json", ["json"], OtgLoader);