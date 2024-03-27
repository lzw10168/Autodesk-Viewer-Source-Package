    function IntervalNode() {

        this.bbox = new THREE.Box2();
        this.left = null;
        this.right = null;
        this.node_edges = [];
    }

    //Acceleration structure for point-in-polygon checking.
    //Takes in a list of points and edges indexing into those points.
    //The Point-in-polygon check is a simple even-odd test based on counting
    //number of edges intersected by a ray from the input point to infinity.
    export function IntervalTree(pts, edges, bbox) {

        this.pts = pts;
        this.edges = edges;
        this.bbox = bbox;
        this.pipResult = false;

    }



    IntervalTree.prototype.splitNode = function(node) {

        if (node.bbox.min.y >= node.bbox.max.y)
            return;

        if (node.node_edges.length < 3)
            return;

        var split = 0.5 * (node.bbox.min.y + node.bbox.max.y);

        //node.bbox.makeEmpty();

        node.left = new IntervalNode();
        node.right = new IntervalNode();

        var pts = this.pts;
        var ne = node.node_edges;
        var remaining_node_edges = [];
        var tmpPt = new THREE.Vector2();

        for (var i = 0; i < ne.length; i++) {

            var e = this.edges[ne[i]];

            var p1y = pts[e.p1].y;
            var p2y = pts[e.p2].y;

            if (p1y > p2y) {
                var tmp = p1y;
                p1y = p2y;
                p2y = tmp;
            }

            var boxPtr = null;

            if (p2y < split) {
                node.left.node_edges.push(ne[i]);
                boxPtr = node.left.bbox;
            } else if (p1y > split) {
                node.right.node_edges.push(ne[i]);
                boxPtr = node.right.bbox;
            } else {
                remaining_node_edges.push(ne[i]);
                //boxPtr = node.bbox;
            }

            if (boxPtr) {
                tmpPt.set(pts[e.p1].x, pts[e.p1].y);
                boxPtr.expandByPoint(tmpPt);
                tmpPt.set(pts[e.p2].x, pts[e.p2].y);
                boxPtr.expandByPoint(tmpPt);
            }
        }

        node.node_edges = remaining_node_edges;

        if (node.left.node_edges.length)
            this.splitNode(node.left);
        if (node.right.node_edges.length)
            this.splitNode(node.right);
    };


    IntervalTree.prototype.build = function() {

        this.root = new IntervalNode();

        var edge_indices = this.root.node_edges;
        for (var i = 0; i < this.edges.length; i++)
            edge_indices.push(i);

        this.root.bbox.copy(this.bbox);

        //split recursively
        this.splitNode(this.root);
    };




    IntervalTree.prototype.pointInPolygonRec = function(node, x, y) {

        if (node.bbox.min.y <= y && node.bbox.max.y >= y) {

            var pts = this.pts;
            var ne = node.node_edges;

            for (var i = 0, iEnd = ne.length; i < iEnd; i++) {

                var e = this.edges[ne[i]];

                // get the last point in the polygon
                var p1 = pts[e.p1];
                var vtx0X = p1.x;
                var vtx0Y = p1.y;

                // get test bit for above/below X axis
                var yflag0 = (vtx0Y >= y);

                var p2 = pts[e.p2];
                var vtx1X = p2.x;
                var vtx1Y = p2.y;

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

        }

        var nl = node.left;
        if (nl && nl.bbox.min.y <= y && nl.bbox.max.y >= y) {
            this.pointInPolygonRec(nl, x, y);
        }

        var nr = node.right;
        if (nr && nr.bbox.min.y <= y && nr.bbox.max.y >= y) {
            this.pointInPolygonRec(nr, x, y);
        }

    };

    IntervalTree.prototype.pointInPolygon = function(x, y) {

        this.pipResult = false;

        this.pointInPolygonRec(this.root, x, y);

        return this.pipResult;

    };