/*
 * Generic Convex Polygon Scan Conversion and Clipping
 * by Paul Heckbert
 * from "Graphics Gems", Academic Press, 1990
 */

/*
 * poly_clip.c: homogeneous 3-D convex polygon clipper
 *
 * Paul Heckbert	1985, Dec 1989
 */

//https://github.com/erich666/GraphicsGems/blob/master/gems/PolyScan/poly_clip.c

const Vector4 = THREE.Vector4;


export const POLY_CLIP_OUT = 0; /* polygon entirely outside box */
export const POLY_CLIP_PARTIAL = 1; /* polygon partially inside */
export const POLY_CLIP_IN = 2; /* polygon entirely inside box */


function SWAP(a, b, temp) {
    temp[0] = a[0];
    a[0] = b[0];
    b[0] = temp[0];
}

function COORD(vert, i) {
    switch (i) {
        case 0:
            return vert.x;
        case 1:
            return vert.y;
        case 2:
            return vert.z;
    }

    return 0;
}

function CLIP_AND_SWAP(elem, sign, k, p, q, r) {
    poly_clip_to_halfspace(p[0], q[0], elem, sign, sign * k);
    if (q[0].length === 0) {
        return POLY_CLIP_OUT;
    }
    SWAP(p, q, r);
    return POLY_CLIP_PARTIAL;
}

/*
 * poly_clip_to_box: Clip the convex polygon p1 to the screen space box
 * using the homogeneous screen coordinates (sx, sy, sz, sw) of each vertex,
 * testing if v->sx/v->sw > box->x0 and v->sx/v->sw < box->x1,
 * and similar tests for y and z, for each vertex v of the polygon.
 * If polygon is entirely inside box, then POLY_CLIP_IN is returned.
 * If polygon is entirely outside box, then POLY_CLIP_OUT is returned.
 * Otherwise, if the polygon is cut by the box, p1 is modified and
 * POLY_CLIP_PARTIAL is returned.
 *
 * Given an n-gon as input, clipping against 6 planes could generate an
 * (n+6)gon, so POLY_NMAX in poly.h must be big enough to allow that.
 */

/**
 * @param p1 {THREE.Vector4[]}
 * @param box {THREE.Box3}
 */
export function poly_clip_to_box(p1, box) {
    var x0out = 0,
        x1out = 0,
        y0out = 0,
        y1out = 0,
        z0out = 0,
        z1out = 0;

    /* count vertices "outside" with respect to each of the six planes */
    var pn = p1.length;
    for (var i = 0; i < pn; i++) {
        var v = p1[i];
        if (v.x < box.min.x * v.w) x0out++; /* out on left */
        if (v.x > box.max.x * v.w) x1out++; /* out on right */
        if (v.y < box.min.y * v.w) y0out++; /* out on top */
        if (v.y > box.max.y * v.w) y1out++; /* out on bottom */
        if (v.z < box.min.z * v.w) z0out++; /* out on near */
        if (v.z > box.max.z * v.w) z1out++; /* out on far */
    }

    /* check if all vertices inside */
    if (x0out + x1out + y0out + y1out + z0out + z1out === 0) return POLY_CLIP_IN;

    /* check if all vertices are "outside" any of the six planes */
    if (x0out === pn || x1out === pn || y0out === pn || y1out === pn || z0out === pn || z1out === pn) {
        p1.length = 0;
        return POLY_CLIP_OUT;
    }

    /*
     * now clip against each of the planes that might cut the polygon,
     * at each step toggling between polygons p1 and p2
     */
    var p2 = [];
    var p = [p1],
        q = [p2],
        r = [null];

    if (x0out)
        if (CLIP_AND_SWAP(0 /*sx*/ , -1., box.min.x, p, q, r) === POLY_CLIP_OUT) {
            p1.length = 0;
            return POLY_CLIP_OUT;
        }
    if (x1out)
        if (CLIP_AND_SWAP(0 /*sx*/ , 1., box.max.x, p, q, r) === POLY_CLIP_OUT) {
            p1.length = 0;
            return POLY_CLIP_OUT;
        }
    if (y0out)
        if (CLIP_AND_SWAP(1 /*sy*/ , -1., box.min.y, p, q, r) === POLY_CLIP_OUT) {
            p1.length = 0;
            return POLY_CLIP_OUT;
        }
    if (y1out)
        if (CLIP_AND_SWAP(1 /*sy*/ , 1., box.max.y, p, q, r) === POLY_CLIP_OUT) {
            p1.length = 0;
            return POLY_CLIP_OUT;
        }
    if (z0out)
        if (CLIP_AND_SWAP(2 /*sz*/ , -1., box.min.z, p, q, r) === POLY_CLIP_OUT) {
            p1.length = 0;
            return POLY_CLIP_OUT;
        }
    if (z1out)
        if (CLIP_AND_SWAP(2 /*sz*/ , 1., box.max.z, p, q, r) === POLY_CLIP_OUT) {
            p1.length = 0;
            return POLY_CLIP_OUT;
        }

    /* if result ended up in p2 then copy it to p1 */
    if (p[0] === p2) {
        p1.length = 0;
        p1.push(...p2);
    }
    return POLY_CLIP_PARTIAL;
}

/*
 * poly_clip_to_halfspace: clip convex polygon p against a plane,
 * copying the portion satisfying sign*s[index] < k*sw into q,
 * where s is a Poly_vert* cast as a double*.
 * index is an index into the array of doubles at each vertex, such that
 * s[index] is sx, sy, or sz (screen space x, y, or z).
 * Thus, to clip against xmin, use
 *	poly_clip_to_halfspace(p, q, XINDEX, -1., -xmin);
 * and to clip against xmax, use
 *	poly_clip_to_halfspace(p, q, XINDEX,  1.,  xmax);
 */

function poly_clip_to_halfspace(p, q, index, sign, k)
/*
Poly *p, *q;
register int index;
double sign, k;
*/
{
    var v;
    var u;
    var t, tu, tv;

    q.length = 0;

    /* start with u=vert[n-1], v=vert[0] */
    u = p.length && p[p.length - 1];
    tu = sign * COORD(u, index) - u.w * k;
    for (var i = 0; i < p.length; i++, u = v, tu = tv) {
        v = p[i];
        /* on old polygon (p), u is previous vertex, v is current vertex */
        /* tv is negative if vertex v is in */
        tv = sign * COORD(v, index) - v.w * k;
        if ((tu <= 0.) ^ (tv <= 0.)) {
            /* edge crosses plane; add intersection point to q */
            t = tu / (tu - tv);
            var w = new Vector4();
            w.x = u.x + t * (v.x - u.x);
            w.y = u.y + t * (v.y - u.y);
            w.z = u.z + t * (v.z - u.z);
            w.w = u.w + t * (v.w - u.w);
            q.push(w);
        }
        if (tv <= 0.) /* vertex v is in, copy it to q */
            q.push(v.clone());
    }
}