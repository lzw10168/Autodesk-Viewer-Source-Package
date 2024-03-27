const MeasureCommon = Autodesk.Viewing.MeasureCommon;
const isEqualVectors = MeasureCommon.isEqualVectors;
const EPSILON = MeasureCommon.EPSILON;
const SnapType = MeasureCommon.SnapType;

const NO_OVERLAY = 0;
const FACE_OVERLAY = 1;
const EDGE_OVERLAY = 2;
const POINT_OVERLAY = 3;

const GEOMETRIES_OVERLAY = 'MeasureTool-snapper-geometries';
const INDICATOR_OVERLAY = 'MeasureTool-snapper-indicator';

const _geometryLineWidth = 0.3;
const _indicatorLineWidth = 0.2;
const _indicatorSize = 1.2;
const _indicatorColor = 0xff7700;
const _geometryColor = 0x00CC00;

let _point = null;

const tmpVec3 = new THREE.Vector3();
/**
 * 
 * @param {BufferAttribute} positionAttribute 
 * @param {number} idx 
 * @returns {THREE.Vector3} Vector3 corresponding to the indicated index. The returned value will be overriden by
 * subsequent calls
 */
export function getXYZFromPos(positionAttribute, idx) {
    tmpVec3.x = positionAttribute.getX(idx);
    tmpVec3.y = positionAttribute.getY(idx);
    tmpVec3.z = positionAttribute.getZ(idx);
    return tmpVec3;
}

export class NullSnapperIndicator {
    isNull() {
        return true;
    }

    render() {}
    removeOverlay(overlayName) {}
    clearOverlay(overlayName) {}
    clearOverlays() {}
    addOverlay(overlayName, mesh) {}
    drawFace(geom, material, overlayName) {}
    cylinderMesh(pointX, pointY, material, width) {
        return new THREE.Mesh();
    }
    renderGeometry(snapResult) {}
    renderVertexIndicator(snapResult) {}
    renderMidpointIndicator(snapResult) {}
    renderEdgeIndicator(snapResult) {}
    renderCircleIndicator(snapResult) {}
    renderPerpendicular(snapResult) {}
    renderPixelIndicator(snapResult) {}
    renderIndicator(snapResult) {}
    drawLine(geom, material, width, overlayName) {}
    drawPoint(point, material, overlayName) {}
    drawCircle(point, material, overlayName) {}
    setScale(point) {
        return 1;
    }
    setPointScale(pointMesh) {}
    setCircleScale(torusMesh) {}
    setEdgeScale(cylinderMesh) {}
    updatePointScale(overlayName) {}
    updateEdgeScale(overlayName) {}
    onCameraChange() {}
    destroy() {}
}

export class SnapperIndicator extends NullSnapperIndicator {
    constructor(viewer, snapper) {
        super();

        this.viewer = viewer;
        this.snapper = snapper;
        this.overlayType = NO_OVERLAY;
        this.previewsIntersectPoint = null;

        this.viewer.impl.createOverlayScene(GEOMETRIES_OVERLAY);
        this.viewer.impl.createOverlayScene(INDICATOR_OVERLAY);

        this.geometryMaterial = new THREE.MeshPhongMaterial({
            color: _geometryColor,
            opacity: 0.5,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        this.indicatorMaterial = new THREE.MeshBasicMaterial({
            color: _indicatorColor,
            opacity: 1,
            transparent: false,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        });
    }

    isNull() {
        return false;
    }

    render() {

        const snapResult = this.snapper.getSnapResult();

        if (!isEqualVectors(this.previewsIntersectPoint, snapResult.intersectPoint, EPSILON)) {
            this.clearOverlay(GEOMETRIES_OVERLAY);
        }

        this.clearOverlay(INDICATOR_OVERLAY);

        if (snapResult.isEmpty())
            return;

        if (this.snapper.renderSnappedGeometry ||
            (snapResult.hasTopology && this.snapper.renderSnappedTopology)) {
            this.renderGeometry(snapResult);
        }
        this.renderIndicator(snapResult);

        this.previewsIntersectPoint = snapResult.intersectPoint.clone();
    }

    removeOverlay(overlayName) {

        this.viewer.impl.clearOverlay(overlayName, true);
        this.viewer.impl.removeOverlayScene(overlayName);

    }

    clearOverlay(overlayName) {

        this.removeOverlay(overlayName);
        this.viewer.impl.createOverlayScene(overlayName);

    }

    clearOverlays() {

        this.removeOverlay(GEOMETRIES_OVERLAY);
        this.viewer.impl.createOverlayScene(GEOMETRIES_OVERLAY);

        this.removeOverlay(INDICATOR_OVERLAY);
        this.viewer.impl.createOverlayScene(INDICATOR_OVERLAY);

        this.previewsIntersectPoint = null;

    }

    addOverlay(overlayName, mesh) {

        this.viewer.impl.addOverlay(overlayName, mesh);

    }

    /**
     * Draw the planar face
     * @param geom - Geometry which needs to be draw.
     * @param material - Material for the geometry.
     * @param overlayName - Name of the overlay.
     */
    drawFace(geom, material, overlayName) {

        const snapperPlane = new THREE.Mesh(geom, material, true);

        if (overlayName === GEOMETRIES_OVERLAY) {
            this.overlayType = FACE_OVERLAY;
        }

        this.addOverlay(overlayName, snapperPlane);

    }

    cylinderMesh(pointX, pointY, material, width) {

        const direction = new THREE.Vector3().subVectors(pointY, pointX);
        const orientation = new THREE.Matrix4();
        orientation.lookAt(pointX, pointY, new THREE.Object3D().up);
        orientation.multiply(new THREE.Matrix4().set(1, 0, 0, 0,
            0, 0, 1, 0,
            0, -direction.length(), 0, 0,
            0, 0, 0, 1));

        width = width || 0.5;
        let cylinder = new THREE.CylinderGeometry(width, width, 1.0, 8, 1, true);
        const edge = new THREE.Mesh(cylinder, material);
        cylinder = null;

        edge.applyMatrix4(orientation);
        edge.position.x = (pointY.x + pointX.x) / 2;
        edge.position.y = (pointY.y + pointX.y) / 2;
        edge.position.z = (pointY.z + pointX.z) / 2;
        return edge;
    }

    renderGeometry(snapResult) {

        if (isEqualVectors(this.previewsIntersectPoint, snapResult.intersectPoint, EPSILON)) {
            return;
        }

        switch (snapResult.geomType) {
            case SnapType.SNAP_VERTEX:
                SnapType.RASTER_PIXEL;
                this.drawPoint(snapResult.geomVertex, this.geometryMaterial, GEOMETRIES_OVERLAY);
                break;

            case SnapType.SNAP_EDGE:
            case SnapType.SNAP_CURVEDEDGE:
            case SnapType.SNAP_CIRCULARARC:
            case SnapType.SNAP_MIDPOINT:
                this.drawLine(snapResult.geomEdge, this.geometryMaterial, _geometryLineWidth, GEOMETRIES_OVERLAY);
                break;

            case SnapType.SNAP_FACE:
            case SnapType.SNAP_CURVEDFACE:
                this.drawFace(snapResult.geomFace, this.geometryMaterial, GEOMETRIES_OVERLAY);
                break;
        }
    }

    /**
     * Renders a square around the given snap result.
     * Is used when you’re snapping on a vertex, intersection, circular
     * arc on a F2D sheet, and the curved face.
     * @param {Autodesk.Viewing.MeasureCommon.SnapResult} snapResult
     */
    renderVertexIndicator(snapResult) {

        const pos = MeasureCommon.getSnapResultPosition(snapResult, this.viewer);
        const scale = this.setScale(pos);
        const length = _indicatorSize * scale;

        const rightVec = this.viewer.navigation.getCameraRightVector().multiplyScalar(length);
        const upVec = this.viewer.navigation.getCameraUpVector().multiplyScalar(length);

        const geom = new THREE.BufferGeometry();

        const vertices = [];
        const p = new THREE.Vector3();

        // Upper line
        p.addVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[0] = p.clone();
        p.subVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[1] = p.clone();

        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Bottom line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Left line
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.subVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Right line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.addVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

    }

    /**
     * Renders a triangle around the given snap result
     * on a midpoint
     * @param {Autodesk.Viewing.MeasureCommon.SnapResult} snapResult
     */
    renderMidpointIndicator(snapResult) {

        const pos = snapResult.geomVertex;
        const scale = this.setScale(pos);
        const length = _indicatorSize * scale;

        const rightVec = this.viewer.navigation.getCameraRightVector().multiplyScalar(length);
        const upVec = this.viewer.navigation.getCameraUpVector().multiplyScalar(length);

        const geom = new THREE.BufferGeometry();
        const vertices = [];
        const p = new THREE.Vector3();

        // Bottom line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Left line
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.addVectors(pos, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Right line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.addVectors(pos, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

    }

    /**
     * Renders an upside-down Y around the given snap result
     * on an edge or a curved edge..
     * @param {Autodesk.Viewing.MeasureCommon.SnapResult} snapResult
     */
    renderEdgeIndicator(snapResult) {

        const pos = MeasureCommon.getSnapResultPosition(snapResult, this.viewer);
        const scale = this.setScale(pos);
        const length = _indicatorSize * scale;

        const rightVec = this.viewer.navigation.getCameraRightVector().multiplyScalar(length);
        const upVec = this.viewer.navigation.getCameraUpVector().multiplyScalar(length);

        const geom = new THREE.BufferGeometry();
        const vertices = [];
        const p = new THREE.Vector3();

        // Bottom line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Left line
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Right line
        p.addVectors(pos, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

    }

    /**
     * Renders an circle on a center of a circle
     * and circular arc for other than F2D sheets.
     * @param {Autodesk.Viewing.MeasureCommon.SnapResult} snapResult
     */
    renderCircleIndicator(snapResult) {

        const pos = MeasureCommon.getSnapResultPosition(snapResult, this.viewer);
        this.drawCircle(pos, this.indicatorMaterial, INDICATOR_OVERLAY);

    }

    /**
     * Renders an right-angle ( |_ ) indicator around the given snap result
     * when the result is perpendicular.
     * @param {Autodesk.Viewing.MeasureCommon.SnapResult} snapResult
     */
    renderPerpendicular(snapResult) {

        const pos = MeasureCommon.getSnapResultPosition(snapResult, this.viewer);
        const scale = this.setScale(pos);
        const length = _indicatorSize * scale;

        const rightVec = this.viewer.navigation.getCameraRightVector().multiplyScalar(length);
        const upVec = this.viewer.navigation.getCameraUpVector().multiplyScalar(length);

        const geom = new THREE.BufferGeometry();
        const vertices = [];
        const p = new THREE.Vector3();

        // Upper line
        vertices[0] = pos.clone();
        p.subVectors(pos, rightVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Bottom line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Left line
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        p.subVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Right line
        vertices[0] = pos.clone();
        p.subVectors(pos, upVec);
        vertices[1] = p.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

    }

    /**
     * Renders an X around the given snap result.
     * Usually shown when using "Free Measure" mode is enabled.
     * @param {Autodesk.Viewing.MeasureCommon.SnapResult} snapResult
     */
    renderPixelIndicator(snapResult) {

        const pos = MeasureCommon.getSnapResultPosition(snapResult, this.viewer);
        const scale = this.setScale(pos);
        const length = _indicatorSize * scale;

        const rightVec = this.viewer.navigation.getCameraRightVector().multiplyScalar(length);
        const upVec = this.viewer.navigation.getCameraUpVector().multiplyScalar(length);

        const geom = new THREE.BufferGeometry();
        const vertices = [];
        const p = new THREE.Vector3();

        // Top-left line
        p.subVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Top-right line
        p.addVectors(pos, rightVec);
        p.addVectors(p, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Bottom-right line
        p.addVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

        // Bottom-left line
        p.subVectors(pos, rightVec);
        p.subVectors(p, upVec);
        vertices[0] = p.clone();
        vertices[1] = pos.clone();
        geom.setFromPoints(vertices);
        this.drawLine(geom, this.indicatorMaterial, _indicatorLineWidth, INDICATOR_OVERLAY);

    }

    renderIndicator(snapResult) {

        if (snapResult.isPerpendicular) {
            this.renderPerpendicular(snapResult);
            return;
        }

        if (snapResult.snapToArc) {
            if (snapResult.isArc && snapResult.geomType === SnapType.SNAP_CIRCULARARC && this.viewer.model.is2d() && !this.viewer.model.isPdf()) {
                this.renderVertexIndicator(snapResult);
            }
            return;
        }


        switch (snapResult.geomType) {
            case SnapType.SNAP_VERTEX:
            case SnapType.SNAP_INTERSECTION:
                this.renderVertexIndicator(snapResult);
                break;

            case SnapType.SNAP_MIDPOINT:
                this.renderMidpointIndicator(snapResult);
                break;

            case SnapType.SNAP_CIRCLE_CENTER:
                this.renderCircleIndicator(snapResult);
                break;

            case SnapType.SNAP_EDGE:
            case SnapType.SNAP_CURVEDEDGE:
                this.renderEdgeIndicator(snapResult);
                break;

            case SnapType.SNAP_CIRCULARARC:
                if (this.viewer.model.is2d()) {
                    this.renderVertexIndicator(snapResult);
                } else {
                    this.renderCircleIndicator(snapResult);
                }
                break;

            case SnapType.SNAP_FACE:
            case SnapType.SNAP_CURVEDFACE:
                this.renderVertexIndicator(snapResult);
                break;

            case SnapType.RASTER_PIXEL:
                this.renderPixelIndicator(snapResult);
                break;
        }
    }

    /**
     * Draws a line in an overlyay
     * @param {THREE.Geometry|THREE.BufferGeometry} geom 
     * @param {THREE.Material} material 
     * @param {number} width 
     * @param {string} overlayName 
     */
    drawLine(geom, material, width, overlayName) {

        // Line Pieces
        if (overlayName === GEOMETRIES_OVERLAY) {
            this.overlayType = EDGE_OVERLAY;
        }

        let verticesLength, geomPos;
        if (geom instanceof THREE.Geometry) {
            console.warn('SnapperIndicator.drawLine(geom, material, width, overlayName): THREE.Geometry has been depecrated and the geom argument should use a THREE.BufferGeometry instead');
            verticesLength = geom.vertices.length;
        } else {
            geomPos = geom.getAttribute('position');
            verticesLength = geomPos.count;
        }
        for (let i = 0; i < verticesLength; i += 2) {
            let cylinder;
            if (geom instanceof THREE.Geometry) {
                cylinder = this.cylinderMesh(geom.vertices[i], geom.vertices[i + 1], material, width);
            } else {
                cylinder = this.cylinderMesh(getXYZFromPos(geomPos, i).clone(), getXYZFromPos(geomPos, i + 1).clone(), material, width);
            }
            this.setEdgeScale(cylinder);
            this.addOverlay(overlayName, cylinder);
        }
    }

    drawPoint(point, material, overlayName) {

        // Because every point is snappable in PDFs, don't display the green dot for PDFs.
        if (this.viewer.model.isLeaflet()) {
            return;
        }

        if (!_point)
            _point = new THREE.SphereGeometry(1.0);

        const pointMesh = new THREE.Mesh(_point, material);
        pointMesh.position.set(point.x, point.y, point.z);

        this.setPointScale(pointMesh);

        if (overlayName === GEOMETRIES_OVERLAY) {
            this.overlayType = POINT_OVERLAY;
        }

        this.addOverlay(overlayName, pointMesh);

    }

    drawCircle(point, material, overlayName) {

        let torus = new THREE.TorusGeometry(_indicatorSize, _indicatorLineWidth, 2, 20);
        const torusMesh = new THREE.Mesh(torus, material);
        torusMesh.lookAt(this.viewer.navigation.getEyeVector().normalize());
        torus = null;

        torusMesh.position.set(point.x, point.y, point.z);

        this.setCircleScale(torusMesh);

        this.addOverlay(overlayName, torusMesh);

    }

    setScale(point) {

        const pixelSize = 5;

        const navapi = this.viewer.navigation;
        const camera = navapi.getCamera();
        const position = navapi.getPosition();

        const p = point.clone();

        const distance = camera.isPerspective ? p.sub(position).length() :
            navapi.getEyeVector().length();

        const fov = navapi.getVerticalFov();
        const worldHeight = 2.0 * distance * Math.tan(THREE.Math.degToRad(fov * 0.5));

        const viewport = navapi.getScreenViewport();
        const scale = pixelSize * worldHeight / viewport.height;

        return scale;
    }

    setPointScale(pointMesh) {

        const scale = this.setScale(pointMesh.position);
        pointMesh.scale.x = scale;
        pointMesh.scale.y = scale;
        pointMesh.scale.z = scale;

    }

    setCircleScale(torusMesh) {

        const scale = this.setScale(torusMesh.position);
        torusMesh.scale.x = scale;
        torusMesh.scale.y = scale;
    }

    setEdgeScale(cylinderMesh) {

        const scale = this.setScale(cylinderMesh.position);
        cylinderMesh.scale.x = scale;
        cylinderMesh.scale.z = scale;
    }

    updatePointScale(overlayName) {

        if (this.overlayType !== POINT_OVERLAY)
            return;

        const overlay = this.viewer.impl.overlayScenes[overlayName];
        if (overlay) {
            const scene = overlay.scene;

            for (let i = 0; i < scene.children.length; i++) {
                const pointMesh = scene.children[i];
                if (pointMesh) {

                    this.setPointScale(pointMesh);
                }
            }
        }
    }

    updateEdgeScale(overlayName) {

        if (this.overlayType !== EDGE_OVERLAY)
            return;

        const overlay = this.viewer.impl.overlayScenes[overlayName];
        if (overlay) {
            const scene = overlay.scene;

            for (let i = 0; i < scene.children.length; i++) {
                const cylinderMesh = scene.children[i];
                if (cylinderMesh) {

                    this.setEdgeScale(cylinderMesh);
                }
            }
        }
    }

    onCameraChange() {

        this.updatePointScale(GEOMETRIES_OVERLAY);
        this.updateEdgeScale(GEOMETRIES_OVERLAY);

        // if (!this.snapper.markupMode) {
        this.render();
        // }
    }

    destroy() {

        this.removeOverlay(GEOMETRIES_OVERLAY);
        this.removeOverlay(INDICATOR_OVERLAY);

        if (_point) {
            _point.dispose();
            _point = null;
        }
    }
}