import {
    ObjectAnimState,
    SceneAnimState
} from './AnimState.js';
import ShapeBoxes from './ShapeBoxes.js';


const tmpBox = new THREE.Box3();

// Rotate an item by 90 degrees to make sure that width >= height. 
// This is done in a way that the box minPoint keeps the same.
// 
// Note: Rotations using animTransform rotate around the world origin
//
// @param {THREE.Box3}      box - Original worldBox of a shape (without any animTransform applied)
// @param {ObjectAnimState} dst - animState on which we set the rotation
const applyAlignmentTransform = (box, dst) => {

    // rotate by 90 degrees
    let angle = 90;
    let axis = new THREE.Vector3(0, 0, 1);
    dst.rot.setFromAxisAngle(axis, THREE.Math.degToRad(angle));

    // Rotations work around the world origin.
    // Now, we modify the move vector to make sure that the bbox keeps the same

    // get rotation as matrix
    let rotTf = new THREE.Matrix4().makeRotationFromQuaternion(dst.rot);

    // get box after rotation
    const box2 = tmpBox.copy(box).applyMatrix4(rotTf);

    // modify move vector to obtain the same box minPoint as before rotation
    // Note that box2.min is not simply the same as we would get when rotating the point box.min. 
    dst.move.sub(box2.min).add(box.min);
};

// A ClusterRowLayout defines how to line up a group of objects along one or more rows.
class ClusterRowLayout {

    constructor(cluster) {

        // MinPoint of the whole cluster.
        this.position = new THREE.Vector3(0, 0, 0);

        // {Cluster} - The cluster defining the object that this layout refers to
        this.cluster = cluster;

        // For each dbId cluster.shapeIds[i], positions[i] defines the corresponding position.
        // Each object is anchored at the bbox minPoint.
        this.positions = []; // Vector3[]

        // If rotated[i] is true, the shape with id clusterShapeIds[i] will be rotated by 90 degree around z, 
        // so that x/y are swapped - while preserving the bbox minPoint.
        this.rotated = []; // bool[]

        // Spatial extent of this cluster.
        this.size = new THREE.Vector3(0, 0, 0);
    }

    getBBox(optionalTarget) {
        let target = optionalTarget || new THREE.Box3();
        target.min.copy(this.position);
        target.max.copy(this.position).add(this.size);
        return target;
    }

    // Modifies the given scene anim state so that all objects in the cluster are properly placed and rotated.
    //
    //  @param {SceneAnimState} sceneAnimState - SceneAnimState to be modified.
    //  @param {Vector3}        offset         - Additional translation offset applied to all objects
    //  @param {ShapeBoxes}     shapeBoxes     - access to shape bboxes
    //  @param {RotationAlignment} [rotationAlignment] - Optional: Defines rotations that are applied per shape.
    apply(sceneAnimState, offset, shapeBoxes, rotationAlignment) {

        // reused tmp-vector
        const targetPos = new THREE.Vector3();

        // Reused below
        const tmpBox = new THREE.Box3();
        const tmpVec = new THREE.Vector3();

        for (let i = 0; i < this.cluster.shapeIds.length; i++) {

            // get shapeId
            let shapeId = this.cluster.shapeIds[i];

            // init itemPlacement for this shape
            const animState = new ObjectAnimState(shapeId.dbId);

            // get final position of this shape: 
            targetPos.copy(this.positions[i]) // position of the shape within the cluster
                .add(this.position) // position of this cluster within the cluster set
                .add(offset); // cluster set position

            // get original shape minPoint
            let originalBox = shapeBoxes.getShapeBox(shapeId, tmpBox);
            const originalPos = originalBox.min;

            // Set move-vector so that originalPos is moved to targePos
            animState.move.subVectors(targetPos, originalPos);

            if (rotationAlignment) {
                // Apply rotation
                rotationAlignment.getShapeRotation(shapeId, animState.rot);

                // Set original shape box center as rotation anchor
                const shapeBox = shapeBoxes.getUnrotatedShapeBox(shapeId, tmpBox);
                const center = shapeBox.getCenter(tmpVec);
                animState.setRotationCenter(center, true);
            }

            // If needed, apply rotation while keeping bbox.min the same.
            // Note: When using RotationAlignments, the auto-flip is not needed anymore.
            //       So, this code path will be removed as soon as the new variant is sufficiently tested.
            const needsRotate = this.rotated[i];
            if (needsRotate) {

                // get shape bbox
                originalBox = shapeBoxes.getShapeBox(shapeId, originalBox);

                // apply rotation
                applyAlignmentTransform(originalBox, animState);
            }

            // Add object anim state to scene anim state
            sceneAnimState.setAnimState(shapeId.modelId, shapeId.dbId, animState);
        }
    }
}

// Defines the placement for a set of object clusters
class ClusterSetLayout {

    // @param {ClusterLayout}     layouts
    // @param {RotationAlignment} [rotationAlignment] - only needed if shapes are rotated for alignment.
    constructor(layouts, rotationAlignment) {

        // ClusterSet position. ClusterSets are anchored at the minPoint
        this.position = new THREE.Vector3(0, 0, 0);

        // {ClusterLayout[]}
        this.clusterLayouts = layouts || [];

        // {RotationAlignment}
        this.rotationAlignment = rotationAlignment;
    }

    // Modifies the given scene anim state so that all objects in all cluster are properly placed and rotated.
    //
    //  @param {SceneAnimState} sceneAnimState - SceneAnimState to be modified.
    //  @param {ShapeBoxes}     shapeBoxes     - access to shape bboxes
    apply(sceneAnimState, shapeBoxes) {
        this.clusterLayouts.forEach(l => l.apply(sceneAnimState, this.position, shapeBoxes, this.rotationAlignment));
    }

    // Creates a SceneAnimState that brings all shapes to their target positions
    createSceneState(models) {
        let shapeBoxes = new ShapeBoxes(models, this.rotationAlignment);
        let state = new SceneAnimState(models);
        this.apply(state, shapeBoxes);
        return state;
    }
}

export {
    ShapeBoxes,
    ClusterRowLayout,
    ClusterSetLayout
};