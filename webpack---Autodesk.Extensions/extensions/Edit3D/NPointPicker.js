import CoordPicker from "./CoordPicker.js";
import PointMarker from "./PointMarker.js";

// Controls the user interaction workflow for picking N points

const Events = {
    POINT_SELECTED: "pointSelected",
    POINT_HOVERED: "pointHovered",
    POINT_SELECTION_STARTED: "pointSelectionStarted",
    CLEAR: "clear",
};

const Colors = {
    Blue: "rgb(6, 150, 215)", // adskBlue500
    Red: "rgb(236, 74, 65)", // red500
    Black: "rgb(0,0,0)",
    White: "rgb(255,255,255)",
};

const ConnectorTypes = {
    Line: "line",
    Arrow: "arrow",
};

// N point picker - allows picking N points.
//  @param {Viewer3D}      viewer
//  @param {CoordPicker}   coordPicker
//  @param {ScreenOverlay} screenOverlay
//  @param {number}        N - number of points to select
//  @param {Object}        [options]
//  @param {Boolean}          [options.draggable] -      Whether points are draggable or not
//  @param {String[]}      [options.colors] -         Array of colors
//  @param {String[]}      [options.labels] -         Array of labels
//  @param {String[]}      [options.icons] -          Array of icons
//  @param {Object[]}      [options.connections] -    Array of point connections metadata.
//  @param {Object[]}      [options.stops] -          Array of point indexes that the tool shouldn't automatically continue positioning new points after them.
export default class NPointPicker {
    constructor(viewer, coordPicker, screenOverlay, N, options = {}) {
        this.viewer = viewer;
        this.options = options;
        this.coordPicker = coordPicker;
        this.N = N;

        Autodesk.Viewing.EventDispatcher.prototype.apply(this);

        // Current active point - the one that is currently being picked or hovered.
        this.selectingIndex = -1;

        // Last valid point that was selected. Drag an exising previous point won't change this value.
        this.lastSelectedPoint = -1;

        this.coordPicker.addEventListener(
            CoordPicker.Events.POINT_CLICKED,
            (event) => this.onPointClicked(event)
        );
        this.coordPicker.addEventListener(
            CoordPicker.Events.POINT_HOVERED,
            (event) => this.onPointHovered(event)
        );
        this.coordPicker.addEventListener(CoordPicker.Events.ESCAPE, () => {
            // Reset point only when dragging.
            if (this.coordPicker.isDragging) {
                this.cancelPointSelection();
            }
        });

        this.points = [];
        this.pointValid = [];
        this.markers = [];
        this.showMarkers = this.options.showMarkers || new Array(this.N).fill(true); // If showMarkers array is not supplied, default to true.

        for (let i = 0; i < this.N; i++) {
            this.points.push(new THREE.Vector3());
            this.pointValid.push(false);
            const color = options.colors ? options.colors[i] : Colors.Blue;
            const label = options.labels ? options.labels[i] : undefined;
            const icon = options.icons ? options.icons[i] : undefined;
            const marker = new PointMarker(this.viewer, undefined, label, icon);
            this.markers.push(marker);

            if (this.options.draggable) {
                marker.addEventListener(PointMarker.Events.DRAG_START, () =>
                    this.startSelectPoint(i, true)
                );
                marker.addEventListener(PointMarker.Events.DRAG_END, (event) =>
                    this.onDragEnded(event)
                );
            }

            // Hide the markers until we have valid from/to point
            marker.setVisible(false);
            marker.setColor(color);

            // Custom label style
            if (options.labelStyles && options.labelStyles[i]) {
                Object.keys(options.labelStyles[i]).forEach((key) => {
                    marker.label.container.style[key] = options.labelStyles[i][key];
                });
            }
        }

        // {Autodesk.Edit2D.ScreenOverlay}
        this.screenOverlay = screenOverlay;

        const connectionsData = this.options.connections || [];
        this.connectors = [];

        for (let i = 0; i < connectionsData.length; i++) {
            const connectionData = connectionsData[i];

            // Configure style of line/arrow connection
            const lineStyle = new Autodesk.Edit2D.Style({
                lineStyle: 10,
                lineWidth: 1.5,
                lineColor: connectionData.color || Colors.Blue,
            });

            let gizmo;
            let attachableObject;
            let setFrom;
            let setTo;

            if (connectionData.type === ConnectorTypes.Line) {
                // Dashed line connecting from/to point
                gizmo = new Autodesk.Edit2D.ScreenOverlay.Line3DGizmo();
                gizmo.line2D.style.copy(lineStyle);

                // Define attachable object for the label
                attachableObject = gizmo.line2D;

                // Define position setters
                setFrom = gizmo.a.copy.bind(gizmo.a);
                setTo = gizmo.b.copy.bind(gizmo.b);
            } else if (connectionData.type === ConnectorTypes.Arrow) {
                // Dashed arrow connecting from/to point
                gizmo = new Autodesk.Edit2D.ScreenOverlay.Arrow3DGizmo();
                gizmo.arrow.line.style.copy(lineStyle);
                gizmo.arrow.head.style.fillColor = lineStyle.lineColor;
                gizmo.arrow.setHeadLength(18); // in pixels, because layer is screen-aligned
                gizmo.arrow.setHeadAngle(40); // in degrees

                // Define attachable object for the label
                attachableObject = gizmo.arrow.line;

                // Define position setters
                setFrom = gizmo.setFrom.bind(gizmo);
                setTo = gizmo.setTo.bind(gizmo);
            } else {
                console.warn("Invalid connector type.");
                continue;
            }

            let label;

            if (connectionData.getEdgeLabelText) {
                label = new Autodesk.Edit2D.EdgeLabel(screenOverlay.layer);
                label.attachToEdge(attachableObject, 0, 0);

                // Custom label style
                if (connectionData.labelStyle) {
                    Object.keys(connectionData.labelStyle).forEach((key) => {
                        label.container.style[key] = connectionData.labelStyle[key];
                    });
                }
            }

            this.connectors.push({
                fromIndex: connectionData.fromIndex,
                toIndex: connectionData.toIndex,
                getEdgeLabelText: connectionData.getEdgeLabelText,
                gizmo,
                label,
                setFrom,
                setTo,
            });
        }

        this.visible = true;

        this.stops = this.options.stops || [];

        this.onModelTransformChanged = this.onModelTransformChanged.bind(this);

        this.modelsToPointsMap = {}; // { modelId: [indexes] }
    }

    dtor() {
        this.viewer.removeEventListener(Autodesk.Viewing.MODEL_TRANSFORM_CHANGED_EVENT, this.onModelTransformChanged);
        this.viewer = null;
    }

    startSelectPoint(index, enableDrag) {
        // Backup current point's position in case the drag won't be valid. In this case, we'll restore the current point.
        this.pointBackup = this.pointValid[index] ?
            this.points[index].clone() :
            null;

        // Start coord picker
        if (!this.viewer.toolController.isToolActivated(this.coordPicker.getName())) {
            this.viewer.toolController.activateTool(this.coordPicker.getName());
        }

        this.selectingIndex = index;

        if (this.options.draggable) {
            this.coordPicker.setDragging(enableDrag);
            this.setMarkersDraggable(false);
        }

        this.fireEvent({
            type: Events.POINT_SELECTION_STARTED,
            index: this.selectingIndex,
        });
    }

    onDragEnded({
        event
    }) {
        if (!this.coordPicker.getDragging()) {
            return;
        }

        this.coordPicker.handleSingleClick(event, 0);
        this.coordPicker.setDragging(false);
    }

    startSelect() {
        this.isActive = true;
        this.continuePointSelectionIfNeeded();
    }

    // @param {Vector3} [from] - Use null/undefined for clearing the fromPoint.
    setPoint(index, point) {
        this.pointValid[index] = !!point;

        if (this.pointValid[index]) {
            this.points[index].copy(point);

            // update point marker
            this.markers[index].setPosition(point);
        }

        this.updateGizmos();
    }

    updateGizmoVisibility(gizmo, visible, skipFade) {
        if (visible || skipFade) {
            // Show/Hide immediately.
            this.screenOverlay.setGizmoVisible(gizmo, visible);
        } else {
            // By default, hiding is done as smooth fadeout.
            this.screenOverlay.fadeOutGizmo(gizmo);
        }
    }

    // Show dashed line or arrow if from/to are both valid
    updateGizmos(skipFade) {
        for (let i = 0; i < this.N; i++) {
            const visible = this.showMarkers[i] && this.visible && this.pointValid[i];
            this.markers[i].setVisible(visible);
        }

        for (let i = 0; i < this.connectors.length; i++) {
            const connector = this.connectors[i];
            // Decide whether to show the connection between both points
            const showGizmo =
                this.visible &&
                this.pointValid[connector.fromIndex] &&
                this.pointValid[connector.toIndex];

            this.updateGizmoVisibility(connector.gizmo, showGizmo, skipFade);

            if (showGizmo) {
                connector.setFrom(this.points[connector.fromIndex]);
                connector.setTo(this.points[connector.toIndex]);
            }

            if (connector.label) {
                connector.label.setOpacity(showGizmo ? 1 : 0, true);

                // Update distance value only if label is visible.
                if (showGizmo) {
                    const text = connector.getEdgeLabelText(i);
                    connector.label.setText(text);
                }
            }
        }

        // ensure refresh if only position has changed
        this.screenOverlay.update();
    }

    clearPoint(index) {
        this.pointValid[index] = false;
        this.markers[index].setVisible(false);

        this.updateGizmos();
    }

    clear() {
        this.cancelPointSelection();

        for (let i = 0; i < this.N; i++) {
            this.pointValid[i] = false;
            this.markers[i].setVisible(false);
        }

        this.selectingIndex = -1;
        this.lastSelectedPoint = -1;

        this.updateGizmos();

        this.isActive = false;

        this.fireEvent({
            type: Events.CLEAR
        });
    }

    onPointHovered(event) {
        if (this.selectingIndex === -1) {
            return;
        }

        this.setPoint(this.selectingIndex, event.point);
        this.fireEvent({
            type: Events.POINT_HOVERED,
            point: event.point,
            index: this.selectingIndex,
        });
    }

    onPointClicked({
        point
    }, pickAnother = true) {
        if (this.selectingIndex === -1) {
            return;
        }

        // In case not point was selected, try restoring point backup.
        point = point || this.pointBackup;

        // Clear point backup
        this.pointBackup = null;

        // TODO: Avoid this hack. For this, the OrbitDollyPanTool should stop locking the ToolController and
        //       properly handle the case to be disabled within an interaction - without global blocking the ToolController.
        this.viewer.toolController.setIsLocked(false);
        this.viewer.toolController.deactivateTool(this.coordPicker.getName());

        if (point) {
            // Set pivot to selected point, so that we can orbit around it
            this.viewer.impl.camera.pivot.copy(point);
            this.viewer.impl.camera.dirty = true;
        }

        this.setPoint(this.selectingIndex, point);

        this.setMarkersDraggable(true);

        const index = this.selectingIndex;

        this.selectingIndex = -1;

        if (point) {
            this.lastSelectedPoint = Math.max(index, this.lastSelectedPoint);
            this.fireEvent({
                type: Events.POINT_SELECTED,
                point,
                index
            });
        }

        // Start picking another point if:
        // - pickAnother flag is set
        // - We just selected a point, and it's not a stop point index.
        if (pickAnother && !(point && this.stops.includes(this.lastSelectedPoint))) {
            this.continuePointSelectionIfNeeded();
        }
    }

    setMarkersDraggable(enable) {
        if (!this.options.draggable) {
            return;
        }

        for (let i = 0; i < this.N; i++) {
            const draggable =
                enable && this.visible && this.pointValid[i] && this.showMarkers[i];
            this.markers[i].setDraggable(draggable);
        }
    }

    cancelPointSelection() {
        this.onPointClicked({}, false);
    }

    continuePointSelectionIfNeeded() {
        if (!this.isPickerActive()) {
            return;
        }

        // Make sure the tool is visible.
        this.setVisible(true);

        for (let i = 0; i < this.N; i++) {
            if (!this.pointValid[i]) {
                this.startSelectPoint(i, false);
                break;
            }
        }
    }

    // Note: By default, setVisible(false) triggers a smooth fadeout. Use skipFade=true if you want to ensure that everything is instantly hidden.
    setVisible(visible, skipFade) {
        if (visible !== this.visible) {
            this.visible = visible;
            this.updateGizmos(skipFade);
        }
    }

    // Shortcut for readability: Hide immediately without any fade-out.
    forceHide() {
        this.setVisible(false, true);
    }

    areAllPointsSet() {
        if (this.selectingIndex !== -1) {
            return false;
        }

        for (let i = 0; i < this.N; i++) {
            if (!this.pointValid[i]) {
                return false;
            }
        }

        return true;
    }

    isPickerActive() {
        return this.isActive;
    }

    attachPointsToModel(model, points) {
        this.setModelsToPointsMap(Object.assign({}, this.modelsToPointsMap, {
            [model.id]: points
        }));
    }

    // ModelsToPointsMap is used to define a connection between points and specific models.
    // It is currently being used in order to update the points according to model transform changes.
    // Could be also used in the future for limiting the snapper to snap only on the attached model.
    setModelsToPointsMap(map) {
        this.modelsToPointsMap = map;

        const ids = Object.keys(this.modelsToPointsMap);

        if (ids.length > 0) {
            ids.forEach(id => {
                const model = this.viewer.impl.findModel(Number(id), true);

                // Used in order to calculate the initial transform diff later.
                const matrix = model.getModelTransform() ? .clone();
                this.modelsToPointsMap[id].matrix = matrix || new Autodesk.Viewing.Private.LmvMatrix4(true);
            });

            if (!this.viewer.hasEventListener(Autodesk.Viewing.MODEL_TRANSFORM_CHANGED_EVENT, this.onModelTransformChanged)) {
                this.viewer.addEventListener(Autodesk.Viewing.MODEL_TRANSFORM_CHANGED_EVENT, this.onModelTransformChanged);
            }

        } else {
            // Remove event if there is no mapping.
            this.viewer.removeEventListener(Autodesk.Viewing.MODEL_TRANSFORM_CHANGED_EVENT, this.onModelTransformChanged);
        }
    }

    // Update points that are attached to a specific model, in case it moved.
    onModelTransformChanged({
        model,
        matrix
    }) {
        // No map;
        if (!this.modelsToPointsMap) {
            return;
        }

        const pointIndexes = this.modelsToPointsMap[model.id];

        // Model not in map - nothing to update.
        if (!pointIndexes) {
            return;
        }

        // Calculate diff matrix.
        const previousMatrix = this.modelsToPointsMap[model.id].matrix;
        const diffMatrix = previousMatrix.invert();
        diffMatrix.multiplyMatrices(matrix, diffMatrix);

        // Update for next time.
        this.modelsToPointsMap[model.id].matrix = matrix.clone();

        for (let i = 0; i < this.N; i++) {
            if (pointIndexes.includes(i) && this.pointValid[i]) {

                const point = this.points[i];
                point.applyMatrix4(diffMatrix);
                this.setPoint(i, point);
            }
        }
    }
}

NPointPicker.Events = Events;
NPointPicker.Colors = Colors;
NPointPicker.ConnectorTypes = ConnectorTypes;