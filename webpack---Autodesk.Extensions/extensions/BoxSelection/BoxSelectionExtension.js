const av = Autodesk.Viewing;
const btnStates = av.UI.Button.State;
const EXT_MODE = 'box-selection';
const TOOL_NAME = EXT_MODE;

import {
    BoxSelectionTool
} from './BoxSelectionTool';
import {
    locales
} from "./BoxSelectionLocales";

import './BoxSelection.css';

/**
 * BoxSelectionExtension allows user to select elements with a mouse box.
 * 
 * The extension id is: `Autodesk.BoxSelection`
 * @example
 *   viewer.loadExtension('Autodesk.BoxSelection')
 * 
 * @memberof Autodesk.Viewing.Extensions
 * @alias Autodesk.Viewing.Extensions.BoxSelection
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @constructor
 */
export class BoxSelectionExtension extends av.Extension {
    constructor(viewer, options = {}) {
        super(viewer, options);
        this.name = EXT_MODE;
        this._onToolChanged = this._onToolChanged.bind(this);
        // Default to faster REGULAR selectionType, 
        // though this may be undesirable when unselected objects obscure the selected ones
        this.options.selectionType = options.selectionType || (options.useGeometricIntersection ? av.SelectionType.REGULAR : av.SelectionType.MIXED);
    }

    load() {
        this.extendLocalization(locales);
        this.boxSelectionTool = new BoxSelectionTool(this.viewer, this.options);

        this.viewer.toolController.registerTool(this.boxSelectionTool, (enable, name) => {
            this.setActive(enable, name);
        });

        this.registerHotkeys();

        return true;
    }

    unload() {
        if (this.viewer.getActiveNavigationTool() === TOOL_NAME) {
            this.viewer.setActiveNavigationTool();
        }

        if (this.boxSelectionToolButton) {
            const navTools = this.viewer.getToolbar().getControl(Autodesk.Viewing.TOOLBAR.NAVTOOLSID);
            if (navTools) {
                navTools.removeControl(this.boxSelectionToolButton.getId());
                this.boxSelectionToolButton = null;
            }
        }

        this.viewer.toolController.deregisterTool(this.boxSelectionTool);
        this.viewer.removeEventListener(Autodesk.Viewing.TOOL_CHANGE_EVENT, this._onToolChanged);

        this.viewer.getHotkeyManager().popHotkeys('Autodesk.BoxSelection');

        return true;
    }

    createToolbarButton() {
        const button = new Autodesk.Viewing.UI.Button('toolbar-box-selection');
        button.setIcon('adsk-icon-selection');
        button.setToolTip('Select');
        button.onClick = () => {
            const state = button.getState();
            if (state === Autodesk.Viewing.UI.Button.State.INACTIVE) {
                this.activate(EXT_MODE);
            } else if (state === Autodesk.Viewing.UI.Button.State.ACTIVE) {
                this.deactivate();
            }
        };

        this.boxSelectionToolButton = button;
    }

    /**
     * 
     * @param {boolean} add true to add the toolbar button and false to remove it
     */
    addToolbarButton(add) {
        if (!this.boxSelectionToolButton) {
            return;
        }

        const toolbar = this.viewer.getToolbar ? .();
        const navTools = toolbar ? .getControl(Autodesk.Viewing.TOOLBAR.NAVTOOLSID);
        if (!navTools) {
            return;
        }

        const exists = navTools.getControl(this.boxSelectionToolButton.getId());
        if (add && !exists) {
            navTools.addControl(this.boxSelectionToolButton, {
                index: 0
            });
        } else if (!add && exists) {
            navTools.removeControl(this.boxSelectionToolButton);
        }
    }

    onToolbarCreated(toolbar) {
        // The _onToolChanged function will change the state of the button thus we will only add the event listener in here.
        this.viewer.addEventListener(Autodesk.Viewing.TOOL_CHANGE_EVENT, this._onToolChanged);

        this.createToolbarButton();

        // currently no toolbar button is added, as it changes the toolbar width and can break the existing layout
        this.addToolbarButton(false);
    }

    registerHotkeys() {
        const onPress = () => {
            if (!this.boxSelectionTool.isActive()) {
                this.viewer.toolController.activateTool(this.boxSelectionTool.getName());
                this.boxSelectionTool.__hotKey = true;
            }
            return true;
        };
        const onRelease = () => {
            if (this.boxSelectionTool.__hotKey) {
                this.viewer.toolController.deactivateTool(this.boxSelectionTool.getName());
                this.boxSelectionTool.__hotKey = false;
            }
            return true;
        };
        this.viewer.getHotkeyManager().pushHotkeys('Autodesk.BoxSelection', [{
            keycodes: [Autodesk.Viewing.KeyCode.CONTROL],
            onPress: onPress,
            onRelease: onRelease
        }]);
    }

    activate(mode) {
        if (mode === EXT_MODE) {
            this._updateActiveState(true);
            this.viewer.setActiveNavigationTool(EXT_MODE);
        }

        return true;
    }

    deactivate() {
        this.viewer.setActiveNavigationTool();
        this._updateActiveState(false);
        return true;
    }

    /**
     * 
     * @param {Autodesk.Viewing.SelectionType} selectionType - Determines how selected nodes are displayed with tinting and/or overlay effect
     */
    setSelectionType(selectionType) {
        this.options.selectionType = selectionType || av.SelectionType.REGULAR;
    }

    _updateActiveState(isActive) {
        this.activeStatus = isActive;
        this.mode = isActive ? EXT_MODE : '';
    }

    /**
     * Handles the TOOL_CHANGE_EVENT event
     * @param {*} event
     * @private
     */
    _onToolChanged(event) {
        if (event.toolName === TOOL_NAME && this.boxSelectionToolButton) {
            const state = event.active ? btnStates.ACTIVE : btnStates.INACTIVE;
            this.boxSelectionToolButton.setState(state);
            // This will ensure that the active state of the extension matches the tool. eg. this.isActive('box-selection')
            this._updateActiveState(!state);
        }
    }

}

av.theExtensionManager.registerExtension('Autodesk.BoxSelection', BoxSelectionExtension);