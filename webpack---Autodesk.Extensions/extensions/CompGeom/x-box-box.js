export function xBoxBox(minx1, miny1, maxx1, maxy1,
    minx2, miny2, maxx2, maxy2) {

    return ((minx1 <= maxx2) &&
        (miny1 <= maxy2) &&
        (maxx1 >= minx2) &&
        (maxy1 >= miny2));

}