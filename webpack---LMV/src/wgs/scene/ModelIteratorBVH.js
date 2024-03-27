import {
    FrustumIntersector
} from './FrustumIntersector';
import * as THREE from "three";

/*
 * Keep these threeJs objects file local for performance reasons,
 * as these are changed frequently, so we keep expensive object creation minimal.
 */
const tmpBox = new THREE.Box3();
const tmpBox2 = new THREE.Box3();

export class ModelIteratorBVH {#
    frags;

    // Nodes in the BVH, in an array for easy access to all of them.
    // There are up to two trees, one for opaques, one for transparent objects.
    // These are normally listed top-down, in a flattened list, e.g., if all the objects
    // in the scene were transparent, _bvhNodes[0] = 0, and the 0 node would have not
    // children and no primitives, as this node would contain all the opaque fragments,
    // of which there are none. The transparent tree is always in _bvhNodes[1], and might
    // look something like this:
    //     1
    //  2     3
    // 4 5   6 7
    // with the children 4-7 each containing a RenderBatch of some number of fragments. Note
    // that inner nodes can also have RenderBatches.                
    #
    bvhNodes;

    // There's indirection for each RenderBatch. A RenderBatch contains a number of fragments.
    // Rather than an array per RenderBatch, a single array is accessed by all RenderBatches.
    // The primitives are in a list sorted by surface area. We preserve this. In this
    // _bvhFragOrder array we by a flattened list of children fragment indices. So child 4,
    // above, might have 3 objects, and their indices might be [291 12 55].
    // primStart and primCount access this array.
    // Also see bvh_partition and the comment there.    
    #
    bvhFragOrder;

    // _bvhRenderBatches is a sparse array of RenderBatches, each RenderBatch has a few fragments.
    // Only those elements in the array that have a RenderBatch are defined.        
    #
    bvhRenderBatches;

    // What is the containment state of this node, if known? Is either CONTAINMENT_UNKNOWN
    // or INTERSECTS or CONTAINS. If CONTAINS, we don't have to run the frustum cull
    // test, saving a few percent in speed.        
    #
    bvhContainment;

    #
    bvhNodeQueue;#
    bvhNodeAreas;#
    bvhHead;#
    bvhTail;#
    bvhLIFO;#
    bvhPrioritizeScreenSize;#
    bvhOpaqueDone;

    // true if skipOpaqueShapes has been called in the current traversal.
    #
    bvhOpaqueSkipped;

    #
    frustum;#
    done;#
    RenderBatch;#
    resetVisStatus;#
    renderModelLinear;#
    options;

    constructor() {
        this.#frags = null;
        this.#bvhNodes = null;
        this.#bvhFragOrder = null;
        this.#bvhRenderBatches = null;
        this.#bvhContainment = null;
        this.#bvhNodeQueue = null;
        this.#bvhNodeAreas = null;
        this.#bvhHead = 0;
        this.#bvhTail = 0;
        this.#bvhLIFO = 1;
        this.#bvhPrioritizeScreenSize = true;
        this.#bvhOpaqueDone = false;
        this.#bvhOpaqueSkipped = false;
        this.#frustum = null;
        this.#done = false;
        this.#RenderBatch = null;
        this.#resetVisStatus = true;
        this.#renderModelLinear = null;
        this.#options = null;
    }

    initialize(renderModelLinear, nodes, primitives, options) {
        this.#renderModelLinear = renderModelLinear;
        this.#options = options;
        this.#frags = renderModelLinear.getFragmentList();
        // Take the RenderBatch class from the model, so on demand loading can
        // use a different class to handle redraws properly
        this.#RenderBatch = renderModelLinear.RenderBatch;

        if (options && options.hasOwnProperty("prioritize_screen_size")) {
            this.#bvhPrioritizeScreenSize = options.prioritize_screen_size;
        }

        this.#bvhFragOrder = primitives;
        this.#bvhRenderBatches = new Array(nodes.nodeCount);
        this.#bvhContainment = new Int8Array(nodes.nodeCount);
        this.#bvhNodes = nodes;
        this.#bvhNodeQueue = new Int32Array(nodes.nodeCount + 1);
        this.#bvhNodeAreas = new Float32Array(nodes.nodeCount);

        for (let i = 0; i < nodes.nodeCount; i++) {
            // does this node have real objects in it?
            const primCount = nodes.getPrimCount(i);
            if (primCount === 0) {
                continue;
            }

            this.#bvhRenderBatches[i] = new this.#RenderBatch(this.#frags, this.#bvhFragOrder, nodes.getPrimStart(i), primCount);

            const currentRenderBatch = this.#bvhRenderBatches[i];

            // These are set manually, because we will not be adding fragments to the
            // render batch one by one -- the fragments are already loaded.
            currentRenderBatch.lastItem = currentRenderBatch.start + primCount;
            currentRenderBatch.numAdded = primCount;
            currentRenderBatch.nodeIndex = i;

            if (nodes.getFlags(i) & 8) {
                currentRenderBatch.sortObjects = true; //scene contains transparent objects
            }

            nodes.getBoxArray(i, currentRenderBatch.bboxes);
        }
    };

    dtor() {
        this.#RenderBatch = null;
        this.#frags = null;
        this.#renderModelLinear = null;
    };

    reset(frustum, camera) {
        this.#frustum = frustum;

        this.#bvhHead = 0;
        this.#bvhTail = 0;

        // means "unknown containment state"
        this.#bvhContainment[0] = this.#bvhContainment[1] = FrustumIntersector.CONTAINMENT_UNKNOWN;

        // prime the pump: the first entry is set to BVH node 0,
        // which is the first node in the first hierarchy (the opaque one) that we'll examine.
        // The ++ here is just for consistency; we could have set tail to 1
        // and used 0 as the index. _bvhTail will immediately get decremented to 0 by nextBatch;
        // it's incremented here to initially pass the while() loop there.
        this.#bvhNodeQueue[this.#bvhTail++] = 0;

        this.#bvhOpaqueDone = false;
        this.#bvhOpaqueSkipped = false;
        this.#done = false;

        if (this.#resetVisStatus) {
            let scenes = this.#bvhRenderBatches;
            let len = scenes.length;
            for (let i = 0; i < len; ++i) {
                let scene = scenes[i];
                if (scene && scene.resetVisStatus) {
                    scene.resetVisStatus();
                }
            }
            this.#resetVisStatus = false;
        }
    };

    // Used to insert nodes into the (sorted) render queue based on
    // a heuristic other than strict front to back or back to front order.
    // Currently we always use this for sorting by screen area.
    #
    insertNode(idx) {
        //This is basically a single sub-loop of an insertion sort.
        const val = this.#bvhNodeAreas[idx];
        let j = this.#bvhTail;

        if (this.#bvhLIFO) {
            // For LIFO we insert the largest at the end of the list, since they
            // are the first to be popped
            while (j > this.#bvhHead && this.#bvhNodeAreas[this.#bvhNodeQueue[j - 1]] > val) {
                this.#bvhNodeQueue[j] = this.#bvhNodeQueue[j - 1];
                j--;
            }
        } else {
            // For FIFO we insert the largest at the front of the list.
            while (j > this.#bvhHead && this.#bvhNodeAreas[this.#bvhNodeQueue[j - 1]] < val) {
                this.#bvhNodeQueue[j] = this.#bvhNodeQueue[j - 1];
                j--;
            }
        }

        this.#bvhNodeQueue[j] = idx;
        this.#bvhTail++;
    };

    nextBatch() {
        if (!this.#bvhOpaqueSkipped && !this.#bvhOpaqueDone && this.#bvhHead === this.#bvhTail) {
            //If we are done with the opaque nodes, queue the transparent ones
            //before processing the contents of the last opaque node
            this.#bvhNodeQueue[this.#bvhTail++] = 1; //root of transparent subtree is at index 1
            this.#bvhOpaqueDone = true;
        }

        // _bvhHead and _bvhTail are indices into the BVH node list. For the opaque objects
        // these start at 0 and 1, respectively. The idea here is to work through the bounding
        // volume hierarchy, with inner nodes sorted into the list by large-to-small screen area
        // (or front-to-back, or back-to-front) order as we go. The way this loop ends is when
        // nothing is on the BVH node stack, or a render batch of stuff to render is found.
        // The next time this method is called, the current _bvhHead and _bvhTail values pick
        // up where they left off, continuing to traverse the tree, until another batch is found
        // or the stack (list) is emptied.
        // Note: this is a breadth-first traversal, but render batches can and do get returned
        // before the whole tree is traversed, because these can be found in inner nodes.
        // This means that there may be nodes with larger screen areas that come later on.        
        while (this.#bvhHead !== this.#bvhTail) {
            // Retrieve node index for what to process in the BVH. _bvhNodeQueue contains the indices
            // of the node(s) in the BVH that are to be processed. 
            // For LIFO, for example, when the nodeIdx is first retrieved, _bvhTail initially
            // goes to 0, and so grabs the index at location 0 in _bvhNodeQueue, typically the top of
            // the opaque tree. The rest of this loop may add to this queue, and/or return fragments to
            // render, in which case it exits. If nothing got returned (yet) and the loop continues,
            // the next time around through this loop, the last
            // BVH node put on this _bvhNodeQueue stack (if LIFO is true) is retrieved (if not LIFO,
            // the first object on the list is retrieved and _bvhHead is incremented).
            // Inner nodes will add their two children in proper order to _bvhNodeQueue and increment _bvhTail, twice.
            const nodeIdx = (this.#bvhLIFO || this.#bvhOpaqueDone) ? this.#bvhNodeQueue[--this.#bvhTail] : this.#bvhNodeQueue[this.#bvhHead++];

            // Is box already found to be contained? This happens when a box's parent is fully contained.
            // We can then avoid the frustum test.
            let intersects = this.#bvhContainment[nodeIdx];
            if (intersects !== FrustumIntersector.CONTAINS) {
                // could be outside or intersecting, so do test
                this.#bvhNodes.getBoxThree(nodeIdx, tmpBox);
                intersects = this.#frustum.intersectsBox(tmpBox);
            }

            // Node is entirely outside, go on to the next node
            if (intersects !== FrustumIntersector.OUTSIDE) {
                const child = this.#bvhNodes.getLeftChild(nodeIdx);
                let isInner = child !== -1;
                let firstIdx, secondIdx;

                // Is it inner node? Add children for processing.
                if (isInner) {
                    const flags = this.#bvhNodes.getFlags(nodeIdx);
                    const reverseAxis = this.#frustum.viewDir[flags & 3] < 0 ? 1 : 0;
                    let firstChild = (flags >> 2) & 1;
                    let transparent = (flags >> 3) & 1;
                    const depthFirst = (this.#bvhLIFO || this.#bvhOpaqueDone) ? 1 : 0;
                    let areaFirst = 0;
                    let areaSecond = 0;

                    // For opaque objects, use the screen size to sort the two children,
                    // or front to back order (back to front for transparent objects).
                    if (this.#bvhPrioritizeScreenSize && !this.#bvhOpaqueDone) {
                        // If traversing based on visible screen area, we have to compute the area for each child 
                        // and insert them into the queue accordingly.
                        firstIdx = child + firstChild;
                        secondIdx = child + 1 - firstChild;

                        this.#bvhNodes.getBoxThree(firstIdx, tmpBox);
                        this.#bvhNodeAreas[firstIdx] = areaFirst = this.#frustum.projectedBoxArea(tmpBox, intersects === FrustumIntersector.CONTAINS);
                        this.#bvhNodes.getBoxThree(secondIdx, tmpBox);
                        this.#bvhNodeAreas[secondIdx] = areaSecond = this.#frustum.projectedBoxArea(tmpBox, intersects === FrustumIntersector.CONTAINS);

                        // "worst case" containment is recorded for later examination.
                        this.#bvhContainment[firstIdx] = this.#bvhContainment[secondIdx] = intersects;

                        // Insert each node in the right place based on screen area, 
                        // so that the queue (or stack, if LIFO traversal) is kept sorted at every step of the way.
                        // Note that with LIFO, for example, the larger object is put last on the list (a stack), 
                        // since we want to pop this one off first.
                        if (areaFirst > 0) {
                            this.#insertNode(firstIdx);
                        }

                        if (areaSecond > 0) {
                            this.#insertNode(secondIdx);
                        }
                    } else {
                        // Traversal by view direction.
                        // Reverse order if looking in the negative of the child split axis.
                        // Reverse order if we are traversing last first.
                        // If node contains transparent objects, then reverse the result so we traverse back to front.
                        // In other words, reverse the order if an odd number of flags are true.
                        if (reverseAxis ^ depthFirst ^ transparent) {
                            firstChild = 1 - firstChild;
                        }

                        firstIdx = child + firstChild;
                        secondIdx = child + 1 - firstChild;

                        this.#bvhNodeQueue[this.#bvhTail++] = firstIdx;

                        // TODO This has to be something based on camera distance,
                        // so that we can draw transparent back to front when multiple models are mixed.
                        this.#bvhNodeAreas[firstIdx] = -1;

                        this.#bvhNodeQueue[this.#bvhTail++] = secondIdx;
                        this.#bvhNodeAreas[secondIdx] = -1;

                        // "worst case" containment is recorded for later examination.
                        this.#bvhContainment[firstIdx] = this.#bvhContainment[secondIdx] = intersects;
                    }
                }

                // Are there graphics in the node? Then return its scene, i.e. its RenderBatch.
                // Inner nodes with children can and do have render batches of their own.
                // This works against a pure screen=area or front-to-back ordering, as
                // these fragments will always get returned first, before further traversal of the tree.
                const prims = this.#bvhNodes.getPrimCount(nodeIdx);
                if (prims !== 0) {
                    const renderBatch = this.#bvhRenderBatches[nodeIdx];

                    // Frustum culling for the RenderBatch is done in RenderBatch.applyVisibility, 
                    // so we don't need it here.
                    // Just returning the batch and it will get cull checked later.
                    // this.#frustum.projectedBoxArea(renderBatch.getBoundingBox(), intersects === FrustumIntersector.CONTAINS);
                    renderBatch.renderImportance = 1;

                    return renderBatch;
                }
            }

            if (!this.#bvhOpaqueDone && !this.#bvhOpaqueSkipped && this.#bvhHead === this.#bvhTail) {
                // If we are done with the opaque nodes, queue the transparent ones 
                // before processing the contents of the last opaque node
                this.#bvhNodeQueue[this.#bvhTail++] = 1; // root of transparent subtree is at index 1
                this.#bvhOpaqueDone = true;
            }
        }

        this.#done = true;
        return null;
    };

    skipOpaqueShapes() {
        if (!this.#bvhOpaqueDone && !this.#bvhOpaqueSkipped) {
            // start traversal of transparent hierarchy
            this.#bvhHead = 0;
            this.#bvhTail = 0;
            this.#bvhNodeQueue[this.#bvhTail++] = 1; // root of transparent subtree is at index 1
            this.#bvhOpaqueSkipped = true;
        }
    };

    #
    updateBVHRec(nodeIdx) {
        const child = this.#bvhNodes.getLeftChild(nodeIdx);
        if (child !== -1) {
            this.#updateBVHRec(child);
            this.#updateBVHRec(child + 1);
        }

        tmpBox.makeEmpty();

        if (child !== -1) {
            this.#bvhNodes.getBoxThree(child, tmpBox2);
            tmpBox.union(tmpBox2);

            this.#bvhNodes.getBoxThree(child + 1, tmpBox2);
            tmpBox.union(tmpBox2);
        }

        const prims = this.#bvhNodes.getPrimCount(nodeIdx);
        if (prims) {
            tmpBox.union(this.#bvhRenderBatches[nodeIdx].getBoundingBox());
            tmpBox.union(this.#bvhRenderBatches[nodeIdx].getBoundingBoxHidden());
        }

        this.#bvhNodes.setBoxThree(nodeIdx, tmpBox);
    };

    getVisibleBounds(visibleBounds, visibleBoundsWithHidden) {
        for (let i = 0; i < this.#bvhRenderBatches.length; i++) {
            let s = this.#bvhRenderBatches[i];

            if (!s) {
                continue;
            }

            s.calculateBounds();

            let bb = s.getBoundingBox();
            visibleBounds.union(bb);

            visibleBoundsWithHidden.union(bb);
            visibleBoundsWithHidden.union(s.getBoundingBoxHidden());
        }

        //Also update all bounding volume tree nodes' bounds.
        //If objects move too much this will make the BVH less effective.
        //However, this only happens during explode or animation, so it shouldn't
        //be an issue. We can always rebuild the BVH in case objects really move a lot.
        this.#updateBVHRec(0); //opaque root
        this.#updateBVHRec(1); //transparent root
    };

    rayCast(raycaster, intersectsOut, dbIdFilter, options = {}) {
        const rayOrigin = raycaster.ray.origin;
        let nodeStack = [1, 0];
        let pt = new THREE.Vector3();
        let nodeBBox = new THREE.Box3();

        while (nodeStack.length > 0) {
            const nodeIdx = nodeStack.pop();

            this.#bvhNodes.getBoxThree(nodeIdx, nodeBBox);
            nodeBBox.expandByScalar(0.5); // Expand bounding box a bit, to take into account axis aligned lines

            if (options.maxDistance != undefined) {
                const distanceToPoint = nodeBBox.distanceToPoint(rayOrigin);
                if (distanceToPoint > options.maxDistance) {
                    continue;
                }
            }

            const intersectionPoint = raycaster.ray.intersectBox(nodeBBox, pt);
            if (intersectionPoint === null) {
                continue;
            }

            const child = this.#bvhNodes.getLeftChild(nodeIdx);
            if (child !== -1) {
                nodeStack.push(child);
                nodeStack.push(child + 1);
            }

            const prims = this.#bvhNodes.getPrimCount(nodeIdx);
            if (prims !== 0) {
                const scene = this.#bvhRenderBatches[nodeIdx];
                scene.raycast(raycaster, intersectsOut, dbIdFilter, options);
            }
        }
    };

    intersectFrustum(frustumIntersector, callback) {
        let nodeStack = [1, FrustumIntersector.CONTAINMENT_UNKNOWN, 0, FrustumIntersector.CONTAINMENT_UNKNOWN];

        while (nodeStack.length) {

            const parentIntersectionState = nodeStack.pop();
            const nodeIdx = nodeStack.pop();

            //Check if current BVH node intersects the frustum. Take into account
            //the intersection state of the parent node, in case we can short-circuit the frustum check
            //when containment is known.
            let result;
            if (parentIntersectionState === FrustumIntersector.CONTAINS) {
                result = FrustumIntersector.CONTAINS;
            } else {
                this.#bvhNodes.getBoxThree(nodeIdx, tmpBox);
                result = frustumIntersector.intersectsBox(tmpBox);
            }

            if (result === FrustumIntersector.OUTSIDE) {
                continue;
            }

            const child = this.#bvhNodes.getLeftChild(nodeIdx);
            if (child !== -1) {
                nodeStack.push(child);
                nodeStack.push(result);

                nodeStack.push(child + 1);
                nodeStack.push(result);
            }

            const prims = this.#bvhNodes.getPrimCount(nodeIdx);
            if (prims !== 0) {
                let scene = this.#bvhRenderBatches[nodeIdx];
                scene && scene.intersectFrustum(frustumIntersector, callback, result === FrustumIntersector.CONTAINS);
            }
        }
    };

    getSceneCount() {
        return this.#bvhRenderBatches.length;
    };

    getGeomScenes() {
        return this.#bvhRenderBatches;
    };

    done() {
        // not supported (yet)
        // Seems to be needed for search in gui/controls only. let's check if this information is required to be public.
        return this.#done;
    };

    resetVisStatus() {
        this.#resetVisStatus = true;
    };

    clone() {
        const clone = new ModelIteratorBVH();
        clone.initialize(this.#renderModelLinear, this.#bvhNodes, this.#bvhFragOrder, this.#options);
        return clone;
    };

};