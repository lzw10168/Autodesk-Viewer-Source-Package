const ToolName = 'ModelAlignment.CoordPicker';

const Events = {
    POINT_CLICKED: 'pointClicked',
    POINT_HOVERED: 'pointHovered', // point param may be undefined if no object was hit at the current mouse position 
    ESCAPE: 'escape'
};

export default class CoordPicker {

    constructor(viewer, snapper) {
        this.viewer = viewer;
        this.snapper = snapper;

        // Bind function so that we can use it for event listeners
        this.onCameraChanged = this.onCameraChanged.bind(this);

        Autodesk.Viewing.EventDispatcher.prototype.apply(this);

        // Optional: If a plane is set, we select points on this plane instead of the model 
        this.selectionPlane = null;

        this.enableSnapper = true;
        this.snapperActive = false;
        this.isDragging = false;

        this.keyMap = {
            SnapKey: Autodesk.Viewing.KeyCode.SHIFT, // Holding this key suppresses snapping
        };

        // Track last mouse position in canvas coords. Note that derived classes must call
        // the base class mouse handlers to keep this value valid.
        this.canvasPos = new THREE.Vector2();

        this.tmpPoint = new THREE.Vector3();
        this.tmpMatrix3 = new THREE.Matrix3();

        // Last successful hit under mouse.
        this.lastHit = null;
        this.consumeClickEvents = true;

        this.snapFilter = null; // Optional snapping filter, based on snapResult. (snapResult) => boolean.

        // Set default cursor.
        this.setCursor();
    }

    // @param {THREE.Plane} [plane] - If a plane is set, we are selecting points on that plane instead of the model. 
    setSelectionPlane(plane) {
        this.selectionPlane = plane;
    }

    getName() {
        return ToolName;
    }

    getNames() {
        return [ToolName];
    }

    setCursor(cursor) {
        this.cursor = cursor ? cursor : 'crosshair';
    }

    getCursor() {
        return this.isDragging ? 'grabbing' : (this.active && this.lastHit ? this.cursor : null);
    }

    snapperOn() {
        if (!this.snapperActive) {
            this.viewer.toolController.activateTool(this.snapper.getName());
            this.snapperActive = true;
        }
    }

    snapperOff() {
        if (this.snapperActive) {
            this.viewer.toolController.deactivateTool(this.snapper.getName());
            this.snapperActive = false;
        }
    }

    setSnapperEnabled(enabled) {
        this.enableSnapper = enabled;
        if (enabled) {
            this.snapperOn();
        } else {
            this.snapperOff();
        }
    }

    setSnapFilter(snapFilter) {
        this.snapFilter = snapFilter;
        this.snapper.setSnapFilter(snapFilter);
    }

    activate() {
        this.active = true;

        if (this.enableSnapper) {
            this.snapperOn();
        }

        this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this.onCameraChanged);
        this.viewer.impl.pauseHighlight(true);
    }

    deactivate() {
        this.active = false;
        this.isDragging = false;
        this.lastHit = null;

        this.snapperOff();

        this.viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this.onCameraChanged);
        this.viewer.impl.pauseHighlight(false);
    }

    register() {}

    // Remember last mouse position
    trackMousePos(e) {
        this.canvasPos.set(e.canvasX, e.canvasY);
    }

    handleMouseMove(event) {
        this.trackMousePos(event);

        // Make sure that snapping result is up-to-date
        this.snapper.onMouseMove({
            x: event.canvasX,
            y: event.canvasY
        });

        if (this.snapper.indicator) {
            this.snapper.indicator.render();
        }

        // Note that we always fire, even if hit is undefined. This is needed to clear indicators and edit 
        // values if the mouse is not on an object anymore.
        const result = this.getHitResultUnderMouse(event);
        this.fireEvent({
            type: Events.POINT_HOVERED,
            ...result
        });

        return this.isDragging;
    }

    // Returns hitPoint under mouse or null if no object under mouse.
    getHitResultUnderMouse(event) {

        let point = null;
        let normal = null;
        let modelId = null;
        let dbId = null;

        if (this.snapperActive && this.snapper.isSnapped()) {
            // Get snapped position.
            const hitResult = this.snapper.getSnapResult();
            point = Autodesk.Viewing.MeasureCommon.getSnapResultPosition(hitResult, this.viewer);
            normal = hitResult ? .faceNormal;
            modelId = hitResult ? .modelId;
            dbId = hitResult ? .snapNode;
        } else {
            // When snapper is not active, or no point resulted, perform a simple hit test.
            const hitResult = this.viewer.impl.hitTest(event.canvasX, event.canvasY);
            point = hitResult ? .point;

            // Extract normal
            if (hitResult ? .face ? .normal) {
                const worldMatrix = new THREE.Matrix4();
                hitResult.model.getFragmentList() ? .getWorldMatrix(hitResult.fragId, worldMatrix);
                const normalMatrix = this.tmpMatrix3.getNormalMatrix(worldMatrix);
                normal = hitResult.face.normal.clone().applyMatrix3(normalMatrix).normalize();
            }

            modelId = hitResult ? .model ? .id;
            dbId = hitResult ? .dbId;
        }

        if (this.snapFilter && !this.snapFilter({
                modelId
            })) {
            point = null;
            normal = null;
            modelId = null;
            dbId = null;
        }

        // If selection plane is set, project the hit point on the plane.
        if (point && this.selectionPlane) {
            point = this.selectionPlane.projectPoint(point, this.tmpPoint);
        }

        const result = {
            point,
            normal,
            modelId,
            dbId
        };

        // Update lastHit only if we have an actual hit.
        this.lastHit = point ? result : null;

        return result;
    }

    setConsumeClickEvents(consumeClickEvents) {
        this.consumeClickEvents = consumeClickEvents;
    }

    handleSingleClick(event, button) {
        this.trackMousePos(event);

        // Only respond to left button
        if (button !== 0) {
            return false;
        }

        const result = this.getHitResultUnderMouse(event);

        this.fireEvent({
            type: Events.POINT_CLICKED,
            ...result
        });

        return this.consumeClickEvents;
    }

    handleDoubleClick(event) {
        this.trackMousePos(event);
    }

    handleButtonDown(event) {
        this.trackMousePos(event);

        // In case of start dragging, make sure to turn on the snapper first.
        if (this.isDragging) {
            this.snapperOn();
        }

        return this.handleMouseMove(event);
    }

    handleButtonUp(event) {
        this.trackMousePos(event);
        return this.isDragging;
    }

    // Simulate mouse move instantly when snapper is being toggled.
    onSnappingToggled() {
        this.handleMouseMove({
            canvasX: this.canvasPos.x,
            canvasY: this.canvasPos.y,
        });
    }

    handleKeyDown(event, keyCode) {
        switch (keyCode) {
            case Autodesk.Viewing.KeyCode.BACKSPACE:
            case Autodesk.Viewing.KeyCode.DELETE:
            case Autodesk.Viewing.KeyCode.ESCAPE:
                this.fireEvent({
                    type: Events.ESCAPE
                });
                return true;
            case this.keyMap.SnapKey:
                if (this.snapperActive) {
                    this.snapperOff();
                    this.onSnappingToggled();
                    return true;
                }
                return false;
            default:
                break;
        }

        return false;
    }


    handleKeyUp(event, keyCode) {
        switch (keyCode) {
            case this.keyMap.SnapKey:
                if (!this.snapperActive && this.enableSnapper) {
                    this.snapperOn();
                    this.onSnappingToggled();
                    return true;
                }
                return false;
            default:
                break;
        }

        return false;
    }

    onCameraChanged() {
        if (this.snapper.indicator) {
            this.snapper.indicator.render();
        }
    }

    setDragging(isDragging) {
        this.isDragging = isDragging;
    }

    getDragging() {
        return this.isDragging;
    }
}

CoordPicker.Events = Events;
CoordPicker.Name = ToolName;