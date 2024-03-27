import {
    ComplexPolygon
} from "./complex-polygon";

export function polygonArea(pts) {

    if (pts.length < 3)
        return 0;

    let needsClose = false;
    if (pts[0] !== pts[pts.length - 1])
        needsClose = true;

    let total = 0;
    for (let i = 0, len = pts.length - 1; i < len; i++) {
        let v1 = pts[i];
        let v2 = pts[i + 1];
        total += v1.x * v2.y - v2.x * v1.y;
    }

    if (needsClose) {
        let v1 = pts[pts.length - 1];
        let v2 = pts[0];
        total += v1.x * v2.y - v2.x * v1.y;
    }

    return total * 0.5;
}


let v2 = new THREE.Vector2();


//An intermediate complex polygon representation, used by the DCEL structure to compose and triangulate
//complex polygons, and also to convert the polygon data to various visualization representations
export class ContourSet {

    constructor() {
        this.contours = [];
        this.areas = [];
        this.bbox = new THREE.Box2();

        this.allPoints = this.pts = [];
        this.allPointsMap = {};
    }

    addContour(verts, skipZeroAreas) {

        this.polygon = null;
        this.perimeterMem = undefined;

        let area = polygonArea(verts);

        if (area < 0) {
            verts.reverse();
            area = Math.abs(area);
        }

        let cntr = [];

        verts.forEach((v, i) => {

            let id = v.id;

            if (typeof id === "undefined") {
                //Auto-assign unique vertex ID if not given -- this assumes the caller
                //has cleaned up the vertex data, or the polygon is simple enough not to
                //suffer from numeric issues.
                id = (this.contours.length + ":" + i);
            }

            let idx = this.allPointsMap[id];
            if (idx === undefined) {
                idx = this.allPoints.length;
                this.allPoints.push(v);
                this.allPointsMap[id] = idx;

                v2.set(v.x, v.y);
                this.bbox.expandByPoint(v2);
            }
            cntr.push(idx);
        });

        if (area === 0 && skipZeroAreas)
            return;

        this.contours.push(cntr);
        this.areas.push(area);
    }

    addContourSet(cset) {

        //TODO: this can be optimized to skip this pre-processing

        let cntr = cset.contours[0];
        let pts = cset.allPoints;

        let ptlist = cntr.map(idx => pts[idx]);

        this.addContour(ptlist);
    }


    triangulate(customInsideChecker) {

        if (this.polygon)
            return;

        let pts = this.allPoints;

        let polygon = new ComplexPolygon(pts, customInsideChecker, this.bbox);

        polygon.contours = this.contours;

        polygon.triangulate();

        this.polygon = polygon;
        this.triangulationFailed = this.polygon.triangulationFailed;
    }

    area() {
        return this.areas[0];
    }

    areaNet() {
        let total = this.areas[0];
        for (let i = 1; i < this.areas.length; i++)
            total -= this.areas[i];
        return total;
    }

    perimeter() {

        if (this.perimeterMem)
            return this.perimeterMem;

        let total = 0;
        let pts = this.contours[0];
        for (let i = 0, len = pts.length - 1; i < len; i++) {
            let v1 = pts[i];
            let v2 = pts[i + 1];
            total += Math.sqrt((v1.x - v2.x) * (v1.x - v2.x) + (v1.y - v2.y) * (v1.y - v2.y));
        }

        this.perimeterMem = total;

        return total;
    }


    getThemeColor() {
        //returns a stable random-ish color value
        //based on properties of the geometry,
        //for use during colorized visualization of areas and volumes

        let r = ((this.areas[0] * 100) % 17) / 16;
        let g = (this.allPoints.length % 23) / 22;
        let b = ((this.perimeterMem * 100) % 29) / 28;

        return {
            r: r,
            g: g,
            b: b
        };
    }

    hash() {
        let all = [];
        this.contours.forEach(c => {
            let vids = c.map(idx => this.allPoints[idx].id);
            if (vids[0] === vids[vids.length - 1])
                vids.pop(); //remove last point that equals first point, since the same closed contour can use any of its points as a start point
            vids.sort();
            all.push(vids);
        });
        return JSON.stringify(all);
    }


    stitchContours() {

        //invalidate this just in case something tries to use it...
        //it makes no sense for open polylines anyway
        this.areas = [];

        let openCntrs = [];
        for (var i = 0; i < this.contours.length; i++) {
            let cntr = this.contours[i];
            if (cntr[0] !== cntr[cntr.length - 1])
                openCntrs.push(cntr);
        }

        if (!openCntrs.length)
            return;


        let didSomething = true;
        while (didSomething) {

            didSomething = false;

            //Try to combine contours
            let cntr_edge_table = {};
            let contours = this.contours;

            for (let i = 0; i < contours.length; i++) {
                let cntr = contours[i];

                let start = cntr[0];
                let end = cntr[cntr.length - 1];

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
                let entry = cntr_edge_table[p];

                if (entry.length === 2) {
                    let toerase = undefined;

                    if (entry[0] < 0 && entry[1] < 0) {
                        let c1 = -entry[0] - 1;
                        let c2 = -entry[1] - 1;
                        //join start point to startpoint
                        contours[c2].shift();
                        Array.prototype.push.apply(contours[c1].reverse(), contours[c2]);
                        toerase = c2;
                    }

                    if (entry[0] < 0 && entry[1] > 0) {
                        let c1 = -entry[0] - 1;
                        let c2 = entry[1];
                        //join start point to endpoint
                        contours[c2].pop();
                        Array.prototype.push.apply(contours[c2], contours[c1]);
                        toerase = c1;
                    }

                    if (entry[0] > 0 && entry[1] < 0) {
                        let c1 = entry[0];
                        let c2 = -entry[1] - 1;
                        //join end point to startpoint
                        contours[c1].pop();
                        Array.prototype.push.apply(contours[c1], contours[c2]);
                        toerase = c2;
                    }

                    if (entry[0] > 0 && entry[1] > 0) {
                        let c1 = entry[0];
                        let c2 = entry[1];
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


    containsPointFrom(cs2) {

        //Only need to check a single point from the interior of the
        //potential hole. Make sure it's inside the triangulation and not on the edge
        //to avoid numeric noise.
        if (!cs2.polygon.indices || cs2.polygon.indices.length < 3)
            return false;

        let p0 = cs2.allPoints[cs2.polygon.indices[0]];
        let p1 = cs2.allPoints[cs2.polygon.indices[1]];
        let p2 = cs2.allPoints[cs2.polygon.indices[2]];

        let cx = (p0.x + p1.x + p2.x) / 3;
        let cy = (p0.y + p1.y + p2.y) / 3;

        return this.polygon && this.polygon.pointInPolygon(cx, cy);
    }


    //creates a vertex buffer containing a filled 2D polygon for visualization on the cut plane
    //as 2D polygon mesh in the 3D model space
    //TODO: Use this directly from the this.polygon
    toPolygonMesh(packNormals) {

        return this.polygon.toPolygonMesh(packNormals);

    }

    //creates an extruded polygon 3d mesh
    //with the given thickness (maxZ=0, minZ=-thickness)
    //TODO: Use this directly from the this.polygon
    toExtrudedMesh(thickness) {

        return this.polygon.toExtrudedMesh(thickness);
    }


}