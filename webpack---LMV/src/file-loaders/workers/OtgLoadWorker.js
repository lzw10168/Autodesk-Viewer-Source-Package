import {
    ViewingService
} from "../net/Xhr";
import {
    LocalDbCache,
    clearIndexedDbIfItsLarge
} from "../lmvtk/otg/LocalDbCache";
import {
    OPFSCache
} from "../lmvtk/otg/OPFSCache.ts";
import {
    gzipSync
} from 'fflate';
import {
    OtgWs
} from "../lmvtk/otg/OtgWebSocket";
import {
    STATE
} from "../lmvtk/otg/WebSocketBase";


// OtgLoadWorker implements the "LOAD_CDN_RESOURCE_OTG" operation.

const NUM_WEBSOCKETS = 2;
// Avoid batch requests with below this size. Should be some small percentage of OtgResourceCache._maxRequestsInFlight.
// This made no observable perf difference, but the derivative service team likes larger batches.
const SMALL_MESSAGE_THRESHOLD = 20;
// When the number of in flight requests falls below this, send small messages again,
// to avoid not sending the last SMALL_MESSAGE_THRESHOLD-1 messages for too long.
// Should be some moderate percentage of OtgResourceCache._maxRequestsInFlight.
const IN_FLIGHT_THRESHOLD_FOR_SMALL_MESSAGES = 400;

//Do not store state data directly in "self" because in the node.js code path
//there are no separate worker contexts
function getWorkerContext(loadContext) {

    //Initialize the worker context -- we cannot use module/global vars here,
    //because in node.js the module variables are shared for all instances of the worker.
    if (!loadContext.worker.ctx) {

        loadContext.worker.ctx = {

            otgws: [],
            localDbCache: null,
            opfsCache: null,

            numRequests: 0,

            pendingForNetwork: [],

            // Keeps batches of geoms to be sent to decoder threads
            _pendingGeomHashes: [],
            _pendingGeoms: [],
            _pendingFromCache: [],
            _pendingTransferList: [],

            // Track total counts to simplify debugging
            _requestsSent: 0,
            _requestsReceived: 0,

            decoderPorts: [],
            nextPortIndex: 0,

            analyticsForHttpFallbackSent: false,
        };
    }

    return loadContext.worker.ctx;
}

function doInitGeomWorker(loadContext) {
    var ctx = getWorkerContext(loadContext);

    if (!loadContext.disableWebSocket) {
        const onResourcesReceived = (hashes, lineageUrns, arrays, resourceType) => onCdnResourcesReceived(loadContext, hashes, lineageUrns, arrays, false, resourceType);
        const onResourceFailed = (hash, resourceType, errorMessage) => onCdnResourceFailed(loadContext, hash, resourceType, errorMessage);
        const onConnectionFailed = (inprogress) => retryPending(loadContext, inprogress);
        for (let i = 0; i < NUM_WEBSOCKETS; i++) {
            ctx.otgws.push(new OtgWs(loadContext.otg_ws, loadContext.queryParams, loadContext.headers, onResourcesReceived, onResourceFailed, onConnectionFailed));
        }
    }

    if (loadContext.useOpfs) {
        const analyticsCallback = (event, properties) => {
            loadContext.worker.postMessage({
                event,
                properties
            });
        };
        ctx.opfsCache = new OPFSCache(analyticsCallback);
        if (loadContext.clearIndexedDbIfItsLarge) {
            clearIndexedDbIfItsLarge();
        }
    } else {
        ctx.localDbCache = new LocalDbCache(loadContext.disableIndexedDb);
        ctx.localDbCache.open(null);
    }

    ctx.decoderPorts = loadContext.ports;
}

function doAddModel(loadContext) {
    var ctx = getWorkerContext(loadContext);
    for (const ws of ctx.otgws) {
        ws.addAuthorizeUrn(loadContext.modelUrn);
    }
    if (loadContext.useOpfs) {
        ctx.opfsCache.open(loadContext.lineageUrn);
    }

    if (!ctx.flushMessages) {
        ctx.flushMessages = setInterval(() => {
            _loadCdnResourceFromNetworkBatch(loadContext);
            flushMessagesToDecoderThread(loadContext);
        }, 25);
    }
}

// Use custom error handler: It  forwards to the default one, but...
//  1. adds the geometry hash to the error message. This is needed by the geometry cache.
//     We use it to determine for which geometry the problem occurred, so that the affected
//     loaders can be informed (see OtgResourceCache.js).
//  2. If any other requests were blocked before to limit the number of parallel
//     requests, we must make sure that these enqueued requests are processed too.
function getHttpErrorHandler(loadContext, hash, resourceType) {

    // add error handler to override raiseError function
    var errorHandler = {
        // add hash and pass on to loadContext.raiseError.
        raiseError: function(code, msg, args) {
            args.hash = hash;
            args.resourceType = resourceType;
            loadContext.raiseError(code, msg, args);
        }
    };

    return function() {
        // forward to default error handler
        ViewingService.defaultFailureCallback.apply(errorHandler, arguments);

        onCdnResourceProcessed(loadContext);
    };
}

function onCdnResourceFailed(loadContext, hash, resourceType, errorMessage) {
    loadContext.raiseError(null, errorMessage, {
        hash: hash,
        resourceType: resourceType
    });
    onCdnResourceProcessed(loadContext);
}

function retryPending(loadContext, inprogress) {
    for (const [hash, value] of inprogress) {
        loadContext.queryParams = value.queryParams;
        loadCdnResources(loadContext, [hash], [value.url], [value.lineageUrn], value.type);
    }
}

function isGzip(data) {
    return data[0] === 31 && data[1] === 139;
}

function onCdnResourcesReceived(loadContext, hashes, lineageUrns, arrays, skipCache, resourceType) {
    const ctx = getWorkerContext(loadContext);

    if (!skipCache) {
        if (ctx.opfsCache) {
            ctx.opfsCache.store(hashes, lineageUrns, arrays);
        } else {
            for (let i = 0; i < hashes.length; i++) {
                const hash = hashes[i];
                let data = arrays[i];
                // If the HTTP fallback was used, the browser already did the decompression
                // Also, we did encounter uncompressed blobs in production.
                if (!isGzip(data)) {
                    data = gzipSync(data);
                }
                ctx.localDbCache ? .store(hash, data);
                // ctx.opfsCache?.store(hash, lineageUrns[i], data);
            }
        }
    }

    if (resourceType === "m") {
        //Post materials as soon as possible without batching -- those are fewer
        //and more critical as they are shared across multiple meshes.
        const port = ctx.decoderPorts[ctx.nextPortIndex];
        ctx.nextPortIndex = ++ctx.nextPortIndex % ctx.decoderPorts.length;
        port.postMessage({
            operation: "DECODE_MATERIALS",
            hashes: hashes,
            arrays: arrays,
        }, [arrays[0].buffer]);
    } else {
        // Each message has a bit of overhead, both when sending and receiving,
        // and both in the decoder thread and the main thread afterwards.
        // Therefore we batch here, even though it introduces a bit of latency.
        // Ideally, cache and websockets would always return batches, then we could remove this.
        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            const data = arrays[i];
            ctx._pendingGeomHashes.push(hash);
            ctx._pendingGeoms.push(data);
            ctx._pendingFromCache.push(skipCache);
            if (i === 0 || data.buffer !== arrays[0].buffer) {
                ctx._pendingTransferList.push(data.buffer);
            }
        }
        // Since the OPFS cache can return very large batches, 
        // ensure that batches are split across decoder threads.
        if (ctx._pendingGeomHashes.length > 50) {
            flushMessagesToDecoderThread(loadContext);
        }
    }
    onCdnResourceProcessed(loadContext, hashes.length);
}

// Sends recently received (since last flush) resources to the decoders
function flushMessagesToDecoderThread(loadContext) {

    var ctx = getWorkerContext(loadContext);

    if (!ctx._pendingGeomHashes.length)
        return;

    const port = ctx.decoderPorts[ctx.nextPortIndex];
    ctx.nextPortIndex = ++ctx.nextPortIndex % ctx.decoderPorts.length;
    port.postMessage({
        operation: "DECODE_GEOMETRIES",
        hashes: ctx._pendingGeomHashes,
        arrays: ctx._pendingGeoms,
        fromCache: ctx._pendingFromCache,
    }, ctx._pendingTransferList);

    ctx._pendingGeomHashes = [];
    ctx._pendingGeoms = [];
    ctx._pendingFromCache = [];
    ctx._pendingTransferList = [];
}

function onCdnResourceProcessed(loadContext, numResourcesProcessed = 1) {
    const ctx = getWorkerContext(loadContext);

    ctx.numRequests -= numResourcesProcessed;
    ctx._requestsReceived += numResourcesProcessed;

    if (ctx.flushCacheAndDisconnectRequested && !ctx.numRequests && !ctx._pendingGeomHashes.length) {
        doFlushCacheAndDisconnect(loadContext);
        ctx.flushCacheAndDisconnectRequested = false;
    }
}

// Request raw geometry data (arraybuffer) and forward result to onCdnResourcesReceived once it is available
//  @param {Object}     loadContext - passed through to the receiving callback
//  @param {String[]}   hashes - hashes of the resources
//  @param {String[]}   urls - urls of the network resources
//  @param {String[]}   lineageUrns - lineage Urns of the resources
//  @param {String}     resourceType - "m" for material and "g" for geometry
//  @param {Boolean[]}  couldBeInCacheArray - One entry per resource, false if the resource can't be in the cache (i.e., skip the cache and directly load from the network)
//                                     if true and not in cache, the data is still requested from the network
function loadCdnResources(loadContext, hashes, urls, lineageUrns, resourceType, couldBeInCacheArray) {

    var ctx = getWorkerContext(loadContext);

    ctx._requestsSent += hashes.length;

    if (ctx.opfsCache) {
        ctx.opfsCache.get(hashes, lineageUrns).then((datas) => {
            for (let i = 0; i < hashes.length; i++) {
                const hash = hashes[i];
                const url = urls[i];
                const lineageUrn = lineageUrns[i];
                const data = datas[i];

                if (data) {
                    onCdnResourcesReceived(loadContext, [hash], [lineageUrn], [data], true, resourceType);
                } else {
                    ctx.pendingForNetwork.push([hash, url, lineageUrn, resourceType, loadContext.queryParams]);
                }
            }
        });
    } else if (ctx.localDbCache) {
        for (let i = 0; i < urls.length; i++) {
            const hash = hashes[i];
            const url = urls[i];
            if (!couldBeInCacheArray || couldBeInCacheArray[i]) {
                //Make sure the IndexedDb session is started before we ask to get() anything.
                //This is done by a call to open, which will call us back immediately, or delay until
                //the database is open.
                ctx.localDbCache.open(() => ctx.localDbCache.get(hash, function(error, data) {
                    if (data) {
                        onCdnResourcesReceived(loadContext, [hash], [""], [data], true, resourceType);
                    } else {
                        ctx.pendingForNetwork.push([hash, url, "", resourceType, loadContext.queryParams]);
                    }
                }));
            } else {
                ctx.pendingForNetwork.push([hash, url, "", resourceType, loadContext.queryParams]);
            }
        }
    }
}


function _loadCdnResourceFromNetworkBatch(loadContext) {
    var ctx = getWorkerContext(loadContext);

    if (ctx.pendingForNetwork.length === 0) {
        return;
    }

    // Only fill the queue of open WS. Non-open WS might take a few seconds to open: 
    // Chrome and Firefox throttle opening WS to one per ~500ms, so the eighth WS would open only after 3.5s.
    // Also, the WS might currently be attempting to recover from an error.
    let openWS = [];
    let numNonbrokenWs = 0;
    let totalInFlightRequests = 0;
    for (const ws of ctx.otgws) {
        if (!ws.hasPermanentError) {
            numNonbrokenWs++;
        }
        if (ws.ws ? .readyState === STATE.OPEN) {
            openWS.push(ws);
            totalInFlightRequests += ws.inFlightRequests.size;
        } else {
            // Reasons they might need opening: 1. WS was just initialized 2. WS was closed due to model/view changing 3. server closed it due to e.g. timeout
            ws._openWebSocket();
        }
    }

    if (numNonbrokenWs === 0) {
        if (!ctx.analyticsForHttpFallbackSent) {
            ctx.analyticsForHttpFallbackSent = true;
            loadContext.worker.postMessage({
                event: "OTG_FALLBACK_TO_HTTP",
                properties: {
                    wsStates: ctx.otgws.map(ws => ws.ws ? .readyState),
                    wsLastErrorNumInFlight: ctx.otgws.map(ws => ws.lastErrorNumInFlight),
                    wsLastErrorReasons: ctx.otgws.map(ws => ws.lastError ? .reason),
                    wsLastErrorCodes: ctx.otgws.map(ws => ws.lastError ? .code),
                }
            });
        }
        //Fallback to XHR/HTTP2
        for (const [hash, url, lineageUrn, resourceType, queryParams] of ctx.pendingForNetwork) {
            loadContext.queryParams = queryParams;
            ViewingService.getItem(
                loadContext,
                url,
                (data) => onCdnResourcesReceived(loadContext, [hash], [lineageUrn], [data], false, resourceType),
                getHttpErrorHandler(loadContext, hash, resourceType), {
                    responseType: "arraybuffer",
                    withCredentials: true
                }
            );
        }
        ctx.pendingForNetwork = [];
        return;
    }

    if (openWS.length <= 0) {
        return;
    }

    const wsSortedByLoad = openWS.sort((a, b) => a.inFlightRequests.size - b.inFlightRequests.size);

    // Do load balancing among WS: every request should go to the WS which is currently least busy.
    // In other words, the minimum of the WS's inFlightRequests.size should be as high as possible,
    // otherwise that would mean that some WS are underutilized.
    // To achieve that, starting with the least busy WS, we raise the targeted requests in flight
    // so that after iteration n, the n least busy WS are utilized equally, until all incoming requests are distributed.
    let requestsToDistribute = ctx.pendingForNetwork.length;
    let targetRequestsInFlight = wsSortedByLoad[0].inFlightRequests.size;
    for (let i = 1; i < wsSortedByLoad.length; i++) {
        const raiseTargetBy = wsSortedByLoad[i].inFlightRequests.size - targetRequestsInFlight;
        requestsToDistribute -= raiseTargetBy * i;
        targetRequestsInFlight += raiseTargetBy;
        if (requestsToDistribute <= 0) {
            wsSortedByLoad.length = i; // cut out WS that we won't use anyway
            break;
        }
    }

    // If there are more requests left, distribute them equally across all WS,
    // or if targetRequestsInFlight got too high (i.e. if requestsToDistribute < 0), trim it down.
    targetRequestsInFlight += Math.ceil(requestsToDistribute / wsSortedByLoad.length);

    // If there are some WS not-yet-open, keep work in the queue for them and not overload the open ones
    const totalRequests = totalInFlightRequests + ctx.pendingForNetwork.length;
    targetRequestsInFlight = Math.min(targetRequestsInFlight, Math.ceil(totalRequests / numNonbrokenWs));

    for (let i = wsSortedByLoad.length - 1; i >= 0; i--) {
        const ws = wsSortedByLoad[i];
        const numHashesToSend = targetRequestsInFlight - ws.inFlightRequests.size;

        if (numHashesToSend < SMALL_MESSAGE_THRESHOLD && !(i == 0 && totalRequests < IN_FLIGHT_THRESHOLD_FOR_SMALL_MESSAGES)) {
            // Message is too small, distribute it to the other WS
            targetRequestsInFlight += Math.ceil(numHashesToSend / i);
            continue;
        }
        for (const [hash, url, lineageUrn, resourceType, queryParams] of ctx.pendingForNetwork.splice(0, numHashesToSend)) {
            ws.requestResource(url, lineageUrn, hash, resourceType, queryParams);
        }
        ws._flushSendQueue();
    }
}

function doCdnResourceLoad(loadContext) {
    var ctx = getWorkerContext(loadContext);

    loadCdnResources(loadContext, loadContext.hashes, loadContext.urls, loadContext.lineageUrns, loadContext.type, loadContext.couldBeInCache);
    ctx.numRequests += loadContext.urls.length;
}

function requestFlushCacheAndDisconnect(loadContext) {
    var ctx = getWorkerContext(loadContext);
    // If there are still requests in flight, we're likely switching views, and in that case we don't want to close the
    // websockets now, because the new view would just re-open them again with some delay.
    // So we just set a flag here, and actually close the websockets when the last request is processed.
    // This way we also don't have to do any cleanup of requests in flight, we cannot cancel anything already on the wire anyway.
    ctx.flushCacheAndDisconnectRequested = true;
    onCdnResourceProcessed(loadContext, 0);
}

function doFlushCacheAndDisconnect(loadContext) {

    var ctx = getWorkerContext(loadContext);

    if (ctx.numRequests || ctx._pendingGeomHashes.length) {
        console.error("OtgLoadWorker disconnect requested even though there are requests in flight");
        flushMessagesToDecoderThread(loadContext);
    }

    for (const ws of ctx.otgws) {
        ws.closeWebSocket();
    }

    clearInterval(ctx.flushMessages);
    ctx.flushMessages = null;

    ctx.localDbCache ? .open(() => ctx.localDbCache.flushStoresAndTimestamps());
    ctx.opfsCache ? .close();
}

// Usage: NOP_VIEWER.impl.geomCache().clearOpfsCache()
async function doClearOpfsCache(loadContext) {
    var ctx = getWorkerContext(loadContext);
    await ctx.opfsCache ? .clear();
    console.log('OPFS cache cleared');
}

// Helper task to faciliate console debugging.
// How to use:
//  If OTG loading gets stuck, call NOP_VIEWER.impl.geomCache().reportLoadingState()
function doReportLoadingState(loadContext) {

    var ctx = getWorkerContext(loadContext);

    // Uncomment to debug a worker that got stuck:
    // const pending = ctx._requestsSent - ctx._requestsReceived;
    // if (pending) {
    //     debugger;
    // }

    const loadingState = {
        // Total number of send/receive (also indexDB etc)
        sent: ctx._requestsSent,
        received: ctx._requestsReceived,

        // Actual websocket sends/receives
        wsSent: ctx.otgws.map(ws => ws.numRequestsSent),
        wsReceived: ctx.otgws.map(ws => ws.numRequestsReceived),
    };
    console.log('WorkerState: ', loadingState);
}

export function register(workerMain) {
    workerMain.register("INIT_WORKER_OTG", {
        doOperation: doInitGeomWorker
    });
    workerMain.register("ADD_MODEL_OTG", {
        doOperation: doAddModel
    });
    workerMain.register("LOAD_CDN_RESOURCE_OTG", {
        doOperation: doCdnResourceLoad
    });
    workerMain.register("FLUSH_CACHE_AND_DISCONNECT_OTG", {
        doOperation: requestFlushCacheAndDisconnect
    });
    workerMain.register("CLEAR_OPFS_CACHE", {
        doOperation: doClearOpfsCache
    });
    workerMain.register("REPORT_LOADING_STATE", {
        doOperation: doReportLoadingState
    });
}