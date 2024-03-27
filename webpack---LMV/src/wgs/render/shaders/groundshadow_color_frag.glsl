module.exports = "uniform sampler2D tDepth;\nuniform vec4 uShadowColor;\nvarying vec2 vUv;\n#include <pack_depth>\nvoid main() {\n    float depthVal = unpackDepth(texture2D(tDepth, vUv));\n    gl_FragColor = vec4(uShadowColor.rgb, uShadowColor.a * depthVal);\n}\n";