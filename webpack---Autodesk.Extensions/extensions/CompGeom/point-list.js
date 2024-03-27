import {
    TOL
} from "./fuzzy-math";
import {
    QuadTree
} from "./quad-tree";
import lmv_poly2tri from "./ThirdParty/lmv_poly2tri";
import {
    LmvVector3
} from '../../src/wgs/scene/LmvVector3';

const tmpVec3 = new LmvVector3();
export class UniquePointList {

    constructor(bbox, precisionTolerance, VertexConstructor, useQuadTree) {

        this.bbox = bbox;
        this.boxSize = this.bbox.getSize(tmpVec3).length();

        if (typeof precisionTolerance === "number") {
            //Input is in model units, e.g. if model is in feet,
            //precision tolerance has to be in feet
            this.precisionTolerance = precisionTolerance;
            this.scale = 1.0 / this.precisionTolerance;
        } else {
            this.precisionTolerance = TOL * this.boxSize;
            this.scale = 1.0 / this.precisionTolerance;
        }

        this.precisionToleranceSq = this.precisionTolerance * this.precisionTolerance;

        this.snapBaseX = (this.bbox.min.x); ///- 0.5 * this.precisionTolerance;
        this.snapBaseY = (this.bbox.min.y); //- 0.5 * this.precisionTolerance;


        this.pts = [];
        this.xymap = new Map();

        if (useQuadTree)
            this.quadTreeVerts = new QuadTree(bbox.min.x, bbox.min.y, bbox.max.x, bbox.max.y, precisionTolerance);

        this.vertexConstructor = VertexConstructor;
    }

    findOrAddPoint(px, py, dbIds) {

        //Snap the vertex to our desired granularity
        let x = 0 | /*Math.round*/ ((px - this.snapBaseX) * this.scale);
        let y = 0 | /*Math.round*/ ((py - this.snapBaseY) * this.scale);

        //Find the nearest snapped vertex or create new
        let v;
        let minDist = Infinity;
        //Look in the 9 square area surrounding the vertex
        for (let i = x - 1; i <= x + 1; i++) {
            let mx = this.xymap.get(i);
            if (!mx)
                continue;

            for (let j = y - 1; j <= y + 1; j++) {
                let tmp = mx.get(j);
                if (!tmp)
                    continue;

                let dist = (tmp.x - px) * (tmp.x - px) + (tmp.y - py) * (tmp.y - py);

                if (dist < minDist) {
                    v = tmp;
                    minDist = dist;
                }
            }
        }

        if (minDist > this.precisionToleranceSq)
            v = undefined;

        if (v === undefined) {
            let mx = this.xymap.get(x);

            if (!mx) {
                mx = new Map();
                this.xymap.set(x, mx);
            }

            v = this.vertexConstructor ? new this.vertexConstructor(px, py) : new lmv_poly2tri.Point(px, py);
            mx.set(y, v);
            v.id = this.pts.length;
            this.pts.push(v);

            if (this.quadTreeVerts)
                this.quadTreeVerts.addItem(v);
        }

        //Remember the source object that's adding this vertex
        if (typeof dbIds !== "undefined") {
            if (typeof dbIds === "number") {
                if (v.dbIds.indexOf(dbIds) === -1)
                    v.dbIds.push(dbIds);
            } else if (dbIds) {
                for (let i = 0; i < dbIds.length; i++) {
                    let dbId = dbIds[i];
                    if (v.dbIds.indexOf(dbId) === -1)
                        v.dbIds.push(dbId);
                }
            }
            v.dbIdsChanged = true;
        }

        return v;
    }


    forEach(f) {
        this.pts.forEach(f);
    }

    delete(v) {
        this.pts[v.id] = undefined;

        if (this.quadTreeVerts)
            this.quadTreeVerts.deleteItem(v);
    }

    //filters out null entries from the point list
    compact() {

        let pts = [];

        for (let i = 0, len = this.pts.length; i < len; i++) {
            let v = this.pts[i];
            if (!v)
                continue;

            v.oldid = v.id;
            v.id = pts.length;
            pts.push(v);
        }

        this.pts = pts;

    }

    enumInBox(minx, miny, maxx, maxy, f) {
        this.quadTreeVerts.enumInBox(minx, miny, maxx, maxy, f);
    }

}