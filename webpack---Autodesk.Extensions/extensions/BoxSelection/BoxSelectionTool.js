import {
    BoxIntersection
} from "./BoxIntersection";

export class BoxSelectionTool {

    /**
     * @param {Autodesk.Viewing.Viewer3D} viewer
     * @param {Object} options
     * @param {string} options.cssClassName  CSS class used for the box. Default 'box-selection'.
     */
    constructor(viewer, options = {}) {
        this.viewer = viewer;
        this.options = options;

        this.isDown = false;

        this.element = document.createElement('div');
        this.styleContains = this.options.styleContains || this.options.cssClassName || 'box-selection-contains';
        this.styleIntersects = this.options.styleIntersects || this.options.cssClassName || 'box-selection-intersects';
        this.element.classList.add(this.styleContains);
        this.element.style.pointerEvents = 'none';

        this.startPoint = new THREE.Vector2();
        this.endPoint = new THREE.Vector2();

        this.useGeometricIntersection = this.options.useGeometricIntersection || Autodesk.Viewing.isMobileDevice();
        this.boxIntersection = new BoxIntersection(this.viewer.getCamera(), this.viewer.impl.modelQueue());
    }

    getName() {
        return 'box-selection';
    }

    getNames() {
        return ['box-selection'];
    }

    activate() {
        this.active = true;
    }

    deactivate() {
        this.onSelectOver();
        this.active = false;
    }

    isActive() {
        return this.active;
    }

    getCursor() {
        return 'crosshair';
    }

    register() {}

    handleGesture(event) {
        switch (event.type) {
            case 'dragstart':
                return this.handleButtonDown(event, 0);

            case 'dragmove':
                return this.handleMouseMove(event);

            case 'dragend':
                return this.handleButtonUp(event, 0);

            default:
                break;
        }

        return false;
    }

    handleButtonDown(event, button) {
        // only handle left click
        if (button !== 0) {
            return false;
        }

        this.viewer.impl.selector.clearSelection();

        this.isDown = true;
        this.onSelectStart(event);

        return true;
    }

    handleMouseMove(event) {
        if (!this.isDown) {
            return false;
        }

        this.onSelectMove(event);

        return true;
    }

    handleButtonUp(event, button) {
        // only handle left click
        if (button !== 0) {
            return false;
        }

        this.isDown = false;
        this.onSelectOver(event);

        const selection = this.getSelection();
        selection.forEach(s => {
            s.selectionType = this.options.selectionType;
        });
        this.viewer.impl.selector.setAggregateSelection(selection);

        return true;
    }

    getSelection() {
        const clientRect = this.viewer.impl.getCanvasBoundingClientRect();

        const vpVecBL = this.viewer.impl.clientToViewport(
            Math.min(this.startPoint.x, this.endPoint.x) - clientRect.left,
            Math.max(this.startPoint.y, this.endPoint.y) - clientRect.top
        );

        const vpVecTR = this.viewer.impl.clientToViewport(
            Math.max(this.startPoint.x, this.endPoint.x) - clientRect.left,
            Math.min(this.startPoint.y, this.endPoint.y) - clientRect.top
        );

        if (this.useGeometricIntersection) {
            //Use geometric selection
            return this.boxIntersection.select(vpVecBL, vpVecTR, this.endPoint.x > this.startPoint.x);

        } else {
            //Model is not 3D, use ID buffer selection

            const hits = this.viewer.impl.hitBoxTestViewport(
                vpVecBL,
                Math.abs(this.startPoint.x - this.endPoint.x) / this.viewer.impl.canvas.clientWidth,
                Math.abs(this.startPoint.y - this.endPoint.y) / this.viewer.impl.canvas.clientHeight
            );

            // aggregate hits in a selection format way
            const selection = [];
            const modelsHitsByModelId = {};
            const modelsById = {};

            for (let i = 0; i < hits.length; i++) {
                const modelId = hits[i].model.id;
                if (!modelsById[modelId]) {
                    modelsById[modelId] = hits[i].model;
                }
                if (!modelsHitsByModelId[modelId]) {
                    modelsHitsByModelId[modelId] = [];
                }
                modelsHitsByModelId[modelId].push(hits[i].dbId);
            }

            for (let modelId in modelsHitsByModelId) {
                selection.push({
                    model: modelsById[modelId],
                    ids: modelsHitsByModelId[modelId],
                });
            }

            return selection;
        }

    }

    onSelectStart(event) {
        this.viewer.canvas.parentElement.appendChild(this.element);

        let clientX, clientY;
        if (event.changedPointers && event.changedPointers.length) {
            clientX = event.changedPointers[0].clientX;
            clientY = event.changedPointers[0].clientY;
        } else {
            clientX = event.clientX;
            clientY = event.clientY;
        }

        this.element.style.left = clientX + 'px';
        this.element.style.top = clientY + 'px';
        this.element.style.width = '0px';
        this.element.style.height = '0px';

        this.startPoint.x = clientX;
        this.startPoint.y = clientY;
    }

    onSelectMove(event) {

        let clientX, clientY;
        if (event.changedPointers && event.changedPointers.length) {
            clientX = event.changedPointers[0].clientX;
            clientY = event.changedPointers[0].clientY;
        } else {
            clientX = event.clientX;
            clientY = event.clientY;
        }

        this.endPoint.x = clientX;
        this.endPoint.y = clientY;

        let left = Math.min(this.startPoint.x, this.endPoint.x);
        let right = Math.max(this.startPoint.x, this.endPoint.x);
        let top = Math.min(this.startPoint.y, this.endPoint.y);
        let bottom = Math.max(this.startPoint.y, this.endPoint.y);

        this.element.style.left = left + 'px';
        this.element.style.top = top + 'px';
        this.element.style.width = (right - left) + "px";
        this.element.style.height = (bottom - top) + "px";

        if (this.useGeometricIntersection && this.endPoint.x >= this.startPoint.x) {
            this.element.classList.replace(this.styleIntersects, this.styleContains);
        } else {
            this.element.classList.replace(this.styleContains, this.styleIntersects);
        }
    }

    onSelectOver() {
        if (this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
    }
}