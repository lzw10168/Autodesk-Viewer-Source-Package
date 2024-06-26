//Utility logic for listing vertex data from LmvBufferGeometry interleaved buffers

import {
    LmvVector3
} from './LmvVector3';

//These functions work for both workers side interleaved buffer structures
//and main thread side LmvBufferGeometry instances. The difference in naming
//if the index attribute on both sides is super annoying and should be cleaned up.


/** Works for BufferGeometry as well as THREE.BufferGeometry. Supports interleaved and non-interleaved buffers.
 *   @param {BufferGeometry|THREE.BufferGeometry} geom
 *   @returns {number}
 */
export function getVertexCount(geom) {
    if (geom.vb) {
        // interleaved
        return geom.vb.length / geom.vbstride;
    }
    // no interleaved buffer. Return count from position attribute or 0
    return (geom.attributes.position ? geom.attributes.position.array.length / 3 : 0);
}

export function getIndicesCount(geometry) {

    const indices = getIndexBuffer(geometry);

    if (indices) {

        var groups = geometry.groups;

        if (!groups || groups.length === 0) {
            return indices.length;
        }

        let res = 0;

        for (var oi = 0, ol = groups.length; oi < ol; ++oi) {
            res += groups[oi].count;
        }

        return res;

    } else {
        return getVertexCount(geometry);
    }
}

var _p, _n, _uv;
var _normalsMatrix;

/**
 * @typedef {Object} PositionVBInfo
 * @property {Float32Array} positions - Vertex buffer containing position data
 * @property {number} poffset - The array buffer offset for position data
 * @property {number} stride - The array buffer stride for both positions and normals
 */

/**
 * @typedef {Object} NormalVBInfo
 * @property {Float32Array} normals - Vertex buffer containing normal data
 * @property {number} noffset - The array buffer offset for normal data
 */

/**
 * Gathers minimum info to traverse the positions stored in an array buffer
 * @param {BufferGeometry|MeshData} geometry
 * @returns {PositionVBInfo}
 */
function extractVertexBufferPositionData(mdata) {
    const attributes = mdata.attributes;
    let positions, stride, poffset;
    // Get the offset to positions in the buffer. Be careful, 2D buffers
    // don't use the 'position' attribute for positions. Reject those.
    if (mdata.vblayout) {
        if (!mdata.vblayout.position)
            return {
                positions: undefined,
                poffset: undefined
            };
        poffset = mdata.vblayout.position.offset;
    } else if (!attributes.position)
        return {
            positions: undefined,
            poffset: undefined
        };
    else {
        poffset = attributes.position.offset || 0;
    }
    positions = mdata.vb || attributes.position.array;
    stride = mdata.vb ? mdata.vbstride : 3;
    return {
        positions,
        stride,
        poffset
    };
}

/**
 * Gathers minimum info to traverse the normals stored in an interleaved array buffer
 * @param {BufferGeometry|MeshData} geometry
 * @returns {NormalVBInfo}
 */
function extractVertexBufferNormalData(geometry) {
    const attributes = geometry.attributes;
    let noffset = 0;
    let noffsetFactor = 1;
    let normals = geometry.vb || (attributes.normal && attributes.normal.array);
    let nattr = geometry.vblayout ? geometry.vblayout.normal : (attributes.normal || null);

    if (nattr) {
        noffset = nattr.offset || 0;
        noffset *= noffsetFactor;
    } else {
        normals = null;
    }

    if (nattr && !nattr.array && (nattr.itemSize !== 3 || nattr.bytesPerItem !== 4)) {
        //console.log("Normals are packed, will be skipped from enumMeshTriangles. Use packNormals=false load option.");
        normals = null;
    }
    return {
        normals,
        noffset
    };
}

/**
 * Extracts the indices array
 * @param {BufferGeometry|MeshData} geometry
 * @returns {Uint16Array|null|undefined}
 */
function getIndexBuffer(geometry) {
    return (geometry.ib || geometry.indices) || (geometry.index ? geometry.index.array : null);
}

export function enumMeshVertices(geometry, callback, matrix) {

    var attributes = geometry.attributes;

    if (!_p) {
        _p = new LmvVector3();
        _n = new LmvVector3();
        _uv = new LmvVector3();
    }

    if (matrix) {
        if (!_normalsMatrix)
            _normalsMatrix = new THREE.Matrix3();

        _normalsMatrix.getNormalMatrix(matrix);
    }

    const {
        positions,
        stride,
        poffset
    } = extractVertexBufferPositionData(geometry);
    const {
        normals,
        noffset
    } = extractVertexBufferNormalData(geometry);
    if (!positions) return; // No positions, what to do??

    //TODO: UV channel

    var vcount = getVertexCount(geometry);

    var pi = poffset;
    var ni = noffset;
    for (var i = 0; i < vcount; i++, pi += stride, ni += stride) {

        _p.set(positions[pi], positions[pi + 1], positions[pi + 2]);

        if (matrix)
            _p.applyMatrix4(matrix);

        if (normals) {
            _n.set(normals[ni], normals[ni + 1], normals[ni + 2]);

            if (matrix) {
                _n.applyMatrix3(_normalsMatrix);
            }
        }

        //TODO: UV channel

        callback(_p, normals ? _n : null, null /*, _uv*/ , i);
    }
}

export function enumMeshIndices(geometry, callback) {
    const indices = getIndexBuffer(geometry);

    if (indices) {

        let groups = geometry.groups;

        if (!groups || groups.length === 0) {
            groups = [{
                start: 0,
                count: indices.length,
                index: 0
            }];
        }

        for (let oi = 0, ol = groups.length; oi < ol; ++oi) {

            let start = groups[oi].start;
            let count = groups[oi].count;
            let index = groups[oi].index;

            for (let i = start, il = start + count; i < il; i += 3) {

                let a = index + indices[i];
                let b = index + indices[i + 1];
                let c = index + indices[i + 2];

                callback(a, b, c);
            }
        }
    } else {

        let vcount = getVertexCount(geometry);

        for (let i = 0; i < vcount; i++) {

            let a = 3 * i;
            let b = 3 * i + 1;
            let c = 3 * i + 2;

            callback(a, b, c);
        }
    }
}


var vA, vB, vC, nA, nB, nC;

export function enumMeshTriangles(geometry, callback) {

    var a, b, c;

    if (!vA) {
        vA = new LmvVector3();
        vB = new LmvVector3();
        vC = new LmvVector3();

        nA = new LmvVector3();
        nB = new LmvVector3();
        nC = new LmvVector3();
    }

    const {
        positions,
        stride,
        poffset
    } = extractVertexBufferPositionData(geometry);
    const {
        normals,
        noffset
    } = extractVertexBufferNormalData(geometry);
    const indices = getIndexBuffer(geometry);
    if (!positions) return; // No positions, what to do??

    if (indices) {

        var groups = geometry.groups;

        if (!groups || groups.length === 0) {
            groups = [{
                start: 0,
                count: indices.length,
                index: 0
            }];
        }

        for (var oi = 0, ol = groups.length; oi < ol; ++oi) {

            var start = groups[oi].start;
            var count = groups[oi].count;
            var index = groups[oi].index;

            for (var i = start, il = start + count; i < il; i += 3) {

                a = index + indices[i];
                b = index + indices[i + 1];
                c = index + indices[i + 2];

                var pa = a * stride + poffset;
                var pb = b * stride + poffset;
                var pc = c * stride + poffset;

                vA.x = positions[pa];
                vA.y = positions[pa + 1];
                vA.z = positions[pa + 2];
                vB.x = positions[pb];
                vB.y = positions[pb + 1];
                vB.z = positions[pb + 2];
                vC.x = positions[pc];
                vC.y = positions[pc + 1];
                vC.z = positions[pc + 2];

                if (normals) {
                    var na = a * stride + noffset;
                    var nb = b * stride + noffset;
                    var nc = c * stride + noffset;

                    nA.x = normals[na];
                    nA.y = normals[na + 1];
                    nA.z = normals[na + 2];
                    nB.x = normals[nb];
                    nB.y = normals[nb + 1];
                    nB.z = normals[nb + 2];
                    nC.x = normals[nc];
                    nC.y = normals[nc + 1];
                    nC.z = normals[nc + 2];

                    callback(vA, vB, vC, a, b, c, nA, nB, nC, i / 3);
                } else {
                    callback(vA, vB, vC, a, b, c, null, null, null, i / 3);
                }


            }

        }

    } else {

        var vcount = getVertexCount(geometry);

        for (var i = 0; i < vcount; i += 3) {

            a = i;
            b = i + 1;
            c = i + 2;

            var pa = a * stride + poffset;
            var pb = b * stride + poffset;
            var pc = c * stride + poffset;

            vA.x = positions[pa];
            vA.y = positions[pa + 1];
            vA.z = positions[pa + 2];
            vB.x = positions[pb];
            vB.y = positions[pb + 1];
            vB.z = positions[pb + 2];
            vC.x = positions[pc];
            vC.y = positions[pc + 1];
            vC.z = positions[pc + 2];

            if (normals) {
                var na = a * stride + noffset;
                var nb = b * stride + noffset;
                var nc = c * stride + noffset;

                nA.x = normals[na];
                nA.y = normals[na + 1];
                nA.z = normals[na + 2];
                nB.x = normals[nb];
                nB.y = normals[nb + 1];
                nB.z = normals[nb + 2];
                nC.x = normals[nc];
                nC.y = normals[nc + 1];
                nC.z = normals[nc + 2];

                callback(vA, vB, vC, a, b, c, nA, nB, nC, i / 3);
            } else {
                callback(vA, vB, vC, a, b, c, null, null, null, i / 3);
            }
        }

    }
}


var vP, vQ;

export function enumMeshLines(geometry, callback) {

    var attributes = geometry.attributes;

    var a, b;

    if (!vP) {
        vP = new LmvVector3();
        vQ = new LmvVector3();
    }

    var istep = 2;
    if (geometry.lineWidth) {
        istep = 6;
    }

    const indices = getIndexBuffer(geometry);

    if (indices) {

        let positions, stride;
        positions = geometry.vb ? geometry.vb : attributes.position.array;
        stride = geometry.vb ? geometry.vbstride : 3;

        var groups = geometry.groups;

        if (!groups || groups.length === 0) {

            groups = [{
                start: 0,
                count: indices.length,
                index: 0
            }];

        }

        for (var oi = 0, ol = groups.length; oi < ol; ++oi) {

            var start = groups[oi].start;
            var count = groups[oi].count;
            var index = groups[oi].index;

            for (var i = start, il = start + count, lineIdx = start / istep; i < il; i += istep, lineIdx++) {

                a = index + indices[i];
                b = index + indices[i + 1];

                vP.x = positions[a * stride];
                vP.y = positions[a * stride + 1];
                vP.z = positions[a * stride + 2];
                vQ.x = positions[b * stride];
                vQ.y = positions[b * stride + 1];
                vQ.z = positions[b * stride + 2];

                callback(vP, vQ, a, b, lineIdx);
            }

        }

    } else {

        const positions = geometry.vb ? geometry.vb : attributes.position.array;
        const stride = geometry.vb ? geometry.vbstride : 3;

        for (var i = 0, il = positions.length / stride, lineIdx = 0; i < il; i += istep, lineIdx++) {

            a = i;
            b = i + 1;

            vP.x = positions[a * stride];
            vP.y = positions[a * stride + 1];
            vP.z = positions[a * stride + 2];
            vQ.x = positions[b * stride];
            vQ.y = positions[b * stride + 1];
            vQ.z = positions[b * stride + 2];

            callback(vP, vQ, a, b, lineIdx);
        }

    }
}


export function enumMeshEdges(geometry, callback) {

    var a, b;

    if (!vP) {
        vP = new LmvVector3();
        vQ = new LmvVector3();
    }

    var istep = 2;

    const indices = geometry.iblines;

    if (!indices) {
        return;
    }

    const positions = geometry.vb ? geometry.vb : attributes.position.array;
    const stride = geometry.vb ? geometry.vbstride : 3;

    var groups = geometry.groups;

    if (!groups || groups.length === 0) {

        groups = [{
            start: 0,
            count: indices.length,
            index: 0
        }];

    }

    for (var oi = 0, ol = groups.length; oi < ol; ++oi) {

        var start = groups[oi].start;
        var count = groups[oi].count;
        var index = groups[oi].index;

        for (var i = start, il = start + count; i < il; i += istep) {

            a = index + indices[i];
            b = index + indices[i + 1];

            vP.x = positions[a * stride];
            vP.y = positions[a * stride + 1];
            vP.z = positions[a * stride + 2];
            vQ.x = positions[b * stride];
            vQ.y = positions[b * stride + 1];
            vQ.z = positions[b * stride + 2];

            callback(vP, vQ, a, b);
        }

    }
}

export let VertexEnumerator = {
    getVertexCount,
    enumMeshVertices,
    enumMeshIndices,
    enumMeshTriangles,
    enumMeshLines,
    enumMeshEdges
};