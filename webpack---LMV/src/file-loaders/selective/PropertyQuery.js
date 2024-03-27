const PROPERTY_HASH_REQUEST_RE = /(["'])\?([\w\d\s]+)\1/g;
const PROPERTY_HASH_MISS_STRING = '"s.props.unresolved"'; // causes property parser to fail

export class PropertyQuery {

    _source;

    _fragmentIDs;

    _extension;
    _initializing = false;


    static validate(queryString) {
        /** @todo: implement */
        return true;
    }

    /**
     * For the given property query, all property hash lookups in the form of "?<Attribute Name>" are
     * replaced with the respective property hash, e.g., "s.props.p823c2fe8". If no exact match is found,
     * "s.props.unresolved" is used as replacement, resulting in an invalid query or query that will not
     * match anything. If more than one match is found, the same unresolved behavior is chosen currently.
     *
     * @param {FilterExtension} extension - Filter extension to gather attribute definitions from.
     * @param {Model} model - Model to gather attribute definitions for.
     * @param {string} queryString - Property query to replace attribute lookups in.
     *
     * @returns {string} - Property query with all valid attribute lookups replaced by property hashes.
     */
    static async preprocessAttributeLookups(extension, model, queryString) {

        const attributes = await extension.getAttributeDefinitions(model) || new Array();
        const matches = queryString.matchAll(PROPERTY_HASH_REQUEST_RE);

        for (const match of matches) {

            // Exact property hash lookup (name instead of display name is checked, so always english)
            const attributeSearchString = match[2].trim();
            let hashes = attributes
                .filter(attribute => attribute.name === attributeSearchString)
                .map(attribute => `${match[0][0]}s.props.${attribute.propertyHash}${match[0][0]}`);

            switch (hashes.length) {
                case 1:
                    queryString = queryString.replace(match[0], hashes[0]);
                    break;
                default:
                    /** @todo: not yet supported. We could duplicate the condition for all hashes... */
                    console.error(`Expected unique property from hash lookup, found ${hashes.length}, given`, match[2]);
                    queryString = queryString.replace(match[0], PROPERTY_HASH_MISS_STRING);
                    break;
            }
        }

        return queryString;
    }

    fromString(queryString) {
        if (this._source === queryString) {
            return;
        }
        this._fragmentIDs = undefined;
        if (queryString === undefined || queryString.length === 0) {
            this._source = undefined;
            return;
        }
        if (!PropertyQuery.validate(queryString)) {
            console.warn('Validation of property query failed, given:', queryString);
            this._source = undefined;
            return;
        }
        this._source = queryString;
    }

    fromObject(queryObject) {
        if (queryObject === undefined || Object.keys(queryObject).length === 0) {
            this._source = undefined;
            this._fragmentIDs = undefined;
            return;
        }
        const queryString = JSON.stringify(queryObject);
        this.fromString(queryString);
    }

    fromDbIDs(model, dbIDs) {
        if (model === undefined || dbIDs === undefined) {
            this._fragmentIDs = undefined;
            return;
        }
        const it = model.getInstanceTree();
        const fragmentIDs = new Array();
        dbIDs.forEach((dbID) => it.enumNodeFragments(dbID, (fragmentID) => {
            fragmentIDs.push(fragmentID);
        }, true));

        this._fragmentIDs = new Set(fragmentIDs);
    }

    isEmpty() {
        return this._source === undefined;
    }

    isReady() {
        return !!this._fragmentIDs;
    }

    isInitializing() {
        return this._initializing;
    }

    async initialize(model) {
        // Either not source is set (then predicate should be undefined) or predicate was initialized.
        if (this.isEmpty() || this.isReady()) {
            return;
        }

        this._initializing = true;
        if (this._extension === undefined) {
            const viewer = model.loader.viewer3DImpl.api;
            this._extension = await viewer.loadExtension('Autodesk.Filter');
        }
        if (this._extension === undefined) {
            console.warn('Expected loading Autodesk.Filter extension to succeed.');
            return;
        }

        const queryStringPreprocessed = await PropertyQuery.preprocessAttributeLookups(this._extension, model, this._source);
        const queryObjectPreprocessed = JSON.parse(queryStringPreprocessed, (key, value) =>
            typeof value === 'number' ? parseFloat(value) : value);

        const result = (await this._extension.getModelIdsWithFilter(model, queryObjectPreprocessed, undefined, undefined, false));
        const ids = result.ids ? .concat(result.ids2 ? ? []);
        this.fromDbIDs(model, ids);

        this._initializing = false;
    }

    isFragmentPassing(model, fragmentID) {
        return this._fragmentIDs.has(fragmentID);
    }

}