const {
    WebSocketBase,
    STATE
} = require('./WebSocketBase');
const packedToBin = require("./HashStrings").packedToBin;
const binToPackedString = require("./HashStrings").binToPackedString;

//OTG web socket protocol.
class OtgWs extends WebSocketBase {

    //Packed message format, where the response from the server may contain multiple items in the same
    //buffer.
    /*
        The format is as follows:

        Bytes      Meaning
        ------------------------------
        0-3        Magic number. The bytes 'OPK1'
        4-7        Currently unused flags + resource type (ASCII 'm' or 'g') in byte 0 of this integer.
        8-11       Number of items in the message stream. Little endian.
        12-15      Offset of the first item in the data buffer (first item is implicitly at offset 0, so this is always zero)
        16-19      Offset of the second item in the data buffer
        20-...     etc... subsequent offsets, one per item
        ...
        Remaining bytes: all items combined into single buffer
    */
    _decodeMessage(buffer) {
        const prefixLength = 12;

        const headerInt = new Int32Array(buffer, 0, prefixLength / 4);

        if (headerInt[0] !== 0x314B504F) {
            console.error("Invalid message format", headerInt[0].toString(16), headerInt[1], buffer);
            return;
        }

        const resourceType = String.fromCharCode(headerInt[1] & 0xff);

        const numItems = headerInt[2];
        const offsets = new Int32Array(buffer, prefixLength, numItems);

        const baseOffset = prefixLength + numItems * 4;
        const items = new Uint8Array(buffer, baseOffset);

        const hashes = [];
        const lineageUrns = [];
        const arrays = [];

        for (let i = 0; i < offsets.length; i++) {
            const start = offsets[i];
            const end = ((i < offsets.length - 1) ? offsets[i + 1] : items.byteLength);

            const hash = binToPackedString(items, start, 20);
            const data = items.subarray(start + 20, end);

            this.numRequestsReceived++;
            if (resourceType === "e") {
                // The first four bytes are a HTTP-statuscode-like error code. It doesn't add anything to the message so we ignore it.
                // See https://git.autodesk.com/A360/platform-ds-ss/blob/6c439e82f3138eed3935b68096d2d980ffe95616/src/ws-server/ws-server.js#L310
                let errorMessage = new TextDecoder().decode(data.subarray(4));
                errorMessage = "The service returned the following message: " + errorMessage;
                let actualResourceType = this.inFlightRequests.get(hash).type;
                this.onResourceFailed(hash, actualResourceType, errorMessage);
            }
            hashes.push(hash);
            lineageUrns.push(this.inFlightRequests.get(hash).lineageUrn);
            arrays.push(data);
            this.inFlightRequests.delete(hash);
        }
        if (resourceType === "e") {
            return;
        }
        this.onResourcesReceived(hashes, lineageUrns, arrays, resourceType);
    }


    _flushSendQueue() {
        if (this.ws ? .readyState !== STATE.OPEN) {
            return;
        }

        for (const [accountId, pendingsSendsOfAccount] of this._pendingSends) {

            // Set accountId for the following messages
            if (this.accountIdSent !== accountId) {
                this.ws.send("/account_id/" + accountId);
                this.accountIdSent = accountId;
            }

            for (const [type, msgs] of pendingsSendsOfAccount) {
                if (!msgs.length)
                    continue;

                this.numRequestsSent += msgs.length;

                //Send all hashes collected in requestResource in a single shot websocket message

                //Enlarge the accumulation buffer if needed
                const len = 1 + msgs.length * 20;
                if (this.msgBuffer.length < len) {
                    this.msgBuffer = new Uint8Array(len);
                }

                this.msgBuffer[0] = type.charCodeAt(0);
                for (let i = 0; i < msgs.length; i++) {
                    packedToBin(msgs[i], this.msgBuffer, 1 + i * 20);
                }
                this.ws.send(new Uint8Array(this.msgBuffer.buffer, 0, len));
            }
        }
        this._pendingSends.clear();
        this._numPendingSends = 0;
    }

    // @param {string}   url - request url
    // @param {string}   lineageUrn - lineage urn of the model
    // @param {string}   hash - corresponding hash
    // @param {string}   type - "m" or "g" (material or geometry)
    // @param {any}      queryParams - additional data passed back into onConnectionFailed (currently only used for the HTTP fallback)
    requestResource(url, lineageUrn, hash, type, queryParams) {
        if (this.hasPermanentError) {
            console.error("requestResource called on unusable WebSocket");
            return;
        }

        const wspath = url.slice(url.indexOf("/cdn/") + 5);
        const accountId = wspath.split("/")[1];

        if (!this._pendingSends.has(accountId)) {
            this._pendingSends.set(accountId, new Map([
                ["g", []],
                ["m", []],
            ]));
        }
        this._pendingSends.get(accountId).get(type).push(hash);
        this._numPendingSends++;
        this.inFlightRequests.set(hash, {
            url: url,
            lineageUrn: lineageUrn,
            type: type,
            queryParams: queryParams
        });
    }
}

module.exports.OtgWs = OtgWs;