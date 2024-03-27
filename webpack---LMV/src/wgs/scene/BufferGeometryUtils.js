// @todo: An accurate implementation for the polygon count is in GeometryList.addGeometry.
// This function just captures the typical polyCount behavior used in most extensions.
export function getPolygonCount(geometry) {
    if (!geometry) {
        return 0;
    }

    const ib = geometry.attributes.index ? .array || geometry.ib;

    return (ib.length / 3) || 0;
}

export function getByteSize(geom) {
    // @todo - To avoid wrong byte size reporting, the geometry should keep track of this itself.
    return (geom.vb ? .byteLength || 0) + (geom.ib ? .byteLength || 0) + (geom.iblines ? .byteLength || 0);
}