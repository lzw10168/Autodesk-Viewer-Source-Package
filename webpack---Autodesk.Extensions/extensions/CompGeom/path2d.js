import ClipperLib from "clipper-lib-fpoint";
import Earcut from "earcut";
import {
    TesselateQuad,
    TesselateCubic,
    DefaultTessParams
} from "./bezier";

//Helper for converting complex HTML Canvas paths to simple polylines / polygons


const MOVETO = 0,
    LINETO = 1,
    ARC = 2,
    ARCTO = 3,
    QUADTO = 4,
    CUBICTO = 5,
    ELLIPSE = 6,
    CLOSE = 7;


let _v2 = new THREE.Vector2();
let _tmpSize = new THREE.Vector2();
let _tmpBox = new THREE.Box2();

// Tmp objct for Ellipse Arcs. We need delayed initialization,
// because Autodesk.Extensions.CompGeom might not be available yet at compile time.
let _tmpArc = null;
let getTmpArc = () => {
    _tmpArc = _tmpArc || new Autodesk.Extensions.CompGeom.EllipseArc();
    return _tmpArc;
};

export function Path2D(precisionTolerance) {
    this.segTypes = [];
    this.segData = [];
    this.hasCurves = false;
    this.bbox = new THREE.Box2();
    this.precisionTolerance = precisionTolerance;
}

// Optional: Use custom tesselation params for bezier arcs. Undefined sets to default.
Path2D.prototype.setTessParams = function(tessParams) {
    this.tessParams = tessParams;
};

Path2D.prototype.isClosedPath = function() {
    return (this.segTypes.length && this.segTypes[this.segTypes.length - 1] === CLOSE);
};

Path2D.prototype.isPoint = function() {
    return (this.segTypes.length == 2 && this.segTypes[0] === MOVETO && this.segTypes[1] === LINETO &&
        this.segData[0] == this.segData[2] && this.segData[1] == this.segData[3]);
};



Path2D.prototype.closePath = function() {
    if (this.isClosedPath())
        return;
    this.segTypes.push(CLOSE);
};


Path2D.prototype.moveTo = function(x, y) {
    this.segTypes.push(MOVETO);
    this.segData.push(x, y);

    this.bbox.expandByPoint(_v2.set(x, y));
};

Path2D.prototype.lineTo = function(x, y) {
    this.segTypes.push(LINETO);
    this.segData.push(x, y);

    this.bbox.expandByPoint(_v2.set(x, y));
};

Path2D.prototype.arc = function(x, y, radius, startAngle, endAngle, anticlockwise) {
    this.hasCurves = true;
    this.segTypes.push(ARC);
    this.segData.push(x, y, radius, startAngle, endAngle, anticlockwise);

    this.bbox.expandByPoint(_v2.set(x, y)); //TODO: all corners
};

Path2D.prototype.arcTo = function(x1, y1, x2, y2, radius) {
    this.hasCurves = true;
    this.segTypes.push(ARCTO);
    this.segData.push(x1, y1, x2, y2, radius);

    this.bbox.expandByPoint(_v2.set(x1, y1));
    this.bbox.expandByPoint(_v2.set(x2, y2));
};

Path2D.prototype.quadraticCurveTo = function(cp1x, cp1y, x, y) {
    this.hasCurves = true;
    this.segTypes.push(QUADTO);
    this.segData.push(cp1x, cp1y, x, y);

    this.bbox.expandByPoint(_v2.set(cp1x, cp1y));
    this.bbox.expandByPoint(_v2.set(x, y));
};

Path2D.prototype.bezierCurveTo = function(cp1x, cp1y, cp2x, cp2y, x, y) {
    this.hasCurves = true;
    this.segTypes.push(CUBICTO);
    this.segData.push(cp1x, cp1y, cp2x, cp2y, x, y);
    this.bbox.expandByPoint(_v2.set(cp1x, cp1y));
    this.bbox.expandByPoint(_v2.set(cp2x, cp2y));
    this.bbox.expandByPoint(_v2.set(x, y));
};

// for params, see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/ellipse
Path2D.prototype.ellipse = function(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw) {

    this.hasCurves = true;
    this.segTypes.push(ELLIPSE);
    this.segData.push(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw);

    // consider arc in bbox
    const arcBox = getTmpArc().set(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw).computeBBox(_tmpBox);
    this.bbox.union(arcBox);
};

Path2D.prototype.flatten = function(forceCloseContours) {

    var ret = new Path2D(this.precisionTolerance);

    var dataOffset = 0;
    var lastX = 0;
    var lastY = 0;
    var contourStartX = lastX;
    var contourStartY = lastY;

    var segTypes = this.segTypes;
    var segData = this.segData;

    let sz = this.bbox.getSize(_tmpSize).length();

    for (var i = 0; i < segTypes.length; i++) {

        var st = segTypes[i];

        switch (st) {

            case MOVETO:
                {
                    if (forceCloseContours) {
                        if (lastX !== contourStartX || lastY !== contourStartY) {
                            ret.closePath();
                        }
                    }

                    lastX = segData[dataOffset++];
                    lastY = segData[dataOffset++];
                    contourStartX = lastX;
                    contourStartY = lastY;
                    ret.moveTo(lastX, lastY);
                }
                break;
            case CLOSE:
                ret.closePath();
                break;
            case LINETO:
                {
                    var x = segData[dataOffset++];
                    var y = segData[dataOffset++];

                    if (x !== lastX || y !== lastY) {
                        ret.lineTo(x, y);

                        lastX = x;
                        lastY = y;
                    }
                }
                break;
            case QUADTO:
                {
                    const cp1x = segData[dataOffset++],
                        cp1y = segData[dataOffset++],
                        x = segData[dataOffset++],
                        y = segData[dataOffset++];
                    TesselateQuad(ret, lastX, lastY, cp1x, cp1y, x, y, sz, this.tessParams, !!this.isFontChar);

                    lastX = x;
                    lastY = y;
                }
                break;
            case CUBICTO:
                {
                    const cp1x = segData[dataOffset++],
                        cp1y = segData[dataOffset++],
                        cp2x = segData[dataOffset++],
                        cp2y = segData[dataOffset++],
                        x = segData[dataOffset++],
                        y = segData[dataOffset++];
                    TesselateCubic(ret, lastX, lastY, cp1x, cp1y, cp2x, cp2y, x, y, sz, this.tessParams, !!this.isFontChar);
                    lastX = x;
                    lastY = y;
                }
                break;
            case ARC:
                console.warn("not implemented: arc");
                dataOffset += 6;
                break;
            case ARCTO:
                console.warn("not implemented: arcto");
                dataOffset += 4;
                break;
            case ELLIPSE:
                {
                    // read ellipse params
                    var cx = segData[dataOffset++];
                    var cy = segData[dataOffset++];
                    var rx = segData[dataOffset++];
                    var ry = segData[dataOffset++];
                    var rotation = segData[dataOffset++];
                    var startAngle = segData[dataOffset++];
                    var endAngle = segData[dataOffset++];
                    var ccw = segData[dataOffset++];

                    // determine tesselation params
                    const tessParams = this.tessParams || DefaultTessParams;
                    const maxSegments = tessParams.numIterations;
                    const minSegmentLength = tessParams.minSegLenFraction * sz;

                    // tesselate arc
                    const arc = getTmpArc().set(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw);
                    arc.tesselate(ret, maxSegments, minSegmentLength);

                    // Update lastX/lastY
                    // The last lineTo() appends x and y of the end position to ret.segData.
                    // So, we can always extract it from there.
                    lastX = ret.segData[ret.segData.length - 2];
                    lastY = ret.segData[ret.segData.length - 1];
                }
                break;
        }
    }

    if (forceCloseContours) {
        if (lastX !== contourStartX || lastY !== contourStartY) {
            ret.closePath();
        }
    }

    return ret;
};

Path2D.prototype.applyTransform = function(loader, xform) {

    for (let i = 0; i < this.segData.length; i += 2) {

        let x = this.segData[i];
        let y = this.segData[i + 1];

        this.segData[i] = loader.tx(x, y, xform);
        this.segData[i + 1] = loader.ty(x, y, xform);
    }
};

Path2D.prototype.stroke = function(loader, lineWidth, color, dbId, layerId, clipPathIn, applyTransform, lineStyle, lineCap) {
    var needClipping = clipPathIn != null;
    let subjFlatted = this;
    if (applyTransform || this.hasCurves) {
        subjFlatted = this.flatten(false);
    }

    var self = this;
    // check whether we can do simple path
    if (needClipping) {
        var subPaths = [];
        var subPath;
        var segIndex = 0;
        for (var i = 0; i < subjFlatted.segTypes.length; i++) {
            if (subjFlatted.segTypes[i] == MOVETO) {
                subPath = new Path2D(this.precisionTolerance);
                subPaths.push(subPath);
                subPath.moveTo(subjFlatted.segData[segIndex++], subjFlatted.segData[segIndex++]);
            } else if (subjFlatted.segTypes[i] == LINETO) {
                subPath ? .lineTo(subjFlatted.segData[segIndex++], subjFlatted.segData[segIndex++]);
            } else if (subjFlatted.segTypes[i] == CLOSE) {
                subPath ? .closePath();
            }
        }

        // workaround for endless loops in ClipperLib.Clipper.AddPath()
        // Some input paths with start==end that are marked as open will run into an endless loop when setting up internal data structures.
        // This is a known issue without a fix. The workaround will simply make the end points non-identical.
        // BLMV-8304, BLMV-8326: some degenerate input will cause ClipperLib to add points from the clip poly for no apparent reason. 
        //   Fix by ensuring there are no duplicate points. For simplicity, I slightly shift all coordinates by a tiny amount. 
        //   This might lead self-intersections. Not sure if this is a problem.
        const fixInput = function(path) {
            // coordinates here are given in inches, Math.pow(2, -32) is a small enough value to not have any visible impact
            const tinyShift = Math.pow(2, -32);
            for (let i = 1; i < path.length; i++) {
                // perturb each coordinate by moving it towards the previous coordinate
                // this should reduce the chance of self-intersections
                const dx = path[i].X - path[i - 1].X;
                const dy = path[i].Y - path[i - 1].Y;
                if (Math.abs(dx) > Math.abs(dy)) {
                    if (dx > 0) {
                        path[i].X -= i * tinyShift;
                    } else {
                        path[i].X += i * tinyShift;
                    }
                } else {
                    if (dy > 0) {
                        path[i].Y -= i * tinyShift;
                    } else {
                        path[i].Y += i * tinyShift;
                    }
                }
            }
        };

        var clipFlatted = clipPathIn.flattened || clipPathIn.flatten(true);
        var clips = clipFlatted.toClipperPath(loader, false);
        subPaths.map((subPath) => {
            // still need to do a check for each subPath
            var subPreResult = self.preCheckForClipping(loader, clipFlatted, subPath, applyTransform, true);
            if (subPreResult.needCancel) {
                return;
            } else if (subPreResult.needClipping && !subPath.isPoint()) { // points (i.e., lines of length 0) are not handled well by Clipper -> check separately
                var myPath = subPath.toClipperPath(loader, applyTransform)[0];
                if (!myPath) {
                    return;
                }

                if (ClipperLib.Clipper.Orientation(myPath)) {
                    // LMV-5983
                    // turn closed paths to clockwise orientation
                    // to workaround a problem where anticlockwise self-intersecting paths ended up with
                    // a different order of vertices after clipping
                    myPath.reverse();
                }

                var solution = new ClipperLib.PolyTree();
                var cpr = new ClipperLib.Clipper();
                // always treat myPath as open in order to get correct stroke clipping. Prevent endless loop in AddPath.
                fixInput(myPath);
                cpr.AddPath(myPath, ClipperLib.PolyType.ptSubject, false);
                cpr.AddPaths(clips, ClipperLib.PolyType.ptClip, true);

                cpr.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
                strokeClipperSolution(solution);
            } else if (!subPreResult.needClipping ||
                (clips.length == 1 && ClipperLib.Clipper.PointInPolygon({
                    X: subPath.segData[0],
                    Y: subPath.segData[1]
                }, clips[0]))) // if needClipping is true, subPath must be a point. So check if it's inside the clip polygon.
            {
                this.strokeFlattedPath(loader, subPath, lineWidth, color, dbId, layerId, applyTransform, lineStyle, lineCap);
            }
        });
    } else {
        // just draw all the segments
        this.strokeFlattedPath(loader, subjFlatted, lineWidth, color, dbId, layerId, applyTransform, lineStyle, lineCap);
    }

    function strokeClipperSolution(solution) {
        var node = solution.GetFirst();
        while (node) {
            self.strokeClipperContour(loader, node.Contour(), node.IsOpen, color, lineWidth, dbId, layerId, loader.currentVpId, lineStyle, false, lineCap);
            node = node.GetNext();
        }
    }
};

Path2D.prototype.strokeFlattedPath = function(loader, flatted, lineWidth, color, dbId, layerId, applyTransform, lineStyle, lineCap) {
    let segData = flatted.segData;
    let segTypes = flatted.segTypes;

    let xform;
    if (applyTransform) {
        xform = loader.getCurrentTransform();
    }

    // our shader only supports "butt" and "round" as line ends. Use round for "square" as well.
    const lineEndButtCap = lineCap === "butt";

    var dataOffset = 0;
    var lastLastX = 0;
    var lastLastY = 0;
    var lastX = 0;
    var lastY = 0;
    var contourStartX = 0;
    var contourStartY = 0;

    for (var i = 0; i < segTypes.length; i++) {

        var st = segTypes[i];

        switch (st) {

            case MOVETO:
                {
                    let tmpx = segData[dataOffset++];
                    let tmpy = segData[dataOffset++];

                    if (applyTransform) {
                        contourStartX = loader.tx(tmpx, tmpy, xform);
                        contourStartY = loader.ty(tmpx, tmpy, xform);
                    } else {
                        contourStartX = tmpx;
                        contourStartY = tmpy;
                    }

                    lastX = lastLastX = contourStartX;
                    lastY = lastLastY = contourStartY;
                }
                break;
            case CLOSE:
            case LINETO:
                {
                    let x, y;
                    if (st === CLOSE) {
                        x = contourStartX;
                        y = contourStartY;
                    } else {
                        let tmpx = segData[dataOffset++];
                        let tmpy = segData[dataOffset++];

                        if (applyTransform) {
                            x = loader.tx(tmpx, tmpy, xform);
                            y = loader.ty(tmpx, tmpy, xform);
                        } else {
                            x = tmpx;
                            y = tmpy;
                        }
                    }

                    // LMV-5336 - Paths that contain a moveTo and a lineTo at the same X, Y positions were not being drawn.
                    // Add the segment when the previous operation was moveTo.
                    const isPrevMoveTo = i > 0 && segTypes[i - 1] === MOVETO;
                    if (x !== lastX || y !== lastY || isPrevMoveTo) {

                        // lineCap only applies to real ends, i.e., if a line segment starts with a MOVETO, is the last segment and ends with a LINETO, or is followed by a MOVETO
                        const buttCapStart = (lineEndButtCap && isPrevMoveTo);
                        const hasNext = i < segTypes.length - 1;
                        const buttCapEnd = (lineEndButtCap && ((!hasNext && st === LINETO) || (hasNext && segTypes[i + 1] === MOVETO)));

                        //Use centerpoint for the initial inside check for better numeric stability,
                        //in case the start point is exactly on the clip polygon's edge, in which case the inside
                        //check would return a random result

                        //Segment is either completely inside or completely outside (does not intersect the clip path at all)
                        loader.flushBuffer(4);

                        if (this.isMiterLine) {
                            let nextX = x;
                            let nextY = y;

                            const nextIsValid = hasNext && (segTypes[i + 1] === LINETO || segTypes[i + 1] === CLOSE);
                            if (st !== CLOSE && nextIsValid) {
                                let tmpx = segData[dataOffset + 0];
                                let tmpy = segData[dataOffset + 1];

                                if (applyTransform) {
                                    nextX = loader.tx(tmpx, tmpy, xform);
                                    nextY = loader.ty(tmpx, tmpy, xform);
                                } else {
                                    nextX = tmpx;
                                    nextY = tmpy;
                                }
                            }

                            loader.currentVbb.addMiterSegment(lastLastX, lastLastY, lastX, lastY, x, y, nextX, nextY,
                                /*totalDistance*/
                                0, lineWidth, color, dbId, layerId, loader.currentVpId || 0, lineStyle, buttCapStart, buttCapEnd
                            );
                        } else {
                            loader.currentVbb.addSegment(lastX, lastY, x, y,
                                /*totalDistance*/
                                0, lineWidth, color, dbId, layerId, loader.currentVpId || 0, lineStyle, buttCapStart, buttCapEnd
                            );
                        }

                        lastLastX = lastX;
                        lastLastY = lastY;
                        lastX = x;
                        lastY = y;
                    }
                }
                break;
            default:
                {
                    console.error("Path must be flattened before rendering");
                }
        }
    }
};

Path2D.prototype.strokeClipperContour = function(loader, contour, isOpen, color, lineWidth, dbId, layerId, vpId, lineStyle, applyTransform, lineCap) {
    let l = contour.length;
    let lastIndex = isOpen ? 0 : l - 1;
    let startIndex = isOpen ? 1 : 0;
    let xform;
    if (applyTransform) {
        xform = loader.getCurrentTransform();
    }

    // our shader only supports "butt" and "round" as line ends. Use round for "square" as well.
    const lineEndCap = lineCap === "butt";

    let lastx = applyTransform ? loader.tx(contour[lastIndex].X, contour[lastIndex].Y, xform) : contour[lastIndex].X;
    let lasty = applyTransform ? loader.ty(contour[lastIndex].X, contour[lastIndex].Y, xform) : contour[lastIndex].Y;
    for (var i = startIndex; i < l; i++) {
        let x = applyTransform ? loader.tx(contour[i].X, contour[i].Y, xform) : contour[i].X;
        let y = applyTransform ? loader.ty(contour[i].X, contour[i].Y, xform) : contour[i].Y;

        // lineEndCap only applies to real line ends, i.e., the beginning or end of an open contour 
        const capStart = lineEndCap && i === 0; // no need to test for isOpen, since i==0 cannot happen for open contours
        const capEnd = lineEndCap && i === l - 1 && isOpen;

        loader.flushBuffer(4);
        loader.currentVbb.addSegment(lastx, lasty, x, y, 0, lineWidth, color, dbId, layerId, vpId, lineStyle, capStart, capEnd);
        lastx = x, lasty = y;
    }
};

//Checks if the path is a simple AABB.
//Used to speed up polygon clipping operations.
Path2D.prototype.isAABB = function() {

    const EPS = 1e-10;
    const ANGLE_EPS = 1e-3;

    let st = this.segTypes;

    if (st.length !== 6 && st.length !== 5)
        return false;

    if (st[0] !== MOVETO)
        return false;

    if (st.length === 6 && st[5] !== CLOSE)
        return false;
    else if (st.length === 5 && (st[4] !== CLOSE && st[4] !== LINETO))
        return false;

    for (let i = 1; i < st.length - 1; i++)
        if (st[i] !== LINETO)
            return false;


    let seg = this.segData;

    //check segments 1 and 3 for parallel and same length
    let dxA = seg[2] - seg[0];
    let dyA = seg[3] - seg[1];
    let dxC = seg[6] - seg[4];
    let dyC = seg[7] - seg[5];
    let lenA = Math.sqrt(dxA * dxA + dyA * dyA);
    let lenC = Math.sqrt(dxC * dxC + dyC * dyC);

    if (Math.abs(lenA - lenC) > EPS)
        return false;

    dxA /= lenA;
    dyA /= lenA;
    dxC /= lenC;
    dyC /= lenC;
    let dot = dxA * dxC + dyA * dyC;

    if (Math.abs(1 + dot) > ANGLE_EPS)
        return false;

    //check segments 2 and 4 for parallel and same length
    let dxB = seg[4] - seg[2];
    let dyB = seg[5] - seg[3];
    let dxD = seg[8] - seg[6];
    let dyD = seg[9] - seg[7];
    let lenB = Math.sqrt(dxB * dxB + dyB * dyB);
    let lenD = Math.sqrt(dxD * dxD + dyD * dyD);

    if (Math.abs(lenB - lenD) > EPS)
        return false;

    dxB /= lenB;
    dyB /= lenB;
    dxD /= lenD;
    dyD /= lenD;
    dot = dxB * dxD + dyB * dyD;

    if (Math.abs(1 + dot) > ANGLE_EPS)
        return false;

    //make sure there is a right angle
    dot = dxA * dxB + dyA * dyB;

    if (Math.abs(dot) > ANGLE_EPS)
        return false;

    //make sure segments are vertical/horizontal
    if (Math.abs(dxA) > EPS && Math.abs(dyA))
        return false;

    return true;
};

const INSIDE = 1;
const OUTSIDE = 2;
const UNKNOWN = 4;

function bboxOverlap(clipBox, pathBox, precisionTolerance) {

    if (clipBox.containsBox(pathBox))
        return INSIDE;

    //The above AABB containment check is exact
    //and sometimes misses cases where the bboxes are
    //almost exactly equal, with very slight numeric noise in the values
    //(which happens quite often with Revit PDFs)

    //So now do another check if our bbox contains the input bbox within a tolerance
    let EPS = precisionTolerance;

    if (EPS === undefined) {
        EPS = 1e-3 / clipBox.size().length();
    }

    if (pathBox.min.x - clipBox.max.x > EPS)
        return OUTSIDE;
    if ((pathBox.min.y - clipBox.min.y) > EPS)
        return OUTSIDE;

    if ((pathBox.max.x - clipBox.max.x) < -EPS)
        return OUTSIDE;
    if ((pathBox.max.y - clipBox.max.y) < -EPS)
        return OUTSIDE;

    if ((pathBox.min.x - clipBox.min.x) < -EPS)
        return UNKNOWN;
    if ((pathBox.min.y - clipBox.min.y) < -EPS)
        return UNKNOWN;

    if ((pathBox.max.x - clipBox.max.x) > EPS)
        return UNKNOWN;
    if ((pathBox.max.y - clipBox.max.y) > EPS)
        return UNKNOWN;

    return INSIDE;
}

Path2D.prototype.isAABBContain = function(bbox) {

    if (!this.isAABB())
        return UNKNOWN;

    return bboxOverlap(this.bbox, bbox, this.precisionTolerance);
};


Path2D.prototype.clip = function(clipPathIn, mode) {
    var clipFlatted = clipPathIn.flattened || clipPathIn.flatten(true);
    var subjFlatted = this.flattened || this.flatten(true);

    var preResult = this.preCheckForClipping(null, clipFlatted, subjFlatted, false, false);
    if (preResult.needCancel) {
        console.warn("No overlap between nested clip regions.");
        return new Path2D();
    } else if (preResult.needClipping == false) {
        if (preResult.needSwapSubject) {
            return clipPathIn;
        } else {
            return this;
        }
    } else {
        // do the clipping here
        var clips = clipFlatted.toClipperPath(null, false);
        var myPath = subjFlatted.toClipperPath(null, false);

        var solution = new ClipperLib.PolyTree();
        var cpr = new ClipperLib.Clipper();
        cpr.AddPaths(myPath, ClipperLib.PolyType.ptSubject, true);
        cpr.AddPaths(clips, ClipperLib.PolyType.ptClip, true);

        cpr.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);

        // need to rebuild a path from the solution, no need to do the tesselation
        let res = new Path2D(this.precisionTolerance);
        var node = solution.GetFirst();
        while (node) {
            var contour = node.Contour();
            for (var i = 0; i < contour.length; i++) {
                if (i == 0) {
                    res.moveTo(contour[i].X, contour[i].Y);
                } else {
                    res.lineTo(contour[i].X, contour[i].Y);
                }
            }

            if (contour[contour.length - 1].X != contour[0].X || contour[contour.length - 1].Y != contour[0].Y) {
                res.lineTo(contour[0].X, contour[0].Y);
            }
            node = node.GetNext();
        }
        return res;
    }
};

/**
 * If segments type is 0, 1, 0, 1 pattern, we should avoid to do fill to it
 * Most of the time, it wants to be line segments, but from 2D, you can always pass a fill/stroke command to it.
 * Eatch MoveTo should start with a segment.
 */
Path2D.prototype.isFillable = function() {
    //Skip some easily detectable degenerate polygons that result in no fill
    let p = this.flattened || this.flatten(true);
    if (p.segTypes.length < 3) {
        return false;
    } else if (p.segTypes.length === 3) {
        const isClosedLine = (p.segTypes[2] === CLOSE && p.segTypes[1] === LINETO && p.segTypes[0] === MOVETO);
        return !isClosedLine;
    } else {
        var isFillable = false;

        for (var i = 0; i < p.segTypes.length; i += 2) {
            if (!(p.segTypes[i] == MOVETO && p.segTypes[i + 1] == LINETO)) {
                isFillable = true;
                break;
            }
        }
        return isFillable;
    }
};

Path2D.prototype.fill = function(loader, color, dbId, layerId, clipPathIn, applyTransform, isFillStrokeCombo) {
    if (!this.isFillable()) {
        return;
    }

    let subjFlatted = this.flattened || this.flatten(true);
    var self = this;

    function clipProcess() {
        var needClipping = clipPathIn != null;
        var needSwapSubject = false;
        // check weather we can do simple path
        if (needClipping) {
            var clipFlatted = clipPathIn.flattened || clipPathIn.flatten(true);

            var preResult = self.preCheckForClipping(loader, clipFlatted, subjFlatted, applyTransform, false);
            if (preResult.needCancel) {
                return;
            }

            needClipping = preResult.needClipping;
            needSwapSubject = preResult.needSwapSubject;
        }

        if (needClipping) {
            const clipFlatted = clipPathIn.flattened || clipPathIn.flatten(true);
            var clips = clipFlatted.toClipperPath(loader, false);
            var myPath = subjFlatted.toClipperPath(loader, applyTransform);

            var solution = new ClipperLib.PolyTree();
            var cpr = new ClipperLib.Clipper();
            cpr.AddPaths(myPath, ClipperLib.PolyType.ptSubject, true);
            cpr.AddPaths(clips, ClipperLib.PolyType.ptClip, true);

            cpr.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);

            var polygons = self.getPolygonFromClipperSolution(solution);
            return {
                polygons,
                appliedTransform: applyTransform,
                needClipping
            };
        } else {
            // if we use clip path directly as subject, we can not cache it, and should not apply transform to it
            subjFlatted = !needSwapSubject ? subjFlatted : clipFlatted;
            if (self.cached) {
                return {
                    polygons: self.cached,
                    appliedTransform: false,
                    needClipping,
                    subjFlatted
                };
            } else {
                const myPath = subjFlatted.toClipperPath(loader, false);

                const solution = new ClipperLib.PolyTree();
                const cpr = new ClipperLib.Clipper();
                cpr.AddPaths(myPath, ClipperLib.PolyType.ptSubject, true);
                cpr.Execute(ClipperLib.ClipType.ctUnion, solution, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
                const polygons = self.getPolygonFromClipperSolution(solution);
                if (!needSwapSubject) {
                    self.cached = polygons;
                }
                return {
                    polygons,
                    appliedTransform: needSwapSubject, // clipPath has already applied transform
                    needClipping,
                    subjFlatted
                };
            }
        }
    }

    function fillPolygon(polygon, needApplytransform, needClipping) {
        var vertices = polygon.vertices;

        if (needApplytransform) {
            var xform = loader.getCurrentTransform();
            var vertices1 = [];
            for (var i = 0; i < vertices.length; i += 2) {
                let x = loader.tx(vertices[i], vertices[i + 1], xform);
                let y = loader.ty(vertices[i], vertices[i + 1], xform);
                vertices1.push(x, y);
            }
            vertices = vertices1;
        }
        loader.addPolyTriangle(vertices, polygon.indices, color, dbId, layerId, false);

        // do the antialias stroke here
        if (!isFillStrokeCombo) {
            if (needClipping || !self.isFontChar) {
                for (var c in polygon.contours) {
                    self.strokeClipperContour(loader, polygon.contours[c], true, color, -0.5, dbId, layerId, loader.currentVpId, 0, needApplytransform);
                }
            } else {
                // stroke the line with the original flatted path
                self.strokeFlattedPath(loader, result.subjFlatted, -0.5, color, dbId, layerId, needApplytransform, 0);
            }
        }
    }

    var result = clipProcess();
    if (result) {
        result.polygons.map((polygon) => {
            var needApplytransform = applyTransform && !result.appliedTransform;
            fillPolygon(polygon, needApplytransform, result.needClipping);
        });
    }
};


Path2D.prototype.toClipperPath = function(loader, applyTransform) {
    var paths = [];
    var path = [];
    var segTypes = this.segTypes;
    var segData = this.segData;
    var segIndex = 0;
    var xform;
    if (applyTransform) {
        xform = loader.getCurrentTransform();
    }

    function addPoint(path, point) {
        if (applyTransform) {
            let x = loader.tx(point.X, point.Y, xform);
            let y = loader.ty(point.X, point.Y, xform);
            point.X = x;
            point.Y = y;
        }

        if ((path.length > 0 && (path[path.length - 1].X != point.X || path[path.length - 1].Y != point.Y)) || path.length == 0) {
            path.push(point);
        }
    }

    for (var i = 0; i < segTypes.length; i++) {
        if (segTypes[i] == MOVETO) {
            if (path && path.length > 1) {
                paths.push(path);
            }
            path = [];
            addPoint(path, {
                X: segData[segIndex++],
                Y: segData[segIndex++]
            });
        } else if (segTypes[i] == LINETO) {
            addPoint(path, {
                X: segData[segIndex++],
                Y: segData[segIndex++]
            });
        } else if (segTypes[i] == CLOSE) {
            path.push({
                X: path[0].X,
                Y: path[0].Y
            });
            paths.push(path);
            path = [];
        }
    }

    if (path && path.length > 1) {
        paths.push(path);
    }

    return paths;
};

Path2D.prototype.hasIntersection = function(box1, box2, tolerance) {
    return !(box1.max.x - box2.min.x <= -tolerance || // left
        box1.max.y - box2.min.y <= -tolerance || // bottom
        box1.min.x - box2.max.x >= tolerance || // right
        box1.min.y - box2.max.y >= tolerance); // top
};

Path2D.prototype.preCheckForClipping = function(loader, clipFlatted, subjFlatted, applyTransform, strokeOnly) {
    var clipBound = clipFlatted.bbox;
    var subjBound = subjFlatted.bbox;

    if (applyTransform) {
        let xform = loader.getCurrentTransform();
        // we need to apply transform to the subject bounds
        subjBound = loader.transformBox(subjBound, xform, _tmpBox);
    }

    // do a simple check if two bounds has no overlap, set need cancel to true
    if (!this.hasIntersection(clipBound, subjBound, this.precisionTolerance)) {
        return {
            needCancel: true
        };
    } else if (clipFlatted.isAABB() && clipBound.containsBox(subjBound)) {
        return {
            needClipping: false
        };
    } else if (subjFlatted.isAABB() && subjBound.containsBox(clipBound)) {
        // there is nothing to stroke
        if (strokeOnly) {
            return {
                needCancel: true
            };
        } else {
            return {
                needClipping: false,
                needSwapSubject: true
            };
        }
    } else {
        return {
            needClipping: true
        };
    }
};

Path2D.prototype.getPolygonFromClipperSolution = function(solution) {
    function addContour(contours, vertices, contour) {
        for (var i = 0; i < contour.length; i++) {
            vertices.push(contour[i].X, contour[i].Y);
        }
        contours.push(contour);
    }

    var exPolygons = ClipperLib.JS.PolyTreeToExPolygons(solution);
    var polygons = exPolygons.map((item) => {
        var vertices = [];
        var holeIndices = [];
        var contours = [];

        // clipper library has some defect when we use 4 thickline to construct a rectangle with border
        // It flipped the hole and outer
        // Add this logic to flip it back to the correct value
        if (item.holes.length == 1 && Math.abs(ClipperLib.JS.AreaOfPolygons(item.holes)) > Math.abs(ClipperLib.JS.AreaOfPolygon(item.outer))) {
            let temp = item.holes[0];
            item.holes[0] = item.outer;
            item.outer = temp;
        }
        addContour(contours, vertices, item.outer);

        item.holes.map((hole) => {
            holeIndices.push(vertices.length / 2);
            addContour(contours, vertices, hole);
        });

        var indices = Earcut(vertices, holeIndices);
        return {
            vertices,
            indices,
            holeIndices,
            contours
        };
    });

    return polygons;
};


Path2D.prototype.msdfClipping = function(clipFlatted) {
    var subjFlatted = this.flattened || this.flatten(true);
    var myPath = subjFlatted.toClipperPath(null, false);
    var clips = clipFlatted.toClipperPath(null, false);

    var solution = new ClipperLib.PolyTree();
    var cpr = new ClipperLib.Clipper();
    cpr.AddPaths(myPath, ClipperLib.PolyType.ptSubject, true);
    cpr.AddPaths(clips, ClipperLib.PolyType.ptClip, true);

    cpr.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);

    return this.getPolygonFromClipperSolution(solution);
};