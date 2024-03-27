const av = Autodesk.Viewing;
const avp = Autodesk.Viewing.Private;

// Given two points p1, p2 in worldSpace, this function computes
// the pixel distance of their screen projections.
const getPixelDistance = (viewer, p1, p2) => {

    const p1Screen = viewer.impl.worldToClient(p1);
    const p2Screen = viewer.impl.worldToClient(p2);

    const dx = p2Screen.x - p1Screen.x;
    const dy = p2Screen.y - p1Screen.y;
    return Math.sqrt(dx * dx + dy * dy);
};

const Events = {
    DRAG_START: "dragStart",
    DRAG_END: "dragEnd",
};

// A Label3D is an html div whose position is synchronized with a fixed world-space position in LMV.
export default class Label3D extends Autodesk.Viewing.EventDispatcher {

    // @param {Viewer3D}      viewer
    // @param {THREE.Vector3} [pos3D] - By default (0,0,0). Can be set later by changing this.pos3D.
    // @param {string}        [text]  - If undefined, label will be empty/invisible by default and you have to configure this.container yourself.
    constructor(viewer, pos3D = new THREE.Vector3(), text = '<Empty>') {
        super();
        this.viewer = viewer;
        this.pos3D = pos3D;
        this.pos2D = new THREE.Vector3(); // updated automatically. z is the depth value
        this.draggable = false;

        this.setGlobalManager(viewer.globalManager);

        // keep position in-sync with camera changes
        this.cameraChangeCb = this.update.bind(this);
        this.viewer.addEventListener(av.CAMERA_CHANGE_EVENT, this.cameraChangeCb);
        this.viewer.addEventListener(av.VIEWER_RESIZE_EVENT, this.cameraChangeCb);

        // Create container
        const document = viewer.canvasWrap.ownerDocument; // (might be != global document in popout scenarios)
        this.container = document.createElement('div');

        // Note: It's essential that we add it to viewer.canvasWrap instead of viewer.container:
        //       ToolController listens to events on canvasWrap. Therefore, if we would add
        //       it to viewer.container, all mouse events captured would never reach the ToolController
        //       no matter whether the gizmo handles them or not.
        viewer.canvasWrap.appendChild(this.container);

        // For fadeIn/Out effects
        const setOpacity = t => {
            this.container.style.opacity = t;
        };
        this.opacityParam = new avp.AnimatedParam(0.0, setOpacity, 0.5);

        // Initial fade-in
        this.opacityParam.fadeTo(1.0);

        // We control position via transform. So, left/top usually keep (0,0)
        this.container.style.left = '0px';
        this.container.style.top = '0px';
        this.container.style.position = 'absolute';
        this.container.style.pointerEvents = 'none';

        // Only used for text labels
        this.textDiv = null;
        if (text) {
            this.setText(text);
        }

        // Level-of-detail (optional)
        this.worldBox = null;
        this.minPixels = 0;

        // Update position and fade-in
        this.setVisible(true);

        this.onMouseDown = this.onMouseDown.bind(this);
    }

    // Decides if the label should be shown or hidden.
    // We hide the label the projected box diagonal falls below this.minPixels.
    shouldBeHidden() {
        if (!this.worldBox) {
            return false;
        }

        const boxSizeScreen = getPixelDistance(this.viewer, this.worldBox.min, this.worldBox.max);
        return boxSizeScreen < this.minPixels;
    }

    // Optional: WorldBox of the annotated object. Used for level-of-detail: We only show the label
    //           if the projected screen-size of the box is >= a given minimum pixel size.
    // @param {Box3}   worldBox
    // @param {number} minPixels
    setWorldBox(box, minPixels) {
        this.worldBox = box;
        this.minPixels = minPixels;
        this.update(); // hide this label immediately if projected world-box is very small
    }

    // Configure this label to display text
    initTextLabel() {

        // Create textDiv child div
        const document = this.viewer.container.ownerDocument;
        this.textDiv = document.createElement('div');
        this.container.appendChild(this.textDiv);

        // Use measure-tool styles by default
        this.container.classList.add('measure-length');
        this.container.classList.add('visible');
        this.textDiv.classList.add('measure-length-text');
    }

    setText(text) {
        if (!this.textDiv) {
            this.initTextLabel();
        }
        this.textDiv.textContent = Autodesk.Viewing.i18n.translate(text);
    }

    dtor() {
        this.container.remove();
        this.viewer.removeEventListener(av.CAMERA_CHANGE_EVENT, this.cameraChangeCb);
        this.viewer.removeEventListener(av.VIEWER_RESIZE_EVENT, this.cameraChangeCb);
    }

    // To change the position, just modify this.pos3D directly and call update().
    update() {
        // Get canvas position corresponding to this.pos3D
        const {
            x,
            y
        } = this.viewer.impl.worldToClient(this.pos3D);

        // Transform the div, so that its center is anchored in (x,y)
        this.container.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 50%))`;

        // Hide label if the annotated object is small on screen
        const hidden = !this.visible || this.shouldBeHidden();

        // If the label should be visible, immediately restore the container visibility, so the fade-in will be displayed.
        if (!hidden) {
            this.changeContainerVisibility(!hidden);
        }

        // this.opacityParam.skipAnim();
        this.opacityParam.fadeTo(hidden ? 0.0 : 1.0, () => {
            // If the label should be hidden, change container visibility only after the fade-out animation finished.
            // This is needed in order that the element won't be touchable while hidden.
            this.changeContainerVisibility(!hidden);
        });
    }

    // Necessary in addition to the opacity change, in order to remove from the DOM rendering.
    changeContainerVisibility(show) {
        if (!show && !this.styleHidden) {
            this.styleHidden = true;
            this.container.style.display = 'none';
        } else if (show && this.styleHidden) {
            this.styleHidden = false;
            this.container.style.display = 'block';
        }
    }

    setPosition(pos) {
        this.pos3D.copy(pos);
        this.update();
    }

    setVisible(visible) {
        this.visible = visible;
        this.update();
    }

    // Fade out and dispose label when done
    dispose() {
        this.setVisible(false);

        // Make sure that we clean up when fading is done.
        window.setTimeout(() => this.dtor(), 1000 * this.opacityParam.animTime);
    }

    // @param {number} offset - Optional: Vertical offset in screen-pixels. Positive values shift down.
    setVerticalOffset(offset) {
        this.container.style.top = offset + 'px';
    }

    onMouseDown(event) {
        this.container.style.cursor = "grabbing";

        this.viewer.toolController.__clientToCanvasCoords(event);

        this.fireEvent({
            type: Events.DRAG_START,
            event
        });

        const handleMouseUp = (e) => {
            this.onMouseUp(e);
            this.removeDocumentEventListener("mouseup", handleMouseUp);
        };

        this.addDocumentEventListener("mouseup", handleMouseUp);
    }

    onMouseUp(event) {
        this.container.style.cursor = "grab";

        this.viewer.toolController.__clientToCanvasCoords(event);

        this.fireEvent({
            type: Events.DRAG_END,
            event
        });
    }

    setDraggable(draggable) {
        if (draggable && !this.draggable) {
            this.container.addEventListener("mousedown", this.onMouseDown);
            this.container.style.cursor = "grab";
            this.container.style.pointerEvents = 'auto';
        } else if (!draggable && this.draggable) {
            this.container.removeEventListener("mousedown", this.onMouseDown);
            this.container.style.cursor = "";
            this.container.style.pointerEvents = 'none';
        }

        this.draggable = draggable;
    }
}

av.GlobalManagerMixin.call(Label3D.prototype);

Label3D.Events = Events;