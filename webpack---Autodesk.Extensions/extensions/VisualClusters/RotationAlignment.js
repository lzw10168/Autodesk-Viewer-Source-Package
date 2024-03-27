// The purpose of this file is to compute the necessary transforms to rotate
// all objects in a way that...
//
//  1. Identical objects are oriented in the same way
//  2. Objects are horizontally aligned with the main axes x/y to reduce bbox extents.
//  3. Up-Vector is preserved
//
// It also provides methods to consider these rotations during computation of
// cluster layout and animation.

// @param {Box3}   box
// @param {number} i - in [0, 7]
export const getBoxCorner = (box, i) => {
    return new THREE.Vector3(
        (i & 1) ? box.min.x : box.max.x,
        (i & 2) ? box.min.y : box.max.y,
        (i & 4) ? box.min.z : box.max.z
    );
};

// Each element is a corner index. Each pair of two forms a main axis direction.
const BoxAxisIndices = Uint32Array.from([
    0, 1, 0, 2, 0, 4
]);

// Helper class to enumerate the main axis directions of one or more rotated bboxes.
class BoxAxes {

    constructor() {
        // Transforming vertices turned out to be the major cost factor. So we use indexing to reduce it.
        this.vertices = [];

        this.tmpPoint = new THREE.Vector3();
    }

    // @param {Box3}    box
    // @param {Matrix4} matrix - orientation of the box
    addBox(box, matrix) {

        // It's important to skip empty boxes. Otherwise, we would produce infinite 
        // extents after transforming min/max
        if (box.isEmpty()) {
            return;
        }

        // add 8 box corners
        for (let i = 0; i < 8; i++) {
            const p = getBoxCorner(box, i).applyMatrix4(matrix);
            this.vertices.push(p);
        }
    }

    // Sets outAxis.indexA and outAxis.indexB to vertex numbers of the given edge
    //
    // @param {number} axisIndex
    // @param {Object} outAxis.indexA and outAxis.indexB will be set.
    getAxis(axisIndex, outAxis) {
        // Get offset where the vertices of the box start
        const boxIndex = Math.floor(axisIndex / 3); // 3 axes per box
        const vertexOffset = 8 * boxIndex; // 8 vertices per box

        // Get index into BoxAxisIndices
        const localIndex = (2 * axisIndex) % BoxAxisIndices.length; // 2 values per axis

        outAxis.indexA = vertexOffset + BoxAxisIndices[localIndex];
        outAxis.indexB = vertexOffset + BoxAxisIndices[localIndex + 1];
    }

    getAxisCount() {
        const boxCount = this.vertices.length / 8;
        const AxesPerBox = 3;
        return boxCount * AxesPerBox;
    }

    // Returns bounding rectangle of all boxes if we transform all points by the given matrix
    //  @param {Box2}    outRect
    //  @param {Matrix4} matrix
    getBoundingRect(outRect, matrix) {
        for (let v of this.vertices) {
            // add transformed vertex to bbox
            const p = this.tmpPoint.copy(v).applyMatrix4(matrix);
            outRect.expandByPoint(p);
        }
    }
};

// Find rotation around z-axis that brings the given (horizontal) direction to the x-axis
//
//  @param {Vector2}  dir - Does not need to be normalized
//  @returns {number} ccw angle in radians. Rotate by this angle to bring dir to xAxis.
export const getAngleToXAxis = (dir) => {
    return -Math.atan2(dir.y, dir.x);
};

// Collects main axes of all fragment geometry boxes and projects them to world-space.
//  @returns {BoxAxes} 
export const collectFragBoxAxes = (model, dbId) => {

    let boxAxes = new BoxAxes();

    const geomList = model.getGeometryList();
    const fragList = model.getFragmentList();

    // Reused tmp-values
    const geomBox = new THREE.Box3();
    const worldMatrix = new THREE.Matrix4();

    // For each fragment...
    const it = model.getInstanceTree();
    it.enumNodeFragments(dbId, (fragId) => {

        // Set geomBox to geometry bbox in object-space (for otg, it will simply be the unit box)
        const geomId = fragList.getGeometryId(fragId);
        geomList.getModelBox(geomId, geomBox);

        // get fragment world matrix
        fragList.getOriginalWorldMatrix(fragId, worldMatrix);

        // collect bbox with transform
        boxAxes.addBox(geomBox, worldMatrix);
    });
    return boxAxes;
};

// Given vertices and axis directions of bboxes, this function finds a rotation around z so that...
//  - area of the boundsXY is minimized
//  - We always have xExtent <= yExtent for boundsXY
// where boundsXY is the bounding box of the xy-projection of all boxes.
//
// Note: We assume here that the optimal solution will align one of the edges with the x-axis.
//
//  @param {BoxAxes} boxAxes
//  @returns {Quaternion}
export const findAlignmentRotation = (boxAxes) => {

    // Reused in the loop below
    const edgeDir = new THREE.Vector2();
    const quaternion = new THREE.Quaternion();
    const rotMatrix = new THREE.Matrix4();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const rect = new THREE.Box2();

    let minArea = Infinity;
    let bestAngle = null;
    let minExtent = new THREE.Vector2();

    // An axis direction, given by two indices into boxAxes.vertices
    const axis = {
        indexA: 0,
        indexB: 0
    };
    let a = null;
    let b = null;

    // For each edge...
    const axisCount = boxAxes.getAxisCount();
    for (let i = 0; i < axisCount; i++) {

        // get edge
        boxAxes.getAxis(i, axis);
        a = boxAxes.vertices[axis.indexA];
        b = boxAxes.vertices[axis.indexB];

        // get edge direction
        edgeDir.set(b.x - a.x, b.y - a.y);

        // compute rotation matrix that brings that angle to x-axis (ccw radians)
        let angleToXAxis = getAngleToXAxis(edgeDir);
        quaternion.setFromAxisAngle(zAxis, angleToXAxis);
        rotMatrix.makeRotationFromQuaternion(quaternion);

        // compute xy-bounding rectangle that we get when using this angle
        boxAxes.getBoundingRect(rect, rotMatrix);

        // compute area
        const dx = rect.max.x - rect.min.x;
        const dy = rect.max.y - rect.min.y;
        const area = dx * dy;

        // If this area is better than our candidates so far, use it
        if (area < minArea) {
            // keep rotation that minimized area so far
            minExtent.set(dx, dy);
            minArea = area;
            bestAngle = angleToXAxis;
        }
    }

    // If needed, rotate by another 90 degree to ensure xExtent < yExtent.
    // Note that this doesn't change the area
    if (minExtent.x > minExtent.y) {
        bestAngle += THREE.Math.degToRad(90.0);
    }

    // Compute final quaternion
    quaternion.setFromAxisAngle(zAxis, bestAngle);
    return quaternion;
};

// Computes a rotation transform for a given dbId that aligns the object horizontally, so that:
//  - xy extent of the bbox is minimized
//  - xExtent <= yExtent
// @returns {Quaternion}
export const computeObjectAlignment = (model, dbId) => {

    // project the main axes of all fragment geometry boxes to world-space
    const axes = collectFragBoxAxes(model, dbId); // {Vector3[]} with two vectors per edge

    // find rotation that minimizes the x/y-bbox of all transformed boxes
    return findAlignmentRotation(axes);
};

const tmpMatrix = new THREE.Matrix4();
const tmpMatrix2 = new THREE.Matrix4();

// Returns the bbox that we obtain when applying the given rotationMatrix
// to the given fragment as animation transform, i.e., applied after world matrix.
export const getRotatedFragmentBox = (model, fragId, rotMatrix, optionalTarget) => {

    const result = optionalTarget || new THREE.Box3();

    const fragList = model.getFragmentList();
    const geomList = model.getGeometryList();

    // Get fragment worldMatrix. Note that we don't want it to be affected by current animation state.
    const worldMatrix = tmpMatrix;
    fragList.getOriginalWorldMatrix(fragId, worldMatrix);

    // Apply worldMatrix then rotMatrix
    const fullMatrix = tmpMatrix2.copy(rotMatrix).multiply(worldMatrix);

    // Get geometry bbox in object-space (for otg, it will simply be the unit box)
    const geomId = fragList.getGeometryId(fragId);
    geomList.getModelBox(geomId, result);

    // Applying a matrix turns an empty box into an infinite one. So, we must skip it for empty boxes
    if (!result.isEmpty()) {
        // Apply combined matrix to geometry box.
        // Note that we cannot simply rotate the fragment's worldBox here, because
        // this would sometimes result in an unnecessary large bbox.
        result.applyMatrix4(fullMatrix);
    }

    return result;
};

// Given a list of fragment ids and an addtional transform to be applied to each of those,
// this function computes the resulting bbox when applying fragment worldMatrix + given transform to each
// fragment geometry.
//
//  @param {Model}   model
//  @param {dbId}    dbId
//  @param {Matrix4} matrix
export const computeTransformedObjectBox = (model, dbId, matrix) => {

    const summedBox = new THREE.Box3();
    const tmpBox = new THREE.Box3();

    // For each fragment...
    const it = model.getInstanceTree();
    it.enumNodeFragments(dbId, (fragId) => {
        // add aligned box of this fragment
        const fragBox = getRotatedFragmentBox(model, fragId, matrix, tmpBox);
        summedBox.union(fragBox);
    });

    return summedBox;
};

// Computes for each object an alignment rotation with the goal that...
//  - x/y extent is minimized
//  - z-axis is preserved
//  - xExtent <= yExtent
export class RotationAlignment {

    // @param {Model[]}
    constructor(models) {

        // Index modely by modelId
        this.modelsById = [];
        models.forEach(m => this.modelsById[m.id] = m);

        // Caches of rotations and bboxes for rotated shapes
        this.rotations = []; // {Quaternion[][]}
        this.boxes = []; // {Box3[][]} - boxes of rotated fragments

        // Reused tmp matrix
        this.rotMatrix = new THREE.Matrix4();
    };

    // Store alignment rotation and bbox for a shape in cache
    _addToCache(modelId, dbId, rotation, bbox) {

        // Get or create arrays for cached rotations and boxes for this model
        let modelRotations = this.rotations[modelId];
        let modelBoxes = this.boxes[modelId];
        if (!this.rotations[modelId]) {
            // first rotation for this model => create new array
            modelRotations = [];
            modelBoxes = [];
            this.rotations[modelId] = modelRotations;
            this.boxes[modelId] = modelBoxes;
        }

        // store rotation and bbox in cache
        modelRotations[dbId] = rotation;
        modelBoxes[dbId] = bbox;
    }

    // Make sure that rotation and rotated box are in cache
    _computeAlignmentAndBox(modelId, dbId) {

        // Skip if already cached
        if (this._isInCache(modelId, dbId)) {
            return;
        }

        // compute Quaternion to align the shape
        const model = this.modelsById[modelId];
        const rotation = computeObjectAlignment(model, dbId);

        // compute bbox that we get after rotation
        this.rotMatrix.makeRotationFromQuaternion(rotation);
        const box = computeTransformedObjectBox(model, dbId, this.rotMatrix);

        // Store both for next time
        this._addToCache(modelId, dbId, rotation, box);

        return box;
    }

    // Check if alignment transform and bbox are already computed
    _isInCache(modelId, dbId) {
        const modelBoxes = this.boxes[modelId];
        return Boolean(modelBoxes && modelBoxes[dbId]);
    }

    // Get resulting bbox that a shape has - assuming that the alignment rotation was already applied.
    //
    // Note: We cannot simply transform the fragment world-box here, because this results in a larger
    //       bbox than transforming the geometry boxes directly to the rotated world position.
    getAlignedBox(shapeId, optionalTarget) {

        const {
            modelId,
            dbId
        } = shapeId;

        const result = optionalTarget || new THREE.Box3();

        // Make sure that box is in cache
        this._computeAlignmentAndBox(modelId, dbId);

        // Return box from cache
        const box = this.boxes[modelId][dbId];
        return result.copy(box);
    }

    // Returns the alignment rotation for a shape.
    // @param {ShapeId}      shapeId
    // @param {Quaternion}   [optionalTarget]
    // @returns {Quaternion}
    getShapeRotation(shapeId, optionalTarget) {

        const {
            modelId,
            dbId
        } = shapeId;

        const result = optionalTarget || new THREE.Quaternion();

        // Make sure that rotation is in cache
        this._computeAlignmentAndBox(modelId, dbId);

        // Return rotation from cache
        const rotation = this.rotations[modelId][dbId];
        return result.copy(rotation);
    }
};