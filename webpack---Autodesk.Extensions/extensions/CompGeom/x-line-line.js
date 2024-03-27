import {
    TOL
} from "./fuzzy-math";

function ABS(x) {
    return Math.abs(x);
}

const EPS = TOL;

export const ONE_INTERSECTION = 4;
export const OVERLAP = 5;


//Returns true if the given point lies on and inside the given line segment
export function pointOnLine(x, y, e, checkInsideSegment, precisionDistance, outPt) {

    if (e.length < EPS) {
        return false;
    }

    let dot = (x - e.v1.x) * e.dx + (y - e.v1.y) * e.dy;

    if (!precisionDistance)
        precisionDistance = EPS * e.length;

    let u = dot / e.length2;

    if (checkInsideSegment) {
        if (u * e.length < -precisionDistance || u * e.length > e.length + precisionDistance)
            return false;
    }

    let lx = e.v1.x + u * e.dx;
    let ly = e.v1.y + u * e.dy;

    let len2 = (lx - x) * (lx - x) + (ly - y) * (ly - y);

    if (outPt) {
        outPt.x = lx;
        outPt.y = ly;
        outPt.d = Math.sqrt(len2);
        outPt.u = u;
    }

    if (len2 < precisionDistance * precisionDistance)
        return true;

    return false;
}


function parallelLinesOverlap(e1, e2, precisionDistance) {

    //Check of the segments are parallel but not on the same infinite line
    if (!pointOnLine(e2.v1.x, e2.v1.y, e1, false, precisionDistance)) {
        return null;
    }

    let res = {
        status: OVERLAP,
        e1: [],
        e2: []
    };

    //They are on the same line. Find overlap points.
    //TODO: There is probably a more efficient way to do this
    let p3_seg1 = pointOnLine(e2.v1.x, e2.v1.y, e1, true, precisionDistance);
    let p4_seg1 = pointOnLine(e2.v2.x, e2.v2.y, e1, true, precisionDistance);

    //If both points of the second segment are inside the first
    //then the reverse cannot be true...
    if (p3_seg1 && p4_seg1) {
        res.e1.push(e2.v1.x, e2.v1.y, e2.v2.x, e2.v2.y);
        return res;
    }

    let p1_seg2 = pointOnLine(e1.v1.x, e1.v1.y, e2, true, precisionDistance);
    let p2_seg2 = pointOnLine(e1.v2.x, e1.v2.y, e2, true, precisionDistance);

    if (p3_seg1)
        res.e1.push(e2.v1.x, e2.v1.y);
    if (p4_seg1)
        res.e1.push(e2.v2.x, e2.v2.y);
    if (p1_seg2)
        res.e2.push(e1.v1.x, e1.v1.y);
    if (p2_seg2)
        res.e2.push(e1.v2.x, e1.v2.y);

    return res;
}


/*
   Determine the intersection point of two line segments
   Modified source from here:
   http://www.paulbourke.net/geometry/pointlineplane/
*/
export function segmentsIntersect(e1, e2, precisionDistance) {
    let denom = e2.dy * e1.dx - e2.dx * e1.dy;
    let numera = e2.dx * (e1.v1.y - e2.v1.y) - e2.dy * (e1.v1.x - e2.v1.x);
    let numerb = e1.dx * (e1.v1.y - e2.v1.y) - e1.dy * (e1.v1.x - e2.v1.x);

    /* Are the lines coincident? */
    if (ABS(numera) < EPS && ABS(numerb) < EPS && ABS(denom) < EPS) {
        return null;
    }

    /* Are the lines parallel */
    if (ABS(denom) < EPS) {
        /* check for overlap */
        return parallelLinesOverlap(e1, e2, precisionDistance);
    }

    /* Is the intersection along the segments */
    let mua = numera / denom;
    let da = mua * e1.length;
    if (da < -precisionDistance || da > e1.length + precisionDistance) {
        return null;
    }

    let mub = numerb / denom;
    let db = mub * e2.length;
    if (db < -precisionDistance || db > e2.length + precisionDistance) {
        return null;
    }

    let x = e1.v1.x + mua * e1.dx;
    let y = e1.v1.y + mua * e1.dy;

    return {
        status: ONE_INTERSECTION,
        e1: [x, y],
        e2: [x, y]
    };
}