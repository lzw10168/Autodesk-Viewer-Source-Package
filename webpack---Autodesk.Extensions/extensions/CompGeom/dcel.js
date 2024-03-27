import {
    segmentsIntersect,
    pointOnLine
} from "./x-line-line";
import {
    isZero,
    isEqual,
    TOL
} from "./fuzzy-math";
import {
    ContourSet
} from "./contour-set";
import {
    QuadTree
} from "./quad-tree";
import {
    UniquePointList
} from "./point-list";

const avp = Autodesk.Viewing.Private;
const logger = avp.logger;

class Vertex {

    constructor(x, y) {
        this.x = x;
        this.y = y;

        this.edges = [];
        this.dbIds = [];
        this.dbIdsChanged = false;
    }

    isDegenerate() {
        return this.edges.length < 2;
    }

    addEdge(de) {

        //Make sure the same edge doesn't already exist
        for (let i = 0; i < this.edges.length; i++) {

            let e = this.edges[i];

            //We already have the exact same edge, return existing id
            if (e.v1 === de.v1 && e.v2 === de.v2)
                return e;
        }

        //Add the edge
        this.edges.push(de);
        return de;
    }

    removeEdge(de) {
        let idx = this.edges.indexOf(de);
        if (idx >= 0)
            this.edges.splice(idx, 1);
        else
            logger.warn("Failed to find edge in vertex list");
    }

    findEdgeTo(v) {
        for (let i = 0; i < this.edges.length; i++) {
            let e = this.edges[i];
            if (e.getOppositeVertex(this) === v)
                return e;
        }

        return null;
    }

    //TODO: make use of this when removing redundant vertices
    disconnect() {
        for (let i = 0; i < this.edges.length; i++) {
            let e = this.edges[i];
            e.getOppositeVertex(this).removeEdge(e);
        }

        let res = this.edges;
        this.edges = [];

        //Return the edges that got orphaned and need deletion 
        //from the parent structure
        return res;
    }

    sortEdges() {

        this.edges.sort((a, b) => {
            let angle1 = a.angle;
            if (a.v1 !== this) {
                angle1 -= Math.PI;
            }

            let angle2 = b.angle;
            if (b.v1 !== this) {
                angle2 -= Math.PI;
            }

            return angle1 - angle2;
        });

    }

    _canTraverse(e) {
        //forward edge
        if (e.v1 === this && !e.flagFwd) {
            e.flagFwd = 1;
            return true;
        }

        //reverse edge (points into this vertex)
        if (e.v2 === this && !e.flagRev) {
            e.flagRev = 1;
            return true;
        }

        return false;
    }

    //Returns an edge that's not yet traversed during
    //area finding
    findUntraversedEdge() {
        for (let i = 0; i < this.edges.length; i++) {
            let e = this.edges[i];

            if (this._canTraverse(e))
                return e;
        }

        return null;
    }

    //Assuming edges are already sorted,
    //returns the edge that's immediately CCW to 
    //the given edge
    findNextCCWEdge(e) {

        let idx = this.edges.indexOf(e);

        if (idx === -1) {
            logger.error("This edge isn't mine.");
            return null;
        }

        //Dangling vertex
        if (this.isDegenerate()) {
            return null;
        }
        /*        
                let idxNext = idx - 1;
                if (idxNext < 0)
                    idxNext = this.edges.length -1;
                    */
        let idxNext = (idx + 1) % this.edges.length;

        let eNext = this.edges[idxNext];

        if (this._canTraverse(eNext))
            return eNext;

        //logger.warn("Hmmm... Didn't find an edge to continue from here.");
        return null;
    }

}


class DirectedEdge {

    constructor(v1, v2, id) {
        let swap = false;

        //Orient the edge so it has increasing dy and dx
        if (v2.y < v1.y)
            swap = true;
        else if (v2.y === v1.y)
            swap = (v2.x < v1.x);

        //the coordinates stored in the edge
        //might be slightly different from the vertex coordinates
        //of the v1 and v2 vertices. The vertices are "snapped" to 
        //the nearest snap positin, while the edge coordinates are the "original" ones
        //from the 3d mesh that generated the edge.
        if (swap) {
            this.v1 = v2;
            this.v2 = v1;
        } else {
            this.v1 = v1;
            this.v2 = v2;
        }

        this.dx = this.v2.x - this.v1.x;
        this.dy = this.v2.y - this.v1.y;
        this.length2 = this.dx * this.dx + this.dy * this.dy;
        this.length = Math.sqrt(this.length2);
        this.angle = Math.atan2(this.dy, this.dx);

        if (this.angle < 0) {
            if (isZero(this.angle))
                this.angle = 0;
            else if (isEqual(this.angle, -Math.PI))
                this.angle = Math.PI;

            if (this.angle < 0)
                logger.warn("Unexpected edge slope <0 :", this.angle);
        }

        //the edge index in the edge list of the parent data structure
        this.id = id;

        this.minx = Math.min(this.v1.x, this.v2.x);
        this.miny = Math.min(this.v1.y, this.v2.y);
        this.maxx = Math.max(this.v1.x, this.v2.x);
        this.maxy = Math.max(this.v1.y, this.v2.y);


        //traversal flags, set temporarily 
        //during graph tarversal
        this.flagFwd = 0;
        this.flagRev = 0;

        this.dbIdsCached = null;
    }

    paramAlong(x, y) {
        let dot = (x - this.v1.x) * this.dx + (y - this.v1.y) * this.dy;
        return dot / this.length2;
    }

    getOppositeVertex(v) {
        if (this.v1 === v)
            return this.v2;
        else if (this.v2 === v)
            return this.v1;
        else
            logger.warn("Edge does not own this vertex.");
    }

    getDbIds() {
        //Return all dbIds that are common between the two 
        //vertices of the edge. Used when splitting edges
        //to pass the information to new vertices

        if (!this.v1.dbIdsChanged && !this.v2.dbIdsChanged) {
            return this.dbIdsCached;
        }

        //Calculate intersection of the dbId arrays of
        //the two vertices.
        let res = [];
        let idv1 = this.v1.dbIds;
        let idv2 = this.v2.dbIds;
        for (let i = 0; i < idv1.length; i++) {
            if (idv2.indexOf(idv1[i]) !== -1)
                res.push(idv1[i]);
        }

        //Cache the result so we don't recompute unnecessarily
        //This requires cooperation by the vertex object change flag.
        this.dbIdsCached = res;
        this.v1.dbIdsChanged = false;
        this.v2.dbIdsChanged = false;

        return res;
    }
}



//doubly connected edge list
export class DCEL {


    constructor(bbox, precisionTolerance) {

        this.bbox = bbox;
        this.boxSize = this.bbox.getSize(new THREE.Vector3()).length();

        if (typeof precisionTolerance === "number") {
            //Input is in model units, e.g. if model is in feet,
            //precision tolerance has to be in feet
            this.precisionTolerance = precisionTolerance;
        } else {
            this.precisionTolerance = TOL * this.boxSize;
        }

        this.edges = [];
        this.verts = new UniquePointList(this.bbox, this.precisionTolerance, Vertex, true);

        this.quadTreeEdges = new QuadTree(this.bbox.min.x, this.bbox.min.y, this.bbox.max.x, this.bbox.max.y, this.precisionTolerance);

        this.nextEdgeId = 1;
    }

    _addVertex(px, py, dbIds) {
        return this.verts.findOrAddPoint(px, py, dbIds);
    }


    splitEdge(de, points) {

        let pts = [];

        pts.push({
            x: de.v1.x,
            y: de.v1.y,
            u: 0
        });

        //Remember the originating objects for this edge, to set them on the
        //resulting split edges
        let dbIds = de.getDbIds();

        for (let i = 0; i < points.length; i += 2) {

            let p = {
                x: points[i],
                y: points[i + 1],
                u: de.paramAlong(points[i], points[i + 1])
            };

            if (isZero(p.u) || isEqual(p.u, 1))
                continue;

            pts.push(p);
        }

        //The intersection points were either on the beginning or on the end
        //vertex of the edge, so splitting is not needed as it will result
        //in a zero length edge.
        if (pts.length === 1)
            return;

        pts.push({
            x: de.v2.x,
            y: de.v2.y,
            u: 1
        });

        pts.sort((a, b) => {
            return a.u - b.u;
        });

        //Remove the source edge
        this.removeDirectedEdge(de);

        //Add all the pieces that the edge was split into
        for (let i = 1; i < pts.length; i++) {
            this.addDirectedEdge(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, true, dbIds);
        }
    }

    _enumNearEdges(de, cb) {

        this.quadTreeEdges.enumNearItems(de, cb);
    }

    addDirectedEdge(x1, y1, x2, y2, skipSplitting, dbIds) {
        let v1 = this._addVertex(x1, y1, dbIds);
        let v2 = this._addVertex(x2, y2, dbIds);

        if (v1 === v2) {
            //logger.warn("zero length edge");
            return;
        }

        if (v1.findEdgeTo(v2)) {
            //edge already exists
            return;
        }

        let de = new DirectedEdge(v1, v2, this.nextEdgeId++);

        let addedEdge = de.v1.addEdge(de);

        //If the edge did not already exist...
        if (addedEdge === de) {
            de.v2.addEdge(de);

            //Remember the unsnapped positions used for this edge
            de.sourcePts = [x1, y1, x2, y2];

            this.edges[de.id] = de;

            this.quadTreeEdges.addItem(de);
        } else {
            //Edge is already in the graph, nothing to do
            return addedEdge;
        }

        if (skipSplitting)
            return addedEdge;

        //Now make sure the new edge doesn't overlap or intersect existing edges
        //by finding and splitting any intersecting edges
        let myInts = [];
        let otherInts = {};

        this._enumNearEdges(de, (e) => {
            let ints = segmentsIntersect(e, de, this.precisionTolerance);

            if (!ints)
                return;

            //Existing edge was crossed by new edge -- split it
            if (ints.e1 && ints.e1.length) {
                otherInts[e.id] = ints.e1;
            }

            //New edge crossed existing edge -- remember the intersection point for later
            if (ints.e2 && ints.e2.length) {
                myInts.push.apply(myInts, ints.e2);
            }

        });

        for (let id in otherInts) {
            this.splitEdge(this.edges[parseInt(id)], otherInts[id]);
        }

        if (myInts.length)
            this.splitEdge(de, myInts);

        this.dirty = true;

        return addedEdge;
    }

    removeDirectedEdge(de) {

        de.v1.removeEdge(de);
        de.v2.removeEdge(de);

        this.edges[de.id] = undefined;

        this.quadTreeEdges.deleteItem(de);
    }

    removeDanglingPolyline(startVertex) {

        while (startVertex.edges.length === 1) {

            let de = startVertex.edges[0];
            let endVertex = de.getOppositeVertex(startVertex);
            this.removeDirectedEdge(de);
            startVertex = endVertex;
        }

    }

    cleanupFlatEdges() {
        //get rid of vertices that only have two parallel edges going into them

        let removeList = [];

        this.verts.forEach(v => {

            if (!v)
                return;

            if (v.edges.length !== 2)
                return;

            let e1 = v.edges[0];
            let e2 = v.edges[1];

            //Detect co-linear edges
            let angleDelta = Math.abs(e1.angle - e2.angle);
            const ANGLE_TOLERANCE = 2e-3;
            if (angleDelta < ANGLE_TOLERANCE || Math.abs(angleDelta - Math.PI) < ANGLE_TOLERANCE) {
                removeList.push(v);
            }

            //Detect degenerate triangles
            let v1 = e1.getOppositeVertex(v);
            let v2 = e2.getOppositeVertex(v);
            let eShared = v1.findEdgeTo(v2);

            if (eShared) {
                let area = 0.5 * Math.abs((e1.dx * e2.dy - e2.dx * e1.dy));
                if (area < 1e-3) {
                    removeList.push(v);
                }
            }

            //TODO: more generic co-linearity and degeneracy heuristics...

        });


        //if (removeList.length)
        //    logger.log("Redundant edges", removeList.length);

        for (let i = 0; i < removeList.length; i++) {

            let v = removeList[i];

            if (v.edges.length !== 2) {
                //logger.warn("Number of edges changed");
                continue;
            }

            let e1 = v.edges[0];
            let e2 = v.edges[1];

            let vOther1 = e1.getOppositeVertex(v);
            let vOther2 = e2.getOppositeVertex(v);

            this.removeDirectedEdge(e1);
            this.removeDirectedEdge(e2);

            this.verts.delete(v);

            this.addDirectedEdge(vOther1.x, vOther1.y, vOther2.x, vOther2.y, true);
        }

        //Clean up again, until no more redundant vertices exist
        if (removeList.length)
            return this.cleanupFlatEdges();
    }



    _compactLists() {

        this.verts.compact();


        let edges = [];

        for (let i = 0, len = this.edges.length; i < len; i++) {
            let e = this.edges[i];
            if (!e)
                continue;

            e.oldid = e.id;
            e.flagFwd = 0;
            e.flagRev = 0;
            e.id = edges.length;
            edges.push(e);
        }

        this.edges = edges;
    }


    //converts closed areas to polygons with holes, in a way where
    //holes themseves are also marked as separate polygons in their own
    //right, thus filling the whole area (i.e. non-zero fill method).
    _detectHolesNonZero(customInsideChecker) {

        this.holes = [];

        //Skip the very largest polygon, because that is
        //the overall model perimeter
        //TODO: This logic is Location Breakdown specific
        this.outerPerimeter = this.closedAreas[this.closedAreas.length - 1];
        if (this.outerPerimeter)
            this.outerPerimeter.triangulate();

        for (let i = 0, len = this.closedAreas.length - 1; i < len; i++) {

            let cs = this.closedAreas[i];

            //detect if the polygon is actually a hole in a
            //bigger exterior polygon
            //The logic we use here: if a polygon contains
            //any of the smaller polygons inside it, it is a hole of a bigger polygon
            //If a polygon contains a polygon marked as a hole, then add the hole to it
            //before triangulating.
            //TODO: this can be optimized via spatial index if number of polygons becomes large
            for (let j = i - 1; j >= 0; j--) {
                let cs2 = this.closedAreas[j];

                //Only need to check a single point from the interior of the
                //potential hole. Make sure it's inside the triangulation and not on the edge
                //to avoid numeric noise.
                if (cs.containsPointFrom(cs2)) {
                    if (cs2.isHole) {
                        cs.addContourSet(cs2);
                    } else {
                        cs.isHole = true;
                        this.holes.push(cs);
                        break;
                    }
                }
            }

            //We added all the holes, now triangulate again with the holes in mind
            if (!cs.isHole) {
                cs.triangulate(customInsideChecker);
            }

        }


        //Do a second pass over just the holes
        //and convert each hole that contains a hole
        //to a real polygon area.
        //TODO: I don't really know if this is mathematically correct...
        for (let i = 0, len = this.holes.length; i < len; i++) {

            let cs = this.holes[i];

            cs.triangulate(customInsideChecker);

            //If a hole contains a hole inside it, then it is
            //no longer hole, mark both as processed
            for (let j = i - 1; j >= 0; j--) {

                let cs2 = this.holes[j];

                if (cs2.holeProcessFlag)
                    continue;

                //Only need to check a single point from the interior of the
                //potential hole. Make sure it's inside the triangulation and not on the edge
                //to avoid numeric noise.
                if (cs.containsPointFrom(cs2)) {
                    cs.addContourSet(cs2);
                    cs.isHole = false;
                    cs2.holeProcessFlag = true;
                }
            }

            //We added all the holes, now triangulate again with the holes in mind
            if (!cs.isHole) {
                cs.triangulate(customInsideChecker);
            }

        }

        //Remove all holes from the list of polygons
        let filteredNonHoles = [];
        for (let i = 0; i < this.closedAreas.length - 1; i++) {
            let cs = this.closedAreas[i];
            if (cs.isHole)
                continue;

            cs.id = filteredNonHoles.length;
            filteredNonHoles.push(cs);
        }

        this.closedAreas = filteredNonHoles;


    }

    _detectHolesEvenOdd(customInsideChecker) {

        let allAreas = this.closedAreas;
        if (this.openAreas && this.openAreas.length)
            allAreas = allAreas.concat(this.openAreas);

        if (!allAreas.length) {
            this.closedAreas = [];
            this.openAreas = null;
            return;
        }

        //In the DCEL, each polygon outline or hole contour
        //appears twice (due to the structure being doubly connected), so
        //here we drop the twin polygon.
        let cmap = {};
        for (let i = 0; i < allAreas.length; i++) {
            let a = allAreas[i];
            let hash = a.hash();
            if (!cmap[hash])
                cmap[hash] = a;
        }

        allAreas = Object.values(cmap);

        //Make one giant complex polygon out of all the contours, and let
        //it triangulate itself using its default even-odd fill rule
        let csAll = new ContourSet();

        for (let i = 0; i < allAreas.length; i++) {
            csAll.addContourSet(allAreas[i]);
        }

        csAll.triangulate(customInsideChecker || this.quadTreeEdges);

        if (csAll.triangulationFailed) {
            //OK, now we get desperate -- the above triangulation attempt
            //of the whole thing as one failed, so we triangulate each
            //area separately (together with areas that are roughly inside it),
            //and filter that result based on even-odd inside checker.
            this._detectHolesNonZero(customInsideChecker || this.quadTreeEdges);
        } else {
            this.closedAreas = [csAll];
            this.openAreas = [];
        }
    }


    finalize(useEvenOddFill, customInsideChecker) {

        //Remove useless vertices
        this.cleanupFlatEdges();

        this._compactLists();

        //Sort the edges of each vertex according to direction
        this.verts.forEach(v => v.sortEdges());

        //traverse the graph and build closed polygons 
        //by following the edges in a counterclockwise direction

        let polygons = [];
        let openPolygons = [];

        this.verts.forEach(v => {
            let e = v.findUntraversedEdge();

            if (!e)
                return;

            let polygon = [v];

            let vNext = e.getOppositeVertex(v);
            do {
                polygon.push(vNext);
                e = vNext.findNextCCWEdge(e);
                if (!e)
                    break;
                vNext = e.getOppositeVertex(vNext);
            } while (vNext && vNext !== v);

            if (vNext === v) {
                polygon.push(v);
                polygons.push(polygon);
            } else {
                openPolygons.push(polygon);
            }
        });

        //logger.log("closed polygons:", polygons.length);
        //if (openPolygons.length)
        //  logger.log("open polygons:", openPolygons.length);

        this.closedAreas = [];
        for (let i = 0, len = polygons.length; i < len; i++) {
            let cs = new ContourSet();
            cs.addContour(polygons[i]);
            this.closedAreas.push(cs);
        }

        //Sort by increasing area, so that
        //we discover potential polygon holes before we
        //triangulate their bigger exterior outlines
        this.closedAreas.sort((a, b) => {
            return a.area() - b.area();
        });


        if (useEvenOddFill) {
            this._detectHolesEvenOdd(customInsideChecker);
        } else {
            this._detectHolesNonZero(customInsideChecker);
        }


        //Put all open polygons into a single set of contours
        //and combine as many as possible end to end to get
        //a minimal number of open contours.
        this.openAreas = [];
        if (openPolygons.length) {
            let openAreas = [];
            let cs = new ContourSet();
            for (let i = 0, len = openPolygons.length; i < len; i++) {
                cs.addContour(openPolygons[i]);
            }
            cs.stitchContours();
            cs.triangulate();
            openAreas.push(cs);
            //logger.log("Stitched open polygons", cs.contours.length);

            this.openAreas = openAreas;
        }

    }


    deleteEdgesOnLine(x1, y1, x2, y2) {

        let v1Tmp = new Vertex(x1, y1);
        let v2Tmp = new Vertex(x2, y2);
        let deTmp = new DirectedEdge(v1Tmp, v2Tmp, -1);

        //Find edges crossed by the given segment
        let otherInts = {};

        this._enumNearEdges(deTmp, e => {

            let ints = segmentsIntersect(e, deTmp, this.precisionTolerance);

            if (!ints)
                return;

            //Existing edge was crossed by new edge
            if (ints.e1 && ints.e1.length) {
                otherInts[e.id] = ints.e1;
            }
        });

        //Remove the intersected edges, effectively
        //joining all areas defined by those edges.
        //This is brute force, in theory we can find all
        //contour sets that own the intersected edges
        //and update the triangulations, but it doesn't seem worth it
        for (let sid in otherInts) {
            let eid = parseInt(sid);
            let edge = this.edges[eid];
            this.removeDirectedEdge(edge);

            //clean up any "dangling" vertices left by the edge removal.
            //those are edges that are only connected to the deleted edge and nothing else
            this.removeDanglingPolyline(edge.v1);
            this.removeDanglingPolyline(edge.v2);
        }

        this.dirty = true;
    }

    //Given a rectangle, join all areas that intersect the rectangle
    deleteEdgesInRectangle(x1, y1, x2, y2) {

        let minx = Math.min(x1, x2);
        let miny = Math.min(y1, y2);
        let maxx = Math.max(x1, x2);
        let maxy = Math.max(y1, y2);

        let otherInts = {};

        //find edges completely inside the rectangle
        this.quadTreeEdges.enumInBox(minx, miny, maxx, maxy, e => {
            otherInts[e.id] = e;
        });

        //Remove the intersected edges, effectively
        //joining all areas defined by those edges.
        //This is brute force, in theory we can find all
        //contour sets that own the intersected edges
        //and update the triangulations, but it doesn't seem worth it
        for (let sid in otherInts) {
            let eid = parseInt(sid);
            let edge = this.edges[eid];

            if (!edge)
                continue;

            this.removeDirectedEdge(edge);

            //clean up any "dangling" vertices left by the edge removal.
            //those are edges that are only connected to the deleted edge and nothing else
            this.removeDanglingPolyline(edge.v1);
            this.removeDanglingPolyline(edge.v2);
        }


        this.dirty = true;
    }

    findNearestVertex(x, y, radius) {

        if (typeof radius !== "number")
            radius = this.precisionTolerance;

        let dNear = Infinity;
        let vNear = null;

        this.verts.enumInBox(x - radius, y - radius, x + radius, y + radius, v => {

            let d = (v.x - x) * (v.x - x) + (v.y - y) * (v.y - y);
            if (d < dNear) {
                dNear = d;
                vNear = v;
            }

        });

        return (dNear <= radius * radius) ? vNear : null;
    }

    findNearestPointOnEdge(x, y, radius) {

        if (typeof radius !== "number")
            radius = this.precisionTolerance;

        let tmp = {
            x: 0,
            y: 0,
            u: 0,
            d: -1
        };
        let ptNearest = {
            x: 0,
            y: 0,
            d: Infinity,
            e: null
        };

        this.quadTreeEdges.enumInBox(x - radius, y - radius, x + radius, y + radius, e => {

            let result = pointOnLine(x, y, e, true, radius, tmp);

            if (result) {
                if (tmp.d < ptNearest.d) {
                    ptNearest.x = tmp.x;
                    ptNearest.y = tmp.y;
                    ptNearest.d = tmp.d;
                    ptNearest.e = e;
                }
            }
        });

        return (ptNearest.d <= radius) ? ptNearest : null;

    }

}