// Disable packed normals for now, because it sometimes causes wrong values in the normal-depth-buffer (not clear why).
// The number of cluster boxes is small anyway, so using unpacked is okay here.
const UsePackedNormals = false;

const avp = Autodesk.Viewing.Private;

// Creates a quad with xy in [-0.5, 0.5] and z=0. Normal is +z
const createUnitQuadGeom = () => {

    const l = -0.5;
    const h = +0.5;

    // vertex positions (3-floats per vertex)
    const positions = Float32Array.from([
        l, l, 0,
        l, h, 0,
        h, l, 0,
        h, h, 0,
    ]);

    // index buffer for triangles
    const indices = Uint16Array.from([0, 3, 1, 0, 2, 3]);

    // index buffer for edges
    const iblines = Uint16Array.from([0, 1, 1, 3, 3, 2, 2, 0]);

    // create interleaved vertex buffer
    const vertexCount = 4;
    const vbstride = UsePackedNormals ? 4 : 6; // float32 values per vertex
    const vb = new Float32Array(vertexCount * vbstride);

    // write positions to interleaved buffer
    for (let i = 0; i < vertexCount; i++) {
        const srcOffset = 3 * i;
        const dstOffset = vbstride * i;
        vb[dstOffset] = positions[srcOffset];
        vb[dstOffset + 1] = positions[srcOffset + 1];
        vb[dstOffset + 2] = positions[srcOffset + 2];
    }

    if (UsePackedNormals) {
        // encode (0,0,1) as packed Uint16 normal
        const toUint16 = 0xFFFF; // for upscaling from [0,1]-floats to Uint16-scale
        const nx = 0.5 * toUint16;
        const ny = 1.0 * toUint16;

        // The first 3 floats per vertex are used by positions. 
        // Counting in Uint16 values, this makes 6.
        const normalOffset = 6;

        // write normals to interleaved buffer
        const vbUint16 = new Uint16Array(vb.buffer);
        const vbUint16Stride = vbstride * 2; // 2 Uint16 per float32
        for (let i = 0; i < vertexCount; i++) {
            const dstOffset = vbUint16Stride * i + normalOffset;
            vbUint16[dstOffset] = nx;
            vbUint16[dstOffset + 1] = ny;
        }
    } else {
        const normalOffset = 3;

        // write normals to interleaved buffer
        for (let i = 0; i < vertexCount; i++) {
            const dstOffset = vbstride * i + normalOffset;
            vb[dstOffset] = 0;
            vb[dstOffset + 1] = 0;
            vb[dstOffset + 2] = 1;
        }
    }

    // create result geometry
    const geom = new THREE.BufferGeometry();

    geom.vbstride = vbstride;
    geom.vb = vb;
    geom.ib = indices;
    geom.iblines = iblines;
    // position attribute
    var attrPos = new THREE.BufferAttribute(undefined, 3);
    attrPos.offset = 0;
    geom.attributes.position = attrPos;

    // normal attribute
    var attrNormal = new THREE.BufferAttribute(undefined, 3);
    attrNormal.offset = 3;
    attrNormal.bytesPerItem = UsePackedNormals ? 2 : 6;
    attrNormal.normalized = true;
    geom.attributes.normal = attrNormal;

    // index attribute
    var attrIndex = new THREE.BufferAttribute(undefined, 1);
    attrIndex.bytesPerItem = 2;
    geom.index = attrIndex;

    // add attribute for edge rendering
    var attrIndexLines = new THREE.BufferAttribute(undefined, 1);
    attrIndexLines.bytesPerItem = 2;
    geom.setAttribute('indexlines', attrIndexLines);

    // attribute keys
    geom.attributesKeys = Object.keys(geom.attributes);

    return geom;
};

// Creates a quad mesh that corresponds to the z-Min face of the given bbox
//  @param {Box3}            bbox
//  @param {BufferGeometry}  unitQuadGeom
//  @param {Material}        matman       - must be registered at materialManager and use packedNormals
const createGizmoMesh = (bbox, material) => {

    // In theory, we could share a static one here. However, this would introduce subtle detail problems
    // when using multiple viewer instances, because WebGLRenderer attaches gl-context-specific resources.
    // The number of gizmo boxes is not big anyway, so what.
    const geom = createUnitQuadGeom();

    // create mesh
    var boxMesh = new THREE.Mesh(geom, material);

    // move mesh origin to center of bbox z-min face
    bbox.getCenter(boxMesh.position);
    bbox.getSize(boxMesh.scale);
    boxMesh.position.z = bbox.min.z;

    // Attach mesh bbox
    boxMesh.boundingBox = bbox.clone();
    boxMesh.boundingBox.max.z = bbox.min.z; // The mesh only spans the z-min surface of bbox

    return boxMesh;
};

// @param {MaterialManager} matman - needed to register the material
const createGizmoMaterial = (matman) => {

    // create material
    var material = new THREE.MeshPhongMaterial({
        color: 0xffffff, // white
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,

        // Disable z-buffer: It doesn't work with fading and the quads are below all the shapes anyway.
        depthTest: false,
        depthWrite: false,
    });

    // Note: This is must be set separately, because it's a custom-lmv property and not supported by the material ctor
    material.packedNormals = UsePackedNormals;

    // Register at MaterialManager
    material.name = 'ClusterGizmoMaterial_' + material.id;
    matman.addHDRMaterial(material.name, material);

    return material;
};

const disposeGizmoMesh = (mesh, matman) => {
    mesh.geometry.dispose();
    mesh.material.dispose();
    matman.removeMaterial(mesh.material.name);
};

// A ClusterGizmo is a quad below an object cluster that helps to distinguish different clusters.
export class ClusterGizmo {

    // @param {Box3}   clusterBox - bbox of the cluster
    // @param {string} [meshName] - Attached to the mesh to simplify debugging
    constructor(viewer, clusterBox, meshName) {

        this.viewer = viewer;

        // create mesh
        const material = createGizmoMaterial(viewer.impl.matman());
        this.mesh = createGizmoMesh(clusterBox, material);

        this.mesh.name = meshName;

        // add it to viewer scene
        this.viewer.impl.scene.add(this.mesh);

        // For smooth fadeIn/Out
        const setOpacity = t => {
            // Fade-in quad
            this.mesh.material.opacity = t;

            // Fade-in outline: Edges should have 0.5 opacity when fully faded in
            this.mesh.material.edgeOpacity = 0.5 * t;

            this.viewer.impl.invalidate(true, true);
        };
        this.opacityParam = new avp.AnimatedParam(0.0, setOpacity, 1.0);

        // Initial fade-in
        this.opacityParam.fadeTo(1);
    }

    dtor() {
        // remove from viewer scene
        this.viewer.impl.scene.remove(this.mesh);
        this.viewer.impl.invalidate(true, true);

        // dispose gpu resources
        disposeGizmoMesh(this.mesh, this.viewer.impl.matman());

        this.mesh = null;
        this.viewer = null;
    }

    // Fade out and dispose mesh when done
    dispose() {
        this.opacityParam.fadeTo(0.0, () => this.dtor());
    }
}

// ClusterGizmoController takes care that ClusterGizmos and corresponding labels are created/disposed according to the currently shown layout.
export class ClusterGizmoController {

    constructor(viewer) {

        this.viewer = viewer;

        this.gizmos = []; // ClusterGizmo[]
        this.labels = []; // Label3D[]

        // We delay fade-in, so that gizmos/labels appear shortly before the cluster animation ends
        this.fadeInDelay = 1.8; // in seconds
        this.timerId = null;
    }

    createGizmos(sceneLayout) {

        // For each cluster...
        const layouts = sceneLayout.clusterLayouts;
        for (let i = 0; i < layouts.length; i++) {
            const layout = layouts[i];

            // create quad gizmo
            const bbox = layout.getBBox();
            const gizmo = new ClusterGizmo(this.viewer, bbox, layout.cluster.name);
            this.gizmos.push(gizmo);

            // get label position (center of the bbox zMin-face)
            const labelPos = bbox.getCenter(new THREE.Vector3());
            labelPos.z = bbox.min.z;

            // create label
            const text = this.getLabelText(layout);
            const label = new Autodesk.Edit3D.Label3D(this.viewer, labelPos, text);
            this.labels.push(label);

            // Hide label if ClusterGizmo size on screen is below MinPixels threshold.
            //
            // Note: We could use the screen-size of the label text. However, this looks confusing
            //       if some cluster labels are shown and others are not (due to longer text that you don't see).
            //       So, it looks more consistent to use a fixed minPixelSize for all clusters.
            //       For super-long cluster names, we will introduce abbreviations instead.
            const MinPixels = 75;
            label.setWorldBox(gizmo.mesh.boundingBox, MinPixels);

            // When clicking a label, fly to the cluster
            const flyToCluster = (e) => {
                const camera = this.viewer.impl.camera;

                // get cluster-platform center and box size
                const gizmoBox = gizmo.mesh.boundingBox;
                const p = gizmoBox.getCenter(new THREE.Vector3());
                const size = gizmoBox.getSize(new THREE.Vector3());

                // Setup view diagonally to look at p
                const dstView = camera.clone();
                dstView.target.copy(p);

                // get current distance from target point
                const curDistance = camera.position.distanceTo(p);

                // Place the camera on the line between target and start camera position.
                // Choose distance close enough to the cluster to clearly focus it.
                let dist = Math.max(size.x, size.y, size.z);
                dist = Math.min(dist, curDistance); // if already close, never move away from target
                let dir = camera.position.clone().sub(p).normalize();
                dstView.position.set(
                    p.x + dir.x * dist,
                    p.y + dir.y * dist,
                    p.z + dir.z * dist,
                );

                // trigger animation
                avp.flyToView(this.viewer, dstView, 1.5);

                // Mark click as consumed, so that it doesn't trigger selection of objects behind the label.
                e.stopPropagation();
            };
            label.container.style.pointerEvents = 'auto';
            label.container.addEventListener('click', flyToCluster);
        }
    }

    getLabelText(layout) {
        let text = layout.cluster.name;

        // Remove "Revit " prefix
        // For now, we hard-wire this, but this function will be customizable by clients later.
        const prefix = 'Revit ';
        if (isNaN(text) && text.startsWith(prefix)) {
            text = text.substring(prefix.length);
        }

        return text;
    }

    disposeGizmos() {
        this.gizmos.forEach(g => g.dispose());
        this.labels.forEach(l => l.dispose());
        this.gizmos.length = 0;
        this.labels.length = 0;
    }

    // If a delayed fade-in of gizmos is pending for prior layout, cancel it
    cancelTimer() {
        if (this.timerId) {
            window.clearTimeout(this.timerId);
            this.timerId = null;
        }
    }

    onLayoutChanged(sceneLayout) {

        // Make sure that there is no concurrent delayed fade-in of a prior layout
        this.cancelTimer();

        // Fade-out and dispose any outdated gizmos
        this.disposeGizmos();

        // Fade-in new gizmos after some delay
        if (sceneLayout) {
            this.timerId = window.setTimeout(
                () => this.createGizmos(sceneLayout),
                this.fadeInDelay * 1000
            );
        }
    }

    // Dispose all resources immediately
    reset() {
        this.gizmos.forEach(g => g.dtor());
        this.labels.forEach(l => l.dtor());
        this.gizmos.length = 0;
        this.labels.length = 0;
    }
}