import {
    init_TransformGizmos
} from '../../thirdparty/three.js/TransformControls';
const debounce = require("lodash/debounce");

// Declared at the bottom, inside a function.
var SectionMeshClass = null;
var avp = Autodesk.Viewing.Private;

/**
 * Tool that provides visual controls for the user to change the cutplane's position and angle.
 * It can (and should) be hooked to [ToolController's registerTool]{@Autodesk.Viewing.ToolController#registerTool}
 *
 * The tool can operate in a rotated coordinate system to align cutplanes and boxes for example with the project
 * north instead of true north. Cutplanes, normals etc. are internally managed in local space to align with canonical axes.
 * Therefore the coordinate system transformation has to be applied when passing values in and out.
 * By default alignment with project north of the first 3D model is used if loaded with 'applyRefPoint=true', true north otherwise.
 *
 * @param {Autodesk.Viewing.Viewer3D} viewer - Viewer3D instance
 * @param {Object} config - Configuration values
 * @param {Object} options.tintColor - Object containing attributes r, g, b in the range [0..1]
 * @param {Number} options.tintIntensity - Value range [0..1]
 * @param {Number} [options.gizmoOffsetRight] - Right bound for the gizmo position in pixel
 * @param {Number} [options.gizmoOffsetLeft] - Left bound for the gizmo position in pixel
 * @param {Number} [options.gizmoOffsetTop] - Top bound for the gizmo position in pixel
 * @param {Number} [options.gizmoOffsetBottom] - Bottom bound for the gizmo position in pixel
 * @constructor
 */
export var SectionTool = function(viewer, options) {
    var _viewer = viewer.impl;

    var _names = ["section"];
    var _active = false;

    var _isDragging = false;
    var _boxChanged = false;
    var _isPlaneOn = true;
    var _tintColor = options.tintColor;
    var _tintIntensity = options.tintIntensity;

    var _transRotControl;
    var _transControl;
    var _gizmoOffsetRight = isNaN(options.gizmoOffsetRight) ? 200 : options.gizmoOffsetRight; // 200 So the gizmo won't be covered by the View Cube.
    var _gizmoOffsetLeft = isNaN(options.gizmoOffsetLeft) ? 80 : options.gizmoOffsetLeft;
    var _gizmoOffsetTop = isNaN(options.gizmoOffsetTop) ? 80 : options.gizmoOffsetTop;
    var _gizmoOffsetBottom = isNaN(options.gizmoOffsetBottom) ? 80 : options.gizmoOffsetBottom;
    var _controlOffset = new THREE.Vector3();
    var _controlNewPosition = new THREE.Vector3();

    var _sectionGroups = [];
    var _sectionPlanes = [];
    var _sectionPicker = [];
    var _activeMode = "";
    var _overlayName = "gizmo";
    var _touchType = null;
    var _initialized = false;
    var _visibleAtFirst = true;
    var _outlineIndices = [
        0, 1,
        1, 3,
        3, 2,
        2, 0
    ];
    var _priority = 70;
    var _selectionOpacity = 0.25;
    var _selectionColor = 0x287EEA;

    var _displaySectionHatches = true;

    let _transform, _inverseTransform, _normalMatrix, _inverseNormalMatrix;

    let _auxVec3 = new THREE.Vector3();

    /**
     * Stores a custom transform to apply to the section planes and gizmos
     * @param {THREE.Matrix4} transform - Transformation
     */
    function setTransform(transform) {
        _transform = transform;
        _inverseTransform = _transform.clone().invert();
        _normalMatrix = new THREE.Matrix3().getNormalMatrix(_transform);
        _inverseNormalMatrix = new THREE.Matrix3().getNormalMatrix(_inverseTransform);
    }

    /**
     * If the RefPoint transform is applied to the first model (we ignore other models at the moment), we return
     * the rotational part of it to align the section planes to project north. Otherwise we return an identity transform
     * to align with true north.
     *
     * @returns {THREE.Matrix4} Transformation matrix
     */
    function getDefaultTransform() {
        let transform = new THREE.Matrix4();

        const first3DModelData = _viewer.get3DModels()[0] ? .getData();
        if (first3DModelData && first3DModelData.loadOptions ? .applyRefPoint && first3DModelData.refPointTransform) {
            const refPointTransform = first3DModelData.refPointTransform;

            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            refPointTransform.decompose(position, quaternion, scale);

            transform.makeRotationFromQuaternion(quaternion);
        }

        return transform;
    }

    setTransform(getDefaultTransform());

    const sendAnalyticsDebounced = debounce((from, type, action) => {
        avp.analytics.track('viewer.section', {
            from: from,
            type: type,
            action: action,
        });
    }, 2000);

    init_TransformGizmos();
    init_SectionMesh();

    function initControl() {

        if (_initialized) {
            // Verify overlays are added.
            _viewer.addOverlay(_overlayName, _transRotControl);
            _viewer.addOverlay(_overlayName, _transControl);
            return;
        }

        _transRotControl = new THREE.TransformControls(_viewer.camera, _viewer.canvas, "transrotate");
        _transRotControl.addEventListener('change', updateViewer);
        _transRotControl.setSnap(Math.PI / 2, Math.PI / 36); // snap to 90 degs within 5 degs range

        _transControl = new THREE.TransformControls(_viewer.camera, _viewer.canvas, "translate");
        _transControl.addEventListener('change', updateViewer);
        _transControl.addEventListener('change', adjustGizmoToBounds);

        // add to overlay scene
        if (_viewer.overlayScenes[_overlayName] === undefined) {
            _viewer.createOverlayScene(_overlayName);
        }
        _viewer.addOverlay(_overlayName, _transRotControl);
        _viewer.addOverlay(_overlayName, _transControl);

        viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, updateControls);
        viewer.addEventListener(Autodesk.Viewing.ISOLATE_EVENT, updateSections);
        viewer.addEventListener(Autodesk.Viewing.HIDE_EVENT, updateSections);
        viewer.addEventListener(Autodesk.Viewing.SHOW_EVENT, updateSections);
        viewer.addEventListener(Autodesk.Viewing.MODEL_TRANSFORM_CHANGED_EVENT, updateSections);
        viewer.addEventListener(Autodesk.Viewing.FRAGMENTS_LOADED_EVENT, updateSections);
        viewer.addEventListener(Autodesk.Viewing.FRAGMENTS_UNLOADED_EVENT, updateSections);
        viewer.addEventListener(Autodesk.Viewing.SCENE_UPDATED_EVENT, onSceneUpdated);

        _initialized = true;
    }

    function deinitControl() {

        if (!_initialized)
            return;

        _viewer.removeOverlay(_overlayName, _transRotControl);
        _transRotControl.removeEventListener('change', updateViewer);
        _transRotControl = null;
        _viewer.removeOverlay(_overlayName, _transControl);
        _transControl.removeEventListener('change', updateViewer);
        _transControl.removeEventListener('change', adjustGizmoToBounds);
        _transControl = null;
        _viewer.removeOverlayScene(_overlayName);

        viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, updateControls);
        viewer.removeEventListener(Autodesk.Viewing.ISOLATE_EVENT, updateSections);
        viewer.removeEventListener(Autodesk.Viewing.HIDE_EVENT, updateSections);
        viewer.removeEventListener(Autodesk.Viewing.SHOW_EVENT, updateSections);
        viewer.removeEventListener(Autodesk.Viewing.MODEL_TRANSFORM_CHANGED_EVENT, updateSections);
        viewer.removeEventListener(Autodesk.Viewing.FRAGMENTS_LOADED_EVENT, updateSections);
        viewer.removeEventListener(Autodesk.Viewing.FRAGMENTS_UNLOADED_EVENT, updateSections);
        viewer.removeEventListener(Autodesk.Viewing.SCENE_UPDATED_EVENT, onSceneUpdated);

        _initialized = false;
    }

    function updateViewer() {
        _viewer.invalidate(false, false, true);
    }

    function updateControls() {

        adjustGizmoToBounds();

        if (_transRotControl) {
            _transRotControl.update();
        }
        if (_transControl) {
            _transControl.update();
        }
    }

    /**
     * Clamp position to screen bounds
     * @param {THREE.Vector3} position - Position in world space to test
     * @returns {THREE.Vector3|undefined} Clamped if position was out of bounds, undefined otherwise
     */
    function getClampedGizmoPosition(position) {
        const client = _viewer.worldToClient(position);
        const rect = _viewer.getCanvasBoundingClientRect();
        let target = new THREE.Vector3().copy(client);

        if (client.x < _gizmoOffsetLeft) {
            target.x = _gizmoOffsetLeft;
        } else if (client.x > rect.width - _gizmoOffsetRight) {
            target.x = rect.width - _gizmoOffsetRight;
        }

        if (client.y < _gizmoOffsetTop) {
            target.y = _gizmoOffsetTop;
        } else if (client.y > rect.height - _gizmoOffsetBottom) {
            target.y = rect.height - _gizmoOffsetBottom;
        }

        return target.x !== client.x || target.y !== client.y ? target : undefined;
    }

    /**
     * Try to keep the gizmo in the valid screen bounds
     */
    function adjustGizmoToBounds() {

        if (!_transRotControl || !_transRotControl.object) {
            return;
        }

        // Adjust gizmo position if it is out of bounds
        let gizmoNewClientPos = getClampedGizmoPosition(_transRotControl.position);
        if (gizmoNewClientPos) {
            const intersection = THREE.TransformControls.intersectObjects(gizmoNewClientPos.x, gizmoNewClientPos.y, [_transRotControl.object], _viewer.camera, false);
            if (intersection) {
                _transRotControl.object.getWorldPosition(_controlOffset);
                _controlNewPosition.copy(intersection.point).sub(_controlOffset);
                _transRotControl.setGizmoOffset(_controlNewPosition);
            }
        }
    }

    function updateSections() {
        if (_active && _sectionPlanes.length === 1) {
            updatePlaneMeshes(true);
            updateControls();
            updateCapMeshes(new THREE.Plane().setComponents(_sectionPlanes[0].x, _sectionPlanes[0].y, _sectionPlanes[0].z, _sectionPlanes[0].w));
        }
    }

    function onSceneUpdated({
        objectsMoved
    }) {
        if (objectsMoved) {
            updateSections();
        }
    }

    /*function mix(a, b, val) {
        return a * (1.0 - val) + b * val;
    }*/

    function getDiffuseColor(material) {
        return (material && material.color) || new THREE.Color(0xffffff);
    }

    /*function getSpecularColor(material) {
        return (material && material.specular) || new THREE.Color(0xffffff);
    }

    function tintColor(c) {
        var intensity = Autodesk.Viewing.Extensions.Section.tintIntensity;
        var tc = _tintColor;
        c.r = mix(c.r, tc.r, intensity);
        c.g = mix(c.g, tc.g, intensity);
        c.b = mix(c.b, tc.b, intensity);
    }*/

    // Use the same fragment iterator for all fragments
    var _fragIterator = new avp.FragmentIterator({
        delay: 50
    });

    function updateCapMeshes(plane) {
        if (!_displaySectionHatches) {
            // LMV-5781: Do not render the section hatches if the preference is turned on.
            return;
        }
        const cg = Autodesk.Viewing.Extensions.CompGeom;

        //When drawing a 2D material in 3D space we will want to skip binding the G-buffer
        //when rendering the scene that contains that material
        _viewer.sceneAfter.skipDepthTarget = true;

        _removeSections();

        var section3D = new THREE.Object3D();
        section3D.name = "section3D";
        _viewer.scene.add(section3D);

        var section2D = new THREE.Object3D();
        section2D.name = "section2D";
        _viewer.sceneAfter.add(section2D);

        var toPlaneCoords = cg.makePlaneBasis(plane);
        var fromPaneCoords = toPlaneCoords.clone().invert();

        var mat2dname = _viewer.matman().create2DMaterial(null, {
            skipCircles: true,
            skipEllipticals: true,
            isScreenSpace: true,
            noIdOutput: true
        }, false, false);
        var mat2d = _viewer.matman().findMaterial(null, mat2dname);
        mat2d.transparent = true;
        mat2d.depthTest = true;
        mat2d.polygonOffset = true;
        mat2d.polygonOffsetFactor = -1;
        mat2d.polygonOffsetUnits = 0.1; // 1.0 is usually way too high, see LMV-1072
        mat2d.cutplanes = _otherCutPlanes; // make sure that cap meshes respect cutplanes from other tools
        mat2d.doNotCut = true;

        var box = new THREE.Box3();

        var models = _viewer.modelQueue().getModels().filter(m => !m.getDoNotCut());

        var intersects = [];
        var material;
        const matrixWorld = new THREE.Matrix4();

        // Start iterating the fragments
        _fragIterator.start(models, function(fragId, dbId, model, lastFrag) {

            // Collect intersections for this fragment
            var frags = model.getFragmentList();
            if (frags.isFragVisible(fragId)) {
                frags.getWorldBounds(fragId, box);
                if (cg.xBoxPlane(plane, box)) {
                    const geometry = frags.getGeometry(fragId);
                    const _material = frags.getMaterial(fragId);

                    if (geometry && !geometry.is2d && !geometry.isLines && _material.cutplanes) {
                        material = _material;
                        frags.getWorldMatrix(fragId, matrixWorld);
                        cg.xMeshPlane(plane, {
                            geometry,
                            matrixWorld,
                            fragId
                        }, intersects);
                    }
                }
            }

            // If this is the last fragment for dbId, process the intersections
            if (lastFrag) {
                if (intersects.length) {

                    var bbox = new THREE.Box3();
                    cg.convertToPlaneCoords(toPlaneCoords, intersects, bbox);

                    //Create the 2D line geometry
                    var vbb = new avp.VertexBufferBuilder(false, 8 * intersects.length);

                    var color = getDiffuseColor(material);
                    var r = 0 | (color.r * 0.25) * 255.5;
                    var g = 0 | (color.g * 0.25) * 255.5;
                    var b = 0 | (color.b * 0.25) * 255.5;

                    var c = 0xff000000 | (b << 16) | (g << 8) | r;


                    var eset = new cg.EdgeSet(intersects, bbox, bbox.getSize(new THREE.Vector3()).length() * 1e-6);
                    eset.snapEdges();
                    eset.sanitizeEdges();
                    eset.stitchContours();

                    //Create the 3D mesh
                    var cset = eset.triangulate({
                        skipOpenContour: true
                    });

                    if (cset) {

                        for (let j = 0; j < cset.contours.length; j++) {

                            var cntr = cset.contours[j];

                            for (var k = 1; k < cntr.length; k++) {
                                var pt1 = cset.pts[cntr[k - 1]];
                                var pt2 = cset.pts[cntr[k]];
                                vbb.addSegment(pt1.x, pt1.y, pt2.x, pt2.y, 0, -2.0, /*isClosed ? c : rc*/ c, dbId, 0);
                            }

                        }


                        var mdata = {
                            mesh: vbb.toMesh()
                        };

                        var bg2d = avp.BufferGeometryUtils.meshToGeometry(mdata);

                        bg2d.streamingDraw = true;
                        bg2d.streamingIndex = true;

                        var mesh2d = new THREE.Mesh(bg2d, mat2d);

                        mesh2d.matrix.copy(fromPaneCoords);
                        mesh2d.matrixAutoUpdate = false;
                        mesh2d.frustumCulled = false;
                        mesh2d.modelId = model.id; // So we can look it up later
                        mesh2d.dbId = dbId;
                        section2D.add(mesh2d);

                        //Create triangulated capping polygon
                        {
                            if (!cset.triangulationFailed) {

                                var bg = cset.toPolygonMesh(material.packedNormals);

                                var mat = _viewer.matman().cloneMaterial(material, model);

                                // If the material is prism, clear all the map definitions.
                                if (mat.prismType != null) {
                                    mat.defines = {};
                                    mat.defines[mat.prismType.toUpperCase()] = "";
                                    if (mat.prismType == "PrismWood") {
                                        mat.defines["NO_UVW"] = "";
                                    }
                                }

                                mat.packedNormals = material.packedNormals;
                                mat.mrtIdBuffer = material.mrtIdBuffer;
                                mat.mrtNormals = material.mrtNormals;
                                mat.cutplanes = _otherCutPlanes; // make sure that cap meshes respect cutplanes from other tools
                                mat.side = THREE.FrontSide;
                                mat.depthTest = true;
                                mat.map = null;
                                mat.bumpMap = null;
                                mat.normalMap = null;
                                mat.alphaMap = null;
                                mat.specularMap = null;
                                mat.transparent = false;
                                mat.depthWrite = true;
                                mat.hatchPattern = true;
                                mat.needsUpdate = true;
                                mat.doNotCut = true;

                                var materialId = material.id + 2;
                                var angle = materialId * Math.PI * 0.125;
                                var tan = Math.tan(angle);
                                mat.hatchParams = new THREE.Vector2(tan, 10.0);
                                mat.hatchTintColor = new THREE.Color(_tintColor.r, _tintColor.g, _tintColor.b);
                                mat.hatchTintIntensity = _tintIntensity;

                                var capmesh = new THREE.Mesh(bg, mat);
                                capmesh.matrix.copy(fromPaneCoords);
                                capmesh.matrixAutoUpdate = false;
                                capmesh.modelId = model.id; // So we can look it up later
                                capmesh.dbId = dbId;
                                capmesh.fragId = intersects.fragId;

                                section3D.add(capmesh);
                            }

                        }

                    }
                }

                // Clear intersections for the next dbId
                intersects.length = 0;
            } // last Fragment for dbId

        }, () => {
            // The cap scene is in sceneAfter, so we need to redraw the model to see the caps.
            // LMV-2571 - clear the render, as otherwise we will draw transparent objects atop themselves.
            _viewer.invalidate(true, true);
        }); //_fragIterator.start

    }

    // We use an own cut plane set to distinguish our own cut planes from others.
    var _ownCutPlaneSet = 'Autodesk.Viewing.Extension.Section.SectionTool';

    // Make sure that the viewer always uses the SectionTool's plane to adjust 2D rendering resolution.
    _viewer.setCutPlaneSetFor2DRendering(_ownCutPlaneSet);

    // Keep track of cutplanes that are not our own, because we have to apply them to our cap meshes
    var _otherCutPlanes = [];

    // Trigger update of cap mesh materials if number of cutplanes have changed by other tools
    function updateCapMaterials(mrtOnly) {

        function update(section) {
            // apply cutplanes to all active cap meshes
            if (!section) {
                return;
            }

            section.traverse(function(obj) {
                // we only care for THREE.Mesh with material
                if (!(obj instanceof THREE.Mesh) || !obj.material) {
                    return;
                }
                if (mrtOnly) {
                    _viewer.matman().adjustMaterialMRTSetting(obj.material);
                } else {
                    obj.material.needsUpdate = true;
                }
            });
        }

        update(_viewer.scene.getObjectByName("section3D"));
        update(_viewer.sceneAfter.getObjectByName("section2D"));
    }

    /**
     * Returns all transformed bounding box corners
     * @param {THREE.Box3} bbox - Input Bounding Box
     * @param {THREE.Matrix4} transform - Transformation to apply to each point
     * @returns {THREE.Vector3[]} Transformed corners
     */
    function getBBoxCorners(bbox, transform) {
        var points = [
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.max.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z).applyMatrix4(transform),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.max.z).applyMatrix4(transform),
        ];
        return points;
    }

    /**
     * Creates quadratic triangle and outline meshes for the given plane
     * @param {THREE.Plane} plane
     * @param {THREE.Vector3} position - Mesh position, will be reprojected to plane
     * @param {Number} [size] - Size of the plane mesh
     * @returns {SectionMesh}
     */
    function createPlaneMesh(plane, position, size = 1) {
        var quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
        var geometry;

        geometry = new THREE.PlaneBufferGeometry(size, size);

        var material = new THREE.MeshBasicMaterial({
            opacity: 0,
            color: _selectionColor,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
            transparent: true
        });

        var mesh = new SectionMeshClass(geometry, material, plane);
        const pt = plane.projectPoint(position, new THREE.Vector3());
        mesh.position.copy(pt);
        mesh.quaternion.multiply(quat);

        // add outline with inverted background color
        var presetIndex = _viewer.currentLightPreset();
        presetIndex = Math.max(0, presetIndex);
        var bgColor = Autodesk.Viewing.Private.LightPresets[presetIndex].bgColorGradient;
        // TODO: these calculations can lead to float colors, which are ignored by three.js and instead interpreted as white
        // In r125 the float colors generate an "Unknown color" warning
        var color = "rgb(" + (255 - bgColor[0]) + "," + (255 - bgColor[1]) + "," + (255 - bgColor[2]) + ")";
        var lineMaterial = new THREE.LineBasicMaterial({
            color: color,
            linewidth: 1,
            depthTest: false,
            depthWrite: false,
            transparent: true
        });

        var pos = mesh.geometry.getAttribute('position');
        const vertices = [];
        for (var i = 0; i < _outlineIndices.length; i++) {
            vertices.push(new THREE.Vector3().fromBufferAttribute(pos, _outlineIndices[i]));
        }

        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), lineMaterial);
        mesh.add(line);
        mesh.outline = line;

        return mesh;
    }

    function updatePlaneMeshes(rebuild) {

        traverseSections(function(child) {
            if (child instanceof SectionMeshClass) {

                let pos;
                if (child.connectivity.length > 0) {
                    // section box
                    var minv = child.matrixWorld.clone().invert();
                    const pt = new THREE.Vector3();
                    pos = child.geometry.getAttribute('position');
                    for (let i = 0; i < pos.count; i++) {
                        var connect = child.connectivity[i];
                        if (intersectPlanes(child.plane, connect[0], connect[1], pt) !== null) {
                            pt.applyMatrix4(minv);
                            pos.setXYZ(i, pt.x, pt.y, pt.z);
                        }
                    }
                    pos.needsUpdate = true;
                    child.geometry.computeBoundingBox();
                    child.geometry.computeBoundingSphere();
                } else if (rebuild) {
                    // section plane
                    var bbox = _viewer.getVisibleBounds();
                    var size = 2.0 * bbox.getBoundingSphere(new THREE.Sphere()).radius;
                    const pt = child.plane.projectPoint(bbox.getCenter(new THREE.Vector3()), new THREE.Vector3());
                    child.geometry = new THREE.PlaneBufferGeometry(size, size);
                    child.position.copy(pt);

                    pos = child.geometry.getAttribute('position');
                }
                if (pos) {
                    for (let i = 0; i < _outlineIndices.length; i++) {
                        child.outline.geometry.attributes.position.setXYZ(i,
                            pos.getX(_outlineIndices[i]),
                            pos.getY(_outlineIndices[i]),
                            pos.getZ(_outlineIndices[i])
                        );
                    }
                    child.outline.geometry.attributes.position.needsUpdate = true;
                }
            }
        });
    }

    function traverseSections(callback) {
        for (var i = 0; i < _sectionGroups.length; i++) {
            _sectionGroups[i].traverse(callback);
        }
    }

    function setSectionPlanes(fireEvent = true) {
        traverseSections(function(child) {
            if (child instanceof SectionMeshClass) {
                child.update();
            }
        });
        if (_sectionPlanes.length === 1) {
            updateCapMeshes(new THREE.Plane().setComponents(_sectionPlanes[0].x, _sectionPlanes[0].y, _sectionPlanes[0].z, _sectionPlanes[0].w));
        }
        _viewer.setCutPlaneSet(_ownCutPlaneSet, _sectionPlanes, fireEvent);
    }

    function showPlane(set) {
        for (var i = 0; i < _sectionGroups.length; i++) {
            _sectionGroups[i].visible = set;
        }

        if (_isPlaneOn !== set)
            updateViewer();

        _isPlaneOn = set;
    }

    function showSection(set) {
        if (set && _sectionPlanes.length > 0) {
            if (_sectionPlanes.length === 1) {
                updateCapMeshes(new THREE.Plane().setComponents(_sectionPlanes[0].x, _sectionPlanes[0].y, _sectionPlanes[0].z, _sectionPlanes[0].w));
            }
            _viewer.setCutPlaneSet(_ownCutPlaneSet, _sectionPlanes);
        }
        showPlane(set);
    }

    function attachControl(control, mesh) {
        control.attach(mesh);
        control.setPosition(mesh.position);
        control.visible = true;
    }

    /**
     * Checks whether the normal points away from the camera and if so flips it
     * @param {THREE.Vector3} normal
     * @returns true, if normal was flipped
     */
    function checkNormal(normal) {
        // flip normal if facing inward as eye direction
        var eyeVec = _viewer.api.navigation.getEyeVector();
        if (eyeVec.dot(normal) > 0) {
            normal.negate();
            return true;
        }

        return false;
    }

    /**
     * Does the normal need to be flipped to point to the camera ?
     * @param {THREE.Vector3} normal
     * @returns {Boolean} True, if it needs to be flipped
     */
    function shouldFlipNormal(normal) {
        // flip normal if facing inward as eye direction
        var eyeVec = _viewer.api.navigation.getEyeVector();
        return eyeVec.dot(normal) > 0;
    }

    /**
     * Define plane in local space
     * @param {THREE.Vector3} normal - Plane normal in local space
     */
    this.setPlaneLocal = function(normal) {
        let normalWorld = normal.clone().applyMatrix3(_normalMatrix).normalize();
        this.setPlane(normalWorld, undefined, true, true);
    };

    /**
     * Define plane in world space
     * @param {THREE.Vector3} normal - Plane normal in world space
     * @param {Number} [distance] - Plane distance in world space,
     *                              uses distance to intersection through screen center if none is provided
     * @param {Boolean} [fireEvent] - If ture, fire cutplane change event
     * @param {Boolean} [checkNormal] - If true, plane gets oriented towards the camera
     */
    this.setPlane = function(normal, distance, fireEvent = true, checkNormal = false) {
        var obbox = _viewer.getVisibleBounds();
        var center = obbox.getCenter(new THREE.Vector3());
        var group = new THREE.Group();

        group.applyMatrix4(_transform);
        group.updateMatrixWorld();

        if (!distance)
            distance = this.getSectionDistance(normal);

        if (checkNormal && shouldFlipNormal(normal)) {
            normal.negate();
            distance = -distance;
        }

        // Calculate the plane signed distance using the dot product of the center point of the scene bounding box
        // and the normal vector.
        distance = (distance !== undefined) ? distance : -1 * center.dot(normal);

        // Plane and mesh are defined in local space so we need to transform normal and center first
        var plane = new THREE.Plane(normal.clone().applyMatrix3(_inverseNormalMatrix).normalize(), distance);
        var mesh = createPlaneMesh(plane,
            center.clone().applyMatrix4(_inverseTransform),
            2.0 * obbox.getBoundingSphere(new THREE.Sphere()).radius);

        group.add(mesh);

        // Apply transformations before using the plane info
        mesh.update();

        _sectionPlanes.push(mesh.planeVec);
        _sectionGroups.push(group);
        _viewer.addOverlay(_overlayName, group);
        if (_transRotControl) {
            attachControl(_transRotControl, mesh);
            mesh.material.opacity = 0;
            centerPlaneArrow(mesh);
            _transRotControl.showRotationGizmos(true);
            _sectionPicker = _transRotControl.getPicker();

        }
        setSectionPlanes(fireEvent);
        if (_active) {
            updateControls();
        }
    };

    function getCenterPoint(mesh) {
        var middle = new THREE.Vector3();
        var geometry = mesh.geometry;

        geometry.computeBoundingBox();

        middle.x = (geometry.boundingBox.max.x + geometry.boundingBox.min.x) / 2;
        middle.y = (geometry.boundingBox.max.y + geometry.boundingBox.min.y) / 2;
        middle.z = (geometry.boundingBox.max.z + geometry.boundingBox.min.z) / 2;

        mesh.localToWorld(middle);
        return middle;
    }

    /**
     * Places the arrow at the center of the passed mesh.
     * @param {THREE.Mesh} mesh - Plane mesh
     * @returns {Boolean} True, if the arrow could be placed
     */
    function centerPlaneArrow(mesh) {
        if (!_transRotControl || !mesh) return false;
        // Get the center of the plane and
        // calculate the x,y,z offset between the plane position and the plane center
        var centerOffset = getCenterPoint(mesh).sub(mesh.getWorldPosition(new THREE.Vector3()));

        // Set the gizmo offset
        _transRotControl.setGizmoOffset(centerOffset);
        return true;
    }

    /**
     * Computes the maximal distance between the transformed corner points of the AABox and a plane
     * @param {THREE.Box3} bbox - Axis Aligned Bounding Box
     * @param {THREE.Plane} plane
     * @param {THREE.Matrix4} [transform] - Transform to apply
     * @returns {Number} Maximal distance
     */
    function getMaxDistanceToPlane(bbox, plane, transform = new THREE.Matrix4()) {
        let points = getBBoxCorners(bbox, transform);
        let max = Number.MIN_VALUE;

        for (let i = 0; i < points.length; ++i) {
            const perpendicularMagnitude = plane.distanceToPoint(points[i]);
            if (perpendicularMagnitude > max)
                max = perpendicularMagnitude;
        }
        return max;
    }

    function setBox(planeSet) {
        var normals = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, -1)
        ];

        var connectivities = [
            [
                [1, 2],
                [1, 5],
                [2, 4],
                [4, 5]
            ], // 0
            [
                [3, 5],
                [0, 5],
                [2, 3],
                [0, 2]
            ], // 1
            [
                [1, 3],
                [0, 1],
                [3, 4],
                [0, 4]
            ], // 2
            [
                [1, 5],
                [1, 2],
                [4, 5],
                [2, 4]
            ], // 3
            [
                [2, 3],
                [0, 2],
                [3, 5],
                [0, 5]
            ], // 4
            [
                [0, 1],
                [3, 1],
                [0, 4],
                [3, 4]
            ] // 5
        ];

        var group = new THREE.Group();
        var obbox = _viewer.getVisibleBounds();
        var bbox = new THREE.Box3(obbox.min, obbox.getCenter(new THREE.Vector3()));
        var centerGlobal = bbox.getCenter(new THREE.Vector3());
        var planes = [],
            meshes = [];
        var mesh, plane;

        // Initialize from planeSet ONLY if it's an AABB.
        var loadingBox = false;
        if (planeSet && planeSet.length === 6) {
            // Transform planes to local space
            for (let i = 0; i < planeSet.length; ++i) {
                let plane = new THREE.Plane(new THREE.Vector3(planeSet[i].x, planeSet[i].y, planeSet[i].z), planeSet[i].w);
                plane.applyMatrix4(_inverseTransform);
                planes.push(plane);
            }

            if (1.0 - planes[0].normal.x <= Number.EPSILON) {
                // Assume that the order on planes is the same as in Array of normals defined above
                bbox = new THREE.Box3(
                    new THREE.Vector3(planes[3].constant, planes[4].constant, planes[5].constant),
                    new THREE.Vector3(-planes[0].constant, -planes[1].constant, -planes[2].constant)
                );

                centerGlobal = bbox.getCenter(new THREE.Vector3()).applyMatrix4(_transform);
                loadingBox = true;
            }
        }

        ////center = obbox.max;   // Use this to initialize the box around the model
        ////bbox = obbox.clone(); // Use this to initialize the box around the model

        group.applyMatrix4(_transform);
        group.updateMatrixWorld();

        for (let i = 0; i < normals.length; i++) {
            if (!loadingBox) {
                plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normals[i], centerGlobal.clone().applyMatrix4(_inverseTransform));
                let offset = getMaxDistanceToPlane(bbox, plane, _inverseTransform);

                plane.constant -= offset;
                planes.push(plane);
            }

            mesh = createPlaneMesh(planes[i], centerGlobal);

            group.add(mesh);
            meshes.push(mesh);
            mesh.update();

            _sectionPlanes.push(mesh.planeVec);
        }

        // build connectivity
        for (let i = 0; i < meshes.length; i++) {
            mesh = meshes[i];
            var connectivity = connectivities[i];
            for (var j = 0; j < connectivity.length; j++) {
                var nc = [];
                var ct = connectivity[j];
                for (var k = 0; k < ct.length; k++) {
                    nc.push(planes[ct[k]]);
                }
                mesh.connectivity.push(nc);
            }
        }

        _sectionGroups.push(group);
        _viewer.addOverlay(_overlayName, group);

        setSectionPlanes();
        updatePlaneMeshes();

        plane = _sectionGroups[0].children[0];
        attachControl(_transRotControl, plane);
        // Set the plane opacity
        plane.material.opacity = _selectionOpacity;
        centerPlaneArrow(plane);

        attachControl(_transControl, _sectionGroups[0]);
        _transRotControl.showRotationGizmos(false);
        _sectionPicker = _transRotControl.getPicker().concat(_transControl.getPicker());
        // Calculate the offset to the max point of the bounding box.
        var cornerOffset = new THREE.Vector3();
        if (intersectPlanes(planes[0], planes[1], planes[2], cornerOffset) !== null) {
            _transControl.setGizmoOffset(cornerOffset.add(new THREE.Vector3().setFromMatrixPosition(_transform).negate()));
        }
    }

    var intersectPlanes = (function() {
        var m = new THREE.Matrix3();
        var n23 = new THREE.Vector3();
        var n31 = new THREE.Vector3();
        var n12 = new THREE.Vector3();
        return function(plane1, plane2, plane3, optionalTarget) {
            m.set(plane1.normal.x, plane1.normal.y, plane1.normal.z,
                plane2.normal.x, plane2.normal.y, plane2.normal.z,
                plane3.normal.x, plane3.normal.y, plane3.normal.z);

            var det = m.determinant();
            if (det === 0) return null;

            n23.crossVectors(plane2.normal, plane3.normal).multiplyScalar(-plane1.constant);
            n31.crossVectors(plane3.normal, plane1.normal).multiplyScalar(-plane2.constant);
            n12.crossVectors(plane1.normal, plane2.normal).multiplyScalar(-plane3.constant);

            var result = optionalTarget || new THREE.Vector3();
            return result.copy(n23).add(n31).add(n12).divideScalar(det);
        };
    })();

    var intersectObjects = function(pointer, objects, recursive) {
        return THREE.TransformControls.intersectObjects(pointer.canvasX, pointer.canvasY, objects, _viewer.camera, recursive);
    };

    // public functions

    /**
     * When active, the geometry will be sectioned by the current set cut plane.
     * @returns {boolean}
     */
    this.isActive = function() {
        return _active;
    };

    /**
     * Returns the signed distance of the sectioning plane from the origin
     * @returns {Number} distance. Null distance is returned if there is no hit found from raycast
     */
    this.getSectionDistance = function(normal) {
        // Find a target point in the direction of the camera
        var eyeVec = _viewer.api.navigation.getEyeVector();
        var hit = _viewer.rayIntersect(new THREE.Ray(_viewer.camera.position, eyeVec));

        // Distance
        return hit && hit.intersectPoint && -1 * hit.intersectPoint.dot(normal);
    };

    /**
     * Enables the cut planes that were created by the viewer.setCutPlanes() function.
     * @param {boolean} [fireEvent] - if set to false the av.CUTPLANES_CHANGE_EVENT event will not be fired.
     */
    this.setViewerSection = function(fireEvent = true) {
        this.clearSection(fireEvent);
        var normal;
        // Attempt to initialize the tool with a plane that is already set.
        var planeSet = _viewer.getCutPlaneSet('__set_view');
        if (planeSet.length !== 1) return;

        _transRotControl.clientScale = 1;
        var v4 = planeSet[0];
        normal = new THREE.Vector3(v4.x, v4.y, v4.z);
        var distance = v4.w;
        this.setPlane(normal, distance, fireEvent);
        _activeMode = 'SET_VIEW_PLANE';
        // Clear sections from Viewer3D::setView
        _viewer.setCutPlaneSet('__set_view', undefined, fireEvent);
    };



    /**
     * Facilitates the initialization of a cut plane
     *
     * @param {String} name - Either 'X', 'Y', 'Z', 'BOX', 'OBJ_BOX', 'OBJ_SET_VIEW_PLANE' or 'SET_VIEW_PLANE'
     */
    this.setSection = function(name) {
        this.clearSection();
        var normal;
        _transRotControl.clientScale = 1;

        // Attempt to initialize the tool with a plane that is already set.
        var planeSet = _viewer.getCutPlaneSet('__set_view');
        if (planeSet.length === 1 && name !== 'BOX' && name !== 'OBJ_SET_VIEW_PLANE') {
            name = 'SET_VIEW_PLANE';
        }
        switch (name) {
            case 'X':
                normal = new THREE.Vector3(1, 0, 0);
                this.setPlaneLocal(normal);
                break;
            case 'Y':
                normal = new THREE.Vector3(0, 1, 0);
                this.setPlaneLocal(normal);
                break;
            case 'Z':
                normal = new THREE.Vector3(0, 0, 1);
                this.setPlaneLocal(normal);
                break;
            case 'OBJ_SET_VIEW_PLANE':
            case 'SET_VIEW_PLANE':
                var v4 = planeSet[0];
                normal = new THREE.Vector3(v4.x, v4.y, v4.z);
                this.setPlane(normal, v4.w);
                break;
            case 'OBJ_BOX':
            case 'BOX':
                setBox(planeSet);
                _transRotControl.clientScale = 2;
                this.recomputePivot();
                break;
        }
        _activeMode = name;

        // Clear sections from Viewer3D::setView
        _viewer.setCutPlaneSet('__set_view', undefined);
    };

    /**
     * Facilitates the initialization of a cut plane from a normal and distance
     *
     * @param {THREE.Vector4} normal (x,y,z) and distance (w)
     * @param {Number} distance
     */
    this.setSectionFromPlane = function(cutplane) {
        this.clearSection();
        this.setPlane(new THREE.Vector3(cutplane.x, cutplane.y, cutplane.z), cutplane.w);
        _activeMode = "";

        // Clear sections from Viewer3D::setView
        _viewer.setCutPlaneSet('__set_view', undefined);
    };

    /**
     * Set the active mode
     * @param {string} [name] - active mode name
     * @private
     */
    this.setActiveMode = function(name) {
        _activeMode = name || "";
    };

    /**
     * Remove the section graphics
     */
    function _removeSections() {
        var oldsection3D = _viewer.scene.getObjectByName("section3D");
        if (oldsection3D)
            _viewer.scene.remove(oldsection3D);
        var oldsection2D = _viewer.sceneAfter.getObjectByName("section2D");
        if (oldsection2D)
            _viewer.sceneAfter.remove(oldsection2D);
    }

    this.setDisplaySectionHatches = function(value) {
        _displaySectionHatches = value;
    };

    this.clearCapMeshes = function() {
        _removeSections();
    };

    this.updateCapMeshes = function(plane, capMeshOnly) {
        if (!plane) {
            return;
        }

        if (!capMeshOnly) {
            this.setPlane(plane.normal, plane.constant);
        }
        updateCapMeshes(plane);
    };

    /**
     * Removes any (and all) currently set cut plane(s).
     * @param {boolean} [fireEvent] - if set to false the av.CUTPLANES_CHANGE_EVENT event will not be fired.
     */
    this.clearSection = function(fireEvent = true) {

        if (_transRotControl)
            _transRotControl.detach();

        if (_transControl)
            _transControl.detach();

        // remove all sections
        while (_sectionPlanes.length > 0) {
            _sectionPlanes.pop();
        }

        while (_sectionGroups.length > 0) {
            var group = _sectionGroups.pop();
            _viewer.removeOverlay(_overlayName, group);
        }

        _fragIterator.start(null); // Shutdown iterator
        _removeSections();

        _viewer.setCutPlaneSet(_ownCutPlaneSet, null, fireEvent);
    };

    this.isPlaneOn = function() {
        return _isPlaneOn;
    };

    this.showPlane = function(set) {
        showPlane(set);
    };

    /**
     * Whether translation and rotation controls are visible or not.
     * @param {Boolean} set
     */
    this.attachControl = function(set) {
        if (!_transRotControl || !_transControl) {
            return;
        }

        if (set) {
            attachControl(_transRotControl, _sectionGroups[0].children[0]);
            _transRotControl.highlight();
            if (_activeMode === 'BOX')
                attachControl(_transControl, _sectionGroups[0]);
        } else {
            _transRotControl.detach();
            _transControl.detach();
        }
    };

    /**
     * Invokes setSection with the last set of parameters used.
     */
    this.resetSection = function() {
        this.setSection(_activeMode);
    };

    // tool interface

    this.getNames = function() {
        return _names;
    };

    this.getName = function() {
        return _names[0];
    };

    this.register = function() {};

    this.deregister = function() {
        this.clearSection();
        deinitControl();
    };

    this.getPriority = function() {
        return _priority;
    };

    /**
     * [ToolInterface] Activates the tool
     * @param {String} name - unused
     */
    this.activate = function( /*name*/ ) {

        setTransform(getDefaultTransform());

        initControl();

        _active = true;
        _isDragging = false;
        _visibleAtFirst = true;

        // keep only one section all the time per design
        _sectionPlanes = _sectionPlanes || [];

        showSection(true);
    };

    /**
     * [ToolInterface] Deactivates the tool
     * @param {String} name - unused
     */
    this.deactivate = function( /*name*/ ) {
        _active = false;
        _isDragging = false;

        if (!this.keepCutPlanesOnDeactivate) {
            // Clean sections and gizmos when deactivating the tool.
            _fragIterator.start(null); // Shutdown iterator
            _removeSections();

            showSection(false);
            _viewer.setCutPlaneSet(_ownCutPlaneSet);
        } else {
            // In case that keepCutPlanesOnDeactivate is set, the control gizmos will disappear, but the sections will stay.
            _viewer.removeOverlay(_overlayName, _transRotControl);
            _viewer.removeOverlay(_overlayName, _transControl);

            for (let i = 0; i < _sectionGroups.length; i++) {
                _viewer.removeOverlay(_overlayName, _sectionGroups[i]);
            }
        }

        _transRotControl.detach();
        _transControl.detach();
    };

    this.update = function( /*highResTimestamp*/ ) {
        return false;
    };

    this.handleSingleClick = function(event /*, button*/ ) {
        var pointer = event;
        var result = intersectObjects(pointer, _sectionGroups[0] ? .children);
        _sectionGroups[0].children.forEach(function(child) {
            child.material.opacity = 0;
        });

        if (result) {
            const prevObject = _transRotControl.object;
            attachControl(_transRotControl, result.object);
            _transRotControl.highlight();
            result.object.material.opacity = _sectionPlanes.length > 1 ? _selectionOpacity : 0;
            // Only in case of a section box, and only when clicking on a different plane - re-center the arrow.
            if (_sectionGroups[0] ? .children.length > 1 && prevObject !== result.object) {
                centerPlaneArrow(result.object);
            }
            updateViewer();
            adjustGizmoToBounds();
        }

        return false;
    };

    this.handleDoubleClick = function( /*event, button*/ ) {
        return false;
    };

    this.handleSingleTap = function(event) {
        return this.handleSingleClick(event, 0);
    };

    this.handleDoubleTap = function( /*event*/ ) {
        return false;
    };

    this.handleKeyDown = function( /*event, keyCode*/ ) {
        return false;
    };

    this.handleKeyUp = function( /*event, keyCode*/ ) {
        return false;
    };

    this.handleWheelInput = function( /*delta*/ ) {
        return false;
    };

    this.handleButtonDown = function(event /*, button*/ ) {
        _isDragging = true;
        if (_transControl.onPointerDown(event))
            return true;
        return _transRotControl.onPointerDown(event);
    };

    this.handleButtonUp = function(event /*, button*/ ) {
        _isDragging = false;
        if (_boxChanged) {
            _boxChanged = false;
            this.recomputePivot();
        }
        if (_transControl.onPointerUp(event))
            return true;
        return _transRotControl.onPointerUp(event);
    };

    this.handleMouseMove = function(event) {
        if (_isDragging) {
            if (_transControl.onPointerMove(event)) {
                _boxChanged = true;
                setSectionPlanes();
                _transRotControl.update();

                sendAnalyticsDebounced('Canvas', 'Box', 'translate');

                return true;
            }
            if (_transRotControl.onPointerMove(event)) {
                _boxChanged = true;
                setSectionPlanes();
                updatePlaneMeshes();
                // TODO: Try to position the triad to the max corner of the section box when moving the plane arrow.
                // Currently, it is positioned at the max point of the section box.

                if (_activeMode.includes('BOX'))
                    sendAnalyticsDebounced('Canvas', 'Box', 'transform');
                else {
                    const mode = _transRotControl.axis.search("R") != -1 ? "rotate" : "translate";
                    sendAnalyticsDebounced('Canvas', 'Plane', mode);
                }

                return true;
            }
        }

        _transControl.visible = _transControl.object !== undefined;

        if (event.pointerType !== 'touch') {
            var pointer = event;
            var result = intersectObjects(pointer, _sectionGroups[0] ? .children);
            if (result) {
                _visibleAtFirst = false;
            }

            // show gizmo + plane when intersecting on non-touch
            var visible = _visibleAtFirst || (result || intersectObjects(pointer, _sectionPicker, true)) ? true : false;
            _transRotControl.visible = visible;
            _transControl.visible = _transControl.visible && visible;
            showPlane(visible);
        }

        if (_transControl.onPointerHover(event))
            return true;

        return _transRotControl.onPointerHover(event);
    };

    this.handleGesture = function(event) {
        switch (event.type) {
            case "dragstart":
                _touchType = "drag";
                // Single touch, fake the mouse for now...
                return this.handleButtonDown(event, 0);

            case "dragmove":
                return (_touchType === "drag") ? this.handleMouseMove(event) : false;

            case "dragend":
                if (_touchType === "drag") {
                    _touchType = null;
                    return this.handleButtonUp(event, 0);
                }
                return false;
        }
        return false;
    };

    this.handleBlur = function( /*event*/ ) {
        return false;
    };

    this.handleResize = function() {};

    this.handlePressHold = function( /*event*/ ) {
        // When this method returns true, it will not call the DefaultHandler's handlePressHold.
        // This makes it not possible to open the context menu on mobile.
        return false;
    };

    this.recomputePivot = function() {

        var values = this.getSectionBoxValues(true);
        if (!values) return;

        var aabb = values.sectionBox;

        _viewer.api.navigation.setPivotPoint(new THREE.Vector3(
            aabb[0] + (aabb[3] - aabb[0]) * 0.5,
            aabb[1] + (aabb[4] - aabb[1]) * 0.5,
            aabb[2] + (aabb[5] - aabb[2]) * 0.5,
        ));
    };

    this.getSectionBoxValues = function(ignoreGlobalOffset) {

        var group = _sectionGroups[0];
        if (!group) {
            return null;
        }

        var planes = group.children;
        if (planes.length < 6) {
            return null;
        }

        var right = planes[0].position.x;
        var top = planes[1].position.y;
        var front = planes[2].position.z;
        var left = planes[3].position.x;
        var bttm = planes[4].position.y;
        var back = planes[5].position.z;

        var off = {
            x: 0,
            y: 0,
            z: 0
        };
        if (!ignoreGlobalOffset) {
            off = _viewer.model.getData().globalOffset || off;
        }

        var aabb = [
            Math.min(left, right) + off.x,
            Math.min(top, bttm) + off.y,
            Math.min(front, back) + off.z,
            Math.max(left, right) + off.x,
            Math.max(top, bttm) + off.y,
            Math.max(front, back) + off.z,
        ];

        // Box doesn't support rotation at the moment.
        // Will have to take it into account if that becomes a feature.
        var transform = new THREE.Matrix4().identity().toArray();

        return {
            sectionBox: aabb,
            sectionBoxTransform: transform,
        };
    };

    this.getSectionPlaneValues = function(ignoreGlobalOffset) {

        var group = _sectionGroups[0];
        if (!group) {
            return null;
        }

        var planes = group.children;
        if (planes.length !== 1) {
            return null;
        }

        var off = {
            x: 0,
            y: 0,
            z: 0
        };
        if (!ignoreGlobalOffset) {
            off = _viewer.model.getData().globalOffset || off;
        }

        var plane = planes[0].plane;
        var constant = plane.constant - THREE.Vector3.prototype.dot.call(off, plane.normal);

        return {
            sectionPlane: [
                plane.normal.x,
                plane.normal.y,
                plane.normal.z,
                constant
            ]
        };
    };

    this.getSectionPlaneSet = function() {
        return _viewer.getCutPlaneSet(_ownCutPlaneSet);
    };

    this.getSectionPlanes = function() {
        // When restoring a viewer state it is put in __set_view, so return from that set
        // However, the notifyCutplanesChanged function can call setViewerSection which would
        // move the planes from __set_view into _ownCutPlaneSet
        const viewSet = _viewer.getCutPlaneSet('__set_view');
        if (viewSet.length > 0) {
            return viewSet;
        }

        return _viewer.getCutPlaneSet(_ownCutPlaneSet);
    };

    // Called by viewer if any cutplanes are modified. It makes sure that cutplanes controlled by separate tools
    // (with own cutplane sets) are considered by our cap meshes.
    this.notifyCutplanesChanged = function() {

        var numCutPlanesBefore = _otherCutPlanes.length;

        // Collect all active cutplanes from other tools
        //
        // NOTE: It's essential that we don't create a new array, but just refill the same one.
        //       Since the cap meshes are created async, the cutPlaneChange event may come in the middle of
        //       the cap mesh generation. For consistency, we want all cap meshes to share the same cutplane array.
        _otherCutPlanes.length = 0;
        var cpSets = _viewer.getCutPlaneSets();
        for (var i = 0; i < cpSets.length; i++) {

            // skip our own cut planes
            var cpName = cpSets[i];
            if (cpName === _ownCutPlaneSet) {
                continue;
            }

            // add cutplanes of this set
            var cp = _viewer.getCutPlaneSet(cpName);
            for (var j = 0; j < cp.length; j++) {
                _otherCutPlanes.push(cp[j]);
            }
        }

        // Set the section tool to the viewer defined cutplane.
        if (cpSets.includes("__set_view") && _activeMode !== "" && _activeMode.indexOf("OBJ_") === -1) {
            this.setViewerSection(false);
        }

        // If the number of cutplanes changed, this requires a shader recompile of the cap materials
        if (numCutPlanesBefore !== _otherCutPlanes.length) {
            updateCapMaterials(false);
        }
    };

    // Sections use cloned materials outside the control of MaterialManager. Thus, when rendering options change, materials need to get recompiled
    this.notifyRenderOptionChanged = function() {
        updateCapMaterials(true);
    };

    /**
     * Set a section box around the passed in bounding box.
     * @param {THREE.Box3} box
     * @returns {boolean} - true if the section box was set
     */
    this.setSectionBox = function(box) {
        if (!box) return false;
        const name = 'OBJ_BOX';
        // Convert the bounding box to planes

        let bbox = box;
        let transform = box.transform;

        // If a transform is specified on the bbox, we use it, otherwise we align the box with project north
        if (!box.transform) {
            bbox = bbox.clone().applyMatrix4(_inverseTransform);
            transform = _transform;
        }

        const planes = Autodesk.Viewing.Private.SceneMath.box2CutPlanes(bbox, transform);
        _activeMode = name;
        _viewer.setCutPlaneSet('__set_view', planes);
        this.setSection(name);
        return true;
    };

    /**
     * Set a section plane at the intersection position.
     * @param {Three.Vector3} normal - plane normal.
     * @param {Three.Vector3} position - position to place the plane.
     * @returns {boolean} - true if the section plane was set
     */
    this.setSectionPlane = function(normal, position, enableRotationGizmo = true) {
        if (!normal || !position) return false;

        const name = 'OBJ_SET_VIEW_PLANE';
        const distance = -1 * position.dot(normal);
        const plane = new THREE.Plane(normal, distance);
        _activeMode = name;
        const planeVecs = [new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant)];
        _viewer.setCutPlaneSet('__set_view', planeVecs);
        this.setSection(name);
        // RotationGizmos are turned on by default.
        // The option to disable it, is for cases like activating the section tool from the context menu.
        _transRotControl ? .showRotationGizmos(enableRotationGizmo);

        const pos = position.clone().sub(_sectionGroups[0].children[0].getWorldPosition(_auxVec3));
        _transRotControl ? .setGizmoOffset(pos);

        return true;
    };
};

function init_SectionMesh() {

    if (SectionMeshClass)
        return;

    const tmpWorldPosition = new THREE.Vector3();
    const tmpNormalMatrix = new THREE.Matrix3();

    class SectionMesh extends THREE.Mesh {
        constructor(geometry, material, plane) {

            super(geometry, material, false);

            this.plane = plane;
            this.planeVec = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
            this.connectivity = [];
            this.outline = null;
        }

        update() {
            this.updateMatrixWorld();
            this.plane.normal.set(0, 0, 1);

            var normal = this.plane.normal;
            normal.applyMatrix3(tmpNormalMatrix.getNormalMatrix(this.matrixWorld));

            var d = -1 * this.getWorldPosition(tmpWorldPosition).dot(normal);
            this.planeVec.set(normal.x, normal.y, normal.z, d);
            this.plane.constant = d;
        }
    }
    SectionMeshClass = SectionMesh;
}