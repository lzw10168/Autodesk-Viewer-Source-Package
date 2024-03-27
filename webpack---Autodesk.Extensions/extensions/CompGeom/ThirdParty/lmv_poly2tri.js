var lmv_poly2tri = require('poly2tri');

// -------------------------------------------------------------------------Edge
/**
 * Represents a simple polygon's edge
 * @constructor
 * @struct
 * @private
 * @param {Point} p1
 * @param {Point} p2
 * @throw {PointError} if p1 is same as p2
 */
var Edge = function Edge(p1, p2) {
    this.p = p1;
    this.q = p2;

    if (p1.y > p2.y) {
        this.q = p1;
        this.p = p2;
    } else if (p1.y === p2.y) {
        if (p1.x > p2.x) {
            this.q = p1;
            this.p = p2;
        } else if (p1.x === p2.x) {
            throw new Error('poly2tri Invalid Edge constructor: repeated points!', [p1]);
        }
    }

    if (!this.q._p2t_edge_list) {
        this.q._p2t_edge_list = [];
    }
    this.q._p2t_edge_list.push(this);
};

lmv_poly2tri.SweepContext.prototype.initEdges = function(polyline, isOpen) {
    var i, len = polyline.length,
        iEnd = isOpen ? polyline.length - 1 : polyline.length;
    for (i = 0; i < iEnd; ++i) {
        this.edge_list.push(new Edge(polyline[i], polyline[(i + 1) % len]));
    }
};

module.exports = lmv_poly2tri;