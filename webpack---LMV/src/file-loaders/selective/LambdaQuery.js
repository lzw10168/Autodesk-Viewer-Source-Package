/**
 * Currently intended for exclusive, internal load-time filtering. It is setup using load options in
 * @see SelectiveLoadingController.prepare and, if set, property and spatial queries are ignored. Example:
 * @example
 *  viewer.loadDocumentNode(lmvDocument, model, { // options ...
 *      filter: {
 *          asyncInit: (model, viewer) => { return new Promise(resolve => setTimeout(resolve, 8000)); },
 *          match: (model, fragId) => !(fragId % 8),
 *      } } );
 */
export class LambdaQuery {

    _asyncInit;
    _match;

    _initializing = false;
    _initialized = false;

    fromObjects(asyncInit, match) {
        if (this._asyncInit === asyncInit && this._match === match) {
            return;
        }
        this._asyncInit = asyncInit;
        this._match = match;

        this._initialized = false;
    }

    isEmpty() {
        return this._match === undefined;
    }

    isReady() {
        return !!(this._asyncInit === undefined) || (!this._initializing && this._initialized);
    }

    needsInitializing() {
        return !!(this._asyncInit === undefined) || !(this._initializing || this._initialized);
    }

    isInitializing() {
        return this._initializing;
    }

    async initialize(model) {
        if (!this.needsInitializing()) {
            return;
        }

        this._initializing = true;

        const viewer = model.loader.viewer3DImpl.api;
        await this._asyncInit(model, viewer);

        this._initializing = false;
        this._initialized = true;
    }

    isFragmentPassing(model, fragmentID) {
        return this._match(model, fragmentID);
    }

}