import HTML_TEMPLATE from './guide.html';

const av = Autodesk.Viewing;
const avp = av.Private;

export function NavigatorSimpleGuide(navigator) {
    this.viewer = navigator.viewer;
    this.setGlobalManager(this.viewer);
    this.tool = navigator.tool;
    this.onTemplate = this.onTemplate.bind(this);
    const _document = this.getDocument();
    this.div = _document.createElement('div'); // Div that holds all content
    this.opened = false;

    this.onTemplate(null, HTML_TEMPLATE);
}

var proto = NavigatorSimpleGuide.prototype;
av.GlobalManagerMixin.call(proto);

proto.showToolTipUI = function(openedByUser) {
    this.viewer.container.appendChild(this.div);

    // Avoid showing panel when preference prevents us.
    var dontRemind = this.div.querySelector('#dontRemind');
    dontRemind.style.display = openedByUser ? "none" : "";

    var tooltipPanel = this.div.querySelector('#tooltipPanel');
    tooltipPanel.classList.add('c-bimwalk-tooltip--open');

    this.opened = true;
};

proto.hideToolTipUI = function() {
    var tooltipPanel = this.div.querySelector('#tooltipPanel');
    tooltipPanel.classList.remove('c-bimwalk-tooltip--open');

    this.opened = false;
};

proto.onTemplate = function(err, content) {
    if (err) {
        avp.logger.error('Failed to show BimWalk guide.');
        return;
    }

    const _document = this.getDocument();
    var tmp = _document.createElement('div');
    tmp.innerHTML = content;
    this.div.appendChild(tmp.childNodes[0]); // Assumes template has only 1 root node.

    var tooltipOK = this.div.querySelector('#tooltipOk');
    tooltipOK.addEventListener('click', this.hideToolTipUI.bind(this));

    var dontRemind = this.div.querySelector('#dontRemind');
    dontRemind.addEventListener('click', function() {
        this.viewer.setBimWalkToolPopup(false);
        this.hideToolTipUI.bind(this);
    }.bind(this));

    this.div.addEventListener('click', function() {
        this.hideToolTipUI();
    }.bind(this));

    // Localize only strings from the newly added DOM
    Autodesk.Viewing.i18n.localize(this.div);
};