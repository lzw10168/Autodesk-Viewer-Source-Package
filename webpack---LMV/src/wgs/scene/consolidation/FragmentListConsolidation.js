import {
    ConsolidationBuilder
} from "./Consolidation";
import {
    InstanceBufferBuilder
} from "./InstanceBufferBuilder";
import {
    MATERIAL_VARIANT
} from "../../render/MaterialManager";
import * as THREE from "three";
import {
    CONSOLIDATION_MEMORY_LIMIT
} from "../../globals";

/**
 * This file contains code to create a Consolidation (see Consolidation.js) from all fraqments of a FragmentList.
 * Rendering the consolidation instead of the individual fragments can improve rendering performance
 * for models containing a large number of small objects.
 */


/**
 *  Creates a consolidated representation for a given list of fragment ids. Consolidation is only done for the
 *  first n elements of the fragIds array, where n is chosen in a way that we stop if a given memory cost limit is reached.
 *
 *  Consolidation is done here by merging fragment Geometries into larger vertex buffers. If multiple fragments share
 *  the same geometry, the geometry is replicated. Therefore, this step is only used for the smaller fragments
 *  with not too many instances.
 *
 *   @param {FragmentList}    fragList
 *   @param {MaterialManager} materials
 *   @param {Int32Array[]}    fragIds
 *   @param {number}          limitInBytes
 *
 *   @returns {Object} Result object containing...
 *                      result.consolidation: Instance of Consolidation
 *                      result.fragIdCount:   Defines a range within fragIds:
 *                                            Only fragIds[0], ... , fragIds[result.fragIdCount-1] were consolidated.
 */
function createConsolidationMap(fragList, materials, fragIds, limitInBytes) {

    // reused in loop below
    var fragBox = new THREE.Box3();

    var mc = new ConsolidationBuilder();
    var i = 0;
    for (; i < fragIds.length; i++) {

        // stop if we reached our memory limit.
        if (mc.costs >= limitInBytes) {
            break;
        }

        // get fragId and world box
        var fragId = fragIds[i];
        fragList.getWorldBounds(fragId, fragBox);

        // add mesh to consolidation
        var geometry = fragList.getGeometry(fragId);
        var material = fragList.getMaterial(fragId);
        mc.addGeom(geometry, material, fragBox, fragId);
    }

    // create ConsolidationMap
    return mc.createConsolidationMap(fragIds, i);
}

/**
 * Combines a sequence of fragments with shared geometry and material into an instanced mesh.
 * This instanced mesh is added to 'result'.
 *
 * For fragments that cannot be instanced, we add an individual mesh instead that shares
 * original geometry and material. This happens if:
 *
 *  a) The is just a single instance (range length 1)
 *  b) The instance has a matrix that cannot be decomposed into pos/scale/rotation.
 *
 *  @param {FragmentList}    fragList
 *  @param {MaterialManager} materials  - needed to create new materials for instanced shapes
 *  @param {Int32Array}      fragIds
 *  @param {number}          rangeStart - defines a range within the fragIds array
 *  @param {number}          rangeEnd
 *  @param {Consolidation}   result     - collects the resulting mesh.
 */
var applyInstancingToRange = (function() {

    var _tempMatrix = null;

    return function(model, materials, fragIds, rangeStart, rangeEnd, result) {

        var fragList = model.getFragmentList();

        // init temp matrix
        if (!_tempMatrix) {
            _tempMatrix = new THREE.Matrix4();
        }

        var firstFrag = fragIds[rangeStart];

        // get geometry and material (must be the same for all frags in the range)
        var geom = fragList.getGeometry(firstFrag);
        var mat = fragList.getMaterial(firstFrag);

        // just a single instance? => add it directly
        var rangeLength = rangeEnd - rangeStart;
        if (rangeLength == 1) {
            result.addSingleFragment(fragList, firstFrag);
            return;
        }
        var lastIndex = rangeEnd - 1;

        // create instanced geometry from geom and all transforms
        var builder = new InstanceBufferBuilder(geom, rangeLength);
        for (var i = rangeStart; i <= lastIndex; i++) {

            var fragId = fragIds[i];

            // world matrix and dbId
            fragList.getOriginalWorldMatrix(fragId, _tempMatrix);
            var dbId = fragList.fragments.fragId2dbId[fragId];

            // try to process as instanced mesh
            var valid = builder.addInstance(_tempMatrix, dbId);

            // If adding this instance failed, its matrix did not allow to
            // be represented as pos/rotation/scale. In this case, add
            // the mesh individually.
            if (!valid) {
                // Swap last and current. This keeps all of the fragments
                // in the instanced buffer together.
                var tmp = fragIds[lastIndex];
                fragIds[lastIndex] = fragId;
                fragIds[i] = tmp;
                --i;
                --lastIndex;
            }
        }

        var instGeom = builder.finish();

        // instGeom might be null if all instances had matrices that could not be decomposed.
        // In this case, all frags have been skipped and will be added individually below
        if (instGeom) {

            // create instancing material
            var instMat = materials.getMaterialVariant(mat, MATERIAL_VARIANT.INSTANCED, model);

            // add instanced mesh
            result.addContainerMesh(instGeom, instMat, fragIds, rangeStart, rangeLength);
            // Set start of fragment id range.
            result.meshes[result.meshes.length - 1].rangeStart = rangeStart;
        }

        // if we had to skip any fragment, add it separately. Note that this must be done after
        // adding the container, so that fragId2MeshIndex finally refers to the individual geometry.
        for (i = lastIndex + 1; i < rangeEnd; i++) {
            fragId = fragIds[i];
            result.addSingleFragment(fragList, fragId);
        }
    };
}());

/**
 * Combines fragments with shared geometries into instanced meshes. Note that creating instanced meshes
 * only makes sense for fragments that share geometry and material. All other fragments will also be
 * added to the result, but the meshes will share original geometry and material.
 *
 * Requirement: fragIds must already be sorted in a way that meshes with identical geometry and material form
 *              a contiguous range.
 *
 * @param {RenderModel}   model
 * @param {MaterialManager} materials
 * @param {Int32Array}     fragIds
 * @param [number}         startIndex - Defines the range in fragIds that we process:
 *                                      fragIds[startIndex], ..., fragIds[fragIds.length-1]
 * @param {Consolidation} result      - collects all output meshes
 */
function applyInstancing(model, materials, fragIds, startIndex, result) {

    var fragList = model.getFragmentList();

    if (startIndex >= fragIds.length) {
        // range empty
        // This may happen if we could consolidate all fragments per mesh merging already, so
        // that instancing is not needed anymore.
        return;
    }

    // track ranges of equal geometry and material
    var rangeStart = startIndex;
    var lastGeomId = -1;
    var lastMatId = -1;

    for (var i = startIndex; i < fragIds.length; i++) {
        var fragId = fragIds[i];
        var geomId = fragList.getGeometryId(fragId);
        var matId = fragList.getMaterialId(fragId);

        // check if a new range starts here
        if (geomId != lastGeomId || matId != lastMatId) {

            // a new range starts at index i
            // => process previous range [rangeStart, ..., i-1]
            if (i != startIndex) {
                applyInstancingToRange(model, materials, fragIds, rangeStart, i, result);
            }

            // start new range
            rangeStart = i;
            lastGeomId = geomId;
            lastMatId = matId;
        }
    }
    // process final range
    applyInstancingToRange(model, materials, fragIds, rangeStart, fragIds.length, result);
}

/**
 * Returns an array that enumerates all fragIds in a way that...
 *
 *  1. They are ordered by increasing memory costs that it takes to consolidate them.
 *  2. FragIds with equal geometry and material form a contiguous range.
 *
 *   @param {FragmentList} fragList
 *   @param {GeometryList} geomList
 *   @returns {Int32Array} ordered list of fragment ids
 */
function sortByConsolidationCosts(fragList, geomList) {

    // define sort predicate
    function fragCompare(fragId1, fragId2) {

        // compute consolidation costs of both fragments
        var geom1 = fragList.getGeometry(fragId1);
        var geom2 = fragList.getGeometry(fragId2);
        var geomId1 = fragList.getGeometryId(fragId1);
        var geomId2 = fragList.getGeometryId(fragId2);
        var instCount1 = geomList.getInstanceCount(geomId1);
        var instCount2 = geomList.getInstanceCount(geomId2);
        var memCost1 = instCount1 * geom1.byteSize;
        var memCost2 = instCount2 * geom2.byteSize;

        // 1. memCost
        if (memCost1 != memCost2) {
            return memCost1 - memCost2;
        }

        // 2. geom id
        if (geom1.id != geom2.id) {
            return geom1.id - geom2.id;
        }

        // 3. material id
        var mat1 = fragList.getMaterialId(fragId1);
        var mat2 = fragList.getMaterialId(fragId2);
        return mat1 - mat2;
    }

    // a single missing geometry shouldn't make the whole consolidation fail.
    // therefore, we exclude any null-geometry fragemnts.
    var validFrags = 0;

    // create fragId array [0,1,2,...]
    var fragCount = fragList.getCount();
    var fragIds = new Int32Array(fragCount);
    for (var i = 0; i < fragCount; i++) {

        // exclude fragments without valid geometry
        if (!fragList.hasGeometry(i)) {
            continue;
        }

        fragIds[validFrags] = i;
        validFrags++;
    }

    // resize array if we had to skip fragments
    if (validFrags < fragCount) {
        fragIds = new Int32Array(fragIds.buffer, fragIds.byteOffset, validFrags);
    }

    // sort by costs
    fragIds.sort(fragCompare);

    return fragIds;
}

/**
 *  Creates a consolidated representation of a fragments. For each fragment f, there will be a mesh in the result that
 *  contains it - or shares its geometry if was not mergeable with any other fragment.
 *
 *   @param {RenderModel}     model
 *   @param {MaterialManager} materials           - needed to create new material variants for consolidated/instanced meshes
 *   @param {number}          [byteLimit]         - Restricts the amount of memory that we spend in mesh consolidation.
 *                                                  Note that without this limit, consolidation may consume several times more memory
 *                                                  than the original model itself, because shared geometries must be replicated.
 *   @param {boolean}         [useDeferredConsolidation] - Optional: If true, consolidation will only compute some initial data 
 *                                                       and leave the actual data crunching to the first time a consolidated
 *                                                       mesh needs to get rendered. Note: the intent is to verify the proper
 *                                                       function of this option and make it the only implementation then.
 *   @param {FireFlyWebGLRenderer} glRenderer
 *   @param {ConsolidationMap} [consMap]          - Optional: If available, the intermediate results can be reused from a previous
 *                                                  consolidation to accelerate preprocessing. Note that a ConsolidationMap
 *                                                  can only be reused if the FragmentList is exactly the same. *
 *   @returns {Consolidation}
 */
export function consolidateFragmentList(model, materials, byteLimit, useDeferredConsolidation, glRenderer, consMap) {
    const fragList = model.getFragmentList();
    const geomList = model.getGeometryList();

    // by default, restrict extra memory consumption to a preset
    byteLimit = byteLimit || CONSOLIDATION_MEMORY_LIMIT;

    // If not available yet, create ConsolidationMap that describes the mapping from src fragments
    // into consolidated meshes.
    if (!consMap) {
        // sort by costs
        var sortedFragIds = sortByConsolidationCosts(fragList, geomList);

        // create consolidation map
        consMap = createConsolidationMap(fragList, materials, sortedFragIds, byteLimit);
    }

    // Create Consolidation
    var result = consMap.buildConsolidation(fragList, materials, model, useDeferredConsolidation); // {Consolidation}

    // the first n=numConsolidated fragments in fragIds are consolidated already.
    // The remaining fragIds are now processed using instancing.
    var fragIds = consMap.fragOrder;
    var numConsolidated = consMap.numConsolidated;

    applyInstancing(model, materials, fragIds, numConsolidated, result);

    // Set modelId for all consolidated meshes (needed to distinguish multiple models via ID-buffer)
    var modelId = model.getModelId();
    for (var i = 0; i < result.meshes.length; i++) {
        var mesh = result.meshes[i];
        mesh.modelId = modelId;
    }

    return result;
}