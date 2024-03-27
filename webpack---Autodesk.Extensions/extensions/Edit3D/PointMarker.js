import Label3D from './Label3D.js';

const createIcon = (icon) => {
    return [
        '<svg width="50" height="50" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
        '<g stroke-width="2" stroke="currentColor" fill="none">',
        icon,
        '</g>',
        '</svg>'
    ].join('');
};

const Icons = {
    Cross: '<path d="M0 25 L50 25 M25 0 L25 50"/>',
    Circle: '<circle r="5" cx="25" cy="27.5" fill="currentColor" stroke-width="0" />',
    Empty: ''
};

export default class PointMarker extends Label3D {

    constructor(viewer, pos3D, labelText, icon = Icons.Cross) {
        super(viewer, pos3D, null);

        this.container.innerHTML = createIcon(icon);

        // Create another label for the text
        if (labelText) {
            this.label = new Label3D(viewer, pos3D, labelText);

            // Center text above the actual position
            this.label.setVerticalOffset(-45);
        }

        // Set label visible by default. If text is empty, it is hidden anyway. 
        this.labelVisible = true;
    }

    // @param {string} Color string in css style (e.g. 'rgb(255, 255, 255)');
    setColor(color) {
        this.container.style.color = color;
    }

    setPosition(pos) {
        super.setPosition(pos);
        this.label && this.label.setPosition(pos);
    }

    setVisible(visible) {
        super.setVisible(visible);
        this.label && this.label.setVisible(this.labelVisible && visible);
    }

    setLabelVisible(visible) {
        this.label && this.label.setVisible(this.visible && visible);
    }
}

PointMarker.Events = Label3D.Events;
PointMarker.Icons = Icons;