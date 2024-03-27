import {
    NavigatorSimpleGuide
} from './NavigatorSimpleGuide';
import './NavigatorSimple.css';

var AutodeskViewing = Autodesk.Viewing;

export function NavigatorSimple(navigator) {
    this.viewer = navigator.viewer;
    this.setGlobalManager(this.viewer.globalManager);
    this.tool = navigator.tool;
    this.opened = false;
    this.hideTimeoutID;
    this.dontRemindAgain_Message = false;
    this.tooltip = new NavigatorSimpleGuide(this);
    var translate = Autodesk.Viewing.i18n.translate;

    var html =
        '<div class="bimwalk">' +
        '<div id = "tooltip-info" class= "tooltip-info">' +
        '<div id = "info-icon" class = "info-icon">' +
        '</div>' +
        '</div>' +
        '<div id = "speed" class= "message-panel docking-panel docking-panel-container-solid-color-b speed">' +
        '<table>' +
        '<tbody>' +
        '<tr>' +
        '<td class="name" data-i18n="Walk Speed">' + translate('Walk Speed') + '</td>' +
        '<td class="value"></td>' +
        '</tr>' +
        '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>';

    const _document = this.getDocument();
    var div = _document.createElement('div');
    div.innerHTML = html;

    this.div = div.childNodes[0];
    this.infoIcon = this.div.childNodes[0];
    this.onSpeedChange = this.onSpeedChange.bind(this);

    // Hide info icon if not wanted
    if (this.tool.options.disableBimWalkInfoIcon) {
        this.infoIcon.style.visibility = 'hidden';
    }
}

var proto = NavigatorSimple.prototype;
AutodeskViewing.GlobalManagerMixin.call(proto);

//Info guide and speedUI gets activated
proto.activate = function() {

    this.viewer.container.appendChild(this.div);
    this.viewer.addEventListener(AutodeskViewing.EVENT_BIMWALK_CONFIG_CHANGED, this.onSpeedChange);

    //Hide viewCube, home, and info button
    this.viewer.getExtension("Autodesk.ViewCubeUi", function(ext) {
        ext.displayViewCube(false);
        ext.displayHomeButton(false);
    });

    if (!AutodeskViewing.isMobileDevice()) {
        var infoButton = this.div.querySelector('#tooltip-info');
        infoButton.classList.add('open');

        var self = this;
        infoButton.addEventListener('click', function() {
            self.tooltip.showToolTipUI(true);
        });
    }

    //Check if don't show remind message is set or not
    if (this.viewer.getBimWalkToolPopup()) {
        this.tooltip.showToolTipUI(false);
    }
};

//Info guide and speedUI gets deactivated
proto.deactivate = function() {
    this.viewer.removeEventListener(AutodeskViewing.EVENT_BIMWALK_CONFIG_CHANGED, this.onSpeedChange);
    this.speedHide();

    var target = this.div.querySelector('#speed');
    target.classList.remove('open');

    if (!AutodeskViewing.isMobileDevice()) {
        //Hide Navigation information
        var target1 = this.div.querySelector('#tooltip-info');
        target1.classList.remove('open');

        this.tooltip.hideToolTipUI();
    }

    this.viewer.getExtension("Autodesk.ViewCubeUi", function(ext) {
        //show viewCube, home, and info button
        ext.displayViewCube(true);
        ext.displayHomeButton(true);
    });

};

proto.isDialogOpen = function() {
    return this.tooltip.opened;
};

proto.onKeyDown = function() {
    if (this.tooltip.opened) {
        this.tooltip.hideToolTipUI();
        return true;
    }
    return false;
};

proto.onSpeedChange = function(event) {
    if (event.data.configuration !== 'topWalkSpeed') {
        return;
    }

    var self = this;

    var speedPanel = this.div.querySelector('#speed');
    speedPanel.classList.add('open');

    var speedValue = this.div.querySelector('.value');
    speedValue.textContent = event.data.value;

    this.hideTimeoutID = setTimeout(function() {
        self.speedHide();
    }, 5000);
    self.opened = true;
};

proto.speedHide = function() {
    var self = this;
    if (self.opened) {
        var target = this.div.querySelector('#speed');
        target.classList.remove('open');

        self.opened = false;
        clearTimeout(this.hideTimeoutID);
    }
};

proto.showInfoIcon = function(show) {
    const visibility = show ? '' : 'hidden';
    this.infoIcon.style.visibility = visibility;
};