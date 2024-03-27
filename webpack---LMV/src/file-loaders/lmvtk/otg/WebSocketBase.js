const WebSocket = require('isomorphic-ws');

//Copied from compat.js to avoid importing ES6 exports from plain node.js forge-tools.
const isBrowser = (typeof navigator !== "undefined");
const isNodeJS = function() {
    return !isBrowser;
};

// https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
const STATE = Object.freeze({
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
});

/** A base class for web socket based resource loading.
 * 
 * Since this class has a history of race conditions and multiple attempts to fix them, here are some notes.
 * 
 * States a WebSocketBase can be in:
 * ws === null: Constructor OR closeWebSocket called, but not _openWebSocket
 * ws.readyState === CONNECTING: _openWebSocket called, but not onopen.
 * ws.readyState === OPEN: onopen called, but not closeWebSocket or onclose. 
 * ws.readyState === CLOSING: server/browser initiated a close, but onclose was not called yet. This is unexpected and will go to one of the error states.
 * ws.readyState === CLOSED && retryEvent: there was an unexpected error, and _openWebSocket will be called again shortly.
 * hasPermanentError: there was an unrecoverable error. Either WebSockets are not supported, or all retries to open one have failed.
 * 
 * Apart from OtgLoadWorker calling any of the API methods at any point, be aware of the following events:
 * * retryEvent firing
 * * The browser closes the WebSocket because the internet connection broke down. (code: 1006)
 * * The server closes the WebSocket after one minute without requests. (code: 1000, reason: 'Idle timeout')
 *     * When using on-demand loading, this is not an error. The WebSocket must be reopened when requestResource is called again.
 * * The server closes the WebSocket if a resource was requested that was not authorized. (code: 1007, reason: '401 (Unauthorized)')
 * * Any other internal server error.
 * * Also, be aware that closeWebSocket might never be called when on-demand loading is active.
 * 
 * When the WebSocket is closing, one task switches it to CLOSING without calling any handler, and another one later switches
 * it to CLOSED and calls the close handler, see https://websockets.spec.whatwg.org/#feedback-from-the-protocol.
 * Since this is done in a task, the state cannot suddenly change while any of our code is running.
 * It's ok that there's no onclosing handler: the CLOSING state will make every send() a noop, and our close/error handler will re-issue all requests.
 */
class WebSocketBase {

    constructor(url, queryParams, headers, onResourcesReceived, onResourceFailed, onConnectionFailed) {

        this.ws = null;
        this.url = url;
        this.queryParams = queryParams;
        this.headers = headers;
        this.numRequestsSent = 0;
        this.numRequestsReceived = 0;
        this.authorizeUrns = new Set();
        this._retriedOpen = 0;
        this.retryEvent = null;
        this.hasPermanentError = typeof WebSocket === "undefined" || !this.url;
        this.lastError = null;
        this.lastErrorNumInFlight = null;
        this.onResourcesReceived = onResourcesReceived;
        this.onResourceFailed = onResourceFailed;
        this.onConnectionFailed = onConnectionFailed;

        this._pendingSends = new Map();
        this._numPendingSends = 0;
        this.inFlightRequests = new Map();

        this.msgBuffer = new Uint8Array(201);
    }

    addAuthorizeUrn(authorizeUrn) {
        if (this.authorizeUrns.has(authorizeUrn) || this.hasPermanentError) {
            return;
        }
        // Since this is also called on every requestResource, it's not strictly necessary here.
        // This is a performance optimization, to start opening the web socket as early as possible.
        this._openWebSocket();

        if (this.ws ? .readyState === STATE.OPEN) {
            // Since we won't go through the onOpen handler anymore, authorize the new urns directly.
            this.ws.send("/auth/" + authorizeUrn);
        }

        this.authorizeUrns.add(authorizeUrn);
    }

    _openWebSocket() {
        if (this.ws || this.hasPermanentError) {
            return;
        }

        //http and 7124->7125 are here to support local debugging, when the endpoints are overridden to
        //point directly to local node.js process(es).
        let url = this.url.replace("https:", "wss:").replace("http:", "ws:").replace(":7124", ":7125");

        if (this.queryParams) {
            url += "?" + this.queryParams;
        }

        this.ws = new WebSocket(url, undefined, isNodeJS() ? {
            headers: this.headers
        } : {});

        this.ws.onopen = () => {
            this.accountIdSent = null;
            this.ws.binaryType = "arraybuffer";

            //On web clients that do not use the cookie approach, the headers
            //will not get sent (unlike on node.js WebSocket implementation
            //so we send the Authorization first thing after open
            if (!isNodeJS()) {
                this.ws.send("/headers/" + JSON.stringify(this.headers));
            }

            //Tell the server that we expect batched responses
            this.ws.send("/options/" + JSON.stringify({
                batch_responses: true,
                report_errors: true
            }));

            //Tell the server to authorize the web socket
            //for the URNs that we will be loading
            for (const urn of this.authorizeUrns) {
                this.ws.send("/auth/" + urn);
            }
        };

        this.ws.onmessage = event => this._decodeMessage(event.data);

        // We do not set onerror, since every error event is followed by a close event, so onclose is enough.
        // This will only be run for unexpected close events, because we reset the close event handler before closing the web socket intentionally 
        this.ws.onclose = event => {

            // Close code 1000 means NORMAL_CLOSURE, currently only used by the server on idle timeout. 
            // This is not an error and we don't wan't to retry in this case.
            if (event.code === 1000 && this.inFlightRequests.size === 0) {
                this.closeWebSocket(); // It's already closed, but we want to also reset the state.
                return;
            }

            console.warn(
                "Abnormal socket close.",
                "pending sends:", this._numPendingSends,
                "in flight", this.inFlightRequests.size,
                "event:", event
            );

            this._pendingSends = new Map();
            this._numPendingSends = 0;

            // try again opening later or give up
            if (this._retriedOpen < 3) {
                console.warn("Retrying");
                this._retriedOpen++;
                this.retryEvent = setTimeout(() => {
                    this.retryEvent = null;
                    this.ws = null;
                    this._openWebSocket();
                }, 2000);
            } else {
                console.error("Too many WebSocket failures. Giving up.");
                this.hasPermanentError = true;
                this.lastError = event;
                this.lastErrorNumInFlight = this.inFlightRequests.size;
            }

            this.onConnectionFailed(this.inFlightRequests);
            this.inFlightRequests.clear();
        };
    }

    /** This should be called when no new requests are expected. */
    closeWebSocket() {
        if (!this.ws) {
            return;
        }
        // Violating this assert won't break something here, but in-flight requests will be lost
        // and pending requests will be issued on next _openWebSocket, which is probably not intended
        console.assert(this.inFlightRequests.size === 0, "closeWebSocket called even though there are requests in flight");

        if (this.retryEvent) {
            clearTimeout(this.retryEvent);
            this.retryEvent = null;
        }

        // We don't care if anything goes wrong past this point.
        // By unsetting this on regular close, any call to our onclose handler is unexpected and is an error.
        // This seemed more robust than checking for our closing message in the close handler.
        this.ws.onclose = null;

        const ws = this.ws;
        if (this.ws.readyState === STATE.CONNECTING) {
            // We could just close the connection right away, which is allowed by the spec.
            // However, browsers will print a warning which is not nice, in particular for small cached models that load
            // faster than the WS open, this would mean a fair bit of console spam. So we wait for the WS to open first.
            this.ws.onopen = () => ws.close(1000, "no more work expected"); // close code 1000 means normal closure
        } else {
            // If this.ws is CLOSING or CLOSED, close() is a NOOP.
            this.ws.close(1000, "no more work expected");
        }
        this.ws = null;
    }

    _decodeMessage(buffer) {
        throw new Error('Implement!');
    }

    _flushSendQueue() {
        throw new Error('Implement!');
    }

    /** This must not be called before a corresponding call to addAuthorizeUrn, otherwise the server will close the WebSocket
     *  and the WebSocketBase will go into the error state after retrying. */
    requestResource() {
        throw new Error('Implement!');
    }
}

module.exports.WebSocketBase = WebSocketBase;
module.exports.STATE = STATE;