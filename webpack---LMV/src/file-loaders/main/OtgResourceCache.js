    import {
        isMobileDevice,
        isChrome,
        getGlobal,
        isNodeJS
    } from "../../compat";
    import {
        BufferGeometryUtils
    } from "../../wgs/scene/BufferGeometry";
    import {
        createWorker
    } from "./WorkerCreator";
    import {
        initLoadContext
    } from "../net/endpoints";
    import {
        EventDispatcher
    } from "../../application/EventDispatcher";
    import {
        getParameterByName
    } from "../../globals";
    import {
        OtgPriorityQueue,
        updateGeomImportance
    } from "../lmvtk/otg/OtgPriorityQueue";
    import {
        LocalDbCache
    } from "../lmvtk/otg/LocalDbCache";
    import {
        MemoryTracker
    } from '../../wgs/scene/MemoryTracker';
    import {
        BandwidthOptimizer
    } from './BandwidthOptimizer';

    export var MESH_RECEIVE_EVENT = "meshReceived";
    export var MESH_FAILED_EVENT = "meshFailed";
    export var MATERIAL_RECEIVE_EVENT = "materialReceived";
    export var MATERIAL_FAILED_EVENT = "materialFailed";
    export var PENDING_REQUESTS_FINISHED_EVENT = "requestsInProgressFinished";

    let avp = Autodesk.Viewing.Private;
    let useOpfs = getParameterByName('useOPFS') === 'true' || getGlobal().USE_OPFS;
    const useAdaptiveStreaming = getParameterByName('useAdaptiveStreaming') === 'true' || getGlobal().USE_ADAPTIVE_STREAMING;
    const disableIndexedDb = getParameterByName("disableIndexedDb").toLowerCase() === "true" || getGlobal().DISABLE_INDEXED_DB;
    const disableWebSocket = getParameterByName("disableWebSocket").toLowerCase() === "true" || getGlobal().DISABLE_WEBSOCKET;
    let disableHashCache = disableIndexedDb || useOpfs || !isChrome();

    const GEOM_ERROR = {
        dummy_value: "error"
    };
    const MAT_ERROR = {
        dummy_value: "error"
    };

    function initLoadContextGeomCache(msg) {
        var ctx = initLoadContext(msg);
        ctx.disableIndexedDb = disableIndexedDb;
        ctx.disableWebSocket = disableWebSocket;
        return ctx;
    }

    // Helper function used for cache cleanup
    function compareGeomsByImportance(geom1, geom2) {
        return geom1.importance - geom2.importance;
    }

    /** Shared cache of BufferGeometries and material JSONs used by different OtgLoaders. 
     *  @param {Object} [options] - optional parameters
     *  @param {Object} [options.cache] - optional parameters for cache
     *  @param {string} [options.cache.type] - type of cache to use, 'OPFS' or unset
     */
    export function OtgResourceCache(options) {

        // all geometries, indexed by geom hashes
        var _geoms = new Map();
        var _mats = new Map();

        // A single geometry may be requested by one or more model loaders.
        // This map keeps track of requests already in progress so that
        // we don't issue multiple simultaneously
        var _hash2Requests = {};

        var opfsCacheEnabledByOptions = options ? .cache ? .type === 'OPFS';
        if (useOpfs || opfsCacheEnabledByOptions) {
            useOpfs = true;
            disableHashCache = true;
        }

        // worker for geometry loading
        var _loadWorker = createWorker();
        _loadWorker.addEventListener('message', handleLoadWorkerMessage);

        var NUM_DECODE_WORKERS = isMobileDevice() ? 2 : 4;
        var _decodeWorkers = [];
        var _decoderPorts = [];

        // Setup message channels for decodeWorkers
        // The loadWorker sends messages to the decodeWorkers, which send messages back here.
        for (var i = 0; i < NUM_DECODE_WORKERS; i++) {
            _decodeWorkers.push(createWorker());
            _decodeWorkers[i].addEventListener('message', handleDecodeWorkerMessage);
            const channel = new MessageChannel();
            _decodeWorkers[i].doOperation({
                operation: "INSTALL_INPUT_PORT",
                port: channel.port2
            }, [channel.port2]);
            _decoderPorts.push(channel.port1);
        }

        const ctx = initLoadContextGeomCache({
            operation: "INIT_WORKER_OTG",
            ports: _decoderPorts,
            useOpfs: useOpfs,
            // clear IndexedDB only if OPFS is enabled by the options (presumably by feature flags of our applications)
            // and not by global variable or URL parameter (presumably someone is just testing it)
            clearIndexedDbIfItsLarge: opfsCacheEnabledByOptions
        });
        let transferList = _decoderPorts.slice();
        _loadWorker.doOperation(ctx, transferList);

        this.initialized = true;

        let _bwo, startTs;
        this.bandwidthOptimizer = () => {
            if (!_bwo && !startTs) {
                startTs = Date.now();
            }

            // start the adaptive streaming after establishing initial conditions
            if (_bwo || this.requestsReceived < _maxRequestsInFlight * 2) {
                return _bwo;
            }

            // create initial fragment average
            // TODO: Need to figure out if we need separate out materials and geometries...
            const initialAssetEstimate = (this.byteSize / this.requestsReceived) * 0.9;
            const avgBytesSec = this.byteSize / ((Date.now() - startTs) / 1000);

            if (useAdaptiveStreaming) {
                _bwo = BandwidthOptimizer.createAndStart(_meshRequestsInProgress + _materialRequestsInProgress, initialAssetEstimate, avgBytesSec, flightSize => {
                    _maxRequestsInFlight = flightSize;
                });
            }

            return _bwo;
        };

        // track memory consumption
        this.byteSize = 0;
        this.refCount = 0;

        // improve hash lookup
        this.cachedHashesDb = undefined;
        this.cachedHashes = null;
        this.cachedHashesPending = false;
        this.cachedHashesEstimate = undefined;
        this.cachedHashesEstimatePending = false;
        this.fromCacheCount = 0;
        this.fromRemoteCount = 0;

        // track total counts to simplify debugging
        this.requestsSent = 0;
        this.requestsReceived = 0;

        // A request is called in-progress if we have sent it to the worker and didn't receive a result yet.
        // We restrict the number of requests in progress. If the limit is reached, all additional requests
        // are enqueued.
        var _materialRequestsInProgress = 0;
        var _meshRequestsInProgress = 0;
        // When changing this, check constants in OtgLoadWorker
        const _defaultMaxRequestsInFlight = useAdaptiveStreaming ? BandwidthOptimizer.MIN_FLIGHT : BandwidthOptimizer.FALLBACK_FLIGHT;
        var _maxRequestsInFlight = _defaultMaxRequestsInFlight;
        var _timeout = undefined;

        var _queue = new OtgPriorityQueue();

        var _this = this;

        // mem limits for cache cleanup
        var MB = 1024 * 1024;
        this._maxMemory = 100 * MB; // geometry limit at which cleanup is activated
        this._minCleanup = 50 * MB; // minimum amount of freed memory for a single cleanup run

        // Keep track of unused geometries.
        // A geometry is tracked as unused if it was used by at least one model and then got removed from all models.
        // This map keep track of which geometries are unused (it stores geom.id -> geometry instance).
        var _unusedGeomsMap = new Map();

        // Needed to determine when the dtor can be called (once the last viewer got removed)
        var _viewers = [];

        this._numActiveLoaders = 0;

        this.addViewer = function(viewer) {
            _viewers.push(viewer);
            _queue.addViewer(viewer);
        };

        this.removeViewer = function(viewer) {
            const index = _viewers.indexOf(viewer);

            if (index !== -1) {
                _queue.removeViewer(viewer);
                _viewers.splice(index, 1);
            }

            if (_viewers.length === 0) {
                this.dtor();
            }
        };

        this.dtor = function() {
            _viewers = [];

            _loadWorker.terminate();
            _loadWorker = null;

            for (const decodeWorker of _decodeWorkers) {
                decodeWorker.terminate();
            }
            _decodeWorkers = [];

            _geoms = null;
            _mats = null;

            this._clearHashCache();

            this.initialized = false;
        };

        // Chrome's implementation of IndexDb (LevelDb) doesn't perform very well with our workload (heavy scattered writes when loading from the net
        // interspersed with reads). The mere attempt to read a non-existing mesh can become so slow that it starves the download from the backend.
        // Solution is to read the set of hashes in the cache once and use it to skip expensive cache misses.
        //
        // The hash cache will only contain approximate information. If the cache exceeds its quota, LMV will delete some meshes, which is not tracked.
        // This is why only the information "not in cache" is treated as certain.
        this._loadHashCache = function() {
            // db must have been created before
            if (this.cachedHashesPending) {
                return;
            }

            this.cachedHashesPending = true;

            this.cachedHashesDb.open(() => {
                this.cachedHashesDb.readAllCachedHashes((hashesArray) => {
                    this.cachedHashes = new Set(hashesArray);
                    this.cachedHashesPending = false;
                });

                // no need to read anything else
                this.cachedHashesDb = undefined;
            });
        };

        this._clearHashCache = function() {
            this.cachedHashes = null;
        };

        this._getHashCacheEstimate = function() {
            if (this.cachedHashesEstimatePending) {
                return;
            }

            this.cachedHashesDb = new LocalDbCache(disableIndexedDb, false);
            this.cachedHashesDb.open(null);
            this.cachedHashesEstimatePending = true;

            this.cachedHashesDb.open(() => {
                this.cachedHashesDb.estimateCachedHashCount((count) => {
                    this.cachedHashesEstimate = count;
                    // if an error happened (count is undefined), do not try again
                    this.cachedHashesEstimatePending = (count === undefined);
                });
            });
        };

        function couldBeInCache(_this, hash) {
            return !_this.cachedHashes || _this.cachedHashes.has(hash);
        }

        // Reading all hashes from the cache can also be expensive. As a remediation, the cache miss rate is monitored. If the estimated
        // number of cache misses is sufficiently high, the number of cache entries is quickly estimated. If the ratio between cache entries
        // and cache misses falls below a threshold, all hashes are read and used for avoiding further cache misses.
        this._handleCache = function() {
            // cache already loaded or irrelevant?
            if (this.cachedHashes || disableHashCache) {
                return;
            }

            // constants for the heuristic
            const MIN_TOTAL_COUNT_FOR_FIRST_ESTIMATION = 200;
            const MIN_REMOTE_COUNT_FOR_SECOND_ESTIMATION = 1000;
            const MAX_CACHED_HASHES_PER_REMOTE_REQUEST = 50;

            // sufficient data to make a decision?
            const receivedCount = this.fromCacheCount + this.fromRemoteCount;
            if (receivedCount < MIN_TOTAL_COUNT_FOR_FIRST_ESTIMATION) {
                return;
            }

            // estimate how many requests will be served from remote
            const remoteRequestEstimate = _queue.waitCount() * this.fromRemoteCount / receivedCount;

            // need to find out how many entries are in the cache
            if (this.cachedHashesEstimate == undefined) {
                // only check if there will be sufficiently many network requests
                if (remoteRequestEstimate > MIN_REMOTE_COUNT_FOR_SECOND_ESTIMATION) {
                    this._getHashCacheEstimate();
                }
                return;
            }

            // check if it is worth loading the cache information given how many network requests we expect
            if (this.cachedHashesEstimate < remoteRequestEstimate * MAX_CACHED_HASHES_PER_REMOTE_REQUEST) {
                this._loadHashCache();
            }
        };

        // function to handle messages from OtgLoadWorker (posted in onGeometryLoaded)
        function handleDecodeWorkerMessage(msg) {

            if (!msg.data) {
                return;
            }

            //Schedule another spin through the task queue
            if (!_queue.isEmpty() && !_timeout) {
                _timeout = setTimeout(processQueuedItems, 0);
            }

            let totalSize = 0;

            if (msg.data.materials) {
                for (let i = 0; i < msg.data.materials.length; i++) {
                    const hash = msg.data.hashes[i];
                    const mat = msg.data.materials[i];

                    _materialRequestsInProgress--;
                    _this.requestsReceived++;

                    // add material to cache
                    _mats.set(hash, mat);

                    // pass geometry to all receiver callbacks
                    _this.fireEvent({
                        type: MATERIAL_RECEIVE_EVENT,
                        material: mat,
                        hash: hash
                    });
                    totalSize += mat.byteLength;

                    delete _hash2Requests[hash];
                }
            } else {

                const meshlist = msg.data;

                for (var i = 0; i < meshlist.length; i++) {
                    _meshRequestsInProgress--;
                    _this.requestsReceived++;

                    var mdata = meshlist[i];

                    if (mdata.hash && mdata.mesh) {

                        // convert geometry data to GeometryBuffer
                        // Moving this to the OtgLoadWorker results in "WebGL: INVALID_OPERATION: drawElements: no buffer is bound to enabled attribute"
                        var geom = BufferGeometryUtils.meshToGeometry(mdata);

                        let geometrySize = MemoryTracker.getGeometrySize(geom);

                        if (!MemoryTracker.memoryHardLimitReached(geometrySize)) {
                            // add geom to cache
                            _this.addGeometry(mdata.hash, geom);

                            // free old unused geoms if necessary
                            _this.cleanup();

                            // pass geometry to all receiver callbacks
                            _this.fireEvent({
                                type: MESH_RECEIVE_EVENT,
                                geom: geom
                            });
                        }

                        delete _hash2Requests[mdata.hash];
                        mdata.fromCache ? ++_this.fromCacheCount : ++_this.fromRemoteCount;
                        totalSize += geom.byteSize;

                    }
                }

                if (MemoryTracker.memoryLimitReached() && _meshRequestsInProgress === 0) {
                    _this.fireEvent({
                        type: PENDING_REQUESTS_FINISHED_EVENT
                    });
                }
            }

            _this.bandwidthOptimizer() ? .onResourceReceived(
                msg.data ? .materials ? .length || msg.data ? .length, totalSize);
            _this._handleCache();
        }

        function handleLoadWorkerMessage(msg) {
            if (msg.data.error) {

                //Schedule another spin through the task queue
                if (!_queue.isEmpty() && !_timeout) {
                    _timeout = setTimeout(processQueuedItems, 0);
                }

                var error = msg.data.error;
                var hash = error.args.hash;

                // inform affected clients.
                if (error.args.resourceType === "m") {
                    _materialRequestsInProgress--;
                    _mats.set(hash, MAT_ERROR);
                    _this.fireEvent({
                        type: MATERIAL_FAILED_EVENT,
                        hash: hash
                    });
                    console.error("Error loading material.", error.msg, error.args);
                } else {
                    _meshRequestsInProgress--;
                    _geoms.set(hash, GEOM_ERROR);
                    _this.fireEvent({
                        type: MESH_FAILED_EVENT,
                        hash: hash
                    });
                    console.error("Error loading mesh.", error.msg, error.args);
                }

                delete _hash2Requests[error.hash];

                // track number of requests in progress
                _this.requestsReceived++;
                return;
            } else if (msg.data.event && msg.data.properties) {
                avp.analytics.track(msg.data.event, msg.data.properties);
            } else {
                console.error("Unknown message from worker", msg.data);
            }
        };

        this.loaderAdded = function(modelUrn, lineageUrn) {
            this._numActiveLoaders++;
            var msg = {
                operation: "ADD_MODEL_OTG",
                modelUrn: modelUrn,
                lineageUrn: lineageUrn,
                useOpfs
            };

            _loadWorker.doOperation(initLoadContextGeomCache(msg));

            // a new model gets added => restart cache stats
            this.fromCacheCount = 0;
            this.fromRemoteCount = 0;
        };

        this.loaderRemoved = function() {
            this._numActiveLoaders--;
            if (this._numActiveLoaders !== 0) {
                return;
            }

            // let go of accumulated hashes.
            this._clearHashCache();

            var msg = {
                operation: "FLUSH_CACHE_AND_DISCONNECT_OTG"
            };
            _loadWorker.doOperation(msg);
        };


        /**  Get a geometry from cache or load it.
         *    @param {string}   url         - full request url of the geometry/ies resource
         *    @param {boolean}  isCDN       - whether the URL is pointing to a public edge cache endpoint
         *    @param {string}   geomHash    - hash key to identify requested geometry/ies
         *    @param {int} geomIdx          - the geometry ID/index in the model's geometry hash list (optional, pass 0 to skip use of geometry packs)
         *    @param {string}   queryParams - additional param passed to file query
         */
        this.requestGeometry = function(url, isCDN, geomHash, geomIdx, queryParams, lineageUrn) {

            // if this geometry is in memory, just return it directly
            var geom = _geoms.get(geomHash);
            if (geom === GEOM_ERROR) {
                //it failed to load previously
                if (isNodeJS()) {
                    setImmediate(() => this.fireEvent({
                        type: MESH_FAILED_EVENT,
                        hash: geomHash
                    }));
                } else {
                    this.fireEvent({
                        type: MESH_FAILED_EVENT,
                        hash: geomHash
                    });
                }
                return;
            } else if (geom) {
                //it was already cached
                if (isNodeJS()) {
                    setImmediate(() => this.fireEvent({
                        type: MESH_RECEIVE_EVENT,
                        geom: geom
                    }));
                } else {
                    this.fireEvent({
                        type: MESH_RECEIVE_EVENT,
                        geom: geom
                    });
                }
                return;
            }

            // if geometry is already loading, just increment
            // the request counter.
            var task = _hash2Requests[geomHash];
            if (task && task.refcount) {
                task.importanceNeedsUpdate = true;
                task.refcount++;
                return;
            }

            // geom is neither in memory nor loading.
            // we have to request it.
            var msg = {
                operation: "LOAD_CDN_RESOURCE_OTG",
                type: "g",
                url: url,
                lineageUrn: lineageUrn,
                isCDN: isCDN,
                hash: geomHash,
                queryParams: queryParams,
                importance: 0.0,
                geomIdx: geomIdx,
                importanceNeedsUpdate: true, // compute actual importance later in updatePriorities
                refcount: 1
            };

            _queue.addTask(msg);
            _hash2Requests[geomHash] = msg;

            if (!_timeout) {
                _timeout = setTimeout(processQueuedItems, 0);
            }

        };


        this.requestMaterial = function(url, isCDN, matHash, matIdx, queryParams, lineageUrn) {

            // if this material is in memory, just return it directly
            var mat = _mats.get(matHash);
            if (mat === MAT_ERROR) {
                //it failed to load previously
                setImmediate(() => this.fireEvent({
                    type: MATERIAL_FAILED_EVENT,
                    error: mat,
                    hash: matHash,
                    repeated: true
                }));
                return;
            } else if (mat) {
                //it was already cached
                setImmediate(() => this.fireEvent({
                    type: MATERIAL_RECEIVE_EVENT,
                    material: mat,
                    hash: matHash
                }));
                return;
            }

            // if material is already loading, just increment
            // the request counter.
            var task = _hash2Requests[matHash];
            if (task && task.refcount) {
                task.refcount++;
                return;
            }

            // material is neither in memory nor loading.
            // we have to request it.
            var msg = {
                operation: "LOAD_CDN_RESOURCE_OTG",
                type: "m",
                urls: [url],
                lineageUrns: [lineageUrn],
                hashes: [matHash],
                isCDN: isCDN,
                queryParams: queryParams,
                refcount: 1,
                couldBeInCache: [couldBeInCache(this, matHash)],
            };

            _hash2Requests[matHash] = msg;

            //Material requests are sent to the worker immediately, without going through the
            //priority queue.
            _loadWorker.doOperation(initLoadContextGeomCache(msg));
            _materialRequestsInProgress++;
            this.requestsSent++;
        };

        function processQueuedItems() {

            var howManyCanWeDo = _maxRequestsInFlight - (_meshRequestsInProgress + _materialRequestsInProgress);

            // avoid the overhead of very small messages
            if (howManyCanWeDo <= _maxRequestsInFlight * 0.01) {
                _timeout = setTimeout(processQueuedItems, 30);
                return;
            }

            // recompute importance for each geometry and sort queue by decreasing priority
            _queue.updateRequestPriorities();

            var tasksAdded = 0;
            var msg = null;
            while (!_queue.isEmpty() && tasksAdded < howManyCanWeDo) {

                var task = _queue.takeTask();

                if (!msg) {
                    msg = {
                        operation: "LOAD_CDN_RESOURCE_OTG",
                        type: "g",
                        urls: [task.url],
                        lineageUrns: [task.lineageUrn],
                        hashes: [task.hash],
                        isCDN: task.isCDN,
                        queryParams: task.queryParams,
                        couldBeInCache: [couldBeInCache(_this, task.hash)],
                    };
                } else {
                    msg.urls.push(task.url);
                    msg.hashes.push(task.hash);
                    msg.lineageUrns.push(task.lineageUrn);
                    msg.couldBeInCache.push(couldBeInCache(_this, task.hash));
                }
                tasksAdded++;
            }

            if (msg) {
                // send request to worker
                _loadWorker.doOperation(initLoadContextGeomCache(msg));
                _meshRequestsInProgress += msg.urls.length;
                _this.requestsSent += msg.urls.length;
            }

            _timeout = undefined;
        }

        // remove all open requests of this client
        // input is a map whose keys are geometry hashes
        this.cancelRequests = function(geomHashMap) {

            for (var hash in geomHashMap) {
                var task = _hash2Requests[hash];

                if (task)
                    task.refcount--;
                /*
                if (task.refcount === 1) {
                    delete _hash2Requests[hash];
                }*/
            }

            _queue.filterTasks((hash) => {
                // TODO: Analyze why `req` can be undefined. Story: https://jira.autodesk.com/browse/FLUENT-5734
                const req = _hash2Requests[hash];
                const keep = req && req.refcount;
                if (!keep) {
                    delete _hash2Requests[hash];
                }
                return keep;
            });

            // TODO: To make switches faster, we should also inform the worker thread,
            //       so that it doesn't spend too much time with loading geometries that noone is waiting for.
        };

        // To prioritize a geometry, we track the bbox surface area of all fragments using it.
        //
        // For this, this function must be called for each new loaded fragment.
        //  @param {RenderModel} model
        //  @param {number}      fragId
        this.updateGeomImportance = function(model, fragId) {
            return updateGeomImportance(model, fragId);
        };

        this.cleanup = function(force) {

            if (_unusedGeomsMap.size === 0 || (!force && this.byteSize < this._maxMemory)) {
                return;
            }

            var _unusedGeoms = [];
            for (let geom of _unusedGeomsMap.values()) {
                _unusedGeoms.push(geom);
            }

            // Sort unused geoms by ascending importance
            _unusedGeoms.sort(compareGeomsByImportance);

            // Since cleanup is too expensive to run per geometry,
            // we always remove a bit more than strictly necessary,
            // so that we can load some more new geometries before we have to
            // run cleanup again.
            var targetMem = force ? 0 : this._maxMemory - this._minCleanup;

            // Remove geoms until we reach mem target
            var i = 0;
            for (; i < _unusedGeoms.length && this.byteSize >= targetMem; i++) {

                var geom = _unusedGeoms[i];

                // remove it from cache
                _geoms.delete(geom.hash);
                _unusedGeomsMap.delete(geom.id);

                // update mem consumption. Note that we run this only for geoms that
                // are not referenced by any RenderModel in memory, so that removing them
                // should actually free memory.
                this.byteSize -= geom.byteSize;

                // Dispose GPU mem.
                // NOTE: In case we get performance issues in Chrome, try commenting this out
                // (see hack in GeometryList.dispose)
                geom.dispose();
            }
        };


        // Wait for specific hashes and push their priority to finish faster.
        //
        // Note: This function does not trigger own requests, i.e. can only be used for hashes of models
        //       that are currently loading.
        //
        //  @param {Object} hashMap          - keys specify hashes. All keys with hashMap[key]===true will be loaded. 
        //  @param {function(Object)} onDone - called with hashMap. hashMap[hash] will contain the geometry.
        this.waitForGeometry = function(hashMap, onDone) {

            // track how many of our geoms are finished
            var geomsDone = 0;
            var geomsTodo = _queue.makeUrgent(hashMap);

            // avoid hanging if hashMap is empty
            if (geomsTodo === 0) {
                if (hashMap) {
                    onDone(hashMap);
                    return;
                }
            }

            processQueuedItems();

            function onGeomDone(hash, geom) {
                // If a geometry is not loading anymore, its priority has no relevance anymore.
                // Note that this is generally true - even if we didn't set the priority in this waitForGeometry call. 
                _queue.removeUrgent(hash);

                // Only care for geometries that we need to fill the hashMap values 
                if (!hashMap[hash] === true) {
                    return;
                }

                hashMap[hash] = geom;

                // check if all done
                geomsDone++;
                if (geomsDone < geomsTodo) {
                    return;
                }

                // cleanup listeners
                _this.removeEventListener(MESH_RECEIVE_EVENT, onGeomReceived);
                _this.removeEventListener(MESH_FAILED_EVENT, onGeomFailed);

                onDone(hashMap);
            }

            function onGeomReceived(event) {
                onGeomDone(event.geom.hash, event.geom);
            }

            function onGeomFailed(event) {
                onGeomDone(event.hash, undefined);
            }

            this.addEventListener(MESH_RECEIVE_EVENT, onGeomReceived);
            this.addEventListener(MESH_FAILED_EVENT, onGeomFailed);

            // Don't wait forever for any meshes that were already loaded
            for (let hash in hashMap) {
                var geom = _geoms.get(hash);
                if (geom) {
                    onGeomDone(hash, geom);
                }
            }
        };

        this.getGeometry = function(hash) {
            return _geoms.get(hash);
        };

        this.addGeometry = function(hash, geom) {
            _geoms.set(hash, geom);

            // track summed cache size in bytes
            _this.byteSize += geom.byteSize;

            if (Object.prototype.hasOwnProperty.call(geom, '_modelRefCount')) {
                return;
            }
            geom._modelRefCount = 0;

            const prototype = Object.getPrototypeOf(geom);
            if (Object.prototype.hasOwnProperty.call(prototype, 'modelRefCount')) {
                return;
            }
            Object.defineProperty(prototype, 'modelRefCount', {
                get() {
                    return this._modelRefCount;
                },
                set(value) {
                    if (this._modelRefCount === 0 && value > 1) {
                        const unused = _unusedGeomsMap.get(this.id);
                        if (unused) {
                            _unusedGeomsMap.delete(this.id);
                        }
                    } else if (value === 0) {
                        _unusedGeomsMap.set(this.id, this);
                    }
                    this._modelRefCount = value;
                }
            });
        };

        // Add material to cache. Note that the cache doesn't store actual Material instances,
        // but rather the source data from the materials file.
        //  @param {string}     hash
        //  @param {Uint8Array} data - a Uint8 blob, containing a material-file json as Utf8.
        this.addMaterialData = function(hash, data) {
            _mats.set(hash, data);
        };

        this.clearOpfsCache = function() {
            // Note I wanted to print navigator.storage.estimate before and after, but it was incorrect.
            // Chrome underreported file system usage, it looked like it was confused by a second directory in the filesystem
            const msg = {
                operation: "CLEAR_OPFS_CACHE",
            };
            _loadWorker.doOperation(msg);
        };

        // For error diagnosis: If something gets stuck during loading, this report helps
        // figuring out where it happens.
        this.reportLoadingState = function() {

            // Report main thread stats
            console.log('OtgResourceCache:', {
                sent: this.requestsSent,
                received: this.requestsReceived
            });

            const msg = {
                operation: "REPORT_LOADING_STATE",
            };
            _loadWorker.doOperation(msg);
        };
    }

    EventDispatcher.prototype.apply(OtgResourceCache.prototype);