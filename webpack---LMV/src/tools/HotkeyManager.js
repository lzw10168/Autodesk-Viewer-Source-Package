/**
 * @callback Autodesk.Viewing.HotkeyManager~onHotkeyPressCallback
 * @param {number[]} keycodes - The key combination that triggered this callback.
 * @returns {boolean} True if the press event was handled, false otherwise.
 */

/**
 * @callback Autodesk.Viewing.HotkeyManager~onHotkeyReleaseCallback
 * @param {number[]} keycodes - The key combination that triggered this callback.
 * @returns {boolean} True if the release event was handled, false otherwise.
 */

/**
 * @typedef {object} Autodesk.Viewing.HotkeyManager~Hotkey
 * @property {number[]} keycodes - The keycode combination (order doesn't matter).
 * @property {Autodesk.Viewing.HotkeyManager~onHotkeyPressCallback} [onPress] - The callback used when the combination is engaged.
 * @property {Autodesk.Viewing.HotkeyManager~onHotkeyReleaseCallback} [onRelease] - The callback used when the combination is disengaged.
 */

// Apparently javascript sorts by string values by default so we need
// our own sort function.
/**
 * @param {number} a - First value to compare
 * @param {number} b - Second value to compare
 * @private
 */
const compare = function(a, b) {
    return a - b;
}

/**
 * Management of hotkeys for the viewer.
 *
 * @class
 * @memberof Autodesk.Viewing
 * @alias Autodesk.Viewing.HotkeyManager
 */
export function HotkeyManager() {
    var stack = []; // The hotkey stack

    var keys = []; // The keys that are currently held

    // Pending items
    var onPressQueue = [];
    var onReleaseQueue = [];

    var _names = ["hotkeys"];

    /**
     * Return name of the tool returned as an array
     * @returns {Array<string>} ["hotkeys"]
     */
    this.getNames = function() {
        return _names;
    }

    /**
     * Return name of HotkeyManager tool
     * @returns {string} "hotkeys"
     */
    this.getName = function() {
        return _names[0];
    }

    /**
     * Pushes new hotkeys onto the stack.
     *
     * @param {string} id - The id for this hotkey set.
     * @param {Autodesk.Viewing.HotkeyManager~Hotkey[]} hotkeys - The list of hotkeys.
     * @param {object} [options] - An optional dictionary of options for this hotkey set.
     * @param {boolean} [options.tryUntilSuccess] - When true, the onPress callback will be called until it returns true
     * or the hotkey state changes. The onRelease callback will be called until it returns true or
     * until the combination is reengaged. Stops propagation through the stack. Non-blocking.
     * @returns {boolean} True if the hotkeys were successfully pushed.
     */
    this.pushHotkeys = function(id, hotkeys, options) {
        var idAlreadyUsed = stack.some(function(element) {
            return element.id === id;
        });

        if (idAlreadyUsed) {
            return false;
        }

        for (var i = 0; i < hotkeys.length; i++) {
            stack.push({
                id: id,
                keys: hotkeys[i].keycodes.sort(compare).join(),
                onPress: hotkeys[i].onPress,
                onRelease: hotkeys[i].onRelease,
                options: options || {}
            });
        }

        return true;
    }

    /**
     * Removes hotkeys associated with an ID from the stack.
     *
     * @param {string} id - The id associated with the hotkeys.
     * @returns {boolean} True if the hotkeys were successfully popped.
     */
    this.popHotkeys = function(id) {
        var found = false;
        for (var i = stack.length - 1; i >= 0; i--) {
            if (stack[i].id === id) {
                stack.splice(i, 1);
                found = true;
            }
        }

        return found;
    }

    /**
     * @private
     */
    const cleanQueues = function() {
        var index = keys.join();

        var item;
        var i;

        for (i = 0; i < onReleaseQueue.length;) {
            item = onReleaseQueue[i];
            if (item.keys === index) {
                onReleaseQueue.splice(i, 1);
            } else {
                i++;
            }
        }

        for (i = 0; i < onPressQueue.length;) {
            item = onPressQueue[i];
            if (item.keys !== index) {
                onPressQueue.splice(i, 1);
            } else {
                i++;
            }
        }
    }

    /**
     * @param event - Event to handle
     * @param keyCode - Key code
     */
    this.handleKeyDown = function(event, keyCode) {
        if (keys.indexOf(keyCode) !== -1) {
            // Ignore duplicate key down events. (see ToolController.applyKeyMappings())
            return;
        }

        var currentIndex = keys.join();
        var currentKeys = keys.slice(0);

        var i = 0;
        while (i < keys.length && keys[i] < keyCode) {
            i++;
        }
        keys.splice(i, 0, keyCode);

        var newIndex = keys.join();
        var newKeys = keys.slice(0);

        cleanQueues();

        // Make sure onRelease is called before onPress
        var releaseHandlers = [];
        var pressHandlers = [];
        var item;

        for (i = stack.length - 1; i >= 0; i--) {
            item = stack[i];
            if (item.keys === currentIndex && item.onRelease) {
                releaseHandlers.unshift(item);
            } else if (item.keys === newIndex && item.onPress) {
                pressHandlers.unshift(item);
            }
        }

        for (i = releaseHandlers.length - 1; i >= 0; i--) {
            item = releaseHandlers[i];
            if (item.onRelease(currentKeys)) {
                break;
            } else if (item.options.tryUntilSuccess) {
                onReleaseQueue.unshift(item);
            }
        }

        for (i = pressHandlers.length - 1; i >= 0; i--) {
            item = pressHandlers[i];
            if (item.onPress(newKeys)) {
                break;
            } else if (item.options.tryUntilSuccess) {
                onPressQueue.unshift(item);
            }
        }
    }

    /**
     * @param event - Event to handle
     * @param keyCode - Key code
     */
    this.handleKeyUp = function(event, keyCode) {
        var currentIndex = keys.join();
        var currentKeys = keys.slice(0);

        var i = keys.indexOf(keyCode);
        if (i > -1) {
            keys.splice(i, 1);
        }

        var newIndex = keys.join();
        var newKeys = keys.slice(0);

        cleanQueues();

        // Make sure onRelease is called before onPress
        var releaseHandlers = [];
        var pressHandlers = [];
        var item;

        for (i = stack.length - 1; i >= 0; i--) {
            item = stack[i];
            if (item.keys === currentIndex && item.onRelease) {
                releaseHandlers.unshift(item);
            } else if (item.keys === newIndex && item.onPress) {
                pressHandlers.unshift(item);
            }
        }

        for (i = releaseHandlers.length - 1; i >= 0; i--) {
            item = releaseHandlers[i];
            if (item.onRelease(currentKeys)) {
                break;
            } else if (item.options.tryUntilSuccess) {
                onReleaseQueue.unshift(item);
            }
        }

        for (i = pressHandlers.length - 1; i >= 0; i--) {
            item = pressHandlers[i];
            if (item.onPress(newKeys)) {
                break;
            } else if (item.options.tryUntilSuccess) {
                onPressQueue.unshift(item);
            }
        }
    }

    /**
     * @private
     */
    this.update = function() {
        var item;
        var i;

        for (i = 0; i < onReleaseQueue.length;) {
            item = onReleaseQueue[i];
            if (item.onRelease(item.keys.split()) === true) {
                onReleaseQueue.splice(i, 1);
            } else {
                i++;
            }
        }

        for (i = 0; i < onPressQueue.length;) {
            item = onPressQueue[i];
            if (item.onPress(item.keys.split()) === true) {
                onPressQueue.splice(i, 1);
            } else {
                i++;
            }
        }

        return false;
    }

    /**
     * Handle blur by releasing all current keys
     */
    this.handleBlur = function() {
        // Release all keys.
        for (var i = keys.length - 1; i >= 0; i--) {
            this.handleKeyUp(null, keys[i]);
        }
    }

    /**
     * No-op
     */
    this.activate = function() {};
    /**
     * No-op
     */
    this.deactivate = function() {};
}