// Collection of static math functions used for snapping implementation

// Find closest point to p on a circular arc. 
//  @param {Vector2} center
//  @param {number} radius
//  @param {number} startAngle, endAngle - ccw angles in radians. 0 means direction x+
//  @param {Vector2} [outPoint]
//  @param {Vector2}
export const nearestPointOnCircularArc = (p, center, radius, startAngle, endAngle, outPoint) => {

    outPoint = outPoint || new THREE.Vector2();

    // get normalized direction from circle center to p.
    // dir = (p-center).normalized()
    const dir = outPoint.copy(p).sub(center).normalize();

    // If the point is within the arc, we are done
    const angle = Math.atan2(dir.y, dir.x);
    const insideArc = Autodesk.Extensions.CompGeom.angleInsideArc(angle, startAngle, endAngle);
    if (insideArc) {
        // The ray from center towards p intersects the circle arc.
        // So, we obtain the closest point by projecting p onto the circle.
        //
        // Since dir is the normalized direction from center to p, we obtain the circle projection by:
        //  onCircleArc = center + dir * radius
        return dir.multiplyScalar(radius).add(center);
    }

    // The closest point on the circle is not on the arc.
    // Then the closest point must be one of the arc ends. Note that this conclusion
    // can only be made for circles, but not for ellipses with different radii.
    const pStart = Autodesk.Extensions.CompGeom.getEllipsePoint(startAngle, center.x, center.y, radius, radius);
    const pEnd = Autodesk.Extensions.CompGeom.getEllipsePoint(endAngle, center.x, center.y, radius, radius);

    const d2Start = pStart.distanceToSquared(p);
    const d2End = pEnd.distanceToSquared(p);
    const startIsCloser = d2Start <= d2End;

    outPoint.copy(startIsCloser ? pStart : pEnd);
    return outPoint;
};

// Compute intersection of two line segments
// based on http://www.paulbourke.net/geometry/pointlineplane/
//  @param {Vector2} p1, p2               - First line segment
//  @param {Vector2} p3, p4               - Second line segment
//  @param {bool}    [checkInsideSegment] - If true, we reject line intersections outside the segment ranges
//  @param {Vector2} [outPoint]           - Optional target vector
//  @param {number}  [epsilon]            - Nearly-zero threshold used to determine "nearly-parallel" resp. "nearly-zero-length line"
//  @param {Vector2|null}
export const intersectLines = (p1, p2, p3, p4, checkInsideSegment, outPoint, epsilon = 0.00001) => {

    const denom = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);

    // Reject if lines are parallel or one of them has zero-length
    if (Math.abs(denom) < epsilon) {
        return null;
    }

    // ua denotes where to find the intersection point p along segment (p1, p2):
    //   For ua = 0, we have p = p1
    //   For ua = 1, we have p = p2
    let ua = (p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x);
    ua /= denom;

    // Apply segment check
    if (checkInsideSegment) {

        // ub denotes where to find the intersection point p along segment (p3, p4)
        let ub = (p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x);
        ub /= denom;

        // Intersection is within the segments if ua and ub are both in [0,1]
        if (ua < 0.0 || ua > 1.0 ||
            ub < 0.0 || ub > 1.0) {
            return null;
        }
    }

    outPoint = outPoint || new THREE.Vector2();

    outPoint.x = p1.x + ua * (p2.x - p1.x);
    outPoint.y = p1.y + ua * (p2.y - p1.y);
    return outPoint;
};