import lmv_poly2tri from "./ThirdParty/lmv_poly2tri";
import {
    IntervalTree
} from "./interval-tree";
import {
    segmentsIntersect,
    ONE_INTERSECTION
} from "./x-line-line";
import {
    UniquePointList
} from "./point-list";


function jitterPoints(pts) {

    for (let i = 0, iEnd = pts.length; i < iEnd; i++) {
        pts[i].x += (Math.random() - 0.5) * 1e-9;
        pts[i].y += (Math.random() - 0.5) * 1e-9;
    }

}

function copyPoints(pts, bbox) {

    //Moving poiints to be centered on the origin
    //seems to improve triangulation success rate, or
    //at least avoids some bugs in poly2yti

    let sz = bbox.getSize(bbox instanceof THREE.Box3 ? new THREE.Vector3() : new THREE.Vector2());
    let offsetx = bbox.min.x + sz.x * 0.5;
    let offsety = bbox.min.y + sz.y * 0.5;
    let scale = 2.0 / sz.length();

    let pts2 = [];

    for (let i = 0, iEnd = pts.length; i < iEnd; i++) {
        pts2.push({
            x: (pts[i].x - offsetx) * scale, // + (Math.random()-0.5) * 1e-9,
            y: (pts[i].y - offsety) * scale, // + (Math.random()-0.5) * 1e-9,
            _triidx: i + 1
        });
    }

    return pts2;

}


//Represents a polygon with holes, and provides triangulation and mesh conversion utilities
export class ComplexPolygon {

    constructor(uniquePoints, customInsidechecker, bbox) {
        this.pts = uniquePoints;
        this.contours = [];
        this.customInsideChecker = customInsidechecker;
        this.bbox = bbox;
        this._tmpVec = bbox instanceof THREE.Box3 ? new THREE.Vector3() : new THREE.Vector2();
    }

    addContour(indices) {
        this.contours.push(indices);
    }

    pointInContour(x, y, cntr) {
        var yflag0, yflag1;
        var vtx0X, vtx0Y, vtx1X, vtx1Y;

        var inside_flag = false;

        var pts = this.pts;

        // get the last point in the polygon
        vtx0X = pts[cntr[cntr.length - 1]].x;
        vtx0Y = pts[cntr[cntr.length - 1]].y;

        // get test bit for above/below X axis
        yflag0 = (vtx0Y >= y);

        for (var j = 0, jEnd = cntr.length; j < jEnd; ++j) {
            vtx1X = pts[cntr[j]].x;
            vtx1Y = pts[cntr[j]].y;

            yflag1 = (vtx1Y >= y);

            // Check if endpoints straddle (are on opposite sides) of X axis
            // (i.e. the Y's differ); if so, +X ray could intersect this edge.
            // The old test also checked whether the endpoints are both to the
            // right or to the left of the test point.  However, given the faster
            // intersection point computation used below, this test was found to
            // be a break-even proposition for most polygons and a loser for
            // triangles (where 50% or more of the edges which survive this test
            // will cross quadrants and so have to have the X intersection computed
            // anyway).  I credit Joseph Samosky with inspiring me to try dropping
            // the "both left or both right" part of my code.
            if (yflag0 != yflag1) {
                // Check intersection of pgon segment with +X ray.
                // Note if >= point's X; if so, the ray hits it.
                // The division operation is avoided for the ">=" test by checking
                // the sign of the first vertex wrto the test point; idea inspired
                // by Joseph Samosky's and Mark Haigh-Hutchinson's different
                // polygon inclusion tests.
                if (((vtx1Y - y) * (vtx0X - vtx1X) >=
                        (vtx1X - x) * (vtx0Y - vtx1Y)) == yflag1) {
                    inside_flag = !inside_flag;
                }
            }

            // move to the next pair of vertices, retaining info as possible
            yflag0 = yflag1;
            vtx0X = vtx1X;
            vtx0Y = vtx1Y;
        }

        return inside_flag;
    }


    pointInPolygon(x, y) {
        var inside = false;

        for (var i = 0; i < this.contours.length; i++) {

            if (this.pointInContour(x, y, this.contours[i]))
                inside = !inside;
        }

        return inside;
    }

    triangulate(options) {
        try {
            this.triangulateInternal(false, options);
        } catch (e) {

            if (e.message.indexOf("Collinear not supported!") !== -1) {
                try {
                    this.triangulateInternal(true, options);
                    //logger.log("Triangulation retry success.");
                } catch (e) {
                    //logger.warn("Triangulation retry failed", e);
                    this.triangulationFailed = true;
                }
            } else {
                //logger.warn("Triangulation failed", e);
                this.triangulationFailed = true;
            }
        }
    }

    createPointInPolygonChecker() {

        let edges = [];

        for (let i = 0; i < this.contours.length; i++) {
            let cntr = this.contours[i];

            var len = cntr.length;
            for (let k = 0; k < len - 1; k++) {
                let e = {
                    p1: cntr[k],
                    p2: cntr[k + 1]
                };
                edges.push(e);
            }
        }

        let it = new IntervalTree(this.pts, edges, this.bbox);
        it.build();
        this.customInsideChecker = it;
    }

    /**
     * @param {boolean} wantJitter
     * @param {Object} options Options objects
     * @param {boolean=false} options.skipOpenContour Flag indicating whether to skip triangulation for open polygons
     */
    triangulateInternal(wantJitter, inOptions = {}) {
        const options = {
            skipOpenContour: false,
            ...inOptions
        };

        if (!this.contours.length) {
            this.triangulationFailed = true;
            this.indices = null;
            return;
        }

        this.indices = [];

        var _pts = copyPoints(this.pts, this.bbox);

        if (wantJitter) {
            jitterPoints(_pts);
        }

        var sweepCtx = new lmv_poly2tri.SweepContext([]);

        sweepCtx.points_ = _pts;

        for (let i = 0; i < this.contours.length; i++) {
            let cntr = this.contours[i];

            //Contour is not closed
            var isOpen = (cntr[0] !== cntr[cntr.length - 1]);

            if (isOpen && options.skipOpenContour)
                continue;

            var len = isOpen ? cntr.length : cntr.length - 1;
            var edge = new Array(len);
            for (var k = 0; k < len; k++) {
                edge[k] = _pts[cntr[k]];
            }

            sweepCtx.initEdges(edge, isOpen);
        }

        sweepCtx.triangulate();

        this.processResult(sweepCtx);

        this.triangulationFailed = !this.indices || !this.indices.length;

    }

    processResult(sweepCtx) {

        //If the polygon has a lot of vertices, create
        //an acceleration structure for point-in-polygon checks
        //so we can filter the triangles faster.
        if (this.pts.length > 10 && !this.customInsideChecker)
            this.createPointInPolygonChecker();

        let tris = sweepCtx.map_;
        for (var i = 0; i < tris.length; i++) {
            var tpts = tris[i].points_;
            var p0 = tpts[0];
            var p1 = tpts[1];
            var p2 = tpts[2];

            var i0 = p0._triidx;
            var i1 = p1._triidx;
            var i2 = p2._triidx;

            if (i0 && i1 && i2)
                this.filterFace(i0 - 1, i1 - 1, i2 - 1);

        }
    }


    filterFace(i0, i1, i2) {

        var p0 = this.pts[i0];
        var p1 = this.pts[i1];
        var p2 = this.pts[i2];

        var cx = (p0.x + p1.x + p2.x) / 3;
        var cy = (p0.y + p1.y + p2.y) / 3;

        let inside = this.customInsideChecker ? this.customInsideChecker.pointInPolygon(cx, cy) : this.pointInPolygon(cx, cy);

        if (inside) {

            var e1x = p1.x - p0.x;
            var e1y = p1.y - p0.y;
            var e2x = p2.x - p0.x;
            var e2y = p2.y - p0.y;

            var cross = e1x * e2y - e2x * e1y;

            if (cross > 0) {
                this.indices.push(i0, i1, i2);
            } else {
                this.indices.push(i0, i2, i1);
            }

        }
    }

    //Returns intersection points between the given line
    //segment and the polygon's contours
    findSegmentIntersections(ex1, ey1, ex2, ey2) {

        if (!this.cachedEdges) {

            this.cachedEdges = [];

            for (let j = 0; j < this.contours.length; j++) {
                let cntr = this.contours[j];

                for (let i = 0; i < cntr.length - 1; i++) {

                    //Add quad for each face formed by the extruded contour
                    let x1 = this.pts[cntr[i]].x;
                    let y1 = this.pts[cntr[i]].y;
                    let x2 = this.pts[cntr[i + 1]].x;
                    let y2 = this.pts[cntr[i + 1]].y;

                    let etmp = {
                        v1: {
                            x: x1,
                            y: y1
                        },
                        v2: {
                            x: x2,
                            y: y2
                        },
                        dx: x2 - x1,
                        dy: y2 - y1,
                        length: Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)
                    };

                    this.cachedEdges.push(etmp);
                }
            }
        }

        let e = {
            v1: {
                x: ex1,
                y: ey1
            },
            v2: {
                x: ex2,
                y: ey2
            },
            dx: ex2 - ex1,
            dy: ey2 - ey1,
            length: Math.sqrt((ex1 - ex2) ** 2 + (ey1 - ey2) ** 2)
        };

        let precision = this.bbox.getSize(this._tmpVec).length() * 1e-4;

        let res = [];

        for (let i = 0; i < this.cachedEdges.length; i++) {
            let etmp = this.cachedEdges[i];
            let xsect = segmentsIntersect(e, etmp, precision);

            if (xsect && xsect.status === ONE_INTERSECTION) {
                let pt = {
                    x: xsect.e1[0],
                    y: xsect.e1[1]
                };
                pt.d = Math.sqrt((pt.x - ex1) ** 2 + (pt.y - ey1) ** 2);
                res.push(pt);
            }
        }

        if (res.length) {
            //Sort in order along the input segment
            res.sort((a, b) => a.d - b.d);

            //Drop start and/or end points if they coincide with the segment start/end
            if (res[0].d < precision) {
                res.shift();
            }

            if (res.length && Math.abs(res[res.length - 1].d - e.length) < precision) {
                res.pop();
            }
        }

        return res.length ? res : null;
    }

    //creates a vertex buffer containing a filled 2D polygon for visualization on the cut plane
    //as 2D polygon mesh in the 3D model space
    toPolygonMesh(packNormals) {

        if (this.polygonMesh)
            return this.polygonMesh;

        var pts = this.pts;

        var bg = new THREE.BufferGeometry();

        var pos = new Float32Array(3 * pts.length);
        for (let j = 0; j < pts.length; j++) {
            pos[3 * j] = pts[j].x;
            pos[3 * j + 1] = pts[j].y;
            pos[3 * j + 2] = 0;
        }
        bg.setAttribute("position", new THREE.BufferAttribute(pos, 3));

        var normal = packNormals ? new Uint16Array(2 * pts.length) : new Float32Array(3 * pts.length);

        for (let j = 0; j < pts.length; j++) {

            if (packNormals) {
                var pnx = (0 /*Math.atan2(0, 0)*/ / Math.PI + 1.0) * 0.5;
                var pny = (1.0 + 1.0) * 0.5;

                normal[j * 2] = (pnx * 65535) | 0;
                normal[j * 2 + 1] = (pny * 65535) | 0;
            } else {
                normal[3 * j] = 0;
                normal[3 * j + 1] = 0;
                normal[3 * j + 2] = 1;
            }
        }

        bg.setAttribute("normal", new THREE.BufferAttribute(normal, packNormals ? 2 : 3));
        if (packNormals) {
            bg.attributes.normal.bytesPerItem = 2;
            bg.attributes.normal.normalized = true;
        }

        var index = new Uint16Array(this.indices.length);
        index.set(this.indices);

        bg.setIndex(new THREE.BufferAttribute(index, 1));

        bg.streamingDraw = true;
        bg.streamingIndex = true;

        this.polygonMesh = bg;

        return bg;
    }


    //creates an extruded polygon 3d mesh
    //with the given thickness (maxZ=0, minZ=-thickness)
    toExtrudedMesh(thickness) {

        if (this.extrudedMesh)
            return this.extrudedMesh;

        if (thickness === undefined)
            thickness = 1;

        //TODO: in case of failed triangulation
        //we can still generate a tube mesh with just the sides, without top and bottom caps
        if (!this.indices)
            return null;

        let vb = [];
        let indices = [];
        let iblines = [];
        let vbase = 0;

        //TODO: for better performance we can allocate ArrayBuffers up front with known
        //sizes... once the logic works.

        //Add the top and bottom polygons

        //The top is just the already triangulated 2D polygon
        //same as toPolygonMesh

        let pts = this.pts;
        for (let i = 0; i < pts.length; i++) {
            vb.push(pts[i].x, pts[i].y, 0);
            vb.push(0, 0, 1);
        }

        let inds = this.indices;

        for (let i = 0; i < inds.length; i += 3) {
            indices.push(inds[i], inds[i + 1], inds[i + 2]);
        }

        vbase += pts.length;

        //The bottom is like the top, but mirrored.

        for (let i = 0; i < pts.length; i++) {
            vb.push(pts[i].x, pts[i].y, -thickness);
            vb.push(0, 0, -1);
        }

        for (let i = 0; i < inds.length; i += 3) {
            indices.push(vbase + inds[i], vbase + inds[i + 2], vbase + inds[i + 1]);
        }

        vbase += pts.length;

        //The sides -- each segment of the contours becomes a quad

        let tmp = new THREE.Vector3();
        let bbox = new THREE.Box3();

        for (let j = 0; j < this.contours.length; j++) {
            let cntr = this.contours[j];

            for (let i = 0; i < cntr.length - 1; i++) {

                //Add quad for each face formed by the extruded contour
                let x1 = this.pts[cntr[i]].x;
                let y1 = this.pts[cntr[i]].y;
                let z1 = 0;

                tmp.set(x1, y1, z1);
                bbox.expandByPoint(tmp);

                let x2 = this.pts[cntr[i + 1]].x;
                let y2 = this.pts[cntr[i + 1]].y;
                let z2 = 0;

                tmp.set(x2, y2, z2);
                bbox.expandByPoint(tmp);

                tmp.set(x1, y1, z1 - thickness);
                bbox.expandByPoint(tmp);

                //orthogonal to the face, will use for the normals
                tmp.set(y2 - y1, x1 - x2, 0).normalize();

                vb.push(x1, y1, z1, tmp.x, tmp.y, tmp.z,
                    x2, y2, z2, tmp.x, tmp.y, tmp.z,
                    x1, y1, z1 - thickness, tmp.x, tmp.y, tmp.z,
                    x2, y2, z2 - thickness, tmp.x, tmp.y, tmp.z);

                iblines.push(vbase, vbase + 1, vbase, vbase + 2, vbase + 1, vbase + 3, vbase + 2, vbase + 3);

                indices.push(vbase, vbase + 2, vbase + 3, vbase, vbase + 3, vbase + 1);

                vbase += 4;
            }
        }

        //Convert to mesh suitable for rendering
        //TODO: As mentioned above, we can do this directly in the loop above
        //for better performance.

        let vbp = new Float32Array(vb.length);
        vbp.set(vb);

        let vbi = new Uint16Array(indices.length);
        vbi.set(indices);

        let vbili = new Uint16Array(iblines.length);
        vbili.set(iblines);

        let mdata = {
            mesh: {
                vb: vbp,
                indices: vbi,
                iblines: vbili,

                vbstride: 6,
                vblayout: {
                    position: {
                        offset: 0,
                        itemSize: 3,
                        bytesPerItem: 4
                    },
                    normal: {
                        offset: 3,
                        itemSize: 3,
                        bytesPerItem: 4
                    },
                },
                boundingBox: bbox,
                boundingSphere: {
                    center: bbox.getCenter(new THREE.Vector3()),
                    radius: bbox.getSize(new THREE.Vector3()).length * 0.5
                }
            }
        };

        this.extrudedMesh = Autodesk.Viewing.Private.BufferGeometryUtils.meshToGeometry(mdata);

        this.extrudedMesh.streamingDraw = true;
        this.extrudedMesh.streamingIndex = true;

        return this.extrudedMesh;
    }

    static FromClipperPaths(paths, bbox, scale) {

        let ptList = new UniquePointList(bbox);
        let complexPolygon = new ComplexPolygon(ptList.pts, null, bbox);
        for (let path of paths) {
            let cntr = [];
            for (let i = 0; i < path.length; i++) {
                let pt = ptList.findOrAddPoint(path[i].X * scale, path[i].Y * scale);
                cntr.push(pt.id);
            }

            //Clipper doesn't explicitly close its paths, so we do
            cntr.push(cntr[0]);

            complexPolygon.addContour(cntr);
        }

        return complexPolygon;
    }

}