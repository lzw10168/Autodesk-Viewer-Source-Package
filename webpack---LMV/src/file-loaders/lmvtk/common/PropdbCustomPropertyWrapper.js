import {
    PropertyDatabase
} from './Propdb';

/**
 *
 * This wrapper takes the Property Database then extends it to have functionality that handles user-provided Custom Properties.
 * @class PropertyDatabaseCustomPropertyWrapper
 * @extends {PropertyDatabase} PropertyDatabase
 * @param dbjsons
 */
export function PropertyDatabaseCustomPropertyWrapper(dbjsons) {
    'use strict';

    this._impl = new PropertyDatabase(dbjsons);

    /** @type ValuesCacheEntry */
    this.customAttrs = undefined;

    this.setCustomAttrs = (customAttrs) => this.customAttrs = customAttrs;

    this._attributeIsBlacklisted = (attrId) => this._impl._attributeIsBlacklisted(attrId);

    this._getAttributeAndValueIds = (dbId, attrId, valueId, integerHint) => this._impl._getAttributeAndValueIds(dbId, attrId, valueId, integerHint);

    this._ignoreAttribute = (attrId) => this._impl._ignoreAttribute(attrId);

    this.attributeHidden = (attrId) => this._impl.attributeHidden(attrId);

    this.setIdsBlob = (data) => this._impl.setIdsBlob(data);

    this.getObjectCount = () => this._impl.getObjectCount();

    this.getIdAt = (entId) => this._impl.getIdAt(entId);

    this.externalIdsLoaded = () => this._impl.externalIdsLoaded();

    this.getExternalIdMapping = (extIdFilter) => this._impl.getExternalIdMapping(extIdFilter);

    this.findRootNodes = () => this._impl.findRootNodes();

    this.nodeHasChild = (dbId) => this._impl.nodeHasChild(dbId);

    this.getNodeNameAndChildren = (node, skipChildren) => this._impl.getNodeNameAndChildren(node, skipChildren);

    this.buildDbIdToFragMap = (fragToDbId) => this._impl.buildDbIdToFragMap(fragToDbId);

    this.buildObjectTree = (rootId, fragToDbId, maxDepth, nodeStorage) =>
        this._impl.buildObjectTree(rootId, fragToDbId, maxDepth, nodeStorage);

    this.buildObjectTreeRec = (dbId, parent, dbToFrag, depth, maxDepth, nodeStorage) =>
        this._impl.buildObjectTreeRec(dbId, parent, dbToFrag, depth, maxDepth, nodeStorage);

    this.getSearchTerms = (searchText) => this._impl.getSearchTerms(searchText);

    this.bruteForceSearch = (searchText, attributeNames, searchOptions) =>
        this._impl.bruteForceSearch(searchText, attributeNames, searchOptions);

    this.bruteForceFind = (propertyName) => this._impl.bruteForceFind(propertyName);

    this.getLayerToNodeIdMapping = () => this._impl.getLayerToNodeIdMapping();

    this.findLayers = () => this._impl.findLayers();

    this.enumObjects = (cb, fromId, toId) => this._impl.enumObjects(cb, fromId, toId);

    this.getAttrChild = () => this._impl.getAttrChild();

    this.getAttrParent = () => this._impl.getAttrParent();

    this.getAttrName = () => this._impl.getAttrName();

    this.getAttrLayers = () => this._impl.getAttrLayers();

    this.getAttrInstanceOf = () => this._impl.getAttrInstanceOf();

    this.getAttrViewableIn = () => this._impl.getAttrViewableIn();

    this.getAttrXref = () => this._impl.getAttrXref();

    this.getAttrNodeFlags = () => this._impl.getAttrNodeFlags();

    this.findParent = (dbId) => this._impl.findParent(dbId);

    this.findDifferences = (dbToCompare, diffOptions, onProgress) =>
        this._impl.findDifferences(dbToCompare, diffOptions, onProgress);

    this.numberOfAttributes = () => this._impl.numberOfAttributes();

    this.numberOfValues = () => this._impl.numberOfValues();

    this.dtor = () => this._impl.dtor();

    this._customAttrIdOffset = this._impl.numberOfAttributes();
    this._customValueIdOffset = this._impl.numberOfValues();

    this.getObjectCustomProperties = (dbId, propsWanted) => this.customAttrs ? .getObjectProperties(dbId, propsWanted, this._customAttrIdOffset, this._customValueIdOffset) ? ? [];

    // ⬇ custom override functions ⬇

    this.getValueAt = (valueId) => {
        const customValueId = valueId - this._customValueIdOffset;
        if (customValueId >= 0)
            return this.customAttrs.customValues[customValueId];

        return this._impl.getValueAt(valueId);
    };

    this.getIntValueAt = (valueId) => {
        const customValueId = valueId - this._customValueIdOffset;
        if (customValueId >= 0)
            return this.customAttrs.customValues[customValueId];

        return this._impl.getIntValueAt(valueId);
    };

    this.getAttrValue = (attrId, valueId, integerHint) => {
        const customAttrId = attrId - this._customAttrIdOffset;
        if (customAttrId >= 0)
            return this.customAttrs.customValues[valueId - this._customValueIdOffset];

        return this._impl.getAttrValue(attrId, valueId, integerHint);
    };

    this._getObjectProperty = (attrId, valueId) => {
        const customAttrId = attrId - this._customAttrIdOffset;
        if (customAttrId >= 0) {
            const customAttr = this.customAttrs.attributes.customAttrs[customAttrId];
            // map value to expected shape
            return {
                displayName: customAttr ? .displayName ? ? customAttr ? .name,
                displayValue: this.customAttrs.customValues[valueId - this._customValueIdOffset],
                displayCategory: customAttr.category,
                attributeName: customAttr.name,
                type: customAttr.dataType,
                units: customAttr.dataTypeContext,
                hidden: false,
                precision: customAttr.precision,
            };
        }

        return this._impl._getObjectProperty(attrId, valueId);
    };

    this.getObjectProperties = (dbId, propFilter, ignoreHidden, propIgnored, categoryFilter) => {
        const result = this._impl.getObjectProperties(dbId, propFilter, ignoreHidden, propIgnored, categoryFilter);
        const customProps = this.getObjectCustomProperties(dbId);
        if (customProps ? .length) {
            const props = result.properties;
            for (let i = 0; i < customProps.length; i += 2) {
                const customProp = this._getObjectProperty(customProps[i], customProps[i + 1]);
                props.push(customProp);
            }
            result.properties = props;
        }
        return result;
    };

    this.getAttributeDef = (attrId) => {
        const customAttrId = attrId - this._customAttrIdOffset;
        if (customAttrId >= 0)
            return this.customAttrs.attributes.customAttrs[customAttrId];

        return this._impl.getAttributeDef(attrId);
    };

    this.enumAttributes = (cb) => {
        this._impl.enumAttributes(cb);
        this.customAttrs ? .attributes.customAttrs.forEach((attr, index) => {
            cb(index + this._customAttrIdOffset, attr);
        });
    };

    this.enumObjectProperties = (dbId, cb, ignoreHidden, propIgnored, categoryFilter) => {
        this._impl.enumObjectProperties(dbId, cb, ignoreHidden, propIgnored, categoryFilter);
        const props = this.getObjectCustomProperties(dbId);
        if (props ? .length) {
            for (let i = 0; i < props.length; i += 2) {
                cb(props[i], props[i + 1]);
            }
        }
    };

    this.getPropertiesSubsetWithInheritance = (dbId, desiredAttrIds, dstValueIds) => {
        const customProps = [];
        Object.keys(desiredAttrIds).forEach((attrIdKey) => {
            const customAttrId = parseInt(attrIdKey, 10);
            if (customAttrId >= this._customAttrIdOffset) {
                customProps.push(customAttrId);
            }
        });
        const result = this._impl.getPropertiesSubsetWithInheritance(dbId, desiredAttrIds, dstValueIds);
        if (customProps.length > 0) {
            const customValues = this.getObjectCustomProperties(dbId, customProps);
            result.push(...customValues);
            if (dstValueIds) {
                for (let i = 0; i < customValues.length; i += 2) {
                    const customValue = customValues[i];
                    dstValueIds[customValue] = customValues[i + 1];
                }
            }
        }
        return result;
    };
}

const TypeMap = {
    "Boolean": 1,
    "Integer": 2,
    "Double": 3,
    "String": 20,
};

class ValuesCacheEntry {

    constructor(attributes) {
        this.lastUpdated = new Date(0); // min date (start of epoch)
        this.lastFetched = new Date(0); // min date (start of epoch)
        this.customValueIds = new Map();
        this.customValues = [];
        this.customAttributeValues = new Map();
        this.attributes = attributes;
    }

    hasObjectProperties(dbId) {
        return this.customAttributeValues.get(dbId) !== undefined;
    }

    getObjectProperties(dbId, propsWanted, attributesOffset, valuesOffset) {
        const props = this.customAttributeValues.get(dbId) ? .slice() ? ? [];
        let result = props;
        if (propsWanted) {
            result = [];
            for (let i = 0; i < props.length && result.length < propsWanted.length * 2; i += 2) {
                const prop = props[i];
                if (propsWanted.includes(prop + attributesOffset)) {
                    result.push(prop, props[i + 1]);
                }
            }
        }
        for (let i = 0; i < result.length; i += 2) {
            result[i] += attributesOffset;
            result[i + 1] += valuesOffset;
        }
        return result;
    }

    internValue(value) {
        let valueId = this.customValueIds.get(value);
        if (valueId === undefined) {
            valueId = this.customValues.length;
            this.customValueIds.set(value, valueId);
            this.customValues.push(value);
        }
        return valueId;
    }

    async refreshCustomPropertiesValues({
        baseUrl,
        headers,
        projectId,
        seedFileUrn
    }) {

        const url = `${baseUrl}/v2/projects/${projectId}/versions/${encodeURIComponent(seedFileUrn)}/custom-properties`;
        var response = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
                ...headers
            }
        });
        if (response.ok) {
            try {
                this.customAttributeValues.clear();
                const payload = await response.json();
                for (const entry of payload.results) {
                    const attrId = this.attributes.customAttrIds.get(entry.propId);
                    if (attrId === undefined) {
                        continue;
                    }
                    const dbId = entry.svf2Id;
                    let avs = this.customAttributeValues.get(dbId);
                    if (avs === undefined) {
                        avs = [];
                        this.customAttributeValues.set(dbId, avs);
                    }
                    avs.push(attrId, this.internValue(entry.value));
                }
                this.lastUpdated = Date.parse(payload.lastModifiedAt);
            } catch (e) {
                console.error(e);
                throw e;
            }
            this.lastFetched = Date.now();
            return this;
        }
        throw new Error(response.statusText);
    }

}

class ProjectCacheEntry {

    constructor() {
        const epoch = new Date(0); // min date (start of epoch)
        this.attributes = {
            lastFetched: epoch,
            lastUpdated: epoch,
            customAttrIds: new Map(),
            customAttrs: []
        };
        this.byUrn = {};
    }

    async parseResponse(response, processLine) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let {
            value: chunk,
            done: readerDone
        } = await reader.read();
        let readString = chunk ? decoder.decode(chunk) : '';

        const re = /\r\n|\n|\r/g;
        let startIndex = 0;
        let line = null;

        for (;;) {
            line = re.exec(readString);
            if (!line) {
                if (readerDone) {
                    break;
                }
                const remainder = readString.substring(startIndex);
                ({
                    value: chunk,
                    done: readerDone
                } = await reader.read());
                readString = remainder + (chunk ? decoder.decode(chunk) : '');
                startIndex = re.lastIndex = 0;
                continue;
            }
            processLine(readString.substring(startIndex, line.index));
            startIndex = re.lastIndex;
        }
        if (startIndex < readString.length) {
            // last line didn't end in a newline char
            processLine(readString.substring(startIndex));
        }
    }

    async refreshCustomProperties({
        baseUrl,
        headers,
        projectId
    }) {

        const url = `${baseUrl}/v2/projects/${projectId}/custom-properties/fields`;
        var response = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
                ...headers
            }
        });
        if (response.ok) {
            const internedValues = new Map();
            const customAttrIds = new Map();
            const customAttrs = [];
            const processLine = (line) => {
                try {
                    const field = JSON.parse(line);
                    let category = internedValues.get(field.category);
                    if (!category) {
                        category = field.category;
                        internedValues.set(category, category);
                    }
                    const customPropertyDef = {
                        propertyHash: field.key,
                        category,
                        name: field.name,
                        displayName: field.displayName,
                        dataType: TypeMap[field.type] ? ? 0,
                        dataTypeContext: field.uom ? ? '',
                        flags: 0,
                        precision: field.precision ? ? 0,
                    };
                    var attrId = customAttrIds.get(customPropertyDef.propertyHash);
                    if (!attrId) {
                        attrId = customAttrs.length;
                        customAttrs.push(customPropertyDef);
                    }
                    customAttrIds.set(customPropertyDef.propertyHash, attrId);
                } catch (e) {
                    console.error(e);
                    console.log(line);
                    throw e;
                }
            };

            await this.parseResponse(response, processLine);
            const attributes = this.attributes;
            attributes.customAttrIds = customAttrIds;
            attributes.customAttrs = customAttrs;
            attributes.lastFetched = Date.now();
            return this;
        }
        throw new Error(response.statusText);
    }

    async acquireValuesCache({
        baseUrl,
        headers,
        projectId,
        seedFileUrn
    }) {
        let entry = this.byUrn[seedFileUrn];
        try {
            if (entry instanceof Promise) {
                // fetching is already in progress
                entry = await entry;
            } else if (entry === undefined || (Date.now() - entry.lastFetched) > 1000) {
                entry ? ? = new ValuesCacheEntry(this.attributes);
                const promise = entry.refreshCustomPropertiesValues({
                    baseUrl,
                    headers,
                    projectId,
                    seedFileUrn
                });
                this.byUrn[seedFileUrn] = promise;
                await promise;
                this.byUrn[seedFileUrn] = entry;
            }
        } catch (err) {
            delete this.byUrn[seedFileUrn];
            throw err;
        }
        return entry;
    }
}

export class CustomPropsCache {

    constructor() {
        this._cache = {};
    }

    async acquireDefinitionsCache({
        baseUrl,
        headers,
        projectId
    }) {
        let entry = this._cache[projectId];
        try {
            if (entry instanceof Promise) {
                // fetching is already in progress
                entry = await entry;
            } else if (entry === undefined || (Date.now() - entry.attributes.lastFetched) > 30000) {
                entry ? ? = new ProjectCacheEntry();
                const promise = entry.refreshCustomProperties({
                    baseUrl,
                    headers,
                    projectId
                });
                this._cache[projectId] = promise;
                await promise;
                this._cache[projectId] = entry;
            }
        } catch (err) {
            delete this._cache[projectId];
            throw err;
        }
        return entry;
    }
}

export function acquireCustomPropsCache(host) {
    let customPropsCache = host.customPropsCache;
    if (!customPropsCache) {
        host.customPropsCache = customPropsCache = new CustomPropsCache();
    }
    return customPropsCache;
}