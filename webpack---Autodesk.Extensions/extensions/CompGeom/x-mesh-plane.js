"use strict";

//const THREE = THREE;
const avp = Autodesk.Viewing.Private;
const VertexEnumerator = avp.VertexEnumerator;

import {
    isZero
} from "./fuzzy-math";
import {
    xTrianglePlane
} from "./x-triangle-plane";


var mi = new THREE.Matrix4();
var pi = new THREE.Plane();

export function xMeshPlane(plane, {
    geometry,
    matrixWorld,
    fragId
}, intersects) {

    if (!geometry)
        return;

    let baseIndex = intersects.length;

    mi.copy(matrixWorld).invert();
    pi.copy(plane).applyMatrix4(mi);

    VertexEnumerator.enumMeshTriangles(geometry, function(vA, vB, vC, a, b, c) {

        xTrianglePlane(pi, vA, vB, vC, a, b, c, intersects, fragId);

    });

    //Put the points into world space. It should actually be possible to do
    //the entire math in object space -- but we have to check if all fragments
    //that belong to the same dbId have the same world transform.
    for (let i = baseIndex, iEnd = intersects.length; i < iEnd; i++) {
        intersects[i].v1.applyMatrix4(matrixWorld);
        intersects[i].v2.applyMatrix4(matrixWorld);
    }

}


function makeRotationAxis(axis, cosa, m) {

    // Based on http://www.gamedev.net/reference/articles/article1199.asp

    let c = cosa;
    let s = Math.sqrt(1.0 - c * c);
    let t = 1 - c;
    let x = axis.x,
        y = axis.y,
        z = axis.z;
    let tx = t * x,
        ty = t * y;

    m.set(

        tx * x + c, tx * y - s * z, tx * z + s * y, 0,
        tx * y + s * z, ty * y + c, ty * z - s * x, 0,
        tx * z - s * y, ty * z + s * x, t * z * z + c, 0,
        0, 0, 0, 1

    );

}


export function makePlaneBasis(plane) {

    //var origin = plane.coplanarPoint();

    let sceneUp = new THREE.Vector3(0, 0, 1);
    let cross = plane.normal.clone().cross(sceneUp);
    cross = cross.normalize();
    let dot = sceneUp.dot(plane.normal);

    //We are ignoring the translation here, since
    //we will drop the Z coord for the 2D processing steps anyway.
    let planeBasis = new THREE.Matrix4();

    if (!(isZero(cross.x) && isZero(cross.y) && isZero(cross.z))) {
        makeRotationAxis(cross, dot, planeBasis);
        planeBasis.elements[14] = plane.constant;
    } else {
        planeBasis.elements[14] = dot * plane.constant;
    }

    return planeBasis;
}


export function convertToPlaneCoords(planeBasis, edges3d, bbox) {

    for (let i = 0; i < edges3d.length; i++) {
        let e = edges3d[i];

        e.v1.applyMatrix4(planeBasis);
        e.v2.applyMatrix4(planeBasis);

        bbox.expandByPoint(e.v1);
        bbox.expandByPoint(e.v2);
    }
}