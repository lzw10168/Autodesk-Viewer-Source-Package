import {
    NullSnapperIndicator,
    SnapperIndicator
} from "./SnapperIndicator.js";
import {
    nearestPointOnCircularArc,
    intersectLines
} from "./SnapMath.js";

const MeasureCommon = Autodesk.Viewing.MeasureCommon;
const EPSILON = MeasureCommon.EPSILON;
const SnapType = MeasureCommon.SnapType;
const SnapResult = MeasureCommon.SnapResult;

var SNAP_PRECISION = 0.001;

const av = Autodesk.Viewing;
const avp = av.Private;
const VertexBufferReader = avp.VertexBufferReader;

/**
 * @param {number} a - First value to compare
 * @param {number} b - Second value to compare
 * @private
 */
function isEqualWithPrecision(a, b) {
    return Math.abs(a - b) <= SNAP_PRECISION;
}

/**
 * Are the vectors equal within SNAP_PRECISION?
 * @param {THREE.Vector3} v1 - vector
 * @param {THREE.Vector3} v2 - vector
 * @returns {boolean} - true when they are equal
 * @private
 */
function isEqualVectorsWithPrecision(v1, v2) {
    return Math.abs(v1.x - v2.x) <= SNAP_PRECISION &&
        Math.abs(v1.y - v2.y) <= SNAP_PRECISION &&
        Math.abs(v1.z - v2.z) <= SNAP_PRECISION;
}

/**
 * Are the vectors inverse of each other within SNAP_PRECISION?
 * @param {THREE.Vector3} v1 - vector
 * @param {THREE.Vector3} v2 - vector
 * @returns {boolean} - true when they are inverse of each other
 * @private
 */
function isInverseVectorsWithPrecision(v1, v2) {
    return Math.abs(v1.x + v2.x) <= SNAP_PRECISION &&
        Math.abs(v1.y + v2.y) <= SNAP_PRECISION &&
        Math.abs(v1.z + v2.z) <= SNAP_PRECISION;
}

/**
 * @param {THREE.Vector3} point - Point
 * @param {THREE.Vector3} lineStart - Start of the line
 * @param {THREE.Vector3} lineEnd - End of the line
 * @returns {number} - distance from point to the line
 * @private
 */
function distancePointToLine(point, lineStart, lineEnd) {

    if (lineStart.equals(lineEnd)) { // Degenerate line
        return point.distanceTo(lineStart);
    }

    var X0 = new THREE.Vector3();
    var X1 = new THREE.Vector3();
    var distance;
    var param;

    X0.subVectors(lineStart, point);
    X1.subVectors(lineEnd, lineStart);
    param = X0.dot(X1);
    X0.subVectors(lineEnd, lineStart);
    param = -param / X0.dot(X0);

    if (param < 0) {
        distance = point.distanceTo(lineStart);
    } else if (param > 1) {
        distance = point.distanceTo(lineEnd);
    } else {
        X0.subVectors(point, lineStart);
        X1.subVectors(point, lineEnd);
        X0.cross(X1);
        X1.subVectors(lineEnd, lineStart);

        distance = Math.sqrt(X0.dot(X0)) / Math.sqrt(X1.dot(X1));
    }

    return distance;
}

const SnapCandidateType = {
    Unknown: 0,
    Line: 1,
    CircularArc: 2,
    EllipticalArc: 3
};

// A SnapCandidate references a single segment (line or arc) that we could snap to.
class SnapCandidate {
    constructor(viewportId) {

        this.type = SnapCandidateType.Unknown;
        this.viewportId = viewportId;

        // 2d distance between original (unsnapped) position and the geometry of this candidate.
        this.distance = 0;

        // {Vector2} Start/Endpoint - only for line segments
        this.lineStart = null;
        this.lineEnd = null;

        // Fixed radius - only for CircularArcs
        this.radius = 0;

        // Separate radii - only for ellipse arcs
        this.radiusX = 0; // = major radius - by convention
        this.radiusY = 0;

        // Center point as Vector2 (for arcs)
        this.center = null;

        // Start/end angle for arcs: Ccw angle in radians. Angle 0 corresponds to direction x+.
        this.startAngle = 0;
        this.endAngle = 0;
    }

    fromLine(p1, p2) {
        this.type = SnapCandidateType.Line;
        this.lineStart = p1.clone();
        this.lineEnd = p2.clone();
        return this;
    }

    fromCircularArc(center, radius, start, end) {
        this.type = SnapCandidateType.CircularArc;
        this.center = center.clone();
        this.radius = radius;
        this.start = start;
        this.end = end;
        return this;
    }

    fromEllipticalArc(center, radiusX, radiusY, start, end) {
        this.type = SnapCandidateType.EllipticalArc;
        this.center = center.clone();
        this.radiusX = radiusX;
        this.radiusY = radiusY;
        this.start = start;
        this.end = end;
        return this;
    }

    isLine() {
        return this.type === SnapCandidateType.Line;
    }
    isCircularArc() {
        return this.type === SnapCandidateType.CirularArc;
    }
    isEllipticalArc() {
        return this.type === SnapCandidateType.EllipticalArc;
    }

    // Checks if the snapGeometry of this candidate intersects with another one.
    //  @param {SnapCandidate} other
    //  @param {Vector2} [optionalTarget]
    //  @returns {THREE.Vector2|null} Returns intersection point if there is one.
    getIntersection(other, optionalTarget) {

        if (this.isLine() && other.isLine()) {
            // Note: We do the intersections on the whole line - not just the intersections.
            // Reason is:
            //  a) Otherwise, it would not snap if you are slightly outline of one line segment
            //  b) By definition, we get only very close segment candidates anyway
            return intersectLines(this.lineStart, this.lineEnd, other.lineStart, other.lineEnd, false, optionalTarget);
        }

        // TODO: Currently, we only support snapping to line-line intersections
    }
}

// Checks if we can snap to an intersection of two close segments (each can be a line or arcs).
//  @param {SnapCandidate[]} candidates     - Snap candidate geometries collected in GeometryCallback. Assumed to be within snapRadius.
//  @param {TREE.Vector3}    intersectPoint - Unsnapped original position
//  @param {number}          snapRadius
//  @returns {Object|null} If an intersection snap is found, the result contains:
//                    {
//                        viewportId  // number
//                        snapPoint   // (THREE.Vector3)
//                    }
const findIntersectionSnap = (candidates, intersectPoint, snapRadius) => {

    // Sort snapping candidates by increasing distance
    // Strictly speaking, we just need the best two ones. But the number of candidates within the snapping
    // distance is generally small anyway - and working with a sorted array is more flexible to incrementally
    // make the snapping smarter later.
    const byDistance = (ca, cb) => ca.distance - cb.distance;
    candidates.sort(byDistance);

    // Stop here if we don't have enough candidates for an intersection
    if (candidates.length < 2) {
        return null;
    }

    // Init result object
    const result = {
        // Just use the one of the first candidate. There is no unique viewportId when using an intersection.
        viewportId: candidates[0].viewportId,

        // Snapping happens in 2d - so we set z in advance and just keep the original value.
        // Note: Snapper generally needs some revision if we use it for planes that are not perpendicular to the viewing direction.
        snapPoint: new THREE.Vector3(0, 0, intersectPoint.z)
    };

    // Check for any candidate that intersects with the closest one we found
    const first = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        const second = candidates[i];

        // Do intersection test. If found, write it to result.snapPoint
        const found = first.getIntersection(second, result.snapPoint);
        if (!found) {
            continue;
        }

        // We found an intersection. Although we assume all candidates to be within
        // snap radius already, the intersection may still be somewhere else.
        // => Check if intersection is still within the snapRadius.
        const dist = THREE.Vector2.prototype.distanceTo.call(result.snapPoint, intersectPoint);
        if (dist < snapRadius) {
            // We found a valid intersection snap
            return result;
        }
    }
    return null;
};


/**
 * A tool that lets users attach pointer events to vertices and edges. It supports 2D and 3D models.
 *
 * @param {Viewer3D} viewer - Viewer instance
 * @param {object} options - Configurations for the extension
 * @memberof Autodesk.Viewing.Extensions.Snapping
 * @alias Autodesk.Viewing.Extensions.Snapping.Snapper
 * @class
 */
export function Snapper(viewer, options) {

    var _snapResult = new SnapResult();

    var _viewer = viewer;
    this.setGlobalManager(viewer.globalManager);

    var _options = options || {};
    var _names;

    if (_options.markupMode) {
        _names = ["snapper-markup"];
    } else if (_options.toolName) {
        // Allow tools to use their own snapper
        _names = [_options.toolName];
    } else {
        _names = ["snapper"];
    }

    var _priority = 60;

    var _active = false;

    var _distanceToEdge = Number.MAX_VALUE;
    var _distanceToVertex = null;

    var _isDragging = false;
    var _isPressing = false;
    var _isSnapped = false;

    var _forcedVpId = null; // the viewport index of the first selection for 2D

    var _snapToPixel = false;

    var _snapFilter = null; // Optional snapping filter, based on snapResult. (snapResult) => boolean.

    this.indicator = new SnapperIndicator(viewer, this);

    this.markupMode = _options.markupMode;
    this.renderSnappedGeometry = _options.renderSnappedGeometry;
    this.renderSnappedTopology = _options.renderSnappedTopology;

    //Notice: The pixelSize should correspond to the amount of pixels per line in idAtPixels, the shape of
    //detection area is square in idAtPixels, but circle in snapper, should make their areas match roughly.
    this.detectRadiusInPixels = av.isMobileDevice() ? 50 : 10;

    /**
     * @returns {boolean} true when the tool is active
     *
     * @alias Autodesk.Viewing.Extensions.Snapping.Snapper#isActive
     */
    this.isActive = function() {
        return _active;
    };

    this.getNames = function() {
        return _names;
    };

    this.getName = function() {
        return _names[0];
    };

    this.getPriority = function() {
        return _priority;
    };

    /**
     * Starts intercepting pointer events.
     * Invoked automatically by the {@link ToolController}.
     *
     * @alias Autodesk.Viewing.Extensions.Snapping.Snapper#activate
     */
    this.activate = function() {
        _active = true;

        if (this.indicator.isNull()) {
            this.indicator = new SnapperIndicator(viewer, this);
        }
    };


    /**
     * Stops intercepting pointer events.
     * Invoked automatically by the {@link ToolController}.
     *
     * @alias Autodesk.Viewing.Extensions.Snapping.Snapper#deactivate
     */
    this.deactivate = function() {
        _active = false;

        if (!this.indicator.isNull()) {
            this.indicator.destroy();
            this.indicator = new NullSnapperIndicator();
        }
    };

    this.copyResults = function(destiny) {
        _snapResult.copyTo(destiny);
    };

    this.getEdge = function() {
        return _snapResult.geomEdge;
    };

    this.getVertex = function() {
        return _snapResult.geomVertex;
    };

    this.getGeometry = function() {
        return _snapResult.getGeometry();
    };

    this.getGeometryType = function() {
        return _snapResult.geomType;
    };

    this.getIntersectPoint = function() {
        return _snapResult.intersectPoint;
    };


    /**
     * @returns {SnapResult} The snapping status of the last pointer event performed.
     *
     * @alias Autodesk.Viewing.Extensions.Snapping.Snapper#getSnapResult
     */
    this.getSnapResult = function() {
        return _snapResult;
    };

    /**
     * Checks whether the tool's last update resulted on a snap.
     *
     * @returns {boolean} true when the last pointer event got snapped.
     *
     * @alias Autodesk.Viewing.Extensions.Snapping.Snapper#isSnapped
     */
    this.isSnapped = function() {
        return _isSnapped;
    };

    this.clearSnapped = function() {
        _snapResult.clear();
        _isSnapped = false;
    };

    this.setViewportId = function(vpId) {
        _forcedVpId = vpId;
    };

    this.setSnapToPixel = function(enable) {
        _snapToPixel = enable;
    };

    this.getSnapToPixel = function() {
        return _snapToPixel;
    };

    this.setSnapToArc = function(enable) {
        _snapResult.snapToArc = enable;
    };

    this.getSnapToArc = function() {
        return _snapResult.snapToArc;
    };

    this.setArc = function(isArc) {
        _snapResult.isArc = isArc;
    };

    this.getArc = function() {
        return _snapResult.isArc;
    };

    this.setSnapFilter = function(filter) {
        _snapFilter = filter;
    };

    /**
     * 3D Snapping
     *
     * @param result -Result of Hit Test.
     */
    this.snapping3D = function(result) {

        _snapResult.snapNode = result.dbId;
        _snapResult.intersectPoint = result.intersectPoint;
        _snapResult.modelId = result.model ? result.model.id : null;

        var face = result.face;

        if (!result.model || result.fragId === undefined) {
            // some non-model geometry was hit
            if (result.object instanceof THREE.Mesh) {
                // if it was a mesh, try to snap to it
                this.meshSnapping(face, result.object);
            }
        } else {
            var fragIds;

            if (result.fragId.length === undefined) {
                fragIds = [result.fragId];
            } else {
                fragIds = result.fragId;
            }

            // This is for Fusion model with topology data
            _snapResult.hasTopology = result.model.hasTopology();
            if (_snapResult.hasTopology) {
                this.snapping3DwithTopology(face, fragIds, result.model);
            } else {
                this.snapping3DtoMesh(face, fragIds, result.model);
            }
        }
    };


    /**
     * Returns a function that sets a vertex (Vector3 or LmvVector3) to the data read from a vertex buffer at idx
     * Signature: func(idx, vertex) -> vertex
     *            if vertex is null/undefined, a new THREE.Vector3 is created
     *
     * @param {BufferGeometry} geometry - the geometry of mesh
     *
     * @private
     */

    this.makeReadVertexFunc = function(geometry) {
        const attributes = geometry.attributes;
        let positions, stride;
        // Get the offset to positions in the buffer. Be careful, 2D buffers
        // don't use the 'position' attribute for positions. Reject those.
        // meshes use vblayout for describing the buffer structure, BufferGeometry uses attributes.xx
        let poffset;

        if (geometry.vblayout) {
            if (!geometry.vblayout.position) {
                return function() {}; // No positions, what to do??
            }
            poffset = geometry.vblayout.position.offset;
        } else if (!attributes.position) {
            return function() {}; // No positions, what to do??
        } else {
            poffset = attributes.position.offset || 0;
        }

        positions = geometry.vb ? geometry.vb : geometry.attributes.position.array;
        stride = geometry.vb ? geometry.vbstride : 3;

        return function(idx, v) {
            const p = idx * stride + poffset;
            v = v || new THREE.Vector3();
            v.set(
                positions[p],
                positions[p + 1],
                positions[p + 2]
            );
            return v;
        };
    };

    /**
     * Snapping order is: 1st vertices, 2nd edges, 3rd and final faces.
     *
     * @param face
     * @param fragIds
     * @param model
     * @private
     */
    this.snapping3DwithTopology = function(face, fragIds, model) {

        // Because edge topology data may be in other fragments with same dbId, need to iterate all of them.
        if (_snapResult.snapNode) {
            fragIds = [];

            model.getData().instanceTree.enumNodeFragments(_snapResult.snapNode, function(fragId) {
                fragIds.push(fragId);
            }, true);
        }

        _snapResult.geomFace = _snapResult.geomEdge = _snapResult.geomVertex = null;
        _distanceToEdge = Number.MAX_VALUE;

        for (var fi = 0; fi < fragIds.length; ++fi) {

            var fragId = fragIds[fi];

            const matrixWorld = new THREE.Matrix4();
            model.getFragmentList() ? .getWorldMatrix(fragId, matrixWorld);
            var geometry = model.getFragmentList() ? .getGeometry(fragId);

            var topoIndex = model.getTopoIndex(fragId);
            var topology = model.getTopology(topoIndex);
            var facesTopology = topology.faces;
            var edgesTopology = topology.edges;

            if (!_snapResult.geomFace) {
                _snapResult.geomFace = this.faceSnappingWithTopology(face, geometry, facesTopology, {
                    matrixWorld
                });

                if (_snapResult.geomFace) {
                    _snapResult.geomFace.fragId = fragId;
                }

                var normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld);
                _snapResult.faceNormal = face.normal.applyMatrix3(normalMatrix).normalize();
            }

            // Need to iterate all frags with same dbId, because when meshes are attached with each other,
            // edge-topology data will only be on one mesh.
            this.edgeSnappingWithTopology(_snapResult.intersectPoint, geometry, edgesTopology, {
                matrixWorld
            });

        }

        _snapResult.geomVertex = this.vertexSnappingWithTopology(_snapResult.geomEdge, _snapResult.intersectPoint);

        if (_snapResult.geomFace) {

            // Determine which one should be drawn: face , edge or vertex
            _snapResult.radius = this.setDetectRadius(_snapResult.intersectPoint);

            if ((_options.forceSnapVertices || _distanceToVertex < _snapResult.radius) && _snapResult.geomVertex) {
                _snapResult.geomType = SnapType.SNAP_VERTEX;
            } else if ((_options.forceSnapEdges || _distanceToEdge < _snapResult.radius) && _snapResult.geomEdge) {

                var center = this.edgeIsCircle(_snapResult.geomEdge);
                if (center) {
                    _snapResult.circularArcCenter = center;
                    _snapResult.circularArcRadius = center.distanceTo(_snapResult.geomEdge.vertices[0]);
                    _snapResult.geomEdge.center = _snapResult.circularArcCenter;
                    _snapResult.geomEdge.radius = _snapResult.circularArcRadius;
                    _snapResult.geomType = SnapType.SNAP_CIRCULARARC;
                } else if (this.edgeIsCurved(_snapResult.geomEdge)) {
                    _snapResult.geomType = SnapType.SNAP_CURVEDEDGE;
                } else {
                    _snapResult.geomType = SnapType.SNAP_EDGE;
                }

            } else {

                if (this.faceIsCurved(_snapResult.geomFace)) {
                    _snapResult.geomType = SnapType.SNAP_CURVEDFACE;
                } else {
                    _snapResult.geomType = SnapType.SNAP_FACE;
                }

            }

            _isSnapped = true;
        }
    };

    this.meshSnapping = function(face, {
        geometry,
        matrixWorld
    }) {

        // Handle 3D line geometry
        const isLine = geometry.isLines || geometry.isWideLines;
        if (isLine && face) {

            // For line meshes, face is a line {a, b} instead of a Face3 instance (see lineRayCast(..) in VBIntersector.js,
            // where a, b are vertex indices into the line mesh vertex array.
            //
            // Note: Unlike edge intersection for faces, we just use the line segment itself and don't search for topology
            //       of connected line segments to identify polylines as one item. If we need this, we have to add the corresponding code first.
            _snapResult.geomEdge = this.extractLineGeometry(face, geometry);
            _snapResult.geomEdge.applyMatrix4(matrixWorld);

            _snapResult.geomVertex = this.vertexSnapping(_snapResult.geomEdge, _snapResult.intersectPoint);

            _snapResult.radius = this.setDetectRadius(_snapResult.intersectPoint);

            // Determine which one should be drawn: edge or vertex
            if ((_options.forceSnapVertices || (_distanceToVertex < _snapResult.radius))) {
                _snapResult.geomType = SnapType.SNAP_VERTEX;
            } else {
                // Note: Since we got the edge as hit result, we can already assume the intersection to be close to the line.
                _snapResult.geomType = SnapType.SNAP_EDGE;
            }

            _isSnapped = true;
            return true;
        }

        // Note that face may also be a line {a, b} (see lineRayCast(..) in VBIntersector.js
        if (face instanceof THREE.Face3) {
            _snapResult.geomFace = this.faceSnapping(face, geometry);
        }

        if (!_snapResult.geomFace)
            return false;

        _snapResult.geomFace.applyMatrix4(matrixWorld);
        _snapResult.geomEdge = this.edgeSnapping(_snapResult.geomFace, _snapResult.intersectPoint);
        _snapResult.geomVertex = this.vertexSnapping(_snapResult.geomEdge, _snapResult.intersectPoint);

        var normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld);
        _snapResult.faceNormal = face.normal.applyMatrix3(normalMatrix).normalize();

        _snapResult.radius = this.setDetectRadius(_snapResult.intersectPoint);

        // Determine which one should be drawn: face, edge or vertex
        if ((_options.forceSnapVertices || (_distanceToVertex < _snapResult.radius))) {
            _snapResult.geomType = SnapType.SNAP_VERTEX;
        } else if (_options.forceSnapEdges || (_distanceToEdge < _snapResult.radius)) {
            _snapResult.geomType = SnapType.SNAP_EDGE;
        } else {
            _snapResult.geomType = SnapType.SNAP_FACE;
        }

        _isSnapped = true;
        return true;
    };

    this.snapping3DtoMesh = function(face, fragIds, model) {
        for (var fi = 0; fi < fragIds.length; ++fi) {

            var fragId = fragIds[fi];


            const geometry = model.getFragmentList().getGeometry(fragId);
            const matrixWorld = new THREE.Matrix4();
            model.getFragmentList().getWorldMatrix(fragId, matrixWorld);

            if (this.meshSnapping(face, {
                    geometry,
                    matrixWorld
                })) {
                break;
            }
        }
    };

    this.faceSnappingWithTopology = function(face, geometry, facesTopology, {
        matrixWorld
    }) {

        var vA = new THREE.Vector3();
        var vB = new THREE.Vector3();
        var vC = new THREE.Vector3();

        const geom = new THREE.Geometry();
        const vertices = [];

        if (geometry.index !== undefined) {

            // Find the index of face topology list which includes the intersect face(triangle)
            for (var i = 0; i < facesTopology.length; i++) {

                var indexList = facesTopology[i].indexList;
                var faceId = facesTopology[i].id;
                let j = 0;
                for (; j < indexList.length; j += 3) {

                    if (face.a === indexList[j]) {
                        if ((face.b === indexList[j + 1] && face.c === indexList[j + 2]) || (face.b === indexList[j + 2] && face.c === indexList[j + 1])) {
                            break;
                        }
                    } else if (face.a === indexList[j + 1]) {
                        if ((face.b === indexList[j] && face.c === indexList[j + 2]) || (face.b === indexList[j + 2] && face.c === indexList[j])) {
                            break;
                        }
                    } else if (face.a === indexList[j + 2]) {
                        if ((face.b === indexList[j] && face.c === indexList[j + 1]) || (face.b === indexList[j + 1] && face.c === indexList[j])) {
                            break;
                        }
                    }
                }

                if (j < indexList.length) {
                    break;
                }
            }

            if (i < facesTopology.length) {

                const readVertex = this.makeReadVertexFunc(geometry);

                for (let j = 0; j < indexList.length; j += 3) {
                    readVertex(indexList[j], vA);
                    readVertex(indexList[j + 1], vB);
                    readVertex(indexList[j + 2], vC);

                    const vIndex = vertices.length;
                    geom.faces.push(new THREE.Face3(vIndex, vIndex + 1, vIndex + 2));
                    vertices.push(vA.clone());
                    vertices.push(vB.clone());
                    vertices.push(vC.clone());
                }
                geom.vertices = vertices;

            }
        }

        if (vertices.length > 0) {

            geom.faceId = faceId;
            geom.applyMatrix4(matrixWorld);
            return geom;
        } else {

            return null;
        }

    };

    /**
     * Find the closest face next to the cast ray
     *
     * @param {THREE.Face3} face - the intersect triangle of Hit Test.
     * @param {BufferGeometry} geometry - the geometry of mesh
     *
     * @private
     */
    this.faceSnapping = function(face, geometry) {

        var vA = new THREE.Vector3();
        var vB = new THREE.Vector3();
        var vC = new THREE.Vector3();

        const geom = new THREE.Geometry(); //Geometry which includes all the triangles on the same plane.

        let indices;
        // @todo: .ib might not be there as expected, e.g., the section tool seems to create incomplete/non-conforming geometries.
        indices = geometry.index && (geometry.index.array || geometry.ib);

        var offsets = geometry.groups;

        if (!offsets || offsets.length === 0) {

            let positions;
            // @todo: .vb might not be there as expected, e.g., the section tool seems to create incomplete/non-conforming geometries.
            positions = geometry.vb ? ? geometry.attributes.position.array;
            offsets = [{
                start: 0,
                count: indices ? indices.length : positions.length,
                index: 0
            }];
        }

        const readVertex = this.makeReadVertexFunc(geometry);

        const va = readVertex(face.a);

        for (var oi = 0; oi < offsets.length; ++oi) {

            var start = offsets[oi].start;
            var count = offsets[oi].count;
            var index = 0;
            index = offsets[oi].index;

            for (var i = start; i < start + count; i += 3) {

                var a = index + (indices ? indices[i] : i);
                var b = index + (indices ? indices[i + 1] : i + 1);
                var c = index + (indices ? indices[i + 2] : i + 2);

                readVertex(a, vA);
                readVertex(b, vB);
                readVertex(c, vC);

                var faceNormal = new THREE.Vector3();
                THREE.Triangle.getNormal(vA, vB, vC, faceNormal);

                if (isEqualVectorsWithPrecision(faceNormal, face.normal) && isEqualWithPrecision(faceNormal.dot(vA), face.normal.dot(va))) {

                    const vIndex = geom.vertices.length;
                    geom.faces.push(new THREE.Face3(vIndex, vIndex + 1, vIndex + 2));
                    geom.vertices.push(vA.clone());
                    geom.vertices.push(vB.clone());
                    geom.vertices.push(vC.clone());
                }
            }
        }

        if (geom.vertices.length > 0) {

            return this.getTrianglesOnSameFace(geom, face, readVertex);
        } else {

            return null;
        }
    };

    /**
     * Find triangles on the same face with the triangle intersected with the cast ray
     *
     * @param geom -Geometry which includes all the triangles on the same plane.
     * @param face -Triangle which intersects with the cast ray.
     * @param readVertexCB -Accessor function to read vertex data (see makeReadVertexFunc)
     *
     * @private
     */
    this.getTrianglesOnSameFace = function(geom, face, readVertexCB) {
        const vertices = geom.vertices;

        const faceVertex1 = readVertexCB(face.a);
        const faceVertex2 = readVertexCB(face.b);
        const faceVertex3 = readVertexCB(face.c);

        const intersectFace = new THREE.Geometry();

        const precisionPoints = 5; // number of decimal points, eg. 4 for epsilon of 0.0001
        const precision = Math.pow(10, precisionPoints);

        // Build triangle list
        // Each triangle will contain a list of its 3 edges
        // Also maintain an edge map, pointing to the triangles indices that contain it
        const trianglesArr = [];
        const edgesMap = {};
        let firstTriangle = -1; // Will point to index of passed face parameter
        for (let i = 0; i < vertices.length; i += 3) {
            // for each triangle
            const vA = vertices[i];
            const vB = vertices[i + 1];
            const vC = vertices[i + 2];

            if (firstTriangle < 0 && faceVertex1.equals(vA) && faceVertex2.equals(vB) && faceVertex3.equals(vC)) {
                firstTriangle = i / 3;
            }

            const keys = [
                Math.round(vA.x * precision) + '_' + Math.round(vA.y * precision) + '_' + Math.round(vA.z * precision),
                Math.round(vB.x * precision) + '_' + Math.round(vB.y * precision) + '_' + Math.round(vB.z * precision),
                Math.round(vC.x * precision) + '_' + Math.round(vC.y * precision) + '_' + Math.round(vC.z * precision)
            ];
            const triangle = {
                edges: []
            };

            // Edge map update
            for (let j = 0; j < 3; j++) {
                const key1 = keys[j];
                const key2 = keys[(j + 1) % 3];

                const defaultEdge = key1 + '_' + key2;
                let edge = edgesMap[defaultEdge] || edgesMap[key2 + '_' + key1];
                if (!edge) {
                    // If this edge hasn't been added before, add it now
                    edge = edgesMap[defaultEdge] = {
                        triangles: []
                    };
                }

                // Add edge to current triangle
                triangle.edges.push(edge);
                // Add current triangle to edge
                edge.triangles.push(i / 3);
            }

            trianglesArr.push(triangle);
        }

        if (firstTriangle < 0) {
            return null;
        }

        // BFS search for neighbouring triangles
        const queue = [firstTriangle];
        const visited = new Set();
        const connectedFaces = [];

        while (queue.length > 0) {
            const currentFace = queue.shift();

            if (visited.has(currentFace)) {
                continue;
            }

            visited.add(currentFace);

            // Add this face to the list of connected faces
            connectedFaces.push(currentFace);

            // Add all neighboring faces to the queue
            const triangle = trianglesArr[currentFace];
            for (const edge of triangle.edges) {
                edge.triangles.forEach(t => t !== currentFace && queue.push(t));
            }
        }

        // Copy results of the actual vertices in the connected faces
        // Since vertices are already cloned in faceSnapping, there's no need to clone them again
        const finalVertices = [];
        let vIndex = 0;
        connectedFaces.forEach(faceIdx => {
            intersectFace.faces.push(new THREE.Face3(vIndex++, vIndex++, vIndex++));
            finalVertices.push(vertices[faceIdx * 3]);
            finalVertices.push(vertices[faceIdx * 3 + 1]);
            finalVertices.push(vertices[faceIdx * 3 + 2]);
        });

        intersectFace.vertices = finalVertices;

        return intersectFace;
    };

    this.edgeSnappingWithTopology = function(intersectPoint, geometry, edgesTopology, {
        matrixWorld
    }) {

        const edgeGeom = new THREE.Geometry(); //Geometry which includes all the triangles on the same plane.
        var minDistTopoIndex;
        var minDist = Number.MAX_VALUE;

        var vA = new THREE.Vector3();
        var vB = new THREE.Vector3();

        if (geometry.index !== undefined && edgesTopology != undefined) {

            const readVertex = this.makeReadVertexFunc(geometry);
            // Find the index of edge topology list which includes the nearest edge segment to the intersect point
            for (var i = 0; i < edgesTopology.length; i++) {

                var indexList = edgesTopology[i].indexList;
                // In edges topology index list the type is LineStrip
                for (var j = 0; j < indexList.length - 1; j++) {
                    readVertex(indexList[j], vA);
                    readVertex(indexList[j + 1], vB);

                    vA.applyMatrix4(matrixWorld);
                    vB.applyMatrix4(matrixWorld);

                    var dist = distancePointToLine(intersectPoint, vA, vB);
                    if (dist < minDist) {
                        minDist = dist;
                        minDistTopoIndex = i;
                    }
                }
            }

            if (minDistTopoIndex) {
                indexList = edgesTopology[minDistTopoIndex].indexList;
                for (var k = 0; k < indexList.length - 1; k++) {
                    const vK0 = readVertex(indexList[k]);
                    const vK1 = readVertex(indexList[k + 1]);

                    edgeGeom.vertices.push(vK0);
                    // To make the line's type to LinePieces which is used by drawLine function
                    edgeGeom.vertices.push(vK1);
                }
            }
        }

        if (_distanceToEdge >= minDist && edgeGeom.vertices.length > 0) {

            _distanceToEdge = minDist;
            edgeGeom.applyMatrix4(matrixWorld);
            _snapResult.geomEdge = edgeGeom;
        }
    };

    /**
     * Get Edge geometry for the case that the hittest result contained a 3D lines. For this case, we have no Face3, so
     * that faceSnapping and edgeSnapping don't work.
     *
     *  @param {Object}         edge     - {a, b} with vertex indices a,b of lineStart/lineEnd vertex
     *  @param {GeometryBuffer} geometry
     *  @returns {THREE.Geometry|THREE.BufferGeometry} Geometry with simple line
     */
    this.extractLineGeometry = function(edge, geometry) {

        const readVertex = this.makeReadVertexFunc(geometry);
        const va = readVertex(edge.a);
        const vb = readVertex(edge.b);

        const edgeGeom = new THREE.Geometry();
        edgeGeom.vertices.push(va, vb);
        return edgeGeom;
    };

    /**
     * Find the closest edge next to the intersect point
     *
     * @param face -Face which is found by faceSnapping.
     * @param intersectPoint -IntersectPoint between cast ray and face.
     *
     * @private
     */
    this.edgeSnapping = function(face, intersectPoint) {

        const vertices = [];
        const verticesLength = face.vertices.length;
        var isEdge_12 = true;
        var isEdge_13 = true;
        var isEdge_23 = true;

        for (var i = 0; i < verticesLength; i += 3) {
            const pi0 = face.vertices[i];
            const pi1 = face.vertices[i + 1];
            const pi2 = face.vertices[i + 2];

            for (var j = 0; j < verticesLength; j += 3) {
                if (i !== j) {
                    const pj0 = face.vertices[j];
                    const pj1 = face.vertices[j + 1];
                    const pj2 = face.vertices[j + 2];
                    // Check edge 12
                    if ((pi0.equals(pj0) || pi0.equals(pj1) || pi0.equals(pj2)) &&
                        (pi1.equals(pj0) || pi1.equals(pj1) || pi1.equals(pj2))) {
                        isEdge_12 = false;
                    }
                    // Check edge 13
                    // Check edge 12
                    if ((pi0.equals(pj0) || pi0.equals(pj1) || pi0.equals(pj2)) &&
                        (pi2.equals(pj0) || pi2.equals(pj1) || pi2.equals(pj2))) {
                        isEdge_13 = false;
                    }
                    // Check edge 23
                    // Check edge 12
                    if ((pi1.equals(pj0) || pi1.equals(pj1) || pi1.equals(pj2)) &&
                        (pi2.equals(pj0) || pi2.equals(pj1) || pi2.equals(pj2))) {
                        isEdge_23 = false;
                    }
                }
            }

            if (isEdge_12) {
                vertices.push(pi0.clone());
                vertices.push(pi1.clone());
            }
            if (isEdge_13) {
                vertices.push(pi0.clone());
                vertices.push(pi2.clone());
            }
            if (isEdge_23) {
                vertices.push(pi1.clone());
                vertices.push(pi2.clone());
            }

            isEdge_12 = true;
            isEdge_13 = true;
            isEdge_23 = true;

        }

        //return lineGeom;

        const edgeVertices = [];
        const edgeGeom = new THREE.Geometry();
        var minDistIndex;
        var minDist = Number.MAX_VALUE;

        for (var k = 0; k < vertices.length; k += 2) {

            var dist = distancePointToLine(intersectPoint, vertices[k], vertices[k + 1]);

            if (dist < minDist) {
                minDist = dist;
                minDistIndex = k;
            }

        }

        edgeVertices.push(vertices[minDistIndex].clone());
        edgeVertices.push(vertices[minDistIndex + 1].clone());

        const lineGeom = new THREE.Geometry();
        lineGeom.vertices = vertices;
        edgeGeom.vertices = this.getConnectedLineSegmentsOnSameLine(lineGeom, edgeVertices);

        _distanceToEdge = minDist;

        return edgeGeom;
    };

    this.getConnectedLineSegmentsOnSameLine = function(lineGeom, edgeVertices) {

        const vertices = lineGeom.vertices.slice();
        var va = edgeVertices[0];
        var vb = edgeVertices[1];

        var vCount = [];

        do {

            vCount = [];

            for (var j = 0; j < vertices.length; j += 2) {

                // The line which has min distance to intersection point
                if (vertices[j].equals(va) && vertices[j + 1].equals(vb)) {

                    continue;
                }

                for (var k = 0; k < edgeVertices.length; k += 2) {

                    // The line segments which are connected on the same line
                    if (vertices[j].equals(edgeVertices[k]) || vertices[j + 1].equals(edgeVertices[k]) ||
                        vertices[j].equals(edgeVertices[k + 1]) || vertices[j + 1].equals(edgeVertices[k + 1])) {

                        var V0 = new THREE.Vector3();
                        var V1 = new THREE.Vector3();

                        V0.subVectors(edgeVertices[k], edgeVertices[k + 1]);
                        V0.normalize();
                        V1.subVectors(vertices[j], vertices[j + 1]);
                        V1.normalize();

                        //if (V0.equals(V1) || V0.equals(V1.negate())) {
                        if (isEqualVectorsWithPrecision(V0, V1) || isInverseVectorsWithPrecision(V0, V1)) {

                            vCount.push(j);
                            break;

                        }
                    }
                }
            }

            for (var ci = vCount.length - 1; ci >= 0; --ci) {

                edgeVertices.push(vertices[vCount[ci]]);
                edgeVertices.push(vertices[vCount[ci] + 1]);
                vertices.splice(vCount[ci], 2);
            }

        } while (vCount.length > 0);

        return edgeVertices;

    };

    this.vertexSnappingWithTopology = function(edge, intersectPoint) {

        var minDist = Number.MAX_VALUE;
        var point = new THREE.Vector3();
        if (!edge) {
            return point;
        }

        if (edge.vertices.length > 1) {
            const start = edge.vertices[0];
            const end = edge.vertices[edge.vertices.length - 1];
            var dist1 = intersectPoint.distanceTo(start);
            var dist2 = intersectPoint.distanceTo(end);

            if (dist1 <= dist2) {
                minDist = dist1;
                point = start.clone();
            } else {
                minDist = dist2;
                point = end.clone();
            }
        }

        _distanceToVertex = minDist;

        return point;
    };

    /**
     * Find the closest vertex next to the intersect point
     *
     * @param edge -Edge which is found by edgeSnapping.
     * @param intersectPoint -IntersectPoint between cast ray and face.
     *
     * @private
     */
    this.vertexSnapping = function(edge, intersectPoint) {

        var minDist = Number.MAX_VALUE;
        var point = new THREE.Vector3();
        const verticesLength = edge.vertices.length;

        for (let i = 0; i < verticesLength; ++i) {
            const pt = edge.vertices[i];
            const dist = intersectPoint.distanceTo(pt);

            if (dist < minDist - SNAP_PRECISION) {

                minDist = dist;
                point = pt.clone();

            }
        }

        _distanceToVertex = minDist;

        return point;
    };

    // This is only a workaround to detect if an edge is circle
    this.edgeIsCircle = function(edge) {

        const vertices = edge.vertices;

        // Exclude squares and regular polygons
        if (vertices.length < 8) {
            return false;
        }

        const start = vertices[0];
        const end = vertices[vertices.length - 1];

        if (start.equals(end)) {

            var center = new THREE.Vector3(0, 0, 0);
            for (let i = 0; i < vertices.length; i += 2) {
                center.add(vertices[i]);
            }
            center.divideScalar(vertices.length / 2.0);

            var radius = center.distanceTo(start);
            for (let i = 0; i < vertices.length; i += 2) {
                if (Math.abs(center.distanceTo(vertices[i]) - radius) <= SNAP_PRECISION) {
                    continue;
                } else {
                    return false;
                }
            }
            return center;
        } else {
            return false;
        }
    };

    this.edgeIsCurved = function(edge) {

        const vertices = edge.vertices;
        const start = vertices[0];
        const end = vertices[vertices.length - 1];

        if (vertices.length <= 2) {
            return false;
        } else if (start.equals(end)) {
            return true;
        } else {
            var V1 = new THREE.Vector3();
            let pi0;
            let pi1 = vertices[1];

            V1.subVectors(start, pi1);

            var V2 = new THREE.Vector3();
            for (var i = 2; i < vertices.length; i += 2) {
                pi0 = vertices[i];
                pi1 = vertices[i + i];
                V2.subVectors(pi0, pi1);
                if (!isEqualVectorsWithPrecision(V1, V2)) {
                    return true;
                }
            }

            return false;
        }
    };

    /**
     * Checks if the given geometry is curved
     * @param {THREE.BufferGeometry} face The geometry
     * @returns {boolean} True if the any of the faces composing the geometry is curved
     */
    this.faceIsCurved = function(face) {

        const vertices = face.vertices;
        const faces = face.faces;

        if (faces.length <= 1) {
            return false;
        }

        var fN1 = new THREE.Vector3();
        const vA1 = vertices[faces[0].a];
        THREE.Triangle.getNormal(vertices[faces[0].a], vertices[faces[0].b], vertices[faces[0].c], fN1);

        var fN2 = new THREE.Vector3();
        for (let i = 1; i < faces.length; i++) {
            const vA2 = vertices[faces[i].a];
            THREE.Triangle.getNormal(vertices[faces[i].a], vertices[faces[i].b], vertices[faces[i].c], fN2);
            if (!isEqualVectorsWithPrecision(fN1, fN2) || !isEqualWithPrecision(fN1.dot(vA1), fN2.dot(vA2))) {
                return true;
            }
        }

        return false;
    };

    this.angleVector2 = function(vector) {

        if (vector.x > 0 && vector.y >= 0) {
            return Math.atan(vector.y / vector.x);
        } else if (vector.x >= 0 && vector.y < 0) {
            return Math.atan(vector.y / vector.x) + Math.PI * 2;
        } else if (vector.x < 0 && vector.y <= 0) {
            return Math.atan(vector.y / vector.x) + Math.PI;
        } else if (vector.x <= 0 && vector.y > 0) {
            return Math.atan(vector.y / vector.x) + Math.PI;
        } else { // x = 0, y = 0
            return null;
        }
    };

    // Creates a THREE.Geometry that represents an approximation of a given elliptical arc in {z=0} plane.
    // Points are obtained by by uniform sampling of a given elliptical arc.
    //  @param {number} numPoints - The length number of points that the output geometry will contain. segments in which we subdivide the arc. Resulting point count is numSegments+1.
    // See getEllipseArcPoint() for param details.
    const createEllipticalArcGeometry = (cx, cy, rx, ry, startAngle, endAngle, numPoints) => {
        let geometry = new THREE.Geometry();
        for (let i = 0; i < numPoints; i++) {
            const p = new THREE.Vector3(0, 0, 0);
            const t = i / (numPoints - 1);
            Autodesk.Extensions.CompGeom.getEllipseArcPoint(t, cx, cy, rx, ry, startAngle, endAngle, 0.0, p);
            geometry.vertices.push(p);
        }
        return geometry;
    };

    /**
     * @param {Viewer3D} viewer - Viewer instance
     * @param snapper
     * @param aDetectRadius
     * @private
     */
    function GeometryCallback(viewer, snapper, aDetectRadius) {
        this.viewer = viewer;
        this.snapper = snapper;

        this.lineGeom = new THREE.Geometry();
        this.circularArc = null;
        this.circularArcCenter;
        this.circularArcRadius;
        this.ellipticalArc = null;
        this.ellipticalArcCenter;

        this.minDist = Number.MAX_VALUE;

        this.matrix = new THREE.Matrix4();

        this.vpIdLine = null;
        this.vpIdCircular = null;
        this.vpIdElliptical = null;

        this.detectRadius = aDetectRadius;

        // Collects candidate segments that we can snap to.
        // This is used to allow snapping to segment intersections.
        this.snapCandidates = []; // {SnappingCandidate[]}
    }

    GeometryCallback.prototype.onLineSegment = function(x1, y1, x2, y2, vpId) {
        var intersectPoint = this.snapper.getIntersectPoint();
        var v1 = new THREE.Vector3(x1, y1, intersectPoint.z);
        var v2 = new THREE.Vector3(x2, y2, intersectPoint.z);

        // LMV-5515: Apply the supplied matrix to the line vector's
        if (this.matrix) {
            v1.applyMatrix4(this.matrix);
            v2.applyMatrix4(this.matrix);
        }

        // Skip segments outside detectRadius
        var dist = distancePointToLine(intersectPoint, v1, v2);
        if (dist > this.detectRadius) {
            return;
        }

        // Collect snap candidate
        this.snapCandidates.push(new SnapCandidate(vpId, dist).fromLine(v1, v2));

        // Track minDist and lineGeometry for best hit so far
        if (dist < this.minDist) {
            this.lineGeom.vertices.splice(0, 2, v1, v2);
            this.minDist = dist;

            this.vpIdLine = vpId;
        }
    };

    GeometryCallback.prototype.onCircularArc = function(cx, cy, start, end, radius, vpId) {
        var intersectPoint = this.snapper.getIntersectPoint();
        var point = new THREE.Vector2(intersectPoint.x, intersectPoint.y);

        var center = new THREE.Vector2(cx, cy);
        point.sub(center);

        // Compute closest point on arc
        const pointOnArc = nearestPointOnCircularArc(intersectPoint, center, radius, start, end);
        const dist = pointOnArc.distanceTo(intersectPoint); // 2D distance

        // Collect snap candidate
        this.snapCandidates.push(new SnapCandidate(vpId, dist).fromCircularArc(center, radius, start, end));

        // Skip arcs outside detectRadius
        if (dist > this.detectRadius) {
            return;
        }

        // TODO: get rid of the CircleGeometry stuff below, because we computed the snapPoint above already.
        //       But this needs some refactoring, because the Geometry is passed around outside of snapper.

        var angle = this.snapper.angleVector2(point);

        let arc;
        if (end > start && angle >= start && angle <= end) {
            arc = new THREE.CircleGeometry(radius, 100, start, end - start);
        } else if (end < start && (angle >= start || angle <= end)) {
            arc = new THREE.CircleGeometry(radius, 100, start, Math.PI * 2 - start + end);
        } else {
            return;
        }

        arc.vertices.splice(0, 1);

        arc.applyMatrix4(new THREE.Matrix4().makeTranslation(cx, cy, intersectPoint.z));
        this.circularArc = arc;
        this.circularArcCenter = new THREE.Vector3(cx, cy, intersectPoint.z);
        this.circularArcRadius = radius;

        this.snapPoint = new THREE.Vector3(pointOnArc.x, pointOnArc.y, intersectPoint.z);

        this.vpIdCircular = vpId;
    };

    GeometryCallback.prototype.onEllipticalArc = function(cx, cy, start, end, major, minor, tilt, vpId) {
        var intersectPoint = this.snapper.getIntersectPoint();
        var point = new THREE.Vector2(intersectPoint.x, intersectPoint.y);

        var major1 = major - this.detectRadius;
        var minor1 = minor - this.detectRadius;
        var major2 = major + this.detectRadius;
        var minor2 = minor + this.detectRadius;

        var equation1 = (point.x - cx) * (point.x - cx) / (major1 * major1) + (point.y - cy) * (point.y - cy) / (minor1 * minor1);
        var equation2 = (point.x - cx) * (point.x - cx) / (major2 * major2) + (point.y - cy) * (point.y - cy) / (minor2 * minor2);

        var center = new THREE.Vector2(cx, cy);
        point.sub(center);
        point.x *= minor;
        point.y *= major;
        var angle = this.snapper.angleVector2(point);

        if (end > Math.PI * 2) {
            end = Math.PI * 2;
        }

        if (equation1 >= 1 && equation2 <= 1) {

            if ((end > start && angle >= start && angle <= end) || (end < start && (angle >= start || angle <= end))) {
                var arc = createEllipticalArcGeometry(cx, cy, major, minor, start, end, 50);
                if (!isEqualWithPrecision(end - start, Math.PI * 2)) {
                    arc.vertices.pop();
                }
                arc.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, intersectPoint.z));

                // Compute distance between geometry and snapped point.
                // We use the same way here as in getSnapResultPosition(). This will be replaced later by a more accurate solution.
                const nearestPoint = MeasureCommon.nearestVertexInVertexToEdge(intersectPoint, arc);
                const dist = THREE.Vector2.prototype.distanceTo.call(nearestPoint, intersectPoint); // only in x/y

                // Collect snap candidate
                const center = new THREE.Vector2(cx, cy);
                this.snapCandidates.push(new SnapCandidate(vpId, dist).makeEllipticalArc(center, major, minor, start, end));

                // Todo: Unlike for line-segments, arcs are currently collected by "last one wins" rule by the code for single-snapping.
                //       We should consider the distance here as well.
                this.ellipticalArc = arc;
                this.ellipticalArcCenter = new THREE.Vector3(cx, cy, intersectPoint.z);

                this.vpIdElliptical = vpId;
            }
        }
    };

    /**
     * This method sets the matrix to identity if matrix is not supplied;
     *
     * @param {THREE.Matrix4} matrix - Matrix to set
     */
    GeometryCallback.prototype.setMatrix = function(matrix) {
        this.matrix = matrix || new THREE.Matrix4();
    };

    /**
     * Snap to a 2D model.
     *
     * @param {object}      hitResult - a result of a ray intersection.
     * @param {object}      [options] - Options object.
     * @param {Function}    [options.enumSegments] - Enumerates all segments within a given bbox in model-space.
     *
     */
    this.snapping2D = function(hitResult, options = {}) {

        if (!hitResult) {
            return;
        }

        // hitResult is a result of a ray intersection. it may contain the following:
        let {
            dbId,
            fragId,
            intersectPoint,
            model = _viewer.model
        } = hitResult;

        if (model.is3d()) {
            return;
        }
        _snapResult.modelId = hitResult.model ? hitResult.model.id : null;
        _snapResult.hasTopology = false;
        _snapResult.intersectPoint = intersectPoint;

        let tr, scale = 1;

        // The model that we are trying to snap is 2D, but the viewer is 3D. It means that we are in hypermodeling scenario!
        // For that, we'll need to apply the inversed transform of the 2D model to the intersect point first, in order to get it in local model coords.
        if (!_viewer.impl.is2d) {
            tr = model.getModelToViewerTransform();
            // If there's a transform, move point to original location in sheet (will be restored at the end)
            if (tr) {
                scale = tr.getMaxScaleOnAxis();
                _snapResult.intersectPoint = intersectPoint.clone();
                _snapResult.intersectPoint.applyMatrix4(model.getInverseModelToViewerTransform());
            }
        }

        // Determine which one should be drawn: line, circular arc or elliptical arc
        // Use the un-transformed point, but scale down the radius because we are comparing with the unscaled geometry
        _snapResult.radius = this.setDetectRadius(intersectPoint) / scale;

        // Geometry snapping is only possible if a fragment list is available to obtain geometry per fragment.
        var supportsGeomSnapping = (model.getFragmentList() != null);
        if (!supportsGeomSnapping) {

            // If no snapping is available, just accept the hitpoint as a vertex hit. This allows to measure
            // distances between arbitrary points in rasters.
            _isSnapped = true;
            _snapResult.geomType = SnapType.SNAP_VERTEX;
            _snapResult.geomVertex = intersectPoint; // Use the un-transformed point
            tr && _snapResult.intersectPoint.applyMatrix4(tr); // Restore to original location
            return;
        }


        var gc = new GeometryCallback(_viewer, this, _snapResult.radius);

        // Performs 2D snapping to segments based on an enumSegments() callback, which enumerates all segments
        // within in a given bbox in model-space.
        if (options.enumSegments) {
            // enum all segments within the snapRadius around intersectPoint
            const minx = _snapResult.intersectPoint.x - _snapResult.radius;
            const miny = _snapResult.intersectPoint.y - _snapResult.radius;
            const maxx = _snapResult.intersectPoint.x + _snapResult.radius;
            const maxy = _snapResult.intersectPoint.y + _snapResult.radius;

            options.enumSegments(minx, miny, maxx, maxy, gc);
        } else {
            // Regular snapping - snap to the 2D model's geometry.
            var fragIds = fragId;

            if (typeof fragIds === "undefined") {
                // LMV-6082 Do not return out if the snap to pixel flag (free measure) is enabled.
                if (!_snapToPixel) {
                    return;
                }
                fragIds = [];
            } else if (!Array.isArray(fragIds)) {
                fragIds = [fragIds];
            }

            for (var fi = 0; fi < fragIds.length; ++fi) {
                const mesh = _viewer.impl.getRenderProxy(model, fragIds[fi]);
                if (mesh ? .geometry) {
                    gc.setMatrix(mesh.matrix);
                    const vbr = new VertexBufferReader(mesh.geometry);
                    vbr.enumGeomsForObject(model.reverseMapDbIdFor2D(dbId), gc);
                    // Set the matrix back to identity after processing a mesh
                    gc.setMatrix();
                }
            }
        }

        // _snapResult.intersectPoint contains the possibly transformed point
        this.finishSnapping2D(gc, _snapResult.intersectPoint);

        // Snap the unsnapped point only if the snapping fails
        if (!_isSnapped && _snapToPixel) {
            _isSnapped = true;
            _snapResult.geomType = SnapType.RASTER_PIXEL;
            _snapResult.geomVertex = _snapResult.intersectPoint;
        }

        // Now apply the transform matrix on the results, so we'll get the results in their final transformed position.
        if (tr) {
            const start = _snapResult.geomEdge ? .vertices[0];
            const end = _snapResult.geomEdge ? .vertices[1];

            let results = [_snapResult.snapPoint, _snapResult.geomVertex, _snapResult.intersectPoint, _snapResult.circularArcCenter,
                start, end
            ];
            // Remove undefined and possibly shared vectors
            results = [...new Set(results.filter(n => n))];
            results.forEach(res => res.applyMatrix4(tr));
            if (_snapResult.circularArcRadius) {
                _snapResult.circularArcRadius *= scale;
            }
            _snapResult.radius *= scale;
        }
    };

    // By default, snapper only considers model geometry that is written to ID buffer.
    // This function performs the 2D snapping on a set of given 2D meshes instead. It works similar to snapping2D() but
    // enumerates the given meshes instead of getting them from the fragment list.
    //
    //  @param {THREE.Vector3}                 intersectPoint - click position in world-coords
    //  @param {function(dbId, layerId, vpId)} filter - Defines subset of primitives to be considered.
    //  @param {THREE.Mesh[]}                  meshes - The triangulated 2D shapes to be checked for snapping
    //  @param {number}                        [detectRadius] - Same coordinate system as the given geometry. Required if geometry is not in world-coords.

    this.snapping2DOverlay = function(intersectPoint, meshes, filter, detectRadius) {
        _snapResult.hasTopology = false;
        _snapResult.intersectPoint = intersectPoint;
        _snapResult.radius = detectRadius || this.setDetectRadius(intersectPoint);

        var gc = new GeometryCallback(_viewer, this, _snapResult.radius);

        for (var i = 0; i < meshes.length; i++) {
            var mesh = meshes[i];
            var vbr = new VertexBufferReader(mesh.geometry);
            vbr.enumGeoms(filter, gc);
        }

        this.finishSnapping2D(gc, intersectPoint);
    };

    // Finish 2D snapping operation - assuming that all candidate geometry for snapping has been processed by the geometryCallback gc already.
    this.finishSnapping2D = function(gc, intersectPoint) {

        // When restricting to a single viewport, exclude candidates of all other viewports
        if (_forcedVpId !== null) {
            const isSameViewport = c => (c.viewportId === _forcedVpId);
            gc.snapCandidates = gc.snapCandidates.filter(isSameViewport);
        }

        // Check if we can snap to an intersection of two close segments
        const intersectSnap = findIntersectionSnap(gc.snapCandidates, intersectPoint, gc.detectRadius);
        if (intersectSnap) {
            _snapResult.viewportIndex2d = intersectSnap.viewportId;
            _snapResult.snapPoint = intersectSnap.snapPoint;
            _snapResult.geomType = SnapType.SNAP_INTERSECTION;
            _snapResult.geomVertex = intersectSnap.snapPoint;
            _isSnapped = true;
            return;
        }

        if (gc.circularArc) {

            _snapResult.viewportIndex2d = gc.vpIdCircular;

            _snapResult.snapPoint = gc.snapPoint;

            // Only snap the geometries which belong to the same viewport as the first selection
            if (_forcedVpId !== null && _forcedVpId !== _snapResult.viewportIndex2d)
                return;

            const start = gc.circularArc.vertices[0];
            const end = gc.circularArc.vertices[gc.circularArc.vertices.length - 1];

            if (intersectPoint.distanceTo(start) < _snapResult.radius) {

                _snapResult.geomVertex = start;
                _snapResult.geomType = SnapType.SNAP_VERTEX;
            } else if (intersectPoint.distanceTo(end) < _snapResult.radius) {

                _snapResult.geomVertex = end;
                _snapResult.geomType = SnapType.SNAP_VERTEX;
            } else {

                this.lineStripToPieces(gc.circularArc);
                _snapResult.geomEdge = gc.circularArc;
                _snapResult.circularArcCenter = gc.circularArcCenter;
                _snapResult.circularArcRadius = gc.circularArcRadius;
                _snapResult.geomType = SnapType.SNAP_CIRCULARARC;
            }

            _isSnapped = true;


        } else if (gc.ellipticalArc) {

            _snapResult.viewportIndex2d = gc.vpIdElliptical;

            // Only snap the geometries which belong to the same viewport as the first selection
            if (_forcedVpId !== null && _forcedVpId !== _snapResult.viewportIndex2d)
                return;

            const start = gc.ellipticalArc.vertices[0];
            const end = gc.ellipticalArc.vertices[gc.ellipticalArc.vertices.length - 1];
            if (intersectPoint.distanceTo(start) < _snapResult.radius) {

                _snapResult.geomVertex = start;
                _snapResult.geomType = SnapType.SNAP_VERTEX;
            } else if (intersectPoint.distanceTo(end) < _snapResult.radius) {

                _snapResult.geomVertex = end;
                _snapResult.geomType = SnapType.SNAP_VERTEX;
            } else {

                this.lineStripToPieces(gc.ellipticalArc);
                _snapResult.geomEdge = gc.ellipticalArc;
                // Before we have measure design for elliptical arc, measure the center for now
                _snapResult.circularArcCenter = gc.ellipticalArcCenter;
                _snapResult.circularArcRadius = null;
                _snapResult.geomType = SnapType.SNAP_CIRCULARARC;
            }

            _isSnapped = true;

        } else if ((gc.lineGeom instanceof THREE.Geometry && gc.lineGeom.vertices.length) ||
            (gc.lineGeom.getAttribute && gc.lineGeom.getAttribute('position').count)) {

            _snapResult.viewportIndex2d = gc.vpIdLine;

            // Only snap the geometries which belong to the same viewport as the first selection
            if (_forcedVpId !== null && _forcedVpId !== _snapResult.viewportIndex2d)
                return;

            // Always expose edge segment - no matter whether we snap to the edge or one of its vertices.
            // This allows us to combine it with other snap constraints later - as done by Edit2D.
            _snapResult.geomEdge = gc.lineGeom;
            const start = gc.lineGeom.vertices[0];
            const end = gc.lineGeom.vertices[1];

            if (this.markupMode) { // Markup mode
                var mid = new THREE.Vector3();
                mid.addVectors(start, end);
                mid.divideScalar(2);
                var md = intersectPoint.distanceTo(mid);
                var sd = intersectPoint.distanceTo(start);
                var ed = intersectPoint.distanceTo(end);

                // Store it for snapping to parallel/perpendicular of underlying vectors
                _snapResult.geomEdge = gc.lineGeom;

                if (md < _snapResult.radius) {
                    _snapResult.geomVertex = mid;
                    _snapResult.geomType = SnapType.SNAP_VERTEX;
                } else if (sd < _snapResult.radius) {
                    _snapResult.geomVertex = start;
                    _snapResult.geomType = SnapType.SNAP_VERTEX;
                } else if (ed < _snapResult.radius) {
                    _snapResult.geomVertex = end;
                    _snapResult.geomType = SnapType.SNAP_VERTEX;
                } else {
                    _snapResult.geomType = SnapType.SNAP_EDGE;
                }

                // Circle center
                if (start.distanceTo(end) < EPSILON) {
                    _snapResult.geomType = SnapType.SNAP_CIRCLE_CENTER;
                }
            } else { // Measure mode
                if (intersectPoint.distanceTo(start) < _snapResult.radius) {

                    if (start.distanceTo(end) < EPSILON) {
                        _snapResult.geomType = SnapType.SNAP_CIRCLE_CENTER;
                    } else {
                        _snapResult.geomType = SnapType.SNAP_VERTEX;
                    }

                    _snapResult.geomVertex = start;
                } else if ((_options.forceSnapVertices || (intersectPoint.distanceTo(end) < _snapResult.radius))) {

                    _snapResult.geomVertex = end;
                    _snapResult.geomType = SnapType.SNAP_VERTEX;
                } else {
                    _snapResult.geomType = SnapType.SNAP_EDGE;
                }
            }

            _isSnapped = true;
        }
    };

    this.snappingRasterPixel = function(result) {
        if (!result) {
            return;
        }

        var intersectPoint = result.intersectPoint;
        _snapResult.intersectPoint = intersectPoint;
        _snapResult.hasTopology = false;

        // Determine which one should be drawn: line, circular arc or elliptical arc
        _snapResult.radius = this.setDetectRadius(intersectPoint);
        _snapResult.geomType = SnapType.RASTER_PIXEL;
        _snapResult.geomVertex = intersectPoint;
        _isSnapped = true;
    };

    this.snapMidpoint = function() {
        _snapResult.isMidpoint = false;

        // Snap midpoint for edge
        if (_isSnapped) {
            if (_snapResult.geomType === SnapType.SNAP_EDGE) {
                const edge = _snapResult.geomEdge;
                const p1 = edge.vertices[0];
                const p2 = edge.vertices[1];

                var midpoint = new THREE.Vector3((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, (p1.z + p2.z) / 2);

                var cutPlanes = _viewer.impl.getAllCutPlanes();
                if (cutPlanes ? .length) {
                    for (let i = 0; i < cutPlanes.length; ++i) {
                        const p = cutPlanes[i];
                        const dot = midpoint.x * p.x + midpoint.y * p.y + midpoint.z * p.z + p.w;
                        if (dot > 1e-5) {
                            // discard midpoint if clipped
                            return;
                        }
                    }
                }

                if (_snapResult.intersectPoint.distanceTo(midpoint) < 2 * _snapResult.radius) {
                    _snapResult.geomVertex = midpoint;
                    _snapResult.geomType = SnapType.SNAP_MIDPOINT;
                }
            }
        }
    };

    this.setPerpendicular = function(isPerpendicular) {
        _snapResult.isPerpendicular = isPerpendicular;
    };

    this.lineStripToPieces = function(geom) {
        const vertices = geom.vertices;
        for (var i = vertices.length - 2; i > 0; i--) {
            vertices.splice(i, 0, vertices[i]);
        }
    };

    this.setDetectRadius = function(point) {

        var navapi = _viewer.navigation;
        var camera = navapi.getCamera();
        var position = navapi.getPosition();

        var p = point.clone();

        var distance = camera.isPerspective ? p.sub(position).length() :
            navapi.getEyeVector().length();

        var fov = navapi.getVerticalFov();
        var worldHeight = 2.0 * distance * Math.tan(THREE.Math.degToRad(fov * 0.5));

        var viewport = navapi.getScreenViewport();
        var _window = this.getWindow();
        var devicePixelRatio = _window.devicePixelRatio || 1;
        var radius = this.detectRadiusInPixels * worldHeight / (viewport.height * devicePixelRatio);

        return radius;
    };

    this.handleButtonDown = function() {
        _isDragging = true;
        return false;
    };

    this.handleButtonUp = function() {
        _isDragging = false;
        return false;
    };

    this.handleMouseMove = function(event) {

        if (_isDragging)
            return false;

        this.onMouseMove({
            x: event.canvasX,
            y: event.canvasY
        });

        return false;
    };

    this.handleSingleTap = function(event) {

        return this.handleMouseMove(event);
    };

    this.handlePressHold = function(event) {

        if (av.isMobileDevice()) {
            switch (event.type) {
                case "press":
                    _isPressing = true;
                    this.onMouseMove({
                        x: event.canvasX,
                        y: event.canvasY
                    });
                    break;

                case "pressup":
                    this.onMouseMove({
                        x: event.canvasX,
                        y: event.canvasY
                    });
                    _isPressing = false;
                    break;
            }
        }
        return false;

    };

    this.handleGesture = function(event) {
        if (av.isMobileDevice()) {
            if (_isPressing) {
                switch (event.type) {
                    case "dragstart":
                    case "dragmove":
                        this.onMouseMove({
                            x: event.canvasX,
                            y: event.canvasY
                        });
                        break;

                    case "dragend":
                        this.onMouseMove({
                            x: event.canvasX,
                            y: event.canvasY
                        });
                        _isPressing = false;
                        break;

                    case "pinchstart":
                    case "pinchmove":
                    case "pinchend":
                        break;
                }
            }
        }

        return false;
    };

    /**
     * Handler to mouse move events, used to snap in markup edit mode.
     *
     * @param mousePosition
     * @private
     */
    this.onMouseDown = function(mousePosition) {
        return this.onMouseMove(mousePosition);
    };

    /**
     * Handler to mouse move events, used to snap in markup edit mode.
     *
     * @param mousePosition
     * @private
     */
    this.onMouseMove = function(mousePosition) {

        this.clearSnapped();

        var result = _viewer.impl.snappingHitTest(mousePosition.x, mousePosition.y, false);

        if (!result && _snapToPixel) {
            var vpVec = _viewer.impl.clientToViewport(mousePosition.x, mousePosition.y);
            let point = _viewer.impl.intersectGroundViewport(vpVec);
            result = {
                intersectPoint: point
            };
        }

        if (!result || !result.intersectPoint)
            return false;

        const isLeaflet = result.model ? .isLeaflet() || (_viewer.impl.is2d && _viewer.model ? .isLeaflet());
        // 3D Snapping
        if (result.face) {
            this.snapping3D(result);
        }
        // 2D Snapping
        else if ((result.dbId || result.dbId === 0) && !isLeaflet) {
            this.snapping2D(result);
        }
        // Pixel Snapping
        else {
            const isPixelSnap = _snapToPixel || isLeaflet;
            if (isPixelSnap) {
                this.snappingRasterPixel(result);
            }
        }

        this.snapMidpoint();

        if (_snapFilter && !_snapFilter(_snapResult)) {
            this.clearSnapped();
            return false;
        }

        return true;
    };
}

av.GlobalManagerMixin.call(Snapper.prototype);