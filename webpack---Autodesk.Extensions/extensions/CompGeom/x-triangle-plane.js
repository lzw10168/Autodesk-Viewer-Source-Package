import {
    TOL
} from "./fuzzy-math";
import {
    xPlaneSegment
} from "./x-plane-segment";

const avp = Autodesk.Viewing.Private;
const logger = avp.logger;

function Edge(pt1, pt2, id1From, id1To, id2From, id2To, meshId) {

    this.v1 = pt1.clone();
    this.v2 = pt2.clone();

}



let res1 = new THREE.Vector3();
let res2 = new THREE.Vector3();

// res is array containing result segments.
// returns number of intersection point on the plane (0, 1, or 2) with the values of the points stored in the res array
export function xTrianglePlane(plane, pt0, pt1, pt2, i0, i1, i2, res, meshId) {

    let d0 = plane.distanceToPoint(pt0);
    let d1 = plane.distanceToPoint(pt1);
    let d2 = plane.distanceToPoint(pt2);

    // Check if all points are to one side of the plane
    if (d0 < -TOL && d1 < -TOL && d2 < -TOL) {
        return null;
    }
    if (d0 > TOL && d1 > TOL && d2 > TOL) {
        return null;
    }

    let s0 = Math.sign(d0);
    let s1 = Math.sign(d1);
    let s2 = Math.sign(d2);

    // Skip coplanar triangles (leave it to the neighbouring triangles to contribute their edges)
    if (s0 === 0 && s1 === 0 && s2 === 0) {
        return null;
    }

    let tmp1, tmp2;
    let i1From, i1To, i2From, i2To;

    //There is intersection, compute it
    if (s0 !== s1) {
        let numInts = xPlaneSegment(plane, pt0, pt1, res1, res2);
        if (numInts === 2) {
            res.push(new Edge(pt0, pt1, i0, i0, i1, i1, meshId));
            return;
        } else if (numInts === 1) {
            i1From = i0;
            i1To = i1;
            tmp1 = res1.clone();
        } else {
            logger.warn("Unexpected zero intersections where at least one was expected");
        }
    }

    if (s1 !== s2) {
        let numInts = xPlaneSegment(plane, pt1, pt2, res1, res2);
        if (numInts === 2) {
            res.push(new Edge(pt1, pt2, i1, i1, i2, i2, meshId));
            return;
        } else if (numInts === 1) {
            if (tmp1) {
                // Avoid the singular scenario where the signs are 0, -1 and +1
                if (res1.distanceTo(tmp1) > TOL) {
                    i2From = i1;
                    i2To = i2;
                    tmp2 = res1.clone();
                }
            } else {
                i1From = i1;
                i1To = i2;
                tmp1 = res1.clone();
            }
        } else {
            logger.warn("Unexpected zero intersections where at least one was expected");
        }
    }

    if (s2 !== s0) {
        let numInts = xPlaneSegment(plane, pt2, pt0, res1, res2);
        if (numInts === 2) {
            res.push(new Edge(pt2, pt0, i2, i2, i0, i0, meshId));
            return;
        } else if (numInts === 1) {
            if (tmp1) {
                // Avoid the singular scenario where the signs are 0, -1 and +1
                if (res1.distanceTo(tmp1) > TOL) {
                    i2From = i2;
                    i2To = i0;
                    tmp2 = res1.clone();
                }
            } else {
                logger.warn("Unexpected single intersection point");
            }
        } else {
            logger.warn("Unexpected zero intersections where at least one was expected");
        }
    }


    if (tmp1 && tmp2) {
        res.push(new Edge(tmp1, tmp2, i1From, i1To, i2From, i2To, meshId));
    } else {
        //logger.warn("Unexpected one intersection where two were expected");
    }

}