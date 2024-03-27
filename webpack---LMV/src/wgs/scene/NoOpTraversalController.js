import {
    ITraversalController
} from "./ITraversalController";

/**
 * This iterator has the purpose to enable loading a model, and wait with starting scene traversal
 * until an applicable controller is found, aka, any data structure needed are available.
 * Thus, we can design a more flexible pick and choose for scene traversal, without worrying for crashes,
 * as control paths will be be valid, but simply not doing anything yet, until we are ready.
 * 
 * In this case, we follow DDD principles, setting RenderModel's scene traversal strategy to "no operation",
 * and avoiding to add various conditions to all the places, where the traversal controller (formerly "iterator")
 * is required to be not null.
 */
export class NoOpTraversalController extends ITraversalController {

    nextBatch() {
        return null;
    }

    getGeomScenes() {
        return new Array();
    }

    getSceneCount() {
        return 0;
    }

    clone() {
        return new NoOpTraversalController();
    }
}