import {
    isNodeJS
} from "../../compat";
import * as THREE from "three";
import {
    logger
} from "../../logger/Logger";

/**
 * @typedef {Object} AttributeLayout
 * @property {number} offset - Offset on the interleaved array buffer for that particular attribute
 * @property {number} itemSize - Number of elements for that attribute for that vertex
 * @property {number} bytesPerItem - Size of each element
 * @property {bool} normalized - Flag indicating if the values of the attribute are normalized
 */

/**
 * @typedef {Object} MeshData
 * @property {Float32Array} vb - Vertex buffer containing all interleaved attributes for the mesh
 * @property {Object<string, AttributeLayout>} vblayout - Layout of the buffer attributes
 * @property {Uint16Array} indices - Indices for the faces
 * @property {number} vbstride - Stride between attributes, assuming the Float32Array representation of the ArrayBuffer
 */

//Finds a precanned BufferAttribute corresponding to the given
//attribute data, so that we don't have to allocate the same exact
//one over and over and over.
var bufattrs = {};

// @todo: misleading name, since the function also crates a buffer attribute if none is cached,
// handles configuration of instancing, and, if incomming attribute layout (not data) is not interleaved
// no cache is skipped (no finding involved at all). This could be split into dedicated tasks.
export function findBufferAttribute(attributeName, attributeData, numInstances) {
    var attr;
    var attrNormalized = attributeData.normalize || attributeData.normalized;
    if (!attributeData.isInterleavedBufferAttribute && attributeData.array) {
        attr = new THREE.BufferAttribute(attributeData.array, attributeData.itemSize);
    } else {
        var id = attributeName + "|" +
            attributeData.bytesPerItem + "|" +
            attrNormalized + "|" +
            attributeData.isPattern + "|" +
            attributeData.divisor + "|" +
            attributeData.offset;

        attr = bufattrs[id];
        if (attr)
            return attr;

        attr = new THREE.BufferAttribute(undefined, attributeData.itemSize);
        bufattrs[id] = attr;
    }

    attr.normalized = attrNormalized;
    attr.bytesPerItem = attributeData.bytesPerItem;
    attr.isPattern = attributeData.isPattern;

    if (numInstances) {
        attr.divisor = attributeData.divisor;
    }

    if (!attributeData.isInterleavedBufferAttribute && attributeData.array) {
        //Is the data for the attribute specified separately
        //from the interleaved VB?
    } else if (Object.prototype.hasOwnProperty.call(attributeData, "offset")) {
        //If the attribute is in the interleaved VB, it has
        //an offset into it.
        attr.offset = attributeData.offset;
    } else {
        logger.warn("VB attribute is neither interleaved nor separate. Something is wrong with the buffer specificaiton.");
    }

    return attr;
}

var attrKeys = {};

function findAttributesKeys(geometry) {
    var key = "";

    for (var p in geometry.attributes)
        key += p + "|";

    var res = attrKeys[key];
    if (res)
        return res;

    res = Object.keys(geometry.attributes);
    attrKeys[key] = res;

    return res;
}

var indexAttr16;
var indexAttr32;
var idcounter = 1;
var LeanBufferGeometry = function() {

    //Avoid calling the superclass constructor for performance reasons.
    //Skips the creation of a uuid and defining an accessor for the .id property.
    //THREE.BufferGeometry.call(this);

    this.id = idcounter++;

    this.attributes = {};

    // Note:
    //  1. Although __webglInit would also be undefined without this assignment, it is still essential
    //     for performance reasons, because it makes this property known to the JIT compiler. Otherwise,
    //     it would be attached to each buffer later in WebGLRenderer - which would waste performance.
    //  2. It is essential to use "undefined" and not "false" here. The reason is that WebGLRenderer
    //     only checks in the form "__webglInit === undefined", i.e., setting it to "false" here would have
    //     the same effect like setting it to "true" and would finally cause a memory leak.
    this.__webglInit = undefined;
};

LeanBufferGeometry.prototype = Object.create(THREE.BufferGeometry.prototype);
LeanBufferGeometry.prototype.clone = function() {
    // Since Interleaved buffers are handled with some custom logic, the default clone logic fails when
    // cloning BufferAttributes
    const geometry = new LeanBufferGeometry();

    // custom LMV logic
    geometry.ib = this.ib;
    geometry.vb = this.vb;
    geometry.vbstride = this.vbstride;
    geometry.byteSize = this.byteSize;
    geometry.isLines = this.isLines;
    geometry.isWideLines = this.isWideLines;
    geometry.lineWidth = this.lineWidth;
    geometry.isPoints = this.isPoints;
    geometry.pointSize = this.pointSize;
    geometry.index = this.index;

    for (const attr in this.attributes) {
        const srcAttr = this.attributes[attr];
        const arr = srcAttr.array ? new srcAttr.array.constructor(this.array) : undefined;
        const dstAttr = new THREE.BufferAttribute(arr, srcAttr.itemSize);
        dstAttr.itemOffset = srcAttr.itemOffset;
        dstAttr.bytesPerItem = srcAttr.bytesPerItem;
        dstAttr.normalized = srcAttr.normalized;
        geometry.setAttribute(attr, dstAttr);
    }

    if (this.groups) {
        for (var i = 0, il = this.groups.length; i < il; i++) {
            var group = this.groups[i];
            geometry.groups.push({
                start: group.start,
                index: group.index,
                count: group.count
            });
        }
    }

    return geometry;
};
LeanBufferGeometry.prototype.constructor = LeanBufferGeometry;
LeanBufferGeometry.prototype.isLeanBufferGeometry = true;

function initBufferGeometry() {

    indexAttr16 = new THREE.BufferAttribute(undefined, 1);
    indexAttr16.bytesPerItem = 2;

    indexAttr32 = new THREE.BufferAttribute(undefined, 1);
    indexAttr32.bytesPerItem = 4;
}

export function createBufferGeometry(instanced) {
    if (!indexAttr16) {
        initBufferGeometry();
    }

    return new LeanBufferGeometry();
}

/**
 * Converts a mesh description passed back from worker threads into a renderable three.js
 * compatible BufferGeometry.
 * Sets various extra flags we need.
 * @param {Object} mdata
 * @param {MeshData} mdata.mesh
 */
export function meshToGeometry(mdata) {

    var mesh = mdata.mesh;
    var geometry = createBufferGeometry(mesh.numInstances);

    if (isNodeJS()) {
        //Used by SVF post-processing tools
        geometry.packId = mdata.packId;
        geometry.meshIndex = mdata.meshIndex;
    }

    geometry.byteSize = 0;

    geometry.vb = mesh.vb;
    geometry.vbbuffer = undefined;
    geometry.vbNeedsUpdate = true;
    geometry.vbstride = mesh.vbstride;
    geometry.byteSize += mesh.vb.byteLength;
    geometry.hash = mdata.hash;

    if (mesh.isLines) /* mesh is SVF lines */
        geometry.isLines = mesh.isLines;
    if (mesh.isWideLines) { /* mesh is SVF wide lines */
        geometry.isWideLines = true;
        geometry.lineWidth = mesh.lineWidth;
    }
    if (mesh.isPoints) { /* mesh is SVF points */
        geometry.isPoints = mesh.isPoints;
        geometry.pointSize = mesh.pointSize;
    }
    if (mdata.is2d) /* mesh is from F2D */ {
        geometry.is2d = true;
    }
    geometry.numInstances = mesh.numInstances;

    for (var attributeName in mesh.vblayout) {
        var attributeData = mesh.vblayout[attributeName];

        geometry.attributes[attributeName] = findBufferAttribute(attributeName, attributeData, mesh.numInstances);
    }
    //Index buffer setup
    geometry.index = (mesh.indices instanceof Uint32Array) ? indexAttr32 : indexAttr16;
    geometry.ib = mesh.indices;
    geometry.ibbuffer = undefined;

    if (mesh.iblines) {
        geometry.attributes.indexlines = (mesh.iblines instanceof Uint32Array) ? indexAttr32 : indexAttr16;
        geometry.iblines = mesh.iblines;
        geometry.iblinesbuffer = undefined;
    }

    // @todo: spelling: it should be 'attributeKeys'
    geometry.attributesKeys = findAttributesKeys(geometry);

    // @todo: this is most likely the wrong byte count. Make this a lazy query, computing the size on the fly and caching
    // the value for as long as the geometry does not change. To correctly account for ib and iblines? we should use
    // geometry.ib.byteLength + geometry.iblines.byteLength and
    // geometry.index.array.byteLength + geometry.indexlines.array.byteLength respectively.
    // Since there is no comment on what byteSize is expected to measure, this might be as well correct as is.
    geometry.byteSize += mesh.indices.byteLength;

    //TODO: Not sure chunking into list of smaller offset/counts
    //is required for LMV data since it's already broken up.
    //if (mesh.indices.length > 65535)
    // Works fine now. Left in for debugging.
    //if (mesh.vb.length / mesh.vbstride > 65535)
    //    logger.warn("Mesh with " + (mesh.vb.length / mesh.vbstride) + " > 65535 vertices. It will fail to draw.");

    //TODO: This is a transient object that gets freed once the geometry
    //is added to the GeometryList. We can save on the object creation
    //eventually when we do micro optimizations.
    if (mesh.boundingBox) {
        geometry.boundingBox = new THREE.Box3().copy(mesh.boundingBox);
        geometry.boundingSphere = new THREE.Sphere().copy(mesh.boundingSphere);
    }
    return geometry;
}


export let BufferGeometryUtils = {
    meshToGeometry: meshToGeometry,
    createBufferGeometry: createBufferGeometry,
    findBufferAttribute: findBufferAttribute
};