var Private = Autodesk.Viewing.Private;

/**
 *
 * @constructor
 */
export function Navigator(tool) {

    this.tool = tool;
    this.viewer = tool.viewer;
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.angularVelocity = new THREE.Vector3(0, 0, 0);
    this.configuration = {};
}

var proto = Navigator.prototype;

/**
 *
 * @param configuration
 * @param value
 * @returns {boolean}
 */
proto.set = function(configuration, value) {

    if (!Object.prototype.hasOwnProperty.call(this.configuration, configuration)) {
        Private.logger.warn('err! configuration not defined for current navigator in BimWalk: ' + configuration);
        return false;
    }

    if (!value === null || value === undefined) {
        Private.logger.warn('err! configuration value should be a number: ' + value);
        return false;
    }

    this.configuration[configuration] = value;
    return true;
};

/**
 *
 * @param configuration
 * @returns {*}
 */
proto.get = function(configuration) {

    if (!Object.prototype.hasOwnProperty.call(this.configuration, configuration)) {
        Private.logger.warn('err! configuration not defined for current navigator in BimWalk: ' + configuration);
        return undefined;
    }

    return this.configuration[configuration];
};

/**
 *
 *
 */
proto.activate = function() {

};

/**
 *
 *
 */
proto.deactivate = function() {

};

/**
 *
 *
 */
proto.getCursor = function() {

    // Default.
    return null;
};

/**
 *
 * @returns {THREE.Vector3}
 */
proto.getVelocity = function() {

    return this.velocity;
};

/**
 *
 * @returns {THREE.Vector3}
 */
proto.getAngularVelocity = function() {

    return this.angularVelocity;
};

/**
 * 
 * @returns {Number}
 */
proto.getMinPitchLimit = function() {

    return THREE.Math.degToRad(20);
};

/**
 * 
 * @returns {Number}
 */
proto.getMaxPitchLimit = function() {

    return THREE.Math.degToRad(160);
};

/**
 *
 * @param elapsed
 * @param camera
 * @param updateNumber
 * @param updatesCount
 */
proto.update = function(elapsed, camera, updateNumber, updatesCount) {

};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleGesture = function(event) {

    return false;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleButtonDown = function(event, button) {

    return false;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleButtonUp = function(event, button) {

    return false;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleMouseClick = function(event, button) {

    return false;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleMouseDoubleClick = function(event, button) {

    return false;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleMouseMove = function(event) {

    return false;
};

/**
 *
 * @param event
 * @param keyCode
 * @returns {boolean}
 */
proto.handleKeyDown = function(event, keyCode) {

    return true;
};

/**
 *
 * @param event
 * @param keyCode
 * @returns {boolean}
 */
proto.handleKeyUp = function(event, keyCode) {

    return true;
};

/**
 *
 * @param delta
 * @returns {boolean}
 */
proto.handleWheelInput = function(delta) {

    return false;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleSingleTap = function(event) {

    return false;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleDoubleTap = function(event) {

    return false;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleBlur = function(event) {

    return false;
};