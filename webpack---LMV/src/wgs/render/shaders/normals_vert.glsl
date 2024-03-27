module.exports = "varying vec3 vNormal;\nvarying float depth;\n#if NUM_CUTPLANES > 0\nvarying vec3 vWorldPosition;\n#endif\n#include <pack_normals>\n#include <instancing_decl_vert>\n#include <logdepthbuf_decl_vert>\nvoid main() {\n#ifdef UNPACK_NORMALS\n    vec3 objectNormal = decodeNormal(normal);\n#else\n    vec3 objectNormal = normal;\n#endif\n#ifdef FLIP_SIDED\n    objectNormal = -objectNormal;\n#endif\n    objectNormal = getInstanceNormal(objectNormal);\n    vec3 instPos = getInstancePos(position);\n    vec3 transformedNormal = normalMatrix * objectNormal;\n    vNormal = normalize( transformedNormal );\n#if NUM_CUTPLANES > 0\n    vec4 worldPosition = modelMatrix * vec4( instPos, 1.0 );\n    vWorldPosition = worldPosition.xyz;\n#endif\n    vec4 mvPosition = modelViewMatrix * vec4( instPos, 1.0 );\n    depth = mvPosition.z;\n    vec4 p_Position = projectionMatrix * mvPosition;\n    gl_Position = p_Position;\n#include <logdepthbuf_vert>\n}\n";