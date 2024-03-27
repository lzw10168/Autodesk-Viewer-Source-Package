/**
 * @author arodic / https://github.com/arodic
 *
 * @author chiena -- Modified for Autodesk LMV web viewer
 */
/*jshint sub:true*/

export function init_TransformGizmos() {

    'use strict';

    class GizmoMaterial extends THREE.MeshBasicMaterial {
        constructor(parameters) {

            super();

            this.depthTest = false;
            this.depthWrite = false;
            this.side = THREE.FrontSide;
            this.transparent = true;

            this.setValues(parameters);

            this.oldColor = this.color.clone();
            this.oldOpacity = this.opacity;

            this.highlight = function(highlighted) {

                if (highlighted) {

                    this.color.setRGB(1, 230 / 255, 3 / 255);
                    this.opacity = 1;

                } else {

                    this.color.copy(this.oldColor);
                    this.opacity = this.oldOpacity;

                }

            };

        }
    }

    class GizmoLineMaterial extends THREE.LineBasicMaterial {

        constructor(parameters) {

            super();

            this.depthTest = false;
            this.depthWrite = false;
            this.transparent = true;
            this.linewidth = 1;

            this.setValues(parameters);

            this.oldColor = this.color.clone();
            this.oldOpacity = this.opacity;

            this.highlight = function(highlighted) {

                if (highlighted) {

                    this.color.setRGB(1, 230 / 255, 3 / 255);
                    this.opacity = 1;

                } else {

                    this.color.copy(this.oldColor);
                    this.opacity = this.oldOpacity;

                }

            };

        }
    }

    var createCircleGeometry = function(radius, facing, arc) {
        const vertices = [];
        arc = arc ? arc : 1;
        for (var i = 0; i <= 64 * arc; ++i) {
            if (facing == 'x') vertices.push(new THREE.Vector3(0, Math.cos(i / 32 * Math.PI), Math.sin(i / 32 * Math.PI)).multiplyScalar(radius));
            if (facing == 'y') vertices.push(new THREE.Vector3(Math.cos(i / 32 * Math.PI), 0, Math.sin(i / 32 * Math.PI)).multiplyScalar(radius));
            if (facing == 'z') vertices.push(new THREE.Vector3(Math.sin(i / 32 * Math.PI), Math.cos(i / 32 * Math.PI), 0).multiplyScalar(radius));
        }

        return new THREE.BufferGeometry().setFromPoints(vertices);
    };

    var createArrowGeometry = function(radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded) {
        const arrowGeometry = new THREE.CylinderBufferGeometry(radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded);
        return arrowGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0.5, 0));
    };

    var createLineGeometry = function(axis) {
        const vertices = [];
        if (axis === 'X')
            vertices.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
        else if (axis === 'Y')
            vertices.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
        else if (axis === 'Z')
            vertices.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));

        return new THREE.BufferGeometry().setFromPoints(vertices);
    };

    class TransformGizmo extends THREE.Object3D {
        constructor(includeAxis) {

            super();

            var scope = this;
            var showPickers = false; //debug
            var showActivePlane = false; //debug


            this.init = function() {
                this.handles = new THREE.Object3D();
                this.pickers = new THREE.Object3D();
                this.planes = new THREE.Object3D();
                this.highlights = new THREE.Object3D();
                this.hemiPicker = new THREE.Object3D();
                this.subPickers = new THREE.Object3D();

                this.add(this.handles);
                this.add(this.pickers);
                this.add(this.planes);
                this.add(this.highlights);
                this.add(this.hemiPicker);
                this.add(this.subPickers);

                //// PLANES

                var planeGeometry = new THREE.PlaneBufferGeometry(50, 50, 2, 2);
                var planeMaterial = new THREE.MeshBasicMaterial({
                    wireframe: true
                });
                planeMaterial.side = THREE.DoubleSide;

                var planes = {
                    "XY": new THREE.Mesh(planeGeometry, planeMaterial),
                    "YZ": new THREE.Mesh(planeGeometry, planeMaterial),
                    "XZ": new THREE.Mesh(planeGeometry, planeMaterial),
                    "XYZE": new THREE.Mesh(planeGeometry, planeMaterial)
                };

                this.activePlane = planes["XYZE"];

                planes["YZ"].rotation.set(0, Math.PI / 2, 0);
                planes["XZ"].rotation.set(-Math.PI / 2, 0, 0);

                for (var i in planes) {
                    planes[i].name = i;
                    this.planes.add(planes[i]);
                    this.planes[i] = planes[i];
                    planes[i].visible = false;
                }

                this.setupGizmos();
                this.activeMode = "";

                // reset Transformations

                this.traverse(function(child) {
                    if (child instanceof THREE.Mesh) {
                        child.updateMatrix();

                        const tempGeometry = child.geometry.clone();
                        tempGeometry.applyMatrix4(child.matrix);
                        child.geometry = tempGeometry;

                        child.position.set(0, 0, 0);
                        child.rotation.set(0, 0, 0);
                        child.scale.set(1, 1, 1);
                    }
                });

            };

            this.hide = function() {
                this.traverse(function(child) {
                    child.visible = false;
                });
            };

            this.show = function() {
                this.traverse(function(child) {
                    child.visible = true;
                    if (child.parent == scope.pickers || child.parent == scope.hemiPicker) child.visible = showPickers;
                    if (child.parent == scope.planes) child.visible = false;
                });
                this.activePlane.visible = showActivePlane;
            };

            this.highlight = function(axis) {
                this.traverse(function(child) {
                    if (child.material && child.material.highlight) {
                        if (child.name == axis) {
                            child.material.highlight(true);
                        } else {
                            child.material.highlight(false);
                        }
                    }
                });
            };

            this.setupGizmos = function() {

                var addGizmos = function(gizmoMap, parent) {

                    for (var name in gizmoMap) {

                        for (var i = gizmoMap[name].length; i--;) {

                            var object = gizmoMap[name][i][0];
                            var position = gizmoMap[name][i][1];
                            var rotation = gizmoMap[name][i][2];
                            var visble = gizmoMap[name][i][3];

                            object.name = name;

                            if (position) object.position.set(position[0], position[1], position[2]);
                            if (rotation) object.rotation.set(rotation[0], rotation[1], rotation[2]);
                            if (visble) object.visble = visble;

                            parent.add(object);

                        }

                    }

                };

                this.setHandlePickerGizmos();

                if (includeAxis) {
                    var axisNames = Object.keys(this.handleGizmos);

                    for (var i = 0; i < axisNames.length; i++) {
                        var axisName = axisNames[i];

                        if (includeAxis.indexOf(axisName) === -1) {
                            delete this.handleGizmos[axisName];
                            delete this.pickerGizmos[axisName];
                            delete this.hemiPickerGizmos[axisName];
                        }
                    }
                }

                addGizmos(this.handleGizmos, this.handles);
                addGizmos(this.pickerGizmos, this.pickers);
                addGizmos(this.highlightGizmos, this.highlights);
                addGizmos(this.hemiPickerGizmos, this.hemiPicker);
                addGizmos(this.subPickerGizmos, this.subPickers);

                this.hide();
                this.show();

            };

        }

        update(rotation, eye) {

            var vec1 = new THREE.Vector3(0, 0, 0);
            var vec2 = new THREE.Vector3(0, 1, 0);
            var lookAtMatrix = new THREE.Matrix4();

            this.traverse(function(child) {
                if (child.name) {
                    if (child.name.search("E") != -1) {
                        child.quaternion.setFromRotationMatrix(lookAtMatrix.lookAt(eye, vec1, vec2));
                    } else if (child.name.search("X") != -1 || child.name.search("Y") != -1 || child.name.search("Z") != -1) {
                        child.quaternion.setFromEuler(rotation);
                    }
                }
            });

        }
    }
    THREE.TransformGizmo = TransformGizmo;

    class TransformGizmoTranslate extends TransformGizmo {
        constructor(includeAxis) {

            super(includeAxis);

            this.setHandlePickerGizmos = function() {

                var arrowGeometry = createArrowGeometry(0, 0.05, 0.2, 12, 1, false);
                var lineXGeometry = createLineGeometry('X');
                var lineYGeometry = createLineGeometry('Y');
                var lineZGeometry = createLineGeometry('Z');

                this.handleGizmos = {
                    X: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                                color: 0xf12c2c
                            })), [0.5, 0, 0],
                            [0, 0, -Math.PI / 2]
                        ],
                        [new THREE.Line(lineXGeometry, new GizmoLineMaterial({
                            color: 0xf12c2c
                        }))]
                    ],
                    Y: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                            color: 0x0bb80b
                        })), [0, 0.5, 0]],
                        [new THREE.Line(lineYGeometry, new GizmoLineMaterial({
                            color: 0x0bb80b
                        }))]
                    ],
                    Z: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                                color: 0x2c2cf1
                            })), [0, 0, 0.5],
                            [Math.PI / 2, 0, 0]
                        ],
                        [new THREE.Line(lineZGeometry, new GizmoLineMaterial({
                            color: 0x2c2cf1
                        }))]
                    ],
                    XYZ: [
                        [new THREE.Mesh(new THREE.OctahedronBufferGeometry(0.1, 0), new GizmoMaterial({
                                color: 0xffffff,
                                opacity: 0.25
                            })), [0, 0, 0],
                            [0, 0, 0]
                        ]
                    ],
                    XY: [
                        [new THREE.Mesh(new THREE.PlaneBufferGeometry(0.29, 0.29), new GizmoMaterial({
                            color: 0xffff00,
                            opacity: 0.25
                        })), [0.15, 0.15, 0]]
                    ],
                    YZ: [
                        [new THREE.Mesh(new THREE.PlaneBufferGeometry(0.29, 0.29), new GizmoMaterial({
                                color: 0x00ffff,
                                opacity: 0.25
                            })), [0, 0.15, 0.15],
                            [0, Math.PI / 2, 0]
                        ]
                    ],
                    XZ: [
                        [new THREE.Mesh(new THREE.PlaneBufferGeometry(0.29, 0.29), new GizmoMaterial({
                                color: 0xff00ff,
                                opacity: 0.25
                            })), [0.15, 0, 0.15],
                            [-Math.PI / 2, 0, 0]
                        ]
                    ]
                };

                this.pickerGizmos = {
                    X: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.2, 0, 1, 4, 1, false), new GizmoMaterial({
                                color: 0xff0000,
                                opacity: 0.25
                            })), [0.6, 0, 0],
                            [0, 0, -Math.PI / 2]
                        ]
                    ],
                    Y: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.2, 0, 1, 4, 1, false), new GizmoMaterial({
                            color: 0x00ff00,
                            opacity: 0.25
                        })), [0, 0.6, 0]]
                    ],
                    Z: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.2, 0, 1, 4, 1, false), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 0.25
                            })), [0, 0, 0.6],
                            [Math.PI / 2, 0, 0]
                        ]
                    ],
                    XYZ: [
                        [new THREE.Mesh(new THREE.OctahedronBufferGeometry(0.2, 0), new GizmoMaterial({
                            color: 0xffffff,
                            opacity: 0.25
                        }))]
                    ],
                    XY: [
                        [new THREE.Mesh(new THREE.PlaneBufferGeometry(0.4, 0.4), new GizmoMaterial({
                            color: 0xffff00,
                            opacity: 0.25
                        })), [0.2, 0.2, 0]]
                    ],
                    YZ: [
                        [new THREE.Mesh(new THREE.PlaneBufferGeometry(0.4, 0.4), new GizmoMaterial({
                                color: 0x00ffff,
                                opacity: 0.25
                            })), [0, 0.2, 0.2],
                            [0, Math.PI / 2, 0]
                        ]
                    ],
                    XZ: [
                        [new THREE.Mesh(new THREE.PlaneBufferGeometry(0.4, 0.4), new GizmoMaterial({
                                color: 0xff00ff,
                                opacity: 0.25
                            })), [0.2, 0, 0.2],
                            [-Math.PI / 2, 0, 0]
                        ]
                    ]
                };

                this.hemiPickerGizmos = {
                    XYZ: [
                        [new THREE.Mesh(new THREE.BoxBufferGeometry(1.2, 1.2, 1.2), new GizmoMaterial({
                            color: 0x0000ff
                        })), [0.5, 0.5, 0.5], null, false]
                    ]
                };

            };

            this.setActivePlane = function(axis, eye, isLocalSpace) {

                var tempMatrix = new THREE.Matrix4();
                eye.applyMatrix4(tempMatrix.extractRotation(this.planes["XY"].matrixWorld).invert());

                if (axis == "X") {
                    this.activePlane = this.planes["XY"];
                    if (!isLocalSpace && Math.abs(eye.y) > Math.abs(eye.z)) this.activePlane = this.planes["XZ"];
                }

                if (axis == "Y") {
                    this.activePlane = this.planes["XY"];
                    if (!isLocalSpace && Math.abs(eye.x) > Math.abs(eye.z)) this.activePlane = this.planes["YZ"];
                }

                if (axis == "Z") {
                    this.activePlane = this.planes["XZ"];
                    if (!isLocalSpace && Math.abs(eye.x) > Math.abs(eye.y)) this.activePlane = this.planes["YZ"];
                }

                if (axis == "XYZ") this.activePlane = this.planes["XYZE"];

                if (axis == "XY") this.activePlane = this.planes["XY"];

                if (axis == "YZ") this.activePlane = this.planes["YZ"];

                if (axis == "XZ") this.activePlane = this.planes["XZ"];

                this.hide();
                this.show();

            };

            this.init();

        }
    }
    THREE.TransformGizmoTranslate = TransformGizmoTranslate;

    class TransformGizmoRotate extends TransformGizmo {
        constructor(includeAxis) {

            super(includeAxis);

            this.setHandlePickerGizmos = function() {

                this.handleGizmos = {
                    RX: [
                        [new THREE.Line(createCircleGeometry(1, 'x', 0.5), new GizmoLineMaterial({
                            color: 0xff0000
                        }))]
                    ],
                    RY: [
                        [new THREE.Line(createCircleGeometry(1, 'y', 0.5), new GizmoLineMaterial({
                            color: 0x00ff00
                        }))]
                    ],
                    RZ: [
                        [new THREE.Line(createCircleGeometry(1, 'z', 0.5), new GizmoLineMaterial({
                            color: 0x0000ff
                        }))]
                    ],
                    RE: [
                        [new THREE.Line(createCircleGeometry(1.25, 'z', 1), new GizmoLineMaterial({
                            color: 0x00ffff
                        }))]
                    ],
                    RXYZE: [
                        [new THREE.Line(createCircleGeometry(1, 'z', 1), new GizmoLineMaterial({
                            color: 0xff00ff
                        }))]
                    ]
                };

                this.pickerGizmos = {
                    RX: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.12, 4, 12, Math.PI), new GizmoMaterial({
                                color: 0xff0000,
                                opacity: 0.25
                            })), [0, 0, 0],
                            [0, -Math.PI / 2, -Math.PI / 2]
                        ]
                    ],
                    RY: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.12, 4, 12, Math.PI), new GizmoMaterial({
                                color: 0x00ff00,
                                opacity: 0.25
                            })), [0, 0, 0],
                            [Math.PI / 2, 0, 0]
                        ]
                    ],
                    RZ: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.12, 4, 12, Math.PI), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 0.25
                            })), [0, 0, 0],
                            [0, 0, -Math.PI / 2]
                        ]
                    ],
                    RE: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1.25, 0.12, 2, 24), new GizmoMaterial({
                            color: 0x00ffff,
                            opacity: 0.25
                        }))]
                    ],
                    RXYZE: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.12, 2, 24), new GizmoMaterial({
                            color: 0xff00ff,
                            opacity: 0.25
                        }))]
                    ]
                };

            };

            this.setActivePlane = function(axis) {

                if (axis == "RE") this.activePlane = this.planes["XYZE"];

                if (axis == "RX") this.activePlane = this.planes["YZ"];

                if (axis == "RY") this.activePlane = this.planes["XZ"];

                if (axis == "RZ") this.activePlane = this.planes["XY"];

                this.hide();
                this.show();

            };

            this.update = function(rotation, eye2) {

                THREE.TransformGizmo.prototype.update.apply(this, arguments);

                var tempMatrix = new THREE.Matrix4();
                var worldRotation = new THREE.Euler(0, 0, 1);
                var tempQuaternion = new THREE.Quaternion();
                var unitX = new THREE.Vector3(1, 0, 0);
                var unitY = new THREE.Vector3(0, 1, 0);
                var unitZ = new THREE.Vector3(0, 0, 1);
                var quaternionX = new THREE.Quaternion();
                var quaternionY = new THREE.Quaternion();
                var quaternionZ = new THREE.Quaternion();
                var eye = eye2.clone();

                worldRotation.copy(this.planes["XY"].rotation);
                tempQuaternion.setFromEuler(worldRotation);

                tempMatrix.makeRotationFromQuaternion(tempQuaternion).invert();
                eye.applyMatrix4(tempMatrix);

                this.traverse(function(child) {

                    tempQuaternion.setFromEuler(worldRotation);

                    if (child.name == "RX") {
                        quaternionX.setFromAxisAngle(unitX, Math.atan2(-eye.y, eye.z));
                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionX);
                        child.quaternion.copy(tempQuaternion);
                    }

                    if (child.name == "RY") {
                        quaternionY.setFromAxisAngle(unitY, Math.atan2(eye.x, eye.z));
                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionY);
                        child.quaternion.copy(tempQuaternion);
                    }

                    if (child.name == "RZ") {
                        quaternionZ.setFromAxisAngle(unitZ, Math.atan2(eye.y, eye.x));
                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionZ);
                        child.quaternion.copy(tempQuaternion);
                    }

                });

            };

            this.init();

        }
    }
    THREE.TransformGizmoRotate = TransformGizmoRotate;

    class TransformGizmoTranslateRotate extends TransformGizmo {
        constructor(includeAxis) {

            super(includeAxis);

            var scope = this;

            this.setHandlePickerGizmos = function() {

                var arrowGeometry = createArrowGeometry(0, 0.05, 0.2, 12, 1, false);
                var theta = 0.15;

                this.handleGizmos = {
                    Z: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                                color: 0xffffff
                            })), [0, 0, 0.25],
                            [Math.PI / 2, 0, 0]
                        ],
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.015, 0.015, 0.6, 4, 1, false), new GizmoMaterial({
                                color: 0xffffff
                            })), [0, 0, 0.5],
                            [Math.PI / 2, 0, 0]
                        ]
                    ],
                    RX: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.015, 12, 60, theta * 2 * Math.PI), new GizmoMaterial({
                                color: 0xff0000
                            })), [0, 0, 0],
                            [theta * Math.PI, -Math.PI / 2, 0]
                        ],
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.05, 0.05, 0.015, 60, 1, false), new GizmoMaterial({
                                color: 0xff0000
                            })), [0, 0, 1],
                            [Math.PI / 2, 0, 0]
                        ]
                    ],
                    RY: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.015, 12, 60, theta * 2 * Math.PI), new GizmoMaterial({
                                color: 0x0000ff
                            })), [0, 0, 0],
                            [Math.PI / 2, 0, (0.5 - theta) * Math.PI]
                        ],
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.05, 0.05, 0.01, 60, 1, false), new GizmoMaterial({
                            color: 0x0000ff
                        })), [0, 0, 1]]
                    ]
                };

                this.pickerGizmos = {
                    Z: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.12, 0.12, 0.65, 4, 1, false), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 0.25
                            })), [0, 0, 0.5],
                            [Math.PI / 2, 0, 0]
                        ]
                    ],
                    RX: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.12, 4, 12, theta * 2 * Math.PI), new GizmoMaterial({
                                color: 0xff0000,
                                opacity: 0.25
                            })), [0, 0, 0],
                            [theta * Math.PI, -Math.PI / 2, 0]
                        ]
                    ],
                    RY: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.12, 4, 12, theta * 2 * Math.PI), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 0.25
                            })), [0, 0, 0],
                            [Math.PI / 2, 0, (0.5 - theta) * Math.PI]
                        ]
                    ]
                };

                this.subPickerGizmos = {
                    Z: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.12, 0.12, 0.65, 4, 1, false), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 0.25
                            })), [0, 0, 0.5],
                            [Math.PI / 2, 0, 0]
                        ]
                    ]
                };

                this.highlightGizmos = {
                    Z: [],
                    RX: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.02, 12, 60, 2 * Math.PI), new GizmoMaterial({
                                color: 0xff0000,
                                opacity: 1
                            })), [0, 0, 0],
                            [0, -Math.PI / 2, -Math.PI / 2], false
                        ]
                    ],
                    RY: [
                        [new THREE.Mesh(new THREE.TorusBufferGeometry(1, 0.02, 12, 60, 2 * Math.PI), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 1
                            })), [0, 0, 0],
                            [Math.PI / 2, 0, 0], false
                        ]
                    ]
                };

                this.hemiPickerGizmos = {
                    XYZ: [
                        [new THREE.Mesh(new THREE.SphereBufferGeometry(1.2, 8, 8, 0, Math.PI), new GizmoMaterial({
                            color: 0x0000ff
                        })), null, null, false]
                    ]
                };

            };

            this.setActivePlane = function(axis, eye, isLocalSpace) {

                if (this.activeMode == "translate") {

                    var tempMatrix = new THREE.Matrix4();
                    eye.applyMatrix4(tempMatrix.extractRotation(this.planes["XY"].matrixWorld).invert());

                    if (axis == "X") {
                        this.activePlane = this.planes["XY"];
                        if (!isLocalSpace && Math.abs(eye.y) > Math.abs(eye.z)) this.activePlane = this.planes["XZ"];
                    }

                    if (axis == "Y") {
                        this.activePlane = this.planes["XY"];
                        if (!isLocalSpace && Math.abs(eye.x) > Math.abs(eye.z)) this.activePlane = this.planes["YZ"];
                    }

                    if (axis == "Z") {
                        this.activePlane = this.planes["XZ"];
                        if (!isLocalSpace && Math.abs(eye.x) > Math.abs(eye.y)) this.activePlane = this.planes["YZ"];
                    }

                } else if (this.activeMode == "rotate") {

                    if (axis == "RX") this.activePlane = this.planes["YZ"];

                    if (axis == "RY") this.activePlane = this.planes["XZ"];

                    if (axis == "RZ") this.activePlane = this.planes["XY"];

                }

                this.hide();
                this.show();

            };

            this.update = function(rotation, eye2) {

                if (this.activeMode == "translate") {

                    THREE.TransformGizmo.prototype.update.apply(this, arguments);

                } else if (this.activeMode == "rotate") {

                    THREE.TransformGizmo.prototype.update.apply(this, arguments);

                    var tempMatrix = new THREE.Matrix4();
                    var worldRotation = new THREE.Euler(0, 0, 1);
                    var tempQuaternion = new THREE.Quaternion();
                    var unitX = new THREE.Vector3(1, 0, 0);
                    var unitY = new THREE.Vector3(0, 1, 0);
                    var unitZ = new THREE.Vector3(0, 0, 1);
                    var quaternionX = new THREE.Quaternion();
                    var quaternionY = new THREE.Quaternion();
                    var quaternionZ = new THREE.Quaternion();
                    var eye = eye2.clone();

                    worldRotation.copy(this.planes["XY"].rotation);
                    tempQuaternion.setFromEuler(worldRotation);

                    tempMatrix.makeRotationFromQuaternion(tempQuaternion).invert();
                    eye.applyMatrix4(tempMatrix);

                    this.traverse(function(child) {

                        tempQuaternion.setFromEuler(worldRotation);

                        if (child.name == "RX") {
                            quaternionX.setFromAxisAngle(unitX, Math.atan2(-eye.y, eye.z));
                            tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionX);
                            child.quaternion.copy(tempQuaternion);
                        }

                        if (child.name == "RY") {
                            quaternionY.setFromAxisAngle(unitY, Math.atan2(eye.x, eye.z));
                            tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionY);
                            child.quaternion.copy(tempQuaternion);
                        }

                        if (child.name == "RZ") {
                            quaternionZ.setFromAxisAngle(unitZ, Math.atan2(eye.y, eye.x));
                            tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionZ);
                            child.quaternion.copy(tempQuaternion);
                        }

                    });

                }

            };

            this.show = function() {
                this.traverse(function(child) {
                    if (scope.parent == null || (scope.parent.useAllPickers || child.parent != scope.handles)) child.visible = true;
                    if (child.material) child.material.opacity = child.material.oldOpacity;
                    if (child.parent == scope.pickers || child.parent == scope.hemiPicker || child.parent == scope.subPickers) child.visible = false;
                    if (child.parent == scope.planes || child.parent == scope.highlights) child.visible = false;
                });
                this.activePlane.visible = false;
            };

            this.highlight = function(axis) {
                this.traverse(function(child) {
                    if (child.material && child.material.highlight) {
                        if (child.name == axis) {
                            if (child.parent == scope.highlights || child.parent == scope.handles) child.visible = true;
                            child.material.highlight(true);
                        } else {
                            child.material.highlight(false);
                            child.material.opacity = 0.1;
                        }
                    }
                });
            };

            this.init();

        }
    }
    THREE.TransformGizmoTranslateRotate = TransformGizmoTranslateRotate;

    class TransformGizmoScale extends TransformGizmo {
        constructor(includeAxis) {

            super(includeAxis);

            this.setHandlePickerGizmos = function() {

                var arrowGeometry = createArrowGeometry(0.125, 0.125, 0.125);
                var lineXGeometry = createLineGeometry('X');
                var lineYGeometry = createLineGeometry('Y');
                var lineZGeometry = createLineGeometry('Z');

                this.handleGizmos = {
                    X: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                                color: 0xff0000
                            })), [0.5, 0, 0],
                            [0, 0, -Math.PI / 2]
                        ],
                        [new THREE.Line(lineXGeometry, new GizmoLineMaterial({
                            color: 0xff0000
                        }))]
                    ],
                    Y: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                            color: 0x00ff00
                        })), [0, 0.5, 0]],
                        [new THREE.Line(lineYGeometry, new GizmoLineMaterial({
                            color: 0x00ff00
                        }))]
                    ],
                    Z: [
                        [new THREE.Mesh(arrowGeometry, new GizmoMaterial({
                                color: 0x0000ff
                            })), [0, 0, 0.5],
                            [Math.PI / 2, 0, 0]
                        ],
                        [new THREE.Line(lineZGeometry, new GizmoLineMaterial({
                            color: 0x0000ff
                        }))]
                    ],
                    XYZ: [
                        [new THREE.Mesh(new THREE.BoxBufferGeometry(0.125, 0.125, 0.125), new GizmoMaterial({
                            color: 0xffffff,
                            opacity: 0.25
                        }))]
                    ]
                };

                this.pickerGizmos = {
                    X: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.2, 0, 1, 4, 1, false), new GizmoMaterial({
                                color: 0xff0000,
                                opacity: 0.25
                            })), [0.6, 0, 0],
                            [0, 0, -Math.PI / 2]
                        ]
                    ],
                    Y: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.2, 0, 1, 4, 1, false), new GizmoMaterial({
                            color: 0x00ff00,
                            opacity: 0.25
                        })), [0, 0.6, 0]]
                    ],
                    Z: [
                        [new THREE.Mesh(new THREE.CylinderBufferGeometry(0.2, 0, 1, 4, 1, false), new GizmoMaterial({
                                color: 0x0000ff,
                                opacity: 0.25
                            })), [0, 0, 0.6],
                            [Math.PI / 2, 0, 0]
                        ]
                    ],
                    XYZ: [
                        [new THREE.Mesh(new THREE.BoxBufferGeometry(0.4, 0.4, 0.4), new GizmoMaterial({
                            color: 0xffffff,
                            opacity: 0.25
                        }))]
                    ]
                };

            };

            this.setActivePlane = function(axis, eye, isLocalSpace) {

                var tempMatrix = new THREE.Matrix4();
                eye.applyMatrix4(tempMatrix.extractRotation(this.planes["XY"].matrixWorld).invert());

                if (axis == "X") {
                    this.activePlane = this.planes["XY"];
                    if (!isLocalSpace && Math.abs(eye.y) > Math.abs(eye.z)) this.activePlane = this.planes["XZ"];
                }

                if (axis == "Y") {
                    this.activePlane = this.planes["XY"];
                    if (!isLocalSpace && Math.abs(eye.x) > Math.abs(eye.z)) this.activePlane = this.planes["YZ"];
                }

                if (axis == "Z") {
                    this.activePlane = this.planes["XZ"];
                    if (!isLocalSpace && Math.abs(eye.x) > Math.abs(eye.y)) this.activePlane = this.planes["YZ"];
                }

                if (axis == "XYZ") this.activePlane = this.planes["XYZE"];

                this.hide();
                this.show();

            };

            this.init();

        }
    }
    THREE.TransformGizmoScale = TransformGizmoScale;

    const _pointerVector = new THREE.Vector3();
    const _pointerDir = new THREE.Vector3();
    const _ray = new THREE.Raycaster();
    class TransformControls extends THREE.Object3D {
        constructor(camera, domElement, mode, includeAxis) {

            // TODO: Make non-uniform scale and rotate play nice in hierarchies
            // TODO: ADD RXYZ contol

            super();

            domElement = (domElement !== undefined) ? domElement : document;

            this.gizmo = {};
            switch (mode) {
                case "translate":
                    this.gizmo[mode] = new THREE.TransformGizmoTranslate(includeAxis);
                    break;
                case "rotate":
                    this.gizmo[mode] = new THREE.TransformGizmoRotate(includeAxis);
                    break;
                case "transrotate":
                    this.gizmo[mode] = new THREE.TransformGizmoTranslateRotate(includeAxis);
                    break;
                case "scale":
                    this.gizmo[mode] = new THREE.TransformGizmoScale(includeAxis);
                    break;
            }

            this.add(this.gizmo[mode]);
            this.gizmo[mode].hide();

            this.object = undefined;
            this.snap = null;
            this.snapDelta = 0;
            this.space = "world";
            this.size = 1;
            this.axis = null;
            this.useAllPickers = true;

            this.unitX = new THREE.Vector3(1, 0, 0);
            this.unitY = new THREE.Vector3(0, 1, 0);
            this.unitZ = new THREE.Vector3(0, 0, 1);
            this.normal = new THREE.Vector3(0, 0, 1);

            if (mode === "transrotate") {
                var vertices = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)];
                var geometry = new THREE.BufferGeometry().setFromPoints(vertices);
                var material = new THREE.LineBasicMaterial({
                    color: 0x000000,
                    linewidth: 2,
                    depthTest: false
                });
                this.startLine = new THREE.Line(geometry, material);

                var vertices = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)];
                var geometry = new THREE.BufferGeometry().setFromPoints(vertices);
                var material = new THREE.LineBasicMaterial({
                    color: 0xffe603,
                    linewidth: 2,
                    depthTest: false
                });
                this.endLine = new THREE.Line(geometry, material);

                var vertices = [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)];
                var geometry = new THREE.BufferGeometry().setFromPoints(vertices);
                var material = new THREE.LineDashedMaterial({
                    color: 0x000000,
                    linewidth: 1,
                    depthTest: false
                });
                this.centerLine = new THREE.Line(geometry, material);

                var map = THREE.ImageUtils.loadTexture(Autodesk.Viewing.Private.getResourceUrl("res/textures/centerMarker_X.png"));
                map.magFilter = map.minFilter = THREE.NearestFilter;
                var geometry = new THREE.CircleBufferGeometry(0.1, 32);
                var material = new THREE.MeshBasicMaterial({
                    opacity: 1,
                    side: THREE.DoubleSide,
                    transparent: true,
                    map: map
                });
                this.centerMark = new THREE.Mesh(geometry, material);
                this.centerMark.rotation.set(Math.PI / 2, 0, 0);

                this.ticks = {};
                var map = THREE.ImageUtils.loadTexture(Autodesk.Viewing.Private.getResourceUrl("res/textures/cardinalPoint.png"));
                map.magFilter = map.minFilter = THREE.NearestFilter;
                var material = new THREE.MeshBasicMaterial({
                    depthTest: false,
                    opacity: 1,
                    transparent: true,
                    side: THREE.DoubleSide,
                    map: map
                });
                var w = 0.12,
                    h = 0.25,
                    d = 1.15;

                this.ticks["RX"] = new THREE.Object3D();
                var geometry = new THREE.PlaneBufferGeometry(w, h);
                var mesh = new THREE.Mesh(geometry, material);
                mesh.position.set(0, 0, -d - h / 2);
                mesh.rotation.set(Math.PI / 2, Math.PI / 2, 0);
                this.ticks["RX"].add(mesh);

                mesh = mesh.clone();
                mesh.position.set(0, d + h / 2, 0);
                mesh.rotation.set(0, Math.PI / 2, 0);
                this.ticks["RX"].add(mesh);

                mesh = mesh.clone();
                mesh.position.set(0, 0, d + h / 2);
                mesh.rotation.set(0, Math.PI / 2, Math.PI / 2);
                this.ticks["RX"].add(mesh);

                mesh = mesh.clone();
                mesh.position.set(0, -d - h / 2, 0);
                mesh.rotation.set(0, Math.PI / 2, 0);
                this.ticks["RX"].add(mesh);

                this.ticks["RY"] = new THREE.Object3D();
                mesh = mesh.clone();
                mesh.position.set(0, 0, -d - h / 2);
                mesh.rotation.set(Math.PI / 2, 0, 0);
                this.ticks["RY"].add(mesh);

                mesh = mesh.clone();
                mesh.position.set(-d - h / 2, 0, 0);
                mesh.rotation.set(Math.PI / 2, 0, Math.PI / 2);
                this.ticks["RY"].add(mesh);

                mesh = mesh.clone();
                mesh.position.set(0, 0, d + h / 2);
                mesh.rotation.set(Math.PI / 2, 0, 0);
                this.ticks["RY"].add(mesh);

                mesh = mesh.clone();
                mesh.position.set(d + h / 2, 0, 0);
                mesh.rotation.set(Math.PI / 2, 0, Math.PI / 2);
                this.ticks["RY"].add(mesh);
            }

            var scope = this;

            var _dragging = false;
            var _mode = mode;
            var _plane = "XY";

            var changeEvent = {
                type: "change"
            };
            var mouseDownEvent = {
                type: "mouseDown"
            };
            var mouseUpEvent = {
                type: "mouseUp",
                mode: _mode
            };
            var objectChangeEvent = {
                type: "objectChange"
            };

            var point = new THREE.Vector3();
            var offset = new THREE.Vector3();

            var rotation = new THREE.Vector3();
            var offsetRotation = new THREE.Vector3();
            var scale = 1;
            this.clientScale = 1;

            var lookAtMatrix = new THREE.Matrix4();
            var eye = new THREE.Vector3();

            var tempMatrix = new THREE.Matrix4();
            var tempVector = new THREE.Vector3();
            var tempQuaternion = new THREE.Quaternion();
            var projX = new THREE.Vector3();
            var projY = new THREE.Vector3();
            var projZ = new THREE.Vector3();

            var quaternionXYZ = new THREE.Quaternion();
            var quaternionX = new THREE.Quaternion();
            var quaternionY = new THREE.Quaternion();
            var quaternionZ = new THREE.Quaternion();
            var quaternionE = new THREE.Quaternion();

            var oldPosition = new THREE.Vector3();
            var oldScale = new THREE.Vector3();
            var oldRotationMatrix = new THREE.Matrix4();

            var parentRotationMatrix = new THREE.Matrix4();
            var parentScale = new THREE.Vector3();

            var worldPosition = new THREE.Vector3();
            var worldRotation = new THREE.Euler();
            var worldRotationMatrix = new THREE.Matrix4();
            var camPosition = new THREE.Vector3();
            var camRotation = new THREE.Euler();

            this.attach = function(object) {

                scope.object = object;

                this.gizmo[_mode].show();

                scope.update();

                scope.updateUnitVectors();

            };

            this.detach = function(object) {

                scope.object = undefined;
                this.axis = null;

                this.gizmo[_mode].hide();

            };

            this.setMode = function(mode) {

                _mode = mode ? mode : _mode;

                if (_mode == "scale") scope.space = "local";

                this.gizmo[_mode].show();

                this.update();
                scope.dispatchEvent(changeEvent);

            };

            this.getPicker = function() {

                return scope.gizmo[_mode].hemiPicker.children;

            };

            this.setPosition = function(position) {

                this.object.position.copy(position);
                this.update();

            };

            this.setNormal = function(normal) {

                tempQuaternion.setFromUnitVectors(this.normal, normal);
                this.unitX.applyQuaternion(tempQuaternion);
                this.unitY.applyQuaternion(tempQuaternion);
                this.unitZ.applyQuaternion(tempQuaternion);
                this.normal.copy(normal);
                if (this.object) {
                    this.object.quaternion.multiply(tempQuaternion);
                }
                this.update();
            };

            this.setRotation = function(rotationMatrix) {
                if (this.object) {
                    this.object.quaternion.setFromRotationMatrix(rotationMatrix);
                    this.update();
                    this.updateUnitVectors();
                }
            };

            this.setSnap = function(snap, delta) {

                scope.snap = snap;
                scope.snapDelta = delta;

            };

            this.setSize = function(size) {

                scope.size = size;
                this.update();
                scope.dispatchEvent(changeEvent);

            };

            this.setSpace = function(space) {

                scope.space = space;
                this.update();
                scope.dispatchEvent(changeEvent);

            };

            this.update = function(highlight) {

                if (scope.object === undefined) return;

                scope.object.updateMatrixWorld();
                worldPosition.setFromMatrixPosition(scope.object.matrixWorld);
                worldRotation.setFromRotationMatrix(tempMatrix.extractRotation(scope.object.matrixWorld));

                camera.updateMatrixWorld();
                camPosition.setFromMatrixPosition(camera.matrixWorld);
                //camRotation.setFromRotationMatrix( tempMatrix.extractRotation( camera.matrixWorld ) );

                this.position.copy(worldPosition);

                this.quaternion.setFromEuler(worldRotation);

                this.normal.set(0, 0, 1);
                this.normal.applyEuler(worldRotation);

                // keep same screen height (100px)
                var height;
                if (camera.isPerspective) {
                    var dist = worldPosition.distanceTo(camPosition);
                    height = 2 * Math.tan(camera.fov * Math.PI / 360) * dist;
                } else {
                    // orthographic, so the world height is simply top minus bottom
                    height = camera.top - camera.bottom;
                }
                var rect = domElement.getBoundingClientRect();
                // multiply 100 pixels by world height for the window, divide by window height in pixels,
                // to get world height equivalent to 100 pixels.
                scale = this.clientScale * 100 * height / rect.height;
                this.scale.set(scale, scale, scale);

                // Set the gizmo position with the specified offset.
                if (this.gizmoOffset) {
                    this.position.add(this.gizmoOffset);
                }
                this.updateMatrixWorld();
                //eye.copy( camPosition ).sub( worldPosition ).normalize();

                //if ( scope.space == "local" )
                //    this.gizmo[_mode].update( worldRotation, eye );
                //else if ( scope.space == "world" )
                //    this.gizmo[_mode].update( new THREE.Euler(), eye );

                if (highlight)
                    this.gizmo[_mode].highlight(scope.axis);

            };

            this.setGizmoOffset = function(vec) {
                // Reset the gizmo if no vector passed in.
                this.gizmoOffset = !vec ? new THREE.Vector3(0, 0, 0) : vec;
                this.update();
            }

            this.updateUnitVectors = function() {

                this.unitX.set(1, 0, 0);
                this.unitY.set(0, 1, 0);
                this.unitZ.set(0, 0, 1);
                this.unitX.applyEuler(worldRotation);
                this.unitY.applyEuler(worldRotation);
                this.unitZ.applyEuler(worldRotation);

            };

            this.showRotationGizmos = function(set) {

                var handles = this.gizmo[_mode].handles.children;
                for (var i = 0; i < handles.length; i++) {
                    var child = handles[i];
                    child.visible = true;
                    if (child.name.search("R") !== -1) child.visible = set;
                }
                this.useAllPickers = set;

            };

            this.highlight = function() {

                this.gizmo[_mode].highlight(this.axis || "Z");

            };

            this.onPointerHover = function(event) {

                if (scope.object === undefined || _dragging === true) return false;

                var pointer = event;

                var intersect = intersectObjects(pointer, scope.useAllPickers ? scope.gizmo[_mode].pickers.children : scope.gizmo[_mode].subPickers.children);

                var axis = null;
                var mode = "";

                if (intersect) {

                    axis = intersect.object.name;
                    mode = axis.search("R") != -1 ? "rotate" : "translate";

                }

                if (scope.axis !== axis) {

                    scope.axis = axis;
                    scope.gizmo[_mode].activeMode = mode;
                    scope.update(true);
                    scope.dispatchEvent(changeEvent);

                }

                if (scope.axis === null) {

                    scope.gizmo[_mode].show();

                }

                return intersect ? true : false;

            };

            this.isDragging = function() {
                return _dragging;
            };

            this.onPointerDown = function(event) {

                if (scope.object === undefined || _dragging === true) return false;

                var pointer = event;

                if (event.pointerType === 'touch') {

                    var intersect = intersectObjects(pointer, scope.useAllPickers ? scope.gizmo[_mode].pickers.children : scope.gizmo[_mode].subPickers.children);

                    var axis = null;
                    var mode = "";

                    if (intersect) {

                        axis = intersect.object.name;
                        mode = axis.search("R") != -1 ? "rotate" : "translate";

                    }

                    if (scope.axis !== axis) {

                        scope.axis = axis;
                        scope.gizmo[_mode].activeMode = mode;
                    }
                }

                var intersect = null;

                if (pointer.button === 0 || pointer.button === -1 || pointer.button === undefined) {

                    intersect = intersectObjects(pointer, scope.useAllPickers ? scope.gizmo[_mode].pickers.children : scope.gizmo[_mode].subPickers.children);

                    if (intersect) {

                        scope.dispatchEvent(mouseDownEvent);

                        scope.axis = intersect.object.name;

                        scope.update();

                        eye.copy(camera.position).sub(worldPosition).normalize();

                        // The eye vector is used to ensure that we choose a plane that is not parallel to the view direction.
                        // When using an orthographic camera, the direction from gizmo to camera (as used above) doesn't matter for this,
                        // because the view rays for any pixel is always parallel to the camera world direction.
                        //
                        // E.g. it may happen that the axis of largest extent in the eye vector above is x, while the ortho-camera direction
                        // is actually y. In this case, setAxisPlane() would choose the "YZ"-plane for dragging along z-axis, so that hittests
                        // with this plane will not work (see FLUENT-6543).
                        if (!camera.isPerspective) {
                            camera.getWorldDirection(eye);
                        }

                        scope.gizmo[_mode].setActivePlane(scope.axis, eye, scope.space === "local");

                        var planeIntersect = intersectObjects(pointer, [scope.gizmo[_mode].activePlane]);

                        if (planeIntersect)
                            offset.copy(planeIntersect.point);

                        oldPosition.copy(scope.object.position);
                        oldScale.copy(scope.object.scale);

                        oldRotationMatrix.extractRotation(scope.object.matrix);
                        worldRotationMatrix.extractRotation(scope.object.matrixWorld);

                        if (scope.object.parent) {
                            parentRotationMatrix.extractRotation(scope.object.parent.matrixWorld);
                            parentScale.setFromMatrixScale(tempMatrix.copy(scope.object.parent.matrixWorld).invert());
                        } else {
                            parentRotationMatrix.extractRotation(scope.object.matrixWorld);
                            parentScale.setFromMatrixScale(tempMatrix.copy(scope.object.matrixWorld).invert());
                        }

                        // show rotation start line and ticks
                        if (_mode === "transrotate" && scope.gizmo[_mode].activeMode === "rotate") {
                            {
                                const startLinePositions = scope.startLine.geometry.getAttribute('position');
                                startLinePositions.setXYZ(0, 0, 0, 0);
                                startLinePositions.setXYZ(1, 0, 0, 1);
                                startLinePositions.applyMatrix4(scope.matrixWorld);
                                startLinePositions.needsUpdate = true;
                                scope.parent.add(scope.startLine);
                            }

                            var pos = scope.object.geometry.getAttribute('position');
                            var pt1 = new THREE.Vector3().fromBufferAttribute(pos, 0).applyMatrix4(scope.object.matrixWorld);
                            var pt2 = new THREE.Vector3().fromBufferAttribute(pos, 1).applyMatrix4(scope.object.matrixWorld);
                            var pt3 = new THREE.Vector3().fromBufferAttribute(pos, 2).applyMatrix4(scope.object.matrixWorld);
                            var pt4 = new THREE.Vector3().fromBufferAttribute(pos, 3).applyMatrix4(scope.object.matrixWorld);

                            const centerLinePositions = scope.centerLine.geometry.getAttribute('position');
                            if (scope.axis === "RX") {
                                pt1.lerp(pt3, 0.5);
                                pt2.lerp(pt4, 0.5);
                                var dist = pt1.distanceTo(pt2);
                                scope.centerLine.material.dashSize = dist / 15;
                                scope.centerLine.material.gapSize = dist / 30;
                                centerLinePositions.setXYZ(0, pt1.x, pt1.y, pt1.z);
                                centerLinePositions.setXYZ(1, pt2.x, pt2.y, pt2.z);
                            } else {
                                pt1.lerp(pt2, 0.5);
                                pt3.lerp(pt4, 0.5);
                                var dist = pt1.distanceTo(pt3);
                                scope.centerLine.material.dashSize = dist / 15;
                                scope.centerLine.material.gapSize = dist / 30;
                                centerLinePositions.setXYZ(0, pt1.x, pt1.y, pt1.z);
                                centerLinePositions.setXYZ(1, pt3.x, pt3.y, pt3.z);
                            }
                            scope.centerLine.computeLineDistances();
                            centerLinePositions.needsUpdate = true;
                            scope.parent.add(scope.centerLine);

                            scope.ticks[scope.axis].position.copy(scope.position);
                            scope.ticks[scope.axis].quaternion.copy(scope.quaternion);
                            scope.ticks[scope.axis].scale.copy(scope.scale);
                            scope.parent.add(scope.ticks[scope.axis]);
                        }

                    }

                }

                _dragging = true;

                return intersect ? true : false;

            }

            this.onPointerMove = function(event) {

                if (scope.object === undefined || scope.axis === null || _dragging === false) return false;

                var pointer = event;

                var planeIntersect = intersectObjects(pointer, [scope.gizmo[_mode].activePlane]);

                if (planeIntersect)
                    point.copy(planeIntersect.point);

                var mode = scope.gizmo[_mode].activeMode;
                if (mode == "translate") {

                    point.sub(offset);
                    point.multiply(parentScale);

                    if (scope.space == "local") {

                        point.applyMatrix4(tempMatrix.copy(worldRotationMatrix).invert());

                        if (scope.axis.search("X") == -1) point.x = 0;
                        if (scope.axis.search("Y") == -1) point.y = 0;
                        if (scope.axis.search("Z") == -1) point.z = 0;

                        point.applyMatrix4(oldRotationMatrix);

                        scope.object.position.copy(oldPosition);
                        scope.object.position.add(point);

                    }

                    if (scope.space == "world" || scope.axis.search("XYZ") != -1) {

                        projX.copy(this.unitX);
                        projY.copy(this.unitY);
                        projZ.copy(this.unitZ);
                        tempVector.set(0, 0, 0);
                        if (scope.axis.search("X") != -1) {
                            projX.multiplyScalar(point.dot(this.unitX));
                            tempVector.add(projX);
                        }
                        if (scope.axis.search("Y") != -1) {
                            projY.multiplyScalar(point.dot(this.unitY));
                            tempVector.add(projY);
                        }
                        if (scope.axis.search("Z") != -1) {
                            projZ.multiplyScalar(point.dot(this.unitZ));
                            tempVector.add(projZ);
                        }
                        point.copy(tempVector);

                        point.applyMatrix4(tempMatrix.copy(parentRotationMatrix).invert());

                        scope.object.position.copy(oldPosition);
                        scope.object.position.add(point);

                    }

                } else if (mode == "scale") {

                    point.sub(offset);
                    point.multiply(parentScale);

                    if (scope.space == "local") {

                        if (scope.axis == "XYZ") {

                            scale = 1 + ((point.y) / 50);

                            scope.object.scale.x = oldScale.x * scale;
                            scope.object.scale.y = oldScale.y * scale;
                            scope.object.scale.z = oldScale.z * scale;

                        } else {

                            point.applyMatrix4(tempMatrix.copy(worldRotationMatrix).invert());

                            if (scope.axis == "X") scope.object.scale.x = oldScale.x * (1 + point.x / 50);
                            if (scope.axis == "Y") scope.object.scale.y = oldScale.y * (1 + point.y / 50);
                            if (scope.axis == "Z") scope.object.scale.z = oldScale.z * (1 + point.z / 50);

                        }

                    }

                } else if (mode == "rotate") {

                    point.sub(worldPosition);
                    point.multiply(parentScale);
                    tempVector.copy(offset).sub(worldPosition);
                    tempVector.multiply(parentScale);

                    if (scope.axis == "RE") {

                        tempMatrix.copy(lookAtMatrix).invert();
                        point.applyMatrix4(tempMatrix);
                        tempVector.applyMatrix4(tempMatrix);

                        rotation.set(Math.atan2(point.z, point.y), Math.atan2(point.x, point.z), Math.atan2(point.y, point.x));
                        offsetRotation.set(Math.atan2(tempVector.z, tempVector.y), Math.atan2(tempVector.x, tempVector.z), Math.atan2(tempVector.y, tempVector.x));

                        tempQuaternion.setFromRotationMatrix(tempMatrix.copy(parentRotationMatrix).invert());

                        var rotz = rotation.z - offsetRotation.z;
                        if (scope.snap !== null) {
                            var rotsnap = Math.round(rotz / scope.snap) * scope.snap;
                            if (Math.abs(rotsnap - rotz) < scope.snapDelta) {
                                rotz = rotsnap;
                            }
                        }
                        quaternionE.setFromAxisAngle(eye, rotz);
                        quaternionXYZ.setFromRotationMatrix(worldRotationMatrix);

                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionE);
                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionXYZ);

                        scope.object.quaternion.copy(tempQuaternion);

                    } else if (scope.axis == "RXYZE") {

                        var tempAxis = point.clone().cross(tempVector).normalize(); // rotation axis

                        tempQuaternion.setFromRotationMatrix(tempMatrix.copy(parentRotationMatrix).invert());

                        var rot = -point.clone().angleTo(tempVector);
                        if (scope.snap !== null) {
                            var rotsnap = Math.round(rot / scope.snap) * scope.snap;
                            if (Math.abs(rotsnap - rot) < scope.snapDelta) {
                                rot = rotsnap;
                            }
                        }
                        quaternionX.setFromAxisAngle(tempAxis, rot);
                        quaternionXYZ.setFromRotationMatrix(worldRotationMatrix);

                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionX);
                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionXYZ);

                        scope.object.quaternion.copy(tempQuaternion);

                    } else if (scope.space == "local") {

                        tempMatrix.copy(worldRotationMatrix).invert();
                        point.applyMatrix4(tempMatrix);
                        tempVector.applyMatrix4(tempMatrix);

                        var projx = point.dot(this.unitX),
                            projy = point.dot(this.unitY),
                            projz = point.dot(this.unitZ);
                        var tempx = tempVector.dot(this.unitX),
                            tempy = tempVector.dot(this.unitY),
                            tempz = tempVector.dot(this.unitZ);
                        rotation.set(Math.atan2(projz, projy), Math.atan2(projx, projz), Math.atan2(projy, projx));
                        offsetRotation.set(Math.atan2(tempz, tempy), Math.atan2(tempx, tempz), Math.atan2(tempy, tempx));

                        var rotx = rotation.x - offsetRotation.x;
                        var roty = rotation.y - offsetRotation.y;
                        var rotz = rotation.z - offsetRotation.z;
                        if (scope.snap !== null) {
                            if (scope.axis.search("X") != -1) {
                                var rotsnap = Math.round(rotx / scope.snap) * scope.snap;
                                if (Math.abs(rotsnap - rotx) < scope.snapDelta) {
                                    rotx = rotsnap;
                                }
                            }
                            if (scope.axis.search("Y") != -1) {
                                var rotsnap = Math.round(roty / scope.snap) * scope.snap;
                                if (Math.abs(rotsnap - roty) < scope.snapDelta) {
                                    roty = rotsnap;
                                }
                            }
                            if (scope.axis.search("Z") != -1) {
                                var rotsnap = Math.round(rotz / scope.snap) * scope.snap;
                                if (Math.abs(rotsnap - rotz) < scope.snapDelta) {
                                    rotz = rotsnap;
                                }
                            }
                        }
                        quaternionX.setFromAxisAngle(this.unitX, rotx);
                        quaternionY.setFromAxisAngle(this.unitY, roty);
                        quaternionZ.setFromAxisAngle(this.unitZ, rotz);
                        quaternionXYZ.setFromRotationMatrix(oldRotationMatrix);

                        if (scope.axis == "RX") quaternionXYZ.multiplyQuaternions(quaternionXYZ, quaternionX);
                        if (scope.axis == "RY") quaternionXYZ.multiplyQuaternions(quaternionXYZ, quaternionY);
                        if (scope.axis == "RZ") quaternionXYZ.multiplyQuaternions(quaternionXYZ, quaternionZ);

                        scope.object.quaternion.copy(quaternionXYZ);

                    } else if (scope.space == "world") {

                        var projx = point.dot(this.unitX),
                            projy = point.dot(this.unitY),
                            projz = point.dot(this.unitZ);
                        var tempx = tempVector.dot(this.unitX),
                            tempy = tempVector.dot(this.unitY),
                            tempz = tempVector.dot(this.unitZ);
                        rotation.set(Math.atan2(projz, projy), Math.atan2(projx, projz), Math.atan2(projy, projx));
                        offsetRotation.set(Math.atan2(tempz, tempy), Math.atan2(tempx, tempz), Math.atan2(tempy, tempx));

                        tempQuaternion.setFromRotationMatrix(tempMatrix.copy(parentRotationMatrix).invert());

                        var rotx = rotation.x - offsetRotation.x;
                        var roty = rotation.y - offsetRotation.y;
                        var rotz = rotation.z - offsetRotation.z;
                        if (scope.snap !== null) {
                            if (scope.axis.search("X") != -1) {
                                var rotsnap = Math.round(rotx / scope.snap) * scope.snap;
                                if (Math.abs(rotsnap - rotx) < scope.snapDelta) {
                                    rotx = rotsnap;
                                }
                            }
                            if (scope.axis.search("Y") != -1) {
                                var rotsnap = Math.round(roty / scope.snap) * scope.snap;
                                if (Math.abs(rotsnap - roty) < scope.snapDelta) {
                                    roty = rotsnap;
                                }
                            }
                            if (scope.axis.search("Z") != -1) {
                                var rotsnap = Math.round(rotz / scope.snap) * scope.snap;
                                if (Math.abs(rotsnap - rotz) < scope.snapDelta) {
                                    rotz = rotsnap;
                                }
                            }
                        }
                        quaternionX.setFromAxisAngle(this.unitX, rotx);
                        quaternionY.setFromAxisAngle(this.unitY, roty);
                        quaternionZ.setFromAxisAngle(this.unitZ, rotz);
                        quaternionXYZ.setFromRotationMatrix(worldRotationMatrix);

                        if (scope.axis == "RX") tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionX);
                        if (scope.axis == "RY") tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionY);
                        if (scope.axis == "RZ") tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionZ);

                        tempQuaternion.multiplyQuaternions(tempQuaternion, quaternionXYZ);

                        scope.object.quaternion.copy(tempQuaternion);

                    }

                    // show rotation end line
                    if (_mode === "transrotate") {
                        scope.add(scope.endLine);
                        scope.add(scope.centerMark);
                    }

                }

                // update matrix
                scope.object.matrixAutoUpdate = true;

                scope.update(true);
                scope.dispatchEvent(changeEvent);
                scope.dispatchEvent(objectChangeEvent);

                return planeIntersect ? true : false;

            }

            this.onPointerUp = function(event) {

                if (_dragging && (scope.axis !== null)) {
                    mouseUpEvent.mode = _mode;
                    scope.dispatchEvent(mouseUpEvent)
                }
                _dragging = false;

                this.gizmo[_mode].show();

                this.updateUnitVectors();

                // remove rotation start/end lines
                if (_mode === "transrotate" && this.gizmo[_mode].activeMode === "rotate") {
                    this.remove(this.endLine);
                    this.remove(this.centerMark);
                    this.parent.remove(this.centerLine);
                    this.parent.remove(this.startLine);
                    this.parent.remove(this.ticks[this.axis]);
                }

                return false;

            }

            function intersectObjects(pointer, objects) {
                return THREE.TransformControls.intersectObjects(pointer.canvasX, pointer.canvasY, objects, camera, true);
            }
        }

        static intersectObjects(clientX, clientY, objects, camera, recursive) {
            // Convert client to viewport coords (in [-1,1]^2)
            var x = (clientX / camera.clientWidth) * 2 - 1;
            var y = -(clientY / camera.clientHeight) * 2 + 1; // y-direction flips between canvas and viewport coords

            if (camera.isPerspective) {
                _pointerVector.set(x, y, 0.5);
                _pointerVector.unproject(camera);
                _ray.set(camera.position, _pointerVector.sub(camera.position).normalize());
            } else {
                _pointerVector.set(x, y, -1);
                _pointerVector.unproject(camera);
                _pointerDir.set(0, 0, -1);
                _ray.set(_pointerVector, _pointerDir.transformDirection(camera.matrixWorld));
            }

            var intersections = _ray.intersectObjects(objects, recursive);
            return intersections[0] ? intersections[0] : null;
        }
    }
    THREE.TransformControls = TransformControls;
};