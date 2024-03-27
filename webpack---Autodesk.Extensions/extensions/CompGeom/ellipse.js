// Sample ellipse at a given angle.
//  @param {number} angle    - ccw angle along the ellipse in radians. 0 = point is ellipse x-axis.
//  @param {number} cx, cy   - ellipse center
//  @param {number} rx, ry   - ellipse radii
//  @param {number} rotation - ccw in radians
//  @param {Vector2} [target]
//  @returns {Vector2}
export const getEllipsePoint = (angle, cx, cy, rx, ry, rotation = 0.0, target = null) => {

    const point = target || new THREE.Vector2();

    // compute point from unrotated ellipse equation
    let x = cx + rx * Math.cos(angle);
    let y = cy + ry * Math.sin(angle);

    // apply this.rotation: (x,y) around center (cx, cy)
    if (rotation !== 0) {

        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);

        const tx = x - cx;
        const ty = y - cy;

        // Rotate the point about the center of the ellipse.
        x = tx * cos - ty * sin + cx;
        y = tx * sin + ty * cos + cy;
    }

    return point.set(x, y);
};

// Sample a single point from an ellipse arc that runs counterclockwise from startAngle to endAngle.
//  @param {number} cx, cy               - center
//  @param {number} rx, ry               - radii in x/y axis
//  @param {number} startAngle, endAngle - ccw angles in radians. 0 corresponds to (xRadius, 0)
//  @param {number} rotation             - ellipse axis rotation, ccw in radians
//  @param {number} t                    - sampling position along ellipse. 0 => startAngle, 1 = endAngle
//  @param {Vector2} [target]
//  @returns {Vector2}
export const getEllipseArcPoint = (t, cx, cy, rx, ry, startAngle, endAngle, rotation = 0.0, target = null) => {

    let deltaAngle = endAngle - startAngle;

    // If start/end angle are approximately the same, just sample at start angle
    const samePoints = Math.abs(deltaAngle) < Number.EPSILON;
    if (samePoints) {
        return getEllipsePoint(0.0, cx, cy, rx, ry, rotation, target);
    }

    // ensures that deltaAngle is [0,2 PI[
    deltaAngle = normalizeAngle(deltaAngle);

    // Since samePoints was false, but deltaAngle is close to 0 after normalization, 
    // deltaAngle must be close to a multiple of 2*Pi.
    const wholeEllipse = (deltaAngle < Number.EPSILON);
    if (wholeEllipse) {
        deltaAngle = 2.0 * Math.PI;
    }

    // Sample ellipse point at that angle
    const angle = startAngle + t * deltaAngle;
    return getEllipsePoint(angle, cx, cy, rx, ry, rotation, target);
};

// Force angle to be within [0, 2Pi[
export const normalizeAngle = (angle) => {
    // Scale [0, 2Pi] to [0,1]
    angle /= 2.0 * Math.PI;

    // Remove integer part
    angle -= Math.trunc(angle);

    // Angle is either in [0,1] or was negative. In the latter case,
    // it is in [-1, 0] now and we add 1 to bring it to [0,1] as well.
    if (angle < 0) {
        angle += 1.0;
    }

    // Scale back to [0, 2Pi] range
    return angle * 2.0 * Math.PI;
};

// Compute the arc angle difference of an arc running from startAngle to endAngle.
//  @param {number} startAngle - in radians
//  @param {number} endAngle   - in radians
//  @param {bool}   ccw        - whether the arc runs counterclockwise (true) or clockwise (false)
export const getAngleDelta = (startAngle, endAngle, ccw) => {

    // get angle difference
    let delta = endAngle - startAngle;

    // Force to [0, 2Pi] range
    delta = normalizeAngle(delta);

    // invert if arc is clockwise
    return ccw ? delta : 2.0 * Math.PI - delta;
};

// Given start/end angle of an arc, this function checks whether angle is within the arc. 
// All angles are ccw in radians. We assume the arc to be running ccw. Note that start may be > end if the arc range contains a 2*Pi mulitple.
export const angleInsideArcCCW = (angle, start, end) => {

    // ensure 0 <= a < 2Pi for all angles
    angle = normalizeAngle(angle);
    start = normalizeAngle(start);
    end = normalizeAngle(end);

    if (start < end) {
        return angle >= start && angle <= end;
    }

    // If start > end, we are crossing a full-circle boundary. So, the range between [start, end] is actually
    // the circle part outside the arc.
    // For start = end, the arc is the whole circle and the result will always be true.
    return angle >= start || angle <= end;
};

// Like angleInsideCCW, but adding an option param to support clockwise arcs.
export const angleInsideArc = (angle, start, end, ccw = true) => {
    const insideCCW = angleInsideArcCCW(angle, start, end);
    return ccw ? insideCCW : !insideCCW;
};

const svgAngle = (ux, uy, vx, vy) => {

    var dot = ux * vx + uy * vy;
    var len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    var ang = Math.acos(Math.max(-1, Math.min(1, dot / len))); // floating point precision, slightly over values appear
    if ((ux * vy - uy * vx) < 0) ang = -ang;
    return ang;
};

const tmpVec = new THREE.Vector2();

// Parameters to describe ellipse arc
export class EllipseArc {

    constructor(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw) {
        this.set(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw);
    }

    set(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw) {
        // center
        this.cx = cx;
        this.cy = cy;

        // radii
        this.rx = rx;
        this.ry = ry;

        // angle in radians
        this.startAngle = startAngle;
        this.endAngle = endAngle;

        // If true, arc runs from startAngle in counterclockwise direction, otherwise clockwise
        this.ccw = ccw;

        // ellipse rotation in radians
        this.rotation = rotation;

        return this;
    }

    /**
     * Convert SVG-style specification of an ellipse arc into an ellipse arc with center and start/end angle that is easier to sample.
     * Implementation is based on parseArcCommand() helper function in THREE.SVGLoader. All output angles in radians.
     * 
     * https://www.w3.org/TR/SVG/implnote.html#ArcImplementationNotes
     * https://mortoray.com/2017/02/16/rendering-an-svg-elliptical-arc-as-bezier-curves/ Appendix: Endpoint to center arc conversion
     * 
     * @param {number}   rx, ry        - radii in x/y axis (before xAxisRoation)
     * @param {number}   xAxisRotation - ccw rotation of the ellipse axes in degrees
     * @param {bool}     largeArcFlag  - whether to use short or long path along the ellipse
     * @param {bool}     sweepFlag     - whether to run counterclockwise around the arc from the startPoint
     * @param {Vector2}  start, end    - startPoint and endPoint of the arc
     */
    setFromSvgArc(rx, ry, xAxisRotation, largeArcFlag, sweepFlag, start, end) {

        // get rotation in radians
        const rotation = xAxisRotation * Math.PI / 180;

        // Ensure radii are positive
        rx = Math.abs(rx);
        ry = Math.abs(ry);

        // To avoid NaNs and for consistency with browser SVG behavior:
        // If any radius is 0, fall back to a straight segment. An EllipseCurve is not able to represent a straight line segment.
        // However, we can resemble this using an arc whose radius is large enough so that the angle difference is hardly noticeable.
        if (rx == 0 || ry == 0) {
            // Choose radius large enough so that 0.01 degrees correspond to the (start, end) distance.
            const minAngleDelta = 0.01;
            const dist = tmpVec.copy(start).distanceTo(end); // still works if start/end are just {x,y} pairs
            const perimeter = dist * 360 / minAngleDelta;
            const radius = perimeter / (2.0 * Math.PI);
            rx = radius;
            ry = radius;
        }

        // Compute (x1′, y1′)
        const dx2 = (start.x - end.x) / 2.0;
        const dy2 = (start.y - end.y) / 2.0;
        const x1p = Math.cos(rotation) * dx2 + Math.sin(rotation) * dy2;
        const y1p = -Math.sin(rotation) * dx2 + Math.cos(rotation) * dy2;

        // Compute (cx′, cy′)
        let rxs = rx * rx;
        let rys = ry * ry;
        const x1ps = x1p * x1p;
        const y1ps = y1p * y1p;

        // Ensure radii are large enough
        const cr = x1ps / rxs + y1ps / rys;

        if (cr > 1) {
            // scale up rx,ry equally so cr == 1
            const s = Math.sqrt(cr);
            rx = s * rx;
            ry = s * ry;
            rxs = rx * rx;
            rys = ry * ry;
        }

        const dq = (rxs * y1ps + rys * x1ps);
        const pq = (rxs * rys - dq) / dq;
        let q = Math.sqrt(Math.max(0, pq));
        if (largeArcFlag === sweepFlag) q = -q;
        const cxp = q * rx * y1p / ry;
        const cyp = -q * ry * x1p / rx;

        // Step 3: Compute (cx, cy) from (cx′, cy′)
        const cx = Math.cos(rotation) * cxp - Math.sin(rotation) * cyp + (start.x + end.x) / 2;
        const cy = Math.sin(rotation) * cxp + Math.cos(rotation) * cyp + (start.y + end.y) / 2;

        // Step 4: Compute θ1 and Δθ
        const theta = svgAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        const delta = svgAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry) % (Math.PI * 2);

        // Set curve params
        this.cx = cx;
        this.cy = cy;
        this.rx = rx;
        this.ry = ry;
        this.rotation = rotation;
        this.startAngle = theta;
        this.endAngle = theta + delta;
        this.ccw = sweepFlag;

        return this;
    }

    // Sample point along arc. 
    //  @param {number}  t - 0: startPoint, 1: endPoint
    //  @param {Vector2} [target]
    //  @returns Vector2
    getPoint(t, target) {

        let start = this.startAngle;
        let end = this.endAngle;

        // In case the arc is clockwise...
        if (!this.ccw) {
            // Swap start/end to get opposite ccw arc and sample it at position 1-t instead.
            start = this.endAngle;
            end = this.startAngle;
            t = 1.0 - t;
        }

        return getEllipseArcPoint(t, this.cx, this.cy, this.rx, this.ry, start, end, this.rotation, target);
    }

    isValid() {
        return isFinite(this.cx) && isFinite(this.cy) && isFinite(this.rx) && isFinite(this.ry) && isFinite(this.rotation) &&
            isFinite(this.startAngle) && isFinite(this.endAngle);
    }

    // @param {Box2} [targetBox]
    // returns {Box2}
    computeBBox(targetBox) {

        // compute extreme points of ellipse equation
        const tanPhi = Math.tan(this.rotation);
        const thetaX1 = -Math.atan(this.ry * tanPhi / this.rx);
        const thetaX2 = Math.PI - Math.atan(this.ry * tanPhi / this.rx);
        const thetaY1 = Math.atan(this.ry / (tanPhi * this.rx));
        const thetaY2 = Math.PI + Math.atan(this.ry / (tanPhi * this.rx));

        // Clear targetBox or create a new one
        const box = targetBox ? targetBox.makeEmpty() : new THREE.Box2();

        // Helper function to add an ellipse point that we obtain at angle theta in the ellipse equation
        const addEllipsePoint = (theta) => {
            const p = getEllipsePoint(theta, this.cx, this.cy, this.rx, this.ry, this.rotation);
            box.expandByPoint(p);
        };

        addEllipsePoint(this.startAngle);
        addEllipsePoint(this.endAngle);

        // Add all extreme points to the bbox that are inside the arc
        angleInsideArc(thetaX1, this.startAngle, this.endAngle, this.ccw) && addEllipsePoint(thetaX1);
        angleInsideArc(thetaX2, this.startAngle, this.endAngle, this.ccw) && addEllipsePoint(thetaX2);
        angleInsideArc(thetaY1, this.startAngle, this.endAngle, this.ccw) && addEllipsePoint(thetaY1);
        angleInsideArc(thetaY2, this.startAngle, this.endAngle, this.ccw) && addEllipsePoint(thetaY2);

        return box;
    }

    // Samples an ellipse arc as lineTo segments that are added a canvas context object.
    // Note: lineTo() is not called with the arc starting point. ctx is expected to end at the arc start point already.
    //
    //  @param {Path2D|LmvCanvasContext|CanvasContext} ctx - line segment are added by ctx.lineTo(x,y) calls.
    //  @param {number} maxSegmentCount  - Maximum number of line segments
    //  @param {number} minSegmentLength - Skip small segments below this length
    tesselate(ctx, maxSegments, minSegmentLength) {

        // Init lastX/lastY
        const lastPoint = this.getPoint(0);

        // Note that we only iterate over inner points.
        // Start point is not added by this function and endpoint is added separately below
        for (var i = 1; i < maxSegments; i++) {

            // get next point along arc
            const t = i / maxSegments;
            const p = this.getPoint(t, tmpVec);

            // Skip point if too close to previous point
            const dist = p.distanceTo(lastPoint);
            if (dist < minSegmentLength) {
                continue;
            }

            // add line segment
            ctx.lineTo(p.x, p.y);
            lastPoint.copy(p);
        }

        // Always add end point (without minSegmentLength-check)
        const p = this.getPoint(1.0, tmpVec);
        ctx.lineTo(p.x, p.y);
    }

    getAngleDelta() {
        return getAngleDelta(this.startAngle, this.endAngle, this.ccw);
    }
}