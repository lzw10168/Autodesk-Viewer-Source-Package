import {
    xLineBox
} from "./x-line-box";
import {
    xBoxBox
} from "./x-box-box";

//Spatial index data structure for fast lookup of line segments or points.
//
// It can also be used for other kinds of items. For this, you can specify an itemHandler, which tells the quadtree 
// how to work with the items. It must provide two functions:
//
// itemHandler = {
//    // Check wheter the (bbox of) this item intersects with the given one
//    insersectsBox: function(item, xmin, ymin, xmax, ymax) {...},
// 
//    // Set 'outPoint' to a point on or close to the item, e.g. bbox center. outPoint is a {x, y} pair.
//    getPoint: function(item, outPoint) {...}
//  }



const ITEMS_PER_NODE = 16;
const EPS = 1e-20;

let logger;

const tmpPoint = {
    x: 0,
    y: 0
};

export class QuadTree {

    constructor(minx, miny, maxx, maxy, extraDistance, itemHandler) {

        this.items = [];
        this.children = null;
        this.itemCount = 0;

        this.extraDistance = extraDistance;

        this.minx = minx;
        this.miny = miny;
        this.maxx = maxx;
        this.maxy = maxy;

        this.itemHandler = itemHandler;

        logger = Autodesk.Viewing.Private.logger;
    }


    addItem(e) {

        //TODO: must check if item fits inside our total bbox
        //before adding. In such case we may have to expand the
        //tree somehow

        this.itemCount++;

        if (this.children) {
            let overlapCount = 0;
            let whichChild = null;

            for (let i = 0; i < 4; i++) {
                if (this.children[i].intersectsItem(e)) {
                    whichChild = this.children[i];
                    overlapCount++;
                }
            }

            if (overlapCount === 1) {
                whichChild.addItem(e);
            } else if (overlapCount !== 0) {
                this.items.push(e);
            }

        } else {
            this.items.push(e);

            if (this.items.length > ITEMS_PER_NODE)
                this.subdivide();
        }

        return this.itemCount;
    }

    deleteItem(e) {

        if (!this.intersectsItem(e))
            return 0;

        if (this.items) {
            let idx = this.items.indexOf(e);
            if (idx >= 0) {
                this.items.splice(idx, 1);
                this.itemCount--;
                return 1;
            }
        }

        if (this.children) {
            let deleteCount = 0;
            let remainingItemsCount = 0;
            for (let i = 0; i < 4; i++) {
                deleteCount += this.children[i].deleteItem(e);
                remainingItemsCount += this.children[i].itemCount;
            }

            if (remainingItemsCount < ITEMS_PER_NODE) {
                //TODO: un-split the node here
            }

            if (deleteCount === 1) {
                this.itemCount--;
                return 1;
            } else {
                logger.warn("Did not find item to delete. Something is wrong.", deleteCount);
                return 0;
            }
        }

        return 0;
    }

    intersectsBox(minx, miny, maxx, maxy) {

        let d = this.extraDistance;

        return xBoxBox(minx, miny, maxx, maxy,
            this.minx - d, this.miny - d, this.maxx + d, this.maxy + d);
    }

    intersectsItem(e) {

        if (this.itemHandler) {
            return this.itemHandler.intersectsBox(e,
                this.minx - this.extraDistance, this.miny - this.extraDistance,
                this.maxx + this.extraDistance, this.maxy + this.extraDistance
            );
        } else if (e.v1) {
            //Edge
            return xLineBox(e.v1.x, e.v1.y, e.v2.x, e.v2.y,
                this.minx - this.extraDistance, this.miny - this.extraDistance,
                this.maxx + this.extraDistance, this.maxy + this.extraDistance);
        } else {
            //Vertex
            return this.intersectsBox(e.x, e.y, e.x, e.y);
        }
    }

    findSplitPoint() {
        //determine split location -- we split along the
        //midpoint of actual data inside the node
        let xs = [];
        let ys = [];

        if (this.itemHandler) {
            for (let i = 0; i < this.items.length; i++) {
                this.itemHandler.getPoint(this.items[i], tmpPoint);
                xs.push(tmpPoint.x);
                ys.push(tmpPoint.y);
            }
        } else if (this.items[0].v1) {
            for (let i = 0; i < this.items.length; i++) {
                xs.push(this.items[i].v1.x);
                ys.push(this.items[i].v1.y);
            }
        } else {
            for (let i = 0; i < this.items.length; i++) {
                xs.push(this.items[i].x);
                ys.push(this.items[i].y);
            }
        }

        xs.sort((a, b) => {
            return a - b;
        });
        ys.sort((a, b) => {
            return a - b;
        });

        //Split slightly to the left of the median min point for all edge items
        let midx = xs[0 | ((xs.length + 1) / 2)] - this.extraDistance - EPS;
        let midy = ys[0 | ((ys.length + 1) / 2)] - this.extraDistance - EPS;

        if (midx <= this.minx || midx >= this.maxx || midy <= this.miny || midy >= this.maxy) {
            //logger.warn("Failed to split quad tree node. Something is wrong with the split choice.");
            return null;
        }

        return {
            midx,
            midy
        };
    }


    subdivide() {

        if (this.children) {
            logger.error("Attempt to subdivide already split node");
            return;
        }

        if (!this.items.length) {
            logger.error("Attempt to subdivide empty node");
            return;
        }

        let minx = this.minx;
        let miny = this.miny;
        let maxx = this.maxx;
        let maxy = this.maxy;

        //determine split location -- we split along the
        //midpoint of actual data inside the node
        let split = this.findSplitPoint();

        if (!split) {
            //logger.warn("Failed to split node");
            return;
        }

        let {
            midx,
            midy
        } = split;

        this.children = new Array(4);
        this.children[0] = new QuadTree(minx, miny, midx, midy, this.extraDistance, this.itemHandler);
        this.children[1] = new QuadTree(midx, miny, maxx, midy, this.extraDistance, this.itemHandler);
        this.children[2] = new QuadTree(midx, midy, maxx, maxy, this.extraDistance, this.itemHandler);
        this.children[3] = new QuadTree(minx, midy, midx, maxy, this.extraDistance, this.itemHandler);

        let keepItems = [];

        for (let i = 0, iEnd = this.items.length; i < iEnd; i++) {

            let overlapCount = 0;
            let whichChild = null;

            for (let j = 0; j < 4; j++) {
                if (this.children[j].intersectsItem(this.items[i])) {
                    whichChild = this.children[j];
                    overlapCount++;
                }
            }

            if (overlapCount === 0) {
                logger.error("Expected at least one overlap");
            } else if (overlapCount === 1) {
                whichChild.addItem(this.items[i]);
            } else {
                keepItems.push(this.items[i]);
            }
        }

        this.items = keepItems;
    }

    enumNearItems(e, cb) {

        if (!this.intersectsItem(e))
            return;

        if (this.items) {
            for (let i = 0; i < this.items.length; i++) {
                cb(this.items[i]);
            }
        }

        if (this.children) {
            for (let i = 0; i < 4; i++) {
                this.children[i].enumNearItems(e, cb);
            }
        }

    }

    enumInBox(minx, miny, maxx, maxy, cb) {

        if (!this.intersectsBox(minx, miny, maxx, maxy))
            return;

        if (this.items) {
            for (let i = 0; i < this.items.length; i++) {
                let e = this.items[i];

                if (this.itemHandler) {
                    if (this.itemHandler.intersectsBox(e, minx, miny, maxx, maxy)) {
                        cb(e);
                    }
                } else if (e.v1) {
                    if (xLineBox(e.v1.x, e.v1.y, e.v2.x, e.v2.y, minx, miny, maxx, maxy))
                        cb(e);
                } else {
                    if (xBoxBox(e.x, e.y, e.x, e.y, minx, miny, maxx, maxy))
                        cb(e);
                }
            }
        }

        if (this.children) {
            for (let i = 0; i < 4; i++) {
                this.children[i].enumInBox(minx, miny, maxx, maxy, cb);
            }
        }

    }


    pointInPolygonRec(e, x, y) {

        // get the last point in the polygon
        var vtx0X = e.v1.x;
        var vtx0Y = e.v1.y;

        // get test bit for above/below X axis
        var yflag0 = (vtx0Y >= y);

        var vtx1X = e.v2.x;
        var vtx1Y = e.v2.y;

        var yflag1 = (vtx1Y >= y);

        // Check if endpoints straddle (are on opposite sides) of X axis
        // (i.e. the Y's differ); if so, +X ray could intersect this edge.
        // The old test also checked whether the endpoints are both to the
        // right or to the left of the test point.  However, given the faster
        // intersection point computation used below, this test was found to
        // be a break-even proposition for most polygons and a loser for
        // triangles (where 50% or more of the edges which survive this test
        // will cross quadrants and so have to have the X intersection computed
        // anyway).  I credit Joseph Samosky with inspiring me to try dropping
        // the "both left or both right" part of my code.
        if (yflag0 != yflag1) {
            // Check intersection of pgon segment with +X ray.
            // Note if >= point's X; if so, the ray hits it.
            // The division operation is avoided for the ">=" test by checking
            // the sign of the first vertex wrto the test point; idea inspired
            // by Joseph Samosky's and Mark Haigh-Hutchinson's different
            // polygon inclusion tests.
            if (((vtx1Y - y) * (vtx0X - vtx1X) >=
                    (vtx1X - x) * (vtx0Y - vtx1Y)) == yflag1) {
                this.pipResult = !this.pipResult;
            }
        }

    }

    pointInPolygon(x, y) {

        this.pipResult = false;

        this.enumInBox(-Infinity, y, Infinity, y, item => {

            this.pointInPolygonRec(item, x, y);

        });

        return this.pipResult;

    }


}