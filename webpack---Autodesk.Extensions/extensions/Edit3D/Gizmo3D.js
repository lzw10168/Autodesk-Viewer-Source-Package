let nextId = 1;

// Helper class for displaying a 3D shape that is scaled to keep approximately constant screen-size.
// Example:
//   const gizmo = new Gizmo3D(viewer).makeCube();
//   gizmo.setPosition(10, 10, 10);
//   gizmo.setVisible(true);
export default class Gizmo3D {

    // @param {Viewer3d} viewer
    // @param {number}   [pixelSize]   - Size of the gizmo in pixels
    // @param {Vector3}  [pos]         - Initial position. Default (0,0,0)
    // @param {string}   [overlayName] - Name of an (existing) viewer overlay used to display the gizmo. If not specified, the Gizmo creates its own.
    constructor(viewer, pixelSize = 30, pos = null, overlayName = null) {

        this.id = nextId++;

        this.viewer = viewer;

        // The shape is auto-scaled in a way that the projected screen-size of the unitBox diagonal
        // keeps equal to this value.
        this.pixelSize = pixelSize;

        // Container for the gizmo shape. Matrix of this scene is controlled by the gizmo
        this.scene = new THREE.Scene();

        // Shape or scene to be displayed. BBox should be the unit box [-0.5, 0.5]^2, so that
        // uto-scaling works properly.
        this.shape = null;

        // Connect event listener
        this.onCameraChange = this.onCameraChange.bind(this);
        this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this.onCameraChange);

        // Make sure that matrix is recomputed after position/scale changes.
        this.scene.matrixAutoUpdate = true;

        // Overlay name that we use to display the gizmo
        this.overlayName = overlayName;

        // create own overlay if none specified
        this.overlayOwned = !overlayName;
        if (this.overlayOwned) {
            this.overlayName = `Gizmo3D_Overlay_${this.id}`;
            this.viewer.impl.createOverlayScene(this.overlayName);
        }

        this.visible = false;

        if (pos) {
            this.setPosition(pos);
        }
    }

    setPosition(x, y, z) {

        // Suppoer call with single Vec3 param
        if ((typeof x) === 'object') {
            this.scene.position.copy(x);
        } else {
            this.scene.position.set(x, y, z);
        }
        this.scene.matrixWorldNeedsUpdate;

        this.update();

        return this;
    }

    dtor() {
        this.viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this.onCameraChange);

        if (this.overlayOwned) {
            this.viewer.impl.removeOverlayScene(this.overlayName);
        }
    }

    clearShape() {
        if (this.shape) {
            this.scene.remove(this.shape);
            this.shape = null;
        }
    }

    // Set a gizmo shape to display. Must be scaled to unitBox.
    setShape(shape) {
        this.clearShape();
        this.shape = shape;
        this.scene.add(shape);
        return this;
    }

    // Set shape to sphere
    makeSphere(color = 0xff0000) {

        // create sphere mesh, centered at (0,0,0)
        const radius = 0.5;
        const widthSegments = 22;
        const heightSegments = 16;
        const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
        const material = new THREE.MeshPhongMaterial({
            color
        });
        const shape = new THREE.Mesh(geometry, material);

        return this.setShape(shape);
    }

    makeCube(color = 0xff0000) {

        // create box mesh of edgeLength 1, centered at (0,0,0)
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshPhongMaterial({
            color
        });
        const shape = new THREE.Mesh(geometry, material);
        return this.setShape(shape);
    }

    setVisible(visible) {
        if (this.visible == visible) {
            return;
        }

        if (visible) {
            this.viewer.impl.addOverlay(this.overlayName, this.scene);
        } else {
            this.viewer.impl.removeOverlay(this.overlayName, this.scene);
        }

        this.visible = visible;

        // trigger overlay update
        this.viewer.impl.invalidate(false, false, true);

        return this;
    }

    update() {
        // compute screenSize that we get with scaling 1.0
        const dist = this.viewer.impl.camera.position.distanceTo(this.scene.position);
        const worldToPixelScale = this.viewer.impl.camera.pixelsPerUnitAtDistance(dist);

        // compute and apply scale in world-space
        const scale = this.pixelSize / worldToPixelScale;
        this.scene.scale.set(scale, scale, scale);

        // make sure that scale changes takes effect
        this.scene.matrixWorldNeedsUpdate = true;

        this.viewer.impl.invalidate(false, false, true);
    }

    // On camera changes, update scaling to keep constant pixel-size
    onCameraChange() {
        this.update();
    }
}