import {
    BVHBuilder as BVHBuilder
} from "../../wgs/scene/BVHBuilder";

function doComputeBvh(loadContext) {

    var tmpbvh = new BVHBuilder(loadContext.fragments);
    tmpbvh.finfo.wantSort = loadContext.fragments.wantSort;
    tmpbvh.build(loadContext.bvhOptions);

    var bvh = {
        nodes: tmpbvh.nodes.getRawData(),
        primitives: tmpbvh.primitives
    };

    loadContext.worker.postMessage({
        bvh: bvh,
        modelId: loadContext.modelId
    }, [bvh.nodes, bvh.primitives.buffer]);
}

export function register(workerMain) {
    workerMain.register("COMPUTE_BVH", {
        doOperation: doComputeBvh
    });
}