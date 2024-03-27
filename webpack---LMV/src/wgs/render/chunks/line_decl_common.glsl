module.exports = "\n#define LINE_2D_SHADER 1\n#define TAU     6.28318530718\n#define PI      3.14159265358979\n#define HALF_PI 1.57079632679\n#define PI_0_5  HALF_PI\n#define PI_1_5  4.71238898038\n#define ENABLE_ID_DISCARD\n#define VBB_GT_TRIANGLE_INDEXED  0.0\n#define VBB_GT_LINE_SEGMENT      1.0\n#define VBB_GT_ARC_CIRCULAR      2.0\n#define VBB_GT_ARC_ELLIPTICAL    3.0\n#define VBB_GT_TEX_QUAD          4.0\n#define VBB_GT_ONE_TRIANGLE      5.0\n#define VBB_GT_MSDF_TRIANGLE_INDEXED 6.0\n#define VBB_GT_LINE_SEGMENT_CAPPED 8.0\n#define VBB_GT_LINE_SEGMENT_CAPPED_START 9.0\n#define VBB_GT_LINE_SEGMENT_CAPPED_END 10.0\n#define VBB_GT_LINE_SEGMENT_MITER 11.0\n#define VBB_INSTANCED_FLAG   0.0\n#define VBB_SEG_START_RIGHT  0.0\n#define VBB_SEG_START_LEFT   1.0\n#define VBB_SEG_END_RIGHT    2.0\n#define VBB_SEG_END_LEFT     3.0\n#define LTSCALE 0.25\nvarying vec4 fsColor;\nvarying vec2 fsOffsetDirection;\nvarying vec4 fsMultipurpose;\nvarying float fsHalfWidth;\nvarying vec2 fsVpTC;\nvarying float fsGhosting;\n#ifdef LOADING_ANIMATION\nvarying float loadingProgress;\n#endif\n";