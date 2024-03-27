var point = new THREE.Vector3();

export function xBoxPlane(plane, box) {

    point.set(box.min.x, box.min.y, box.min.z); // 000
    var d = plane.distanceToPoint(point);
    var s = Math.sign(d);

    point.set(box.min.x, box.min.y, box.max.z); // 001
    var d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    point.set(box.min.x, box.max.y, box.min.z); // 010
    d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    point.set(box.min.x, box.max.y, box.max.z); // 011
    d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    point.set(box.max.x, box.min.y, box.min.z); // 100
    d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    point.set(box.max.x, box.min.y, box.max.z); // 101
    d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    point.set(box.max.x, box.max.y, box.min.z); // 110
    d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    point.set(box.max.x, box.max.y, box.max.z); // 111
    d2 = plane.distanceToPoint(point);
    if (Math.sign(d2) !== s)
        return true;

    return false;
}