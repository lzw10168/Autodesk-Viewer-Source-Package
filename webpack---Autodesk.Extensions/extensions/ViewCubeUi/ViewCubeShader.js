import * as THREE from "three";
export let ViewCubeShader = {

    uniforms: {
        "tCube": {
            type: "t",
            value: null
        },
        "tFlip": {
            type: "f",
            value: -1
        }
    },

    vertexShader: [

        "varying vec3 vWorldPosition;",

        THREE.ShaderChunk["common"],
        THREE.ShaderChunk["logdepthbuf_pars_vertex"],

        "void main() {",

        "	vWorldPosition = transformDirection( position, modelMatrix );",

        "	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );",

        THREE.ShaderChunk["logdepthbuf_vertex"],

        "}"

    ].join("\n"),

    fragmentShader: [

        "uniform samplerCube tCube;",
        "uniform float tFlip;",

        "varying vec3 vWorldPosition;",

        THREE.ShaderChunk["common"],
        THREE.ShaderChunk["logdepthbuf_pars_fragment"],

        "void main() {",

        "	gl_FragColor = textureCube( tCube, vec3( tFlip * vWorldPosition.x, vWorldPosition.yz ) );",

        THREE.ShaderChunk["logdepthbuf_fragment"],

        "}"

    ].join("\n")

};