import {
    IntervalTree
} from "./interval-tree";
import {
    UniquePointList
} from "./point-list";
import {
    ComplexPolygon
} from "./complex-polygon";
import {
    getGlobal
} from "../../src/compat";

const _window = getGlobal();


//Functionality for converting a list of two-point line segments into a connected
//set of (hopefully) closed contour lines. The contour set is then used
//for triangulation.
//This data structure assumes there are no intersecting edges (use the DCEL if there are, or you need fully-connected topology).
export class EdgeSet {

    constructor(edges, bbox, precisionTolerance) {

        this.edges = edges;
        this.bbox = bbox;

        this.verts = new UniquePointList(bbox, precisionTolerance);
        this.polygon = null;
    }


    getPointIndex(px, py) {

        let v = this.verts.findOrAddPoint(px, py);

        return v.id;
    }

    snapEdges() {

        for (var i = 0; i < this.edges.length; i++) {

            var e = this.edges[i];

            e.p1 = this.getPointIndex(e.v1.x, e.v1.y);
            e.p2 = this.getPointIndex(e.v2.x, e.v2.y);
        }
    }

    sanitizeEdges() {
        var edgeSet = {};
        var sanitizedEdges = [];

        for (var i = 0, len = this.edges.length; i < len; i++) {
            var e = this.edges[i];
            if (e.p1 === e.p2) {
                continue;
            }

            var key = Math.min(e.p1, e.p2) + ':' + Math.max(e.p1, e.p2);
            if (edgeSet[key] !== true) {
                edgeSet[key] = true;
                sanitizedEdges.push(e);
            }
        }

        this.edges = sanitizedEdges;
    }


    stitchContours() {

        this.contours = [];

        //Create jump table from edge to edge
        //and back
        var edge_table = {};

        for (var i = 0; i < this.edges.length; i++) {
            var e = this.edges[i];

            if (e.p1 === e.p2)
                continue;

            if (edge_table[e.p1] !== undefined)
                edge_table[e.p1].push(e.p2);
            else
                edge_table[e.p1] = [e.p2];

            if (edge_table[e.p2] !== undefined)
                edge_table[e.p2].push(e.p1);
            else
                edge_table[e.p2] = [e.p1];
        }

        var cur_cntr = [];

        for (var p in edge_table) {
            if (edge_table[p].length !== 2) {
                _window.Autodesk ? .Viewing.Private.logger.warn("Incomplete edge table");
                break;
            }
        }

        //Start with the first edge, and stitch until we can no longer
        while (true) {

            var sfrom = undefined;

            //Look for doubly connected point first
            for (let p in edge_table) {
                if (edge_table[p].length > 1) {
                    sfrom = p;
                    break;
                }
            }

            //If no double-connected point found, we know
            //the it will be an open contour, but stitch as much
            //as we can anyway.
            if (!sfrom) {
                for (let p in edge_table) {
                    if (edge_table[p].length > 0) {
                        sfrom = p;
                        break;
                    }
                }
            }

            if (!sfrom)
                break;

            var prev = -1;
            var cur = parseInt(sfrom);
            var cur_segs = edge_table[sfrom];

            //start a new contour
            cur_cntr.push(cur);

            while (cur_segs && cur_segs.length) {

                var toPt = cur_segs.shift();

                //skip backpointer if we hit it
                if (toPt === prev)
                    toPt = cur_segs.shift();

                if (toPt === undefined) {
                    delete edge_table[cur];
                    break;
                }

                cur_cntr.push(toPt);

                if (cur_segs.length == 0)
                    delete edge_table[cur];
                else if (cur_segs[0] === prev)
                    delete edge_table[cur];

                prev = cur;
                cur = toPt;
                cur_segs = edge_table[toPt];
            }

            if (cur_cntr.length) {
                this.contours.push(cur_cntr);
                cur_cntr = [];
            }
        }

        var openCntrs = [];
        for (let i = 0; i < this.contours.length; i++) {
            var cntr = this.contours[i];
            if (cntr[0] !== cntr[cntr.length - 1])
                openCntrs.push(cntr);
        }


        if (openCntrs.length) {
            //avp.logger.warn("Incomplete stitch");

            var didSomething = true;
            while (didSomething) {

                didSomething = false;

                //Try to combine contours
                var cntr_edge_table = {};
                var contours = this.contours;

                for (let i = 0; i < contours.length; i++) {
                    const cntr = contours[i];
                    var start = cntr[0];
                    var end = cntr[cntr.length - 1];

                    if (start === end)
                        continue;

                    if (!cntr_edge_table[start])
                        cntr_edge_table[start] = [-i - 1];
                    else
                        cntr_edge_table[start].push(-i - 1);


                    if (!cntr_edge_table[end])
                        cntr_edge_table[end] = [i];
                    else
                        cntr_edge_table[end].push(i);
                }

                for (let p in cntr_edge_table) {
                    var entry = cntr_edge_table[p];

                    if (entry.length == 2) {
                        var toerase = undefined;

                        if (entry[0] < 0 && entry[1] < 0) {
                            var c1 = -entry[0] - 1;
                            var c2 = -entry[1] - 1;
                            //join start point to startpoint
                            contours[c2].shift();
                            Array.prototype.push.apply(contours[c1].reverse(), contours[c2]);
                            toerase = c2;
                        }

                        if (entry[0] < 0 && entry[1] > 0) {
                            const c1 = -entry[0] - 1;
                            const c2 = entry[1];
                            //join start point to endpoint
                            contours[c2].pop();
                            Array.prototype.push.apply(contours[c2], contours[c1]);
                            toerase = c1;
                        }

                        if (entry[0] > 0 && entry[1] < 0) {
                            const c1 = entry[0];
                            const c2 = -entry[1] - 1;
                            //join end point to startpoint
                            contours[c1].pop();
                            Array.prototype.push.apply(contours[c1], contours[c2]);
                            toerase = c2;
                        }

                        if (entry[0] > 0 && entry[1] > 0) {
                            const c1 = entry[0];
                            const c2 = entry[1];
                            //join end point to endpoint
                            contours[c1].pop();
                            Array.prototype.push.apply(contours[c1], contours[c2].reverse());
                            toerase = c2;
                        }

                        if (toerase !== undefined) {
                            contours.splice(toerase, 1);
                            didSomething = true;
                        }
                        break;
                    }
                }

            }

        }
    }


    cleanupFlatEdges() {

        let pts = this.verts.pts;
        let TOL = this.verts.precisionTolerance;

        for (let i = 0; i < this.contours.length; i++) {

            let cntr = this.contours[i];

            while (true) {
                let removePt = -1;

                for (let j = 1; j < cntr.length - 1; j++) {
                    let prev = cntr[j - 1];
                    let cur = cntr[j];
                    let next = cntr[j + 1];

                    let p0 = pts[prev];
                    let p1 = pts[cur];
                    let p2 = pts[next];

                    let dx1 = p1.x - p0.x;
                    let dy1 = p1.y - p0.y;
                    let dx2 = p2.x - p1.x;
                    let dy2 = p2.y - p1.y;

                    let len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                    if (len1 < TOL) {
                        removePt = j;
                        break;
                    }

                    let len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                    if (len2 < TOL) {
                        removePt = j;
                        break;
                    }

                    dx1 /= len1;
                    dy1 /= len1;
                    dx2 /= len2;
                    dy2 /= len2;

                    let dot = dx1 * dx2 + dy1 * dy2;

                    if (Math.abs(dot - 1.0) < 1e-2) {
                        removePt = j;
                        break;
                    }
                }

                if (removePt < 0)
                    break;

                cntr.splice(removePt, 1);
            }

        }

    }


    triangulate(options = {}) {

        //this.cleanupFlatEdges();

        //The interval tree is a faster and more tolerant
        //way of checking if a point is inside the complex polygon defined
        //by a set of edges. We use that in preference to the built-in
        //ComplexPolygon inside checker.
        let it = new IntervalTree(this.verts.pts, this.edges, this.bbox);
        it.build();

        let polygon = new ComplexPolygon(this.verts.pts, it, this.bbox);
        polygon.contours = this.contours;
        polygon.triangulate(options);
        return polygon;

    }


}