module.exports = "#ifdef HATCH_PATTERN\ngl_FragColor = calculateHatchPattern(hatchParams, gl_FragCoord.xy, gl_FragColor, hatchTintColor, hatchTintIntensity);\n#endif\n#ifdef MRT_NORMALS\noutNormal = vec4(geomNormal.x, geomNormal.y, depth, gl_FragColor.a < 1.0 ? 0.0 : 1.0);\n#endif\n#include <id_frag>\n";