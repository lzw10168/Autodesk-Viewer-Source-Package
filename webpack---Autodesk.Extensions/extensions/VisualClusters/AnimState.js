// Contains classes to control the animation state of animation for objects of one or more models.

const tmpMatrix = new THREE.Matrix4();
const tmpVec1 = new THREE.Vector3();

// Get translation offset that is needed to make the given
// point center of the rotation.
//  @param {Quaternion} rotation
//  @param {Vector3}    center
//  @param {Vecotr3}    [optionalTarget]
//  @returns {THREE.Vector3}
const getRotationOffset = (rotation, center, optionalTarget) => {

    const result = optionalTarget || new THREE.Vector3();

    // get rotation as matrix
    let rotMatrix = tmpMatrix.makeRotationFromQuaternion(rotation);

    // Compute where center would be moved when just applying rotation alone
    const p = center.clone().applyMatrix4(rotMatrix);

    // Return correction offset to bring center back at its original position
    return result.copy(center).sub(p);
};

// Describes an animation transform to be applied to single object. 
// Note that placement is relative to original position, i.e., identity means shape appears at original position.
export class ObjectAnimState {

    constructor(dbId) {

        // id of the object being animated
        this.dbId = dbId;

        // translation
        this.move = new THREE.Vector3(0, 0, 0);

        // scale
        this.scale = new THREE.Vector3(1, 1, 1);

        // rotation (as Quaternion)
        //
        // Note: Note that fragment animTransforms always rotate around the world origin, 
        //       because the original matrix is applied first.
        this.rot = new THREE.Quaternion();

        // By default, fragment rotations in LMV rotate around the world-origin.
        this.rotCenter = new THREE.Vector3(0, 0, 0);
    }

    apply(model) {

        const fragList = model.getFragmentList();
        const it = model.getInstanceTree();

        // Apply additional correction offset when rotating around a center != origin.
        // Note that rotations set by updateAnimTransform always rotate around world origin.
        const move = getRotationOffset(this.rot, this.rotCenter, tmpVec1).add(this.move);

        // Update fragment animation transforms
        it.enumNodeFragments(this.dbId, fragId => {
            fragList.updateAnimTransform(fragId, this.scale, this.rot, move);
        });
    }

    // Set this placement by interpolating between a start and end placement
    //  @param {ItemPlacement} start, end - If null, we assume identity transform.
    //  @param {number}        t          - interpolation param in [0,1]
    lerp(start, end, t) {

        // use identiy transform if start or end is missing
        start = start || ObjectAnimState.Identity;
        end = end || ObjectAnimState.Identity;

        // Interpolate move/scale/rotation
        this.move.lerpVectors(start.move, end.move, t);
        this.scale.lerpVectors(start.scale, end.scale, t);
        this.rotCenter.lerpVectors(start.rotCenter, end.rotCenter, t);
        this.rot.slerpQuaternions(start.rot, end.rot, t);
    }

    copyFrom(src) {
        this.dbId = src.dbId;
        this.move.copy(src.move);
        this.scale.copy(src.scale);
        this.rot.copy(src.rot);
        this.rotCenter.copy(src.rotCenter);
    }

    resetTransform() {
        this.move.set(0, 0, 0);
        this.scale.set(1, 1, 1);
        this.rot.set(0, 0, 0, 1); // = identity Quaternion
        this.rotCenter.set(0, 0, 0);
    }

    // Set rotation center. 
    // @param {Vector3} center
    // @param {bool}    ajdustMove - If true, the move vector is changed so that the effect of the AnimState keeps the same.
    setRotationCenter(newCenter, adjustMove) {

        // Adjust translation offset to keep position
        if (adjustMove) {

            // Compute the shift that the shape position would do without move adjustment.
            // This could be optimized by avoiding double-computation of the rotation matrix.
            const oldOffset = getRotationOffset(this.rot, this.rotCenter);
            const newOffset = getRotationOffset(this.rot, newCenter);

            // Modify translation to eliminate the position shift
            this.move.add(oldOffset).sub(newOffset);
        }

        // Change rotationCenter
        this.rotCenter.copy(newCenter);
    }
}

// Represents the original state of an object when no anim transform is applied.
ObjectAnimState.Identity = new ObjectAnimState(-1);

// Describes animation transforms for a set of objects within the same RenderModel
export class ModelAnimState {

    constructor(model) {

        this.model = model;

        // Indexed by dbId.
        this.animStates = []; // ObjectAnimState[]
    }

    apply() {
        for (var dbId in this.animStates) {
            this.animStates[dbId].apply(this.model);
        }

        // Make sure that hierarchical bboxes are updated
        this.model.visibleBoundsDirty = true;
    }

    // Finds or creates an animState for the given dbId.
    //  @param {number}          dbId
    //  @param {ObjectAnimState} animState
    setAnimState(dbId, animState) {
        this.animStates[dbId] = animState;
    }

    getAnimState(dbId, createIfMissing = false) {

        let animState = this.animStates[dbId];

        // Create new one if needed
        if (!animState && createIfMissing) {
            animState = new ObjectAnimState(dbId);
            this.setAnimState(dbId, animState);
        }

        return animState;
    }

    // Adds new ObjectAnimStates for all dbIds in srcState.
    //
    // This is important if you use this to interpolate between other ModelStates and want to make sure that this ModelState
    // affects all dbIds that are affected either by startState or endState.
    //
    // @param {ModelAnimState} srcState
    createObjctAnimStates(srcState) {
        for (let key in srcState.animStates) {

            // Note that key is the dbId as string. 
            // => Use the integer variant from srcState instead.
            const dbId = srcState.animStates[key].dbId;

            // Make sure that we have an ObjectAnimState for this dbId
            this.getAnimState(dbId, true);
        }
    }

    // Prepares this ModelState to interpolate between two others:
    // For this, we make sure that this ModelState affects all dbIds that are modified by either start or end.
    prepareLerp(start, end) {
        this.createObjectAnimStates(start);
        this.createObjectAnimStates(end);
    }

    // Updates all ObjectAnimStates by interpolating between a start and end anim state.
    //
    // Note: This only affects the existing ObjectAnimStates within this ModelAnimState.
    //       It does NOT create new AnimStates. See prepareLerp()
    // 
    //  @param {ModelAnimState} start, end - may be null (= original state)
    //  @param {number}         t          - interpolation param in [0,1]
    lerp(start, end, t) {
        for (let dbId in this.animStates) {
            const objStart = start && start.animStates[dbId];
            const objEnd = end && end.animStates[dbId];
            this.animStates[dbId].lerp(objStart, objEnd, t);
        }
    }

    copyFrom(src) {

        this.model = src.model;

        // Make sure that we set the same ObjectAnimStates as src.
        // Avoid re-allocations if possible.
        for (let dbId in src.animStates) {
            // get or create state
            const srcObj = src.animStates[dbId];
            const dstObj = this.getAnimState(dbId, true);
            dstObj.copyFrom(srcObj);
        }

        // Clean all object animStates that src doesn't have
        for (let dbId in this.animStates) {
            if (!src.animStates[dbId]) {
                delete this.animStates[dbId];
            }
        }
    }

    // Reset anim transforms for all fragments that were modified by this state
    resetTransforms() {
        for (let dbId in this.animStates) {
            this.animStates[dbId].resetTransform();
        }
    }
}

// Describes animations for several objects within a scene composed from multiple models.
export class SceneAnimState {

    constructor(models) {

        // ModelAnimState[] - indexed by modelId
        this.animStates = [];

        // Create a model placement for each model, indexed by modelId
        models && models.forEach(m => this.animStates[m.id] = new ModelAnimState(m));
    }

    apply(viewer) {
        // Apply all model anim states
        for (let modelId in this.animStates) {
            this.animStates[modelId].apply();
        }

        // Force re-render
        viewer.impl.invalidate(true, true, true);
    }

    // Set animation state for a single object
    // Note that modelId must be the id of one of the models used for construction
    setAnimState(modelId, dbId, animState) {
        this.animStates[modelId].setAnimState(dbId, animState);
    }

    // Adds new ObjectAnimStates for all dbIds in srcState.
    // see ModelAnimState.createObjectAnimStates for details.
    //
    // @param {ModelAnimState} srcState
    createObjectAnimStates(srcState) {
        for (let modelId in srcState.animStates) {
            // get src ModelAnimState
            const src = srcState.animStates[modelId];

            // Get or create target ModelState for this model
            let dst = this.animStates[modelId];
            if (!dst) {
                dst = new ModelAnimState(src.model);
                this.animStates[modelId] = dst;
            }

            // Make sure that this ModelState operates on the same dbIds as src
            dst.createObjctAnimStates(src);
        }
    }

    // Prepares this SceneAnimState to interpolate between two others:
    // For this, we make sure that this SceneAnimState affects all dbIds that are modified by either start or end.
    //  @param {SceneAnimState} start, end
    prepareLerp(start, end) {
        this.createObjctAnimStates(start);
        this.createObjctAnimStates(end);
    }

    // Set this placement by interpolating between a start and end placement
    // Note:
    //  - All placements must refer to the same list of models
    //  - For each model, all placements must enlist the same dbIds
    // 
    //  @param {ScenePlacement} start, end
    //  @param {number}         t          - interpolation param in [0,1]
    lerp(start, end, t) {
        for (let modelId in this.animStates) {
            const modelStart = start && start.animStates[modelId];
            const modelEnd = end && end.animStates[modelId];
            this.animStates[modelId].lerp(modelStart, modelEnd, t);
        }
    }

    // Makes this SceneState equal to the src state.
    copyFrom(srcState) {

        for (let modelId in srcState.animStates) {
            const src = srcState.animStates[modelId];
            let dst = this.animStates[modelId];

            // In case we don't have a ModelState for this model, create one
            if (!dst) {
                dst = new ModelAnimState(src.model);
                this.animStates[modelId] = dst;
            }

            dst.copyFrom(src);
        }

        // Erase any modelState that src doesn't have
        for (let modelId in this.animStates) {
            if (!srcState.animStates[modelId]) {
                delete this.animStates[modelId];
            }
        }
    }

    // Reset anim transforms for all fragments that were modified by this state
    resetTransforms() {
        for (let modelId in this.animStates) {
            this.animStates[modelId].resetTransforms();
        }
    }
}