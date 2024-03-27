//
// An algorithm to computes the placement (ClusterSetLayout) for a set of object clusters.
//

import {
    ClusterRowLayout,
    ClusterSetLayout
} from './ClusterLayout.js';


// Computes the x/y extent that we obtain when lining up all shapes in a single row. 
//
//  @param {bool} autoRotate - If true, we assume that each object is rotated in a way that sizeX <= sizeY.
const getRowExtent = (cluster, shapeBoxes, spacing, autoRotate) => {

    // Reused tmp vector
    let boxDiag = new THREE.Vector3();

    // Accumulated row width
    let rowSize = new THREE.Vector2();

    for (let i = 0; i < cluster.shapeIds.length; i++) {

        // get shape box diagonal
        let shapeId = cluster.shapeIds[i];
        boxDiag = shapeBoxes.getShapeSize(shapeId, boxDiag);

        // get width/height along row
        const shapeSizeX = autoRotate ? Math.min(boxDiag.x, boxDiag.y) : boxDiag.x;
        const shapeSizeY = autoRotate ? Math.max(boxDiag.x, boxDiag.y) : boxDiag.y;

        // sum up shape with along the row
        rowSize.x += shapeSizeX;

        // Track y-extent of row (determined by largest shape along y)
        rowSize.y = Math.max(rowSize.y, shapeSizeY);
        rowSize.z = Math.max(rowSize.z, boxDiag.z);
    }

    // consider spacing
    rowSize.x += (cluster.shapeIds.length - 1) * spacing;

    return rowSize;
};

// Given a list of bboxes, this function creates a ClusterLayout that stacks all items vertically.
//  @param {Cluster}    cluster
//  @param {ShapeBoxes} shapeBoxes
//  @param {number}     spacing
const createStack = (cluster, shapeBoxes, spacing) => {

    let shapeIds = cluster.shapeIds;

    let layout = new ClusterRowLayout(cluster);

    // Track position where to add next shape
    let zOffset = 0.0;

    // Reused tmp vector
    let boxSize = new THREE.Vector3();

    // Why backwards?: Shapes are ordered by increasing size. For stacking, it looks better to start with the largest.
    for (let i = shapeIds.length - 1; i >= 0; i--) {
        let shapeId = shapeIds[i];

        // Place shape i
        layout.positions[i] = new THREE.Vector3(0, 0, zOffset);

        // Size along the row is alway min(sizeX, sizeY)
        boxSize = shapeBoxes.getShapeSize(shapeId, boxSize);

        // Track layout size
        layout.size.x = Math.max(layout.size.x, boxSize.x);
        layout.size.y = Math.max(layout.size.y, boxSize.y);
        layout.size.z = zOffset + boxSize.y;

        // Step up to next stack level
        zOffset += boxSize.z + spacing;
    }
    return layout;
};

// Given a list of bboxes, this function creates a ClusterLayout that lines them up in one or more rows.
//  @param {Cluster}    cluster
//  @param {ShapeBoxes} shapeBoxes
//  @param {number}     rowWidth
//  @param {number}     spacing
//  @param {number}     autoRotate - If true, each shape is aligned so that sizeX <= sizeY
const createRows = (cluster, shapeBoxes, rowWidth, spacing, autoRotate) => {

    let shapeIds = cluster.shapeIds;

    let layout = new ClusterRowLayout(cluster);

    // Track position where to add next shape
    let nextPos = new THREE.Vector3(0, 0, 0);

    // Reused tmp vector
    let boxSize = new THREE.Vector3();

    // Track y-extent of current row
    let rowSizeY = 0;

    for (let i = 0; i < shapeIds.length; i++) {
        let shapeId = shapeIds[i];

        // Place shape i
        layout.positions[i] = nextPos.clone();

        // Size along the row is alway min(sizeX, sizeY)
        boxSize = shapeBoxes.getShapeSize(shapeId, boxSize);

        // If wanted, we orient all shapes so that sizeX < sizeY.
        layout.rotated[i] = autoRotate && (boxSize.x > boxSize.y);

        // get shapeSize in x/y - after rotating in a way that sizeX <= sizeY
        const shapeSizeX = autoRotate ? Math.min(boxSize.x, boxSize.y) : boxSize.x;
        const shapeSizeY = autoRotate ? Math.max(boxSize.x, boxSize.y) : boxSize.y;

        // Track y-extent of current row
        rowSizeY = Math.max(rowSizeY, shapeSizeY);

        // Track overall extent of the whole layout
        layout.size.x = Math.max(layout.size.x, nextPos.x + shapeSizeX);
        layout.size.y = Math.max(layout.size.y, nextPos.y + shapeSizeY); // 
        layout.size.z = Math.max(layout.size.z, boxSize.z); // max over all shape heights

        // Shift position along x to next new slot
        nextPos.x += shapeSizeX + spacing;

        // If width of current row reached the target row width...
        if (nextPos.x >= rowWidth) {
            // Start a new row
            nextPos.x = 0;
            nextPos.y += rowSizeY + spacing;
            rowSizeY = 0;
        }
    }

    return layout;
}

// Given a list of shapeIds, this function computes how these can be positioned in order to form a compact block.
//
//   @param {Cluster}    cluster    - Note: cluster.shapeIds within the claster will be sorted within this function.
//   @param {ShapeBoxes} shapeBoxes - to get shape sizes per shapeId
//   @param {bool}       autoRotate - Ensure sizeX <= sizeY for each shape by auto-rotating by 90 degree if necessary.
//   @returns {ClusterRowLayout}
const createClusterRowLayout = (cluster, shapeBoxes, spacing, autoRotate, enableStacking = true) => {

    // Sort shapes by increasing yExtent.
    //
    // When using autoRotate, we must consider that shapes will be xy-flipped, so that we
    // must sort by max{xExtent, yExtent} instead.
    //
    // Note: The autoRotate option will eventually be removed, because the rotationAlignment can already ensure xExtent <= yExtent,
    //       so that the layout algorithm can just assume it and always sort by y-extent only.
    let shapeIds = cluster.shapeIds;
    const byY = (a, b) => bySizeY(a, b, shapeBoxes);
    const byMaxXY = (a, b) => byMaxXYSize(a, b, shapeBoxes);
    const pred = autoRotate ? byMaxXY : byY;

    // Sort shapeIds
    shapeIds.sort(pred);

    // Compute x/y-extent that we would get when lining up all objects in a single row
    const singleRowSize = getRowExtent(cluster, shapeBoxes, spacing, autoRotate);

    // For simplicity and performance, the code below is just a heuristic: We neglect the fact 
    // that y-extents of rows may be varying. So, depending on the variance of y-extents
    // we may not get an actual squre. However, at least we usually avoid to odd aspect ratios.
    // 
    // We would like to choose the number of rows in a way that the cluster gets approximately squared.
    // Given n rows, we would approximately obtain a cluster for which...
    //  - sizeX = singleRowSizeX / numRows
    //  - sizeY = singleRowSizeY * numRows
    //
    // To get it approximately square, we choose so that 
    //    sizeX = sizeY
    //
    const numRows = Math.sqrt(singleRowSize.x / singleRowSize.y);
    const rowWidth = singleRowSize.x / numRows;

    const rows = createRows(cluster, shapeBoxes, rowWidth, spacing, autoRotate);

    // For large flat shapes (like floors/ceilings), it may be better to just stack them on top of each other.
    // So, we try stacking them as well.
    if (enableStacking) {
        const stack = createStack(cluster, shapeBoxes, spacing);

        // If the stack height is smaller than the horizonal extent, we use the stack.
        const useStack = (stack.size.z < Math.max(rows.size.x, rows.size.y));
        if (useStack) {
            return stack;
        }
    }

    return rows;
}

// Sort predicate to order objects by increasing y-extent
// Input:
//   @param {ShapeId}    a          - shapeID a
//   @param {ShapeId}    b          - shapeID b
//   @param {ShapeBoxes} shapeBoxes - shape sizes per shapeId
//
// Output: -1, if the max extent of object a is greater than of object b
//          1, otherwise
const bySizeY = (a, b, shapeBoxes) => {

    // Get bbox extents
    const diagA = shapeBoxes.getShapeSize(a);
    const diagB = shapeBoxes.getShapeSize(b);

    // If y-extent is different, use it
    if (diagA.y != diagB.y) {
        return diagA.y - diagB.y;
    }

    // Among shapes with equal y-extent, sort by increasing x-extent
    if (diagA.x != diagB.x) {
        return diagA.x - diagB.x;
    }

    return 0;
};


// Sort predicate to order objects by increasing maxXYExtent (=max(xExtent, yExtent)). 
// Input:
//   @param {ShapeId}    a          - shapeID a
//   @param {ShapeId}    b          - shapeID b
//   @param {ShapeBoxes} shapeBoxes - shape sizes per shapeId
//
// Output: -1, if the max extent of object a is greater than of object b
//          1, otherwise
const byMaxXYSize = (a, b, shapeBoxes) => {

    // Get bbox extents
    const diagA = shapeBoxes.getShapeSize(a);
    const diagB = shapeBoxes.getShapeSize(b);

    // Sort based on the max axis extent.
    const sizeA = Math.max(diagA.x, diagA.y);
    const sizeB = Math.max(diagB.x, diagB.y);
    if (sizeA < sizeB) {
        return -1;
    } else if (sizeA > sizeB) {
        return 1;
    }

    // If max-entents are equal, sort by minExtent
    const minExtA = Math.min(diagA.x, diagA.y);
    const minExtB = Math.min(diagB.x, diagB.y);
    if (minExtA > minExtB) {
        return -1;
    } else if (minExtA < minExtB) {
        return 1;
    }

    // If min/max extents are both equal, just sort by id for consistency
    return b - a;
};

// Given a set of individual ClusterRowLayouts, this function sets their positions, so that clusters are lined up in a grid or stack as well.
//
//  @param {ClusterRowLayout[]} layouts
//  @param {number}             clusterSpacing - Minimum distance between two clusters
//  @param {Box3}               sceneBox       - bbox of the full scene (without anim transforms)
const setClusterPositions = (layouts, clusterSpacing, sceneBox) => {

    // For placing the clusters, we use the same code that we used for arranging the shapes within
    // the cluster. 
    //
    // Only difference is that the shapes to be placed are actually clusters instead of shapes.

    const parentCluster = {
        // In this case, shapeIds are just indices into the layouts array
        shapeIds: new Int32Array(layouts.length)
    };

    // Enlist all cluster indices 0, 1, ..., layouts.length-1.
    for (let i = 0; i < layouts.length; i++) {
        parentCluster.shapeIds[i] = i;
    }

    // ShapeBoxes access when using clusters as shapes.
    const clusterBoxes = {
        // Return cluster size
        getShapeSize: (shapeId, target) => {
            target = target || new THREE.Vector3();
            const layout = layouts[shapeId];
            target.copy(layout.size);
            return target;
        }
    };

    // We only align single shapes, but don't rotate clusters. Note that the aspect ratio 
    const autoRotate = false;

    // Run layout to place the clusters
    const enableStacking = false; // We only use stacking inside clusters. But the clusters themselves are always layouted horizontally.
    const parentLayout = createClusterRowLayout(parentCluster, clusterBoxes, clusterSpacing, autoRotate, enableStacking);

    // Parent cluster should be horizonally centered at the scene midpoint
    let origin = sceneBox.getCenter(new THREE.Vector3());

    origin.x -= 0.5 * parentLayout.size.x;

    // Start the flea-market behind the actual building
    origin.y = sceneBox.min.y + 1.1 * (sceneBox.max.y - sceneBox.min.y);

    // Copy positions from parent clusterLayout to the individual cluster positions
    for (let i = 0; i < parentCluster.shapeIds.length; i++) {
        // get position for next cluster
        const clusterPos = parentLayout.positions[i];

        // Find the corresponding cluster
        const clusterIndex = parentCluster.shapeIds[i];
        const layout = layouts[clusterIndex]; // Note that shapeIds is reordered during layout process. So we cannot assume shapeIds[i]==i anymore

        // set cluster position
        layout.position.copy(clusterPos).add(origin);
    }
}

const getDefaultOptions = () => {
    return {
        // minimum distance between two shapes within a group
        spacing: 1.0,

        // minimum distance between different groups
        clusterSpacing: 10.0,

        // If true, we stack clusters vertically - otherwise, we line up along x/y
        stackClusters: true
    }
};

// Computes a ClusterSetLayout from a set of object clusters.
//
// @param {Cluster[]}         layouts    - Each shape group is given by an array of shapeIds
// @param {ShapeBoxes}        shapeBoxes - Provides bboxes per shape
// @param {RotationAlignment} [rotationAlignment] - Defines rotations per shape (optional)
// @param {Object}            options    - configuration params (see getDefaultOptions)
// @returns {ClusterSetLayout}
const createClusterSetLayout = (clusters, shapeBoxes, rotationAlignment, options = getDefaultOptions()) => {

    // When using pre-rotated shapes, the algorithm doesn't need to flipXY for items anymore.
    const enableXYFlip = !rotationAlignment;

    // Create layout for each cluster
    const layouts = clusters.map(c => createClusterRowLayout(c, shapeBoxes, options.spacing, enableXYFlip));

    // Based on layouts and known cluster sizes, determine the placement of each cluster
    //setClusterPositions(layouts, shapeBoxes, options.stackClusters, options.clusterSpacing);
    setClusterPositions(layouts, options.clusterSpacing, shapeBoxes.sceneBox);

    return new ClusterSetLayout(layouts, rotationAlignment);
};

export {
    createClusterSetLayout
}