import NPointPicker from './NPointPicker.js';

// Controls the user interaction workflow for aligning a model based on two selected points

// Extend NPointPicker events.
const Events = Object.assign({}, NPointPicker.Events, {
    FROM_POINT_SELECTED: 'fromPointSelected',
    TO_POINT_SELECTED: 'toPointSelected',
    FROM_POINT_HOVERED: 'fromPointHovered',
    TO_POINT_HOVERED: 'toPointHovered'
});

// Implements the interaction to select two points: A 'fromPoint' and a 'toPoint'.
export default class TwoPointPicker extends NPointPicker {

    constructor(viewer, coordPicker, screenOverlay, options) {
        super(viewer, coordPicker, screenOverlay, 2, options);

        this.addEventListener(NPointPicker.Events.POINT_SELECTED, ({
            point,
            index
        }) => {
            if (index === 0) {
                this.fireEvent({
                    type: Events.FROM_POINT_SELECTED,
                    point
                });
            } else {
                this.fireEvent({
                    type: Events.TO_POINT_SELECTED,
                    point
                });
            }
        });

        this.addEventListener(NPointPicker.Events.POINT_HOVERED, ({
            point,
            index
        }) => {
            if (index === 0) {
                this.fireEvent({
                    type: Events.FROM_POINT_HOVERED,
                    point
                });
            } else {
                this.fireEvent({
                    type: Events.TO_POINT_HOVERED,
                    point
                });
            }
        });
    }

    setOffset(offset) {
        this.offset.copy(offset);
    }

    startSelectFrom() {
        this.startSelectPoint(0);
    }

    startSelectTo() {
        this.startSelectPoint(1);
    }
}

TwoPointPicker.Events = Events;