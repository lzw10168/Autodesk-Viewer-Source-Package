import {
    isZero,
    TOL
} from "./fuzzy-math";

let v1 = new THREE.Vector3();

export function xPlaneSegment(plane, pt0, pt1, res1, res2) {

    let direction = v1.subVectors(pt1, pt0);

    let denominator = plane.normal.dot(direction);

    if (isZero(denominator)) {

        res1.copy(pt0);
        res2.copy(pt1);

        // line is coplanar
        return 2;
    }

    denominator = 1.0 / denominator;

    let t = -(pt0.dot(plane.normal) * denominator + plane.constant * denominator);

    if (t < -TOL || t > 1 + TOL) {

        return 0;

    }

    let pt = direction.multiplyScalar(t).add(pt0);

    res1.copy(pt);

    return 1;
}