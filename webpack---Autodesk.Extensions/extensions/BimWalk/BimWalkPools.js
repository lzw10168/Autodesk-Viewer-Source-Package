// Extension made lot of vector operations,
// temporal vectors are created to not generate much garbage to be collected.

var temporalVectorSize = 128;
var temporalVectors = [];
var temporalVectorsIndex = 0;
var zero = {
    x: 0,
    y: 0,
    z: 0
};

/**
 * Gets a vector initialized with values or source using a simple pool of temporal intermediate math results objects.
 * Idea is to not make trash for garbage collection.
 * @param source
 * @returns {THREE.Vector3}
 */
export function getTempVector(source) {

    // Initialize temporal vectors.
    for (var i = temporalVectors.length; i < temporalVectorSize; ++i) {
        temporalVectors.push(new THREE.Vector3());
    }

    source = source || zero;

    if (temporalVectorsIndex < temporalVectorSize) {
        return temporalVectors[temporalVectorsIndex++].copy(source);
    }

    Autodesk.Viewing.Private.logger.warn('Vector pool in Autodesk.Viewing.Extensions.BimWalk reached maximum size');
    return new THREE.Vector3().copy(source);
}

/**
 * Free vectors acquired from the pool with getTempVector.
 * @param vector
 */
export function freeTempVectors() {

    temporalVectorsIndex = 0;
}