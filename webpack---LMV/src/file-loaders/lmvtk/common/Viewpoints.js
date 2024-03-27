import {
    readCameraDefinition
} from '../svf/Cameras';
import {
    transformCameraData
} from './SvfPlacementUtils';
"use strict";

const ViewpointParts = {
    VP_Camera: 1,
    VP_CameraTransform: 2,
    VP_RenderMode: 4,
    VP_PrimitiveDisplayFlags: 8,
    VP_ClipPlanes: 16,
    VP_OverrideSet: 32,
};

export function readViewpointDefinition(pfr, camPfr, entry) {
    const tse = pfr.seekToEntry(entry);
    if (!tse)
        return null;

    const def = {};
    const parts = pfr.readVarint();

    if (parts & ViewpointParts.VP_Camera) {
        def.cameraEntry = pfr.readVarint();
        const inst = {
            definition: def.cameraEntry
        };
        def.camera = readCameraDefinition(camPfr, inst);
    }

    if (parts & ViewpointParts.VP_CameraTransform) {
        def.cameraTransform = pfr.readTransform();
        if (def.camera && def.cameraTransform) {
            transformCameraData(def.camera, def.cameraTransform);
        }
    }

    if (parts & ViewpointParts.VP_RenderMode) {
        def.renderMode = pfr.readU8();
    }

    if (parts & ViewpointParts.VP_PrimitiveDisplayFlags) {
        def.primitiveDisplayFlags = pfr.readU8();
    }

    if (parts & ViewpointParts.VP_OverrideSet) {
        def.overrideSet = pfr.readVarint();
    }

    if (parts & ViewpointParts.VP_ClipPlanes) {
        def.clipPlaneMode = pfr.readU8();
        if (def.clipPlaneMode === 0) { // Planes
            def.sectionCount = pfr.readU8();
            def.clipData = {};
            def.sectionPlane = [];
            for (let i = 0; i < def.sectionCount; i++) {
                const normal = Object.assign({}, pfr.readVector3f());
                const distance = pfr.readF64();
                def.sectionPlane.push(-normal.x, -normal.y, -normal.z, distance);
            }
        } else { // Box
            def.clipData = {};
            const min = Object.assign({}, pfr.readVector3d());
            const max = Object.assign({}, pfr.readVector3d());
            const rotationQuat = Object.assign({}, pfr.readQuaternionf());
            def.sectionBox = {
                min,
                max
            };
            def.sectionBoxTransform = rotationQuat;
            def.isFromViewpoint = true;
        }
    }

    return def;
}