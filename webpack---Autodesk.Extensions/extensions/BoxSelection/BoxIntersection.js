//Based on https://github.com/mrdoob/three.js/blob/dev/examples/jsm/interactive/SelectionBox.js

//import * as THREE from "three";

import {
    poly_clip_to_box,
    POLY_CLIP_IN,
    POLY_CLIP_OUT
} from "./poly_clip";

const {
    enumMeshLines,
    enumMeshTriangles
} = Autodesk.Viewing.Private.VertexEnumerator;

const Frustum = THREE.Frustum;
const Vector3 = THREE.Vector3;
const Vector4 = THREE.Vector4;
const Box3 = THREE.Box3;
const Matrix4 = THREE.Matrix4;

/**
 * This is a class to check whether objects are in a selection area in 3D space
 */

var frustum = new Frustum();
var viewProj = new Matrix4();
var tmpMat = new Matrix4();

var ndcBox = new THREE.Box3();
ndcBox.min.x = -1;
ndcBox.min.y = -1;
ndcBox.min.z = -1;
ndcBox.max.x = 1;
ndcBox.max.y = 1;
ndcBox.max.z = 1;

var tempBox = new Box3();

var vecTopLeft = new Vector3();
var vecTopRight = new Vector3();
var vecDownRight = new Vector3();
var vecDownLeft = new Vector3();

var vecFarTopLeft = new Vector3();
var vecFarTopRight = new Vector3();
var vecFarDownRight = new Vector3();
var vecFarDownLeft = new Vector3();

var vectemp1 = new Vector3();
var vectemp2 = new Vector3();

var v41 = new Vector4();
var v42 = new Vector4();
var v43 = new Vector4();

const OUTSIDE = 0;
const INTERSECTS = 1;
const CONTAINS = 2;

function frustumIntersectsBox(frustum, box) {

    //Copied from three.js and modified to return separate
    //value for full containment versus intersection.
    //Return values: 0 -> outside, 1 -> intersects, 2 -> contains

    var p1 = vectemp1;
    var p2 = vectemp2;
    var planes = frustum.planes;
    var contained = 0;

    for (var i = 0; i < 6; i++) {

        var plane = planes[i];

        p1.x = plane.normal.x > 0 ? box.min.x : box.max.x;
        p2.x = plane.normal.x > 0 ? box.max.x : box.min.x;
        p1.y = plane.normal.y > 0 ? box.min.y : box.max.y;
        p2.y = plane.normal.y > 0 ? box.max.y : box.min.y;
        p1.z = plane.normal.z > 0 ? box.min.z : box.max.z;
        p2.z = plane.normal.z > 0 ? box.max.z : box.min.z;

        var d1 = plane.distanceToPoint(p1);
        var d2 = plane.distanceToPoint(p2);

        // if both outside plane, no intersection

        if (d1 < 0 && d2 < 0) {

            return OUTSIDE;

        }

        if (d1 > 0 && d2 > 0) {

            contained++;

        }
    }

    return (contained === 6) ? CONTAINS : INTERSECTS;
}

/**
 * @param v {THREE.Vector3}
 * @param m {THREE.Matrix4}
 * @param out {THREE.Vector4}
 */
function applyProjection(v, m, out) {

    //Similar to Vector3.applyProjection, but without perspective divide (leaves output in clip space).

    let x = v.x,
        y = v.y,
        z = v.z;

    let e = m.elements;

    out.x = (e[0] * x + e[4] * y + e[8] * z + e[12]);
    out.y = (e[1] * x + e[5] * y + e[9] * z + e[13]);
    out.z = (e[2] * x + e[6] * y + e[10] * z + e[14]);
    out.w = (e[3] * x + e[7] * y + e[11] * z + e[15]);
}

/**
 * @param {BufferGeometry} geom
 * @param {Matrix4} mvpMtx
 * @param {Box3} ndcBox
 * @param {Boolean} containmentOnly
 */
function geomIntersectsNDC(geom, mvpMtx, ndcBox, containmentOnly) {

    let contains = true;
    let intersects = false;

    if (geom.isLine) {
        enumMeshLines(geom, (vA, vB) => {

            //Get the line into NDC coordinates and do the
            //clipping check by faking a triangle.
            applyProjection(vA, mvpMtx, v41);
            applyProjection(vB, mvpMtx, v42);

            let pIn = [v41, v42, v43];
            let result = poly_clip_to_box(pIn, ndcBox);

            if (result !== POLY_CLIP_IN) {
                contains = false;
            }

            if (result !== POLY_CLIP_OUT) {
                intersects = true;
            }

            //TODO: we can early out here if we can definitively reject containment or detect intersection
        });
    } else {

        enumMeshTriangles(geom, (vA, vB, vC) => {

            //Get the triangle into NDC coordinates and do the
            //clipping check.
            applyProjection(vA, mvpMtx, v41);
            applyProjection(vB, mvpMtx, v42);
            applyProjection(vC, mvpMtx, v43);

            let pIn = [v41, v42, v43];
            let result = poly_clip_to_box(pIn, ndcBox);

            if (result !== POLY_CLIP_IN) {
                contains = false;
            }

            if (result !== POLY_CLIP_OUT) {
                intersects = true;
            }

            //TODO: we can early out here if we can definitively reject containment or detect intersection
        });
    }

    if (contains) {
        return CONTAINS;
    } else if (intersects) {
        return INTERSECTS;
    } else {
        return OUTSIDE;
    }
}



/**
 * @param camera {UnifiedCamera}
 * @param scene {RenderScene}
 */
export function BoxIntersection(camera, scene) {

    this.camera = camera;
    this.scene = scene;
    this.startPoint = new Vector3();
    this.endPoint = new Vector3();
    this.result = [];
}

BoxIntersection.prototype.select = function(startPoint, endPoint, containmentOnly) {

    this.startPoint = startPoint || this.startPoint;
    this.endPoint = endPoint || this.endPoint;
    this.result = [];

    this.updateFrustum(this.startPoint, this.endPoint);
    this.searchChildInRenderScene(frustum, containmentOnly);

    return this.result;
};

BoxIntersection.prototype.updateFrustum = function(startPoint, endPoint) {

    startPoint = startPoint || this.startPoint;
    endPoint = endPoint || this.endPoint;

    // Avoid invalid frustum

    if (startPoint.x === endPoint.x) {

        endPoint.x += Number.EPSILON;

    }

    if (startPoint.y === endPoint.y) {

        endPoint.y += Number.EPSILON;

    }

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    viewProj.multiplyMatrices(this.camera.projectionMatrix, viewProj.copy(this.camera.matrixWorld).invert());

    var left = Math.min(startPoint.x, endPoint.x);
    var top = Math.max(startPoint.y, endPoint.y);
    var right = Math.max(startPoint.x, endPoint.x);
    var down = Math.min(startPoint.y, endPoint.y);

    vecTopLeft.set(left, top, -1);
    vecTopRight.set(right, top, -1);
    vecDownRight.set(right, down, -1);
    vecDownLeft.set(left, down, -1);

    vecFarTopLeft.set(left, top, 1);
    vecFarTopRight.set(right, top, 1);
    vecFarDownRight.set(right, down, 1);
    vecFarDownLeft.set(left, down, 1);

    ndcBox.min.x = left;
    ndcBox.min.y = down;
    ndcBox.min.z = -1;
    ndcBox.max.x = right;
    ndcBox.max.y = top;
    ndcBox.max.z = 1;

    tmpMat.copy(viewProj).invert();

    vecTopLeft.applyProjection(tmpMat);
    vecTopRight.applyProjection(tmpMat);
    vecDownRight.applyProjection(tmpMat);
    vecDownLeft.applyProjection(tmpMat);

    vecFarTopLeft.applyProjection(tmpMat);
    vecFarTopRight.applyProjection(tmpMat);
    vecFarDownRight.applyProjection(tmpMat);
    vecFarDownLeft.applyProjection(tmpMat);

    var planes = frustum.planes;

    planes[0].setFromCoplanarPoints(vecTopLeft, vecFarTopLeft, vecFarTopRight);
    planes[1].setFromCoplanarPoints(vecTopRight, vecFarTopRight, vecFarDownRight);
    planes[2].setFromCoplanarPoints(vecFarDownRight, vecFarDownLeft, vecDownLeft);
    planes[3].setFromCoplanarPoints(vecFarDownLeft, vecFarTopLeft, vecTopLeft);
    planes[4].setFromCoplanarPoints(vecTopRight, vecDownRight, vecDownLeft);
    planes[5].setFromCoplanarPoints(vecFarDownRight, vecFarTopRight, vecFarTopLeft);

};

/**
 * @param frustum {THREE.Frustum}
 * @param containmentOnly {Boolean}
 */
BoxIntersection.prototype.searchChildInRenderScene = function(frustum, containmentOnly) {

    let models = this.scene.getModels();

    //This is in effect a simple simulation of the main LMV FrustumIntersector that just does box intersection
    let myCustomIntersector = {
        intersectsBox: function(box) {
            return frustumIntersectsBox(frustum, box);
        }
    };

    for (let model of models) {

        let fl = model.getFragmentList();

        //Keeps track of intersection/containment state per element.
        //We need to keep state for elements that are composed of multiple fragments
        //in case we need to verify the whole element is fully contained by the search box.
        let dbIdStatus = new Map();

        model.getIterator().intersectFrustum(myCustomIntersector, (fragId, containmentKnown) => {

            let fragState;

            if (containmentKnown) {
                fragState = CONTAINS;
            } else {
                fl.getWorldBounds(fragId, tempBox);
                fragState = frustumIntersectsBox(frustum, tempBox);
            }

            if (fragState === OUTSIDE) {
                return;
            }

            if (fragState !== CONTAINS) {

                //The fragment intersects the frustum in a non-trivial. Now we have to do hard work and check each triangle or line.

                //Get the model-view-projection matrix
                fl.getWorldMatrix(fragId, tmpMat);
                tmpMat.multiplyMatrices(viewProj, tmpMat);

                let geom = fl.getGeometry(fragId);

                fragState = geomIntersectsNDC(geom, tmpMat, ndcBox, containmentOnly);
            }

            if (fragState === OUTSIDE) {
                return;
            }

            //Fragment is either inside or intersects the frustum
            let dbId = fl.getDbIds(fragId);

            let curStatus = dbIdStatus.get(dbId);
            if (curStatus === undefined) {
                dbIdStatus.set(dbId, fragState);
            } else if (curStatus === CONTAINS && fragState !== CONTAINS) {
                dbIdStatus.set(dbId, fragState);
            }
        });

        if (containmentOnly) {
            //containment only -- return element IDs whose fragments are entirely contained in the search box
            let res = {
                model,
                ids: []
            };
            dbIdStatus.forEach((value, key) => {
                if (value === CONTAINS) {
                    res.ids.push(key);
                }
            });
            this.result.push(res);
        } else {
            //Any intersection acceptable, return result without filtering
            this.result.push({
                model,
                ids: Array.from(dbIdStatus.keys())
            });
        }

    }

};