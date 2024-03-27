const getSummedModelBox = (models) => {
    let bbox = new THREE.Box3();
    for (let i = 0; i < models.length; i++) {
        const modelBox = models[i].getBoundingBox();
        bbox.union(modelBox);
    }
    return bbox;
};

// Helper class to faciliate access to shape bboxes across multiple models
export default class ShapeBoxes {

    // @param {bool} [rotationAlignment] - If specified, we don't return the original fragment boxes. Instead, we return the boxes obtained
    //                                     assuming that an alignment rotation has been applied to each shape. (see RotationAlignment.js for details)
    constructor(models, rotationAlignment) {

        // Index modely by modelId
        this.modelsById = [];
        models.forEach(m => this.modelsById[m.id] = m);

        // reused for bbox access
        this.tmpFloat6 = new Float32Array(6);
        this.tmpBox = new THREE.Box3();

        // Compute summed scene box. Note that sceneBox is always the original scene bbox - not considering alignment rotations per object.
        this.sceneBox = getSummedModelBox(models);

        // {RotationAlignment}
        this.rotationAlignment = rotationAlignment;
    }

    // Return shapeBox that we obtain when not applying any rotationAlignment.
    // @param {ShapeId} shapeId
    // @param {Box3}    [optionalTarget]
    getUnrotatedShapeBox(shapeId, optionalTarget) {
        const box = optionalTarget || new THREE.Box3();

        const {
            modelId,
            dbId
        } = shapeId;

        // get instanceTree
        const model = this.modelsById[modelId];
        const it = model.getInstanceTree();

        // get box as 6 floats in tmpArray
        it.getNodeBox(dbId, this.tmpFloat6);

        // convert to Box3
        const values = this.tmpFloat6;
        box.min.set(values[0], values[1], values[2]);
        box.max.set(values[3], values[4], values[5]);

        return box;
    }

    // @param {ShapeId} shapeId
    // @param {Box3}    [optionalTarget]
    getShapeBox(shapeId, optionalTarget) {

        // If shapes are rotated, we must return the bboxes of the rotated shapes instead
        // of the original fragment boxes.
        // It would be nice if AlignmentRotation could simply provide only the rotations and ShapeBoxes
        // apply them to the fragment boxes. Unfortunately, this would not work, because it would unnecessarily 
        // increase the bbox sizes. So, RotationAlignment has to provide own bboxes that are computed by transforming the geometry boxes directly.
        if (this.rotationAlignment) {
            return this.rotationAlignment.getAlignedBox(shapeId, optionalTarget);
        }

        // No rotation applied - just use original boxes.
        return this.getUnrotatedShapeBox(shapeId, optionalTarget);
    }

    // get shape box diagonal from a given ShapeId
    getShapeSize(shapeId, optionalTarget) {
        const target = optionalTarget || new THREE.Vector3();

        const box = this.getShapeBox(shapeId, this.tmpBox);

        // For empty boxes, the diagonal contains -infinity - which isn't helpful for layouting.
        // So, we return zero extent for this case.
        if (box.isEmpty()) {
            target.set(0, 0, 0);
        } else {
            box.getSize(target);
        }
        return target;
    }
}