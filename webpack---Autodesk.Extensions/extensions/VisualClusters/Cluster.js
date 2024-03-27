// A ShapeID references a single object within a multi-models scene. 
const createShapeId = (modelId, dbId) => {
    return {
        modelId,
        dbId
    };
};

// A Cluster is a group of objects that is supposed to be positions close to each other.
class Cluster {

    constructor(name) {

        // string
        this.name = name;

        // ShapeID[]
        this.shapeIds = [];
    }
}

// Checks if all fragments of a given dbId are hidden. If so, we exclude it from layout algorithm, because it would just produce empty space.
const hasVisibleFragments = (model, dbId) => {

    const it = model.getInstanceTree();
    const fragList = model.getFragmentList();
    const visFlags = model.myData.fragments.visibilityFlags;

    // Update fragment animation transforms
    let allHidden = true;
    it.enumNodeFragments(dbId, fragId => {

        // For OTG models, the visFlags tell us which fragments have been skipped by OtgLoader. This applies for Revit Room geometry.
        // For Svf, these flags may not exist, because they are deleted after loading. However, SvfLoader then sets the corresponding fragments to invisible.
        const skipped = visFlags && (visFlags[fragId] === Autodesk.Viewing.Private.MeshFlags.MESH_NOTLOADED);
        const hidden = !fragList.isFragVisible(fragId);

        if (!skipped && !hidden) {
            // We found a visible fragment
            allHidden = false;

            // No need to continue traversal
            return true;
        }
    })
    return !allHidden;
};

// Remove duplicates from array
//  @param {[]} a
//  @returns {[]} Deduplicated copy.
const uniq = (a) => {
    return Array.from(new Set(a));
};

// Creates a set of clusters based on the values of a certain propertyDB attribute.
// Note that you have to wait for an async propDB call to finish.
//
// By default, we only categorize leaf objects. This requires that all leaf objects contain the attribute to search for.
// The searchParents option enables to allow parent nodes as well:
//      i.e. we search all levels of the model tree and consider inner nodes as a single object if they contain
//           the search attribute.
//
//  @param {Model[]}   models
//  @param {string}    attribName
//  @param {boolean}   searchParents
//  @returns {Promise} When done, it resolves to a {Cluster[]}, where each element is...
//                       - named by an attribute value 
//                       - containing all ShapeIds that match that value
const buildClustersFromAttribute = async (models, attribName = 'Category', searchAncestors = false) => {

    // Collects result
    const clustersByName = {};

    // For each model, we run an async propDB worker query
    const promises = [];

    for (let i = 0; i < models.length; i++) {

        let model = models[i];
        const tree = model.getData().instanceTree;
        let dbIds;

        if (searchAncestors) {
            // Use all the dbIds in the model
            const ids = Object.keys(tree.nodeAccess.dbIdToIndex);
            dbIds = ids.map(item => parseInt(item, 10));
        } else {
            // get all dbIds with visual representation
            dbIds = model.myData.fragments.fragId2dbId;

            // Exclude all dbIds that only contain hidden fragments (like room geometries)
            dbIds = dbIds.filter(dbId => hasVisibleFragments(model, dbId));

            // Remove duplicates. Note that this is necessary, because dbIds with multiple fragments will
            // occur several times in fragId2dbId.
            dbIds = uniq(dbIds);
        }

        const options = {
            ignoreHidden: false,
            propFilter: [attribName]
        };

        promises.push(new Promise((resolve, reject) => {

            // Process dbIds. result is an array of item,
            // each containing the props for a single dbId
            const onDone = (result) => {
                for (let i = 0; i < result.length; i++) {

                    // item contains props of a single db object
                    const item = result[i];

                    // get category of this db item  
                    const category = item.properties[0].displayValue;

                    // get or create cluster for this category
                    let cluster = clustersByName[category];
                    if (!cluster) {
                        cluster = new Cluster(category);
                        clustersByName[category] = cluster;
                    }

                    if (searchAncestors) {
                        // Append IDs of visible children
                        tree.enumNodeChildren(item.dbId, child => {
                            if (hasVisibleFragments(model, child)) {
                                cluster.shapeIds.push(createShapeId(model.id, child));
                            }
                        }, true);
                    } else {
                        // Append current dbId to this cluster
                        cluster.shapeIds.push(createShapeId(model.id, item.dbId));
                    }
                }
                resolve();
            };

            model.getBulkProperties2(dbIds, options, onDone);
        }));
    }

    await Promise.all(promises);

    // Flatten to an array
    let clusters = Object.values(clustersByName);

    return clusters;
};

export {
    buildClustersFromAttribute,
    Cluster,
    createShapeId,
    hasVisibleFragments
}