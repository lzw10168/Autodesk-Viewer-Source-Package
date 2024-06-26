import {
    defineFunctionIfMissing
} from "./backport-utils";

/**
 * Polyfill for r75 THREE.CylinderBufferGeometry
 * 
 * CylinderBufferGeometry (r75): https://github.com/mrdoob/three.js/commit/8a8f05ddf1fadfe3cc57dafed5e0035cab25412b
 * CylinderBufferGeometry -> CylinderGeometry (r125): https://github.com/mrdoob/three.js/commit/7232aa40266d43e0caa128b52793574bf2c89cff
 * Copied CylinderGeometry as CylinderBufferGeometry from https://github.com/mrdoob/three.js/blob/r125/src/geometries/CylinderGeometry.js
 * 
 * Caveats: No support for multimaterials if THREE.REVISION < 72
 */
export const defineCylinderBufferGeometry = (THREE) => {

    defineFunctionIfMissing(THREE, "CylinderBufferGeometry",
        class CylinderBufferGeometry extends THREE.BufferGeometry {

            constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 8, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2) {

                super();
                this.type = 'CylinderGeometry';

                this.parameters = {
                    radiusTop: radiusTop,
                    radiusBottom: radiusBottom,
                    height: height,
                    radialSegments: radialSegments,
                    heightSegments: heightSegments,
                    openEnded: openEnded,
                    thetaStart: thetaStart,
                    thetaLength: thetaLength
                };

                const scope = this;

                radialSegments = Math.floor(radialSegments);
                heightSegments = Math.floor(heightSegments);

                // buffers

                const indices = [];
                const vertices = [];
                const normals = [];
                const uvs = [];

                // helper variables

                let index = 0;
                const indexArray = [];
                const halfHeight = height / 2;
                let groupStart = 0;

                // generate geometry

                generateTorso();

                if (openEnded === false) {

                    if (radiusTop > 0) generateCap(true);
                    if (radiusBottom > 0) generateCap(false);

                }

                // build geometry

                this.setIndex(indices);
                this.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
                this.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
                this.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

                function generateTorso() {

                    const normal = new THREE.Vector3();
                    const vertex = new THREE.Vector3();

                    let groupCount = 0;

                    // this will be used to calculate the normal
                    const slope = (radiusBottom - radiusTop) / height;

                    // generate vertices, normals and uvs

                    for (let y = 0; y <= heightSegments; y++) {

                        const indexRow = [];

                        const v = y / heightSegments;

                        // calculate the radius of the current row

                        const radius = v * (radiusBottom - radiusTop) + radiusTop;

                        for (let x = 0; x <= radialSegments; x++) {

                            const u = x / radialSegments;

                            const theta = u * thetaLength + thetaStart;

                            const sinTheta = Math.sin(theta);
                            const cosTheta = Math.cos(theta);

                            // vertex

                            vertex.x = radius * sinTheta;
                            vertex.y = -v * height + halfHeight;
                            vertex.z = radius * cosTheta;
                            vertices.push(vertex.x, vertex.y, vertex.z);

                            // normal

                            normal.set(sinTheta, slope, cosTheta).normalize();
                            normals.push(normal.x, normal.y, normal.z);

                            // uv

                            uvs.push(u, 1 - v);

                            // save index of vertex in respective row

                            indexRow.push(index++);

                        }

                        // now save vertices of the row in our index array

                        indexArray.push(indexRow);

                    }

                    // generate indices

                    for (let x = 0; x < radialSegments; x++) {

                        for (let y = 0; y < heightSegments; y++) {

                            // we use the index array to access the correct indices

                            const a = indexArray[y][x];
                            const b = indexArray[y + 1][x];
                            const c = indexArray[y + 1][x + 1];
                            const d = indexArray[y][x + 1];

                            // faces

                            indices.push(a, b, d);
                            indices.push(b, c, d);

                            // update group counter

                            groupCount += 6;

                        }

                    }

                    // add a group to the geometry. this will ensure multi material support

                    scope.addGroup(groupStart, groupCount, 0);

                    // calculate new start value for groups

                    groupStart += groupCount;

                }

                function generateCap(top) {

                    // save the index of the first center vertex
                    const centerIndexStart = index;

                    const uv = new THREE.Vector2();
                    const vertex = new THREE.Vector3();

                    let groupCount = 0;

                    const radius = (top === true) ? radiusTop : radiusBottom;
                    const sign = (top === true) ? 1 : -1;

                    // first we generate the center vertex data of the cap.
                    // because the geometry needs one set of uvs per face,
                    // we must generate a center vertex per face/segment

                    for (let x = 1; x <= radialSegments; x++) {

                        // vertex

                        vertices.push(0, halfHeight * sign, 0);

                        // normal

                        normals.push(0, sign, 0);

                        // uv

                        uvs.push(0.5, 0.5);

                        // increase index

                        index++;

                    }

                    // save the index of the last center vertex
                    const centerIndexEnd = index;

                    // now we generate the surrounding vertices, normals and uvs

                    for (let x = 0; x <= radialSegments; x++) {

                        const u = x / radialSegments;
                        const theta = u * thetaLength + thetaStart;

                        const cosTheta = Math.cos(theta);
                        const sinTheta = Math.sin(theta);

                        // vertex

                        vertex.x = radius * sinTheta;
                        vertex.y = halfHeight * sign;
                        vertex.z = radius * cosTheta;
                        vertices.push(vertex.x, vertex.y, vertex.z);

                        // normal

                        normals.push(0, sign, 0);

                        // uv

                        uv.x = (cosTheta * 0.5) + 0.5;
                        uv.y = (sinTheta * 0.5 * sign) + 0.5;
                        uvs.push(uv.x, uv.y);

                        // increase index

                        index++;

                    }

                    // generate indices

                    for (let x = 0; x < radialSegments; x++) {

                        const c = centerIndexStart + x;
                        const i = centerIndexEnd + x;

                        if (top === true) {

                            // face top

                            indices.push(i, i + 1, c);

                        } else {

                            // face bottom

                            indices.push(i + 1, i, c);

                        }

                        groupCount += 3;

                    }

                    // add a group to the geometry. this will ensure multi material support

                    const materialIndex = 0;
                    scope.addGroup(groupStart, groupCount, materialIndex);

                    // calculate new start value for groups

                    groupStart += groupCount;

                }

            }

        }
    );
};