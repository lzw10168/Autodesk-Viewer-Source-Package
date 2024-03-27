"use strict";

import * as THREE from "three";

/**
 * Callback class for calculating bounds of 2D objects via VertexBufferReader
 * @private
 */
export function BoundsCallback(bounds) {
    this.bounds = bounds;
    // workspace, so we don't reallocate this each time
    this.point = new THREE.Vector4();
    this.point.z = 0.0;
    this.point.w = 1.0; // it's a point, not a vector
}

BoundsCallback.prototype.onVertex = function(cx, cy, vpId) {
    this.point.x = cx;
    this.point.y = cy;
    this.bounds.expandByPoint(this.point);
};

BoundsCallback.prototype.onLineSegment = function(x1, y1, x2, y2, vpId) {
    this.onVertex(x1, y1);
    this.onVertex(x2, y2);
};

BoundsCallback.prototype.onCircularArc = function(cx, cy, start, end, radius, vpId) {
    this.onEllipticalArc(cx, cy, start, end, radius, radius, 0.0, vpId);
};

BoundsCallback.prototype.onEllipticalArc = function(cx, cy, start, end, major, minor, tilt, vpId) {
    if (tilt == 0.0) {
        // does start and end make a full ellipse?
        if ((start <= 0) && (end >= 2.0 * Math.PI - 0.00001)) {
            // full way around, simply treat it like a rectangle
            this.onTexQuad(cx, cy, 2 * major, 2 * minor, tilt, vpId);
        } else {
            // Not a full ellipse. We take the start and end points and also figure
            // out the four "compass rose" points that are between these two locations.
            // The start and end locations often exist as separate vertices so would
            // already be included, but for some line types they may not exist, so we
            // include them here.
            this.point.x = cx + Math.cos(start) * major;
            this.point.y = cy + Math.sin(start) * minor;
            this.bounds.expandByPoint(this.point);
            this.point.x = cx + Math.cos(end) * major;
            this.point.y = cy + Math.sin(end) * minor;
            this.bounds.expandByPoint(this.point);

            // now check each NESW compass point, i.e., middle of each edge
            if (start > end) {
                // add right edge
                this.point.x = cx + major;
                this.point.y = cy;
                this.bounds.expandByPoint(this.point);
                // make start < end for the rest of the tests
                start -= 2.0 * Math.PI;
            }
            if (start < 0.5 * Math.PI && end > 0.5 * Math.PI) {
                // add top edge
                this.point.x = cx;
                this.point.y = cy + minor;
                this.bounds.expandByPoint(this.point);
            }
            if (start < Math.PI && end > Math.PI) {
                // add left edge
                this.point.x = cx - major;
                this.point.y = cy;
                this.bounds.expandByPoint(this.point);
            }
            if (start < 1.5 * Math.PI && end > 1.5 * Math.PI) {
                // add bottom edge
                this.point.x = cx;
                this.point.y = cy - minor;
                this.bounds.expandByPoint(this.point);
            }
        }
    } else {
        // Has a tilt.
        // From what we see, you should never reach here, as tilted ellipses are actually
        // always tessellated. So, we do a fallback: call the onTexQuad with the rotation.
        // This call will be a pretty good approximation, putting a rotated bounding box
        // around the whole ellipse. For more accuracy you would need to tessellate the
        // ellipse and get its points (especially if you don't have a full ellipse).
        this.onTexQuad(cx, cy, 2 * major, 2 * minor, tilt, vpId);

        // does start and end make a full ellipse?
        //if ( (start <= 0) && (end >= 2.0 * Math.PI - 0.00001) ) {
        //}
    }
};

// Currently this case does not actually come up, as textured quads, i.e., images, are
// not something that can be selected, from what data I have tried. So I have not spent
// any time on the rotated case.
// TODO: this code is only partially tested: I had problems getting a selectable raster
// object in a DWG convert to an F2D.
BoundsCallback.prototype.onTexQuad = function(centerX, centerY, width, height, rotation, vpId) {
    var halfWidth = 0.5 * width;
    var halfHeight = 0.5 * width;
    if (rotation == 0.0) {
        this.onVertex(centerX - halfWidth, centerY - halfHeight);
        this.onVertex(centerX + halfWidth, centerY + halfHeight);
    } else {
        // A more complex rectangle, rotated. Take the four corners and rotate each
        // around the center.
        var rmtx = new THREE.Matrix4(); // Matrix3() does not have enough helper methods
        var mtx = new THREE.Matrix4();
        // Take a rectangle centered at the origin, rotate it, translate it to the final
        // position. Each corner is added to the bounds.
        rmtx.makeRotationZ(rotation);
        // put it into the final position:
        mtx.makeTranslation(centerX, centerY, 0.0);
        mtx.multiply(rmtx);

        for (var i = 0; i < 4; i++) {
            this.point.x = (((i % 2) == 1) ? halfWidth : -halfWidth);
            this.point.y = ((i >= 2) ? halfHeight : -halfHeight);
            this.point.applyMatrix4(mtx);
            this.bounds.expandByPoint(this.point);
        }
    }
};

BoundsCallback.prototype.onOneTriangle = function(x1, y1, x2, y2, x3, y3, vpId) {
    this.onVertex(x1, y1);
    this.onVertex(x2, y2);
    this.onVertex(x3, y3);
};