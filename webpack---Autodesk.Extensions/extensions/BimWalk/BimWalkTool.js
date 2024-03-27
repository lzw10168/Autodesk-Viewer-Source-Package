import {
    getTempVector,
    freeTempVectors
} from './BimWalkPools';
import {
    metersToModel
} from './BimWalkUtils';
import {
    NavigatorMobile
} from './Navigators/NavigatorMobile';
import {
    NavigatorSimple
} from './Navigators/NavigatorSimple';
import {
    NavigatorAEC
} from './Navigators/NavigatorAEC';

var AutodeskViewing = Autodesk.Viewing;
const avp = Autodesk.Viewing.Private;

AutodeskViewing.EVENT_BIMWALK_CONFIG_CHANGED = "EVENT_BIMWALK_CONFIG_CHANGED";

/*
 * First Person View tool for LMV
 *
 * This tool provides a first person view with movement using the standard WASD keys
 * to forward/backward/left/right and the QE keys to move vertically.  The mouse or
 * cursor is used to orient the view.  Movement is always along or perpendicular to
 * the view direction.
 *
 * The SHIFT key may be used when moving to increase the speed.  Or the default
 * movement speed may be increased/decreased with the MINUS or EQUAL keys.  The
 * ZERO (0) will reset to the default speed values.
 *
 * @author Hans Kellner (Oct 2014)
 *
 */
export function BimWalkTool(viewer, options, extension) {
    this.viewer = viewer;
    this.options = options || {};
    this.names = ["bimwalk"];
    this.navapi = viewer.navigation;
    this.camera = this.navapi.getCamera();
    this.active = false;
    this.clock = new THREE.Clock(true);
    this.bimWalkExtension = extension;

    this.setNavigator(viewer.prefs.get(avp.Prefs3D.BIM_WALK_NAVIGATOR_TYPE));
}

var proto = BimWalkTool.prototype;

/**
 * Sets the tool's navigator.
 * NavigatorMobile will be used if this tool is activated on a mobile device. 
 * @param {string} type - 'default' -> NavigatorSimple, 'aec' -> NavigatorAEC
 */
proto.setNavigator = function(type) {
    if (AutodeskViewing.isMobileDevice()) {
        // If using a mobile device default to the mobile navigator.
        this.navigator = this.navigator || new NavigatorMobile(this);
    } else {
        switch (type) {
            case 'aec':
                this.navigator = new NavigatorAEC(this);
                break;
            default:
                this.navigator = new NavigatorSimple(this);
                break;
        }
    }
};

proto.set = function(configuration, value) {

    if (!this.navigator.set(configuration, value)) {
        return false;
    }

    // Value can differ from provided after navigation validations.
    value = this.navigator.get(configuration);

    // Fire config changed event.
    var event = {
        type: AutodeskViewing.EVENT_BIMWALK_CONFIG_CHANGED,
        data: {
            configuration: configuration,
            value: value
        }
    };

    this.viewer.dispatchEvent(event);
    return true;
};

proto.get = function(configuration) {

    if (configuration) {
        return this.navigator.get(configuration);
    }

    return this.navigator.configuration;
};

proto.isActive = function() {

    return this.active;
};

proto.activate = function(name) {

    this.active = true;
    this.clock.start();

    // Pause mouse-over highlight.
    this.viewer.impl.pauseHighlight(true);

    // Change from current camera to perspective camera.
    this.navapi.toPerspective();
    // Clamp camera fov. This is useful when switching from orthogonal view to first person view.
    this.navapi.setVerticalFov(this.camera.fov);

    // Check if look camera is looking straigh up/down, which causes Gimbal Lock.
    // If it is, then clamp pitch to min/max.
    var EPSILON = 0.0001;
    var camera = this.camera;
    var forward = new THREE.Vector3().copy(camera.target).sub(camera.position).normalize();
    var dot = forward.dot(camera.worldup);

    if (Math.abs(dot) >= 1 - EPSILON) {

        var navigator = this.navigator;
        var position = camera.position;
        var target = camera.target;

        // BimWalk limits the camera angle to 20-160 degrees 
        // and below the angle is adjusted only when the angle is way closer than 20 degrees or 160 degrees to vertical.
        var angle = dot < 0 ? navigator.getMinPitchLimit() : navigator.getMaxPitchLimit() - Math.PI;

        var offset = target.clone().sub(position);
        // Rotating the offset by certain angle around an axis
        var axis = new THREE.Vector3(1, 0, 0);
        axis.applyQuaternion(camera.quaternion);
        offset.applyAxisAngle(axis, angle);

        this.navapi.setRequestTransition(true, position, offset.add(position), camera.fov);
    }

    if (!AutodeskViewing.isMobileDevice()) {
        // HACK: Place focus in canvas so we get key events.
        // It's important not calling canvas.focus() for mobile devices (especially iOS), since they
        // don't have key events anyway, and it turns out that calling canvas.focus() adds "internal-direct-focus" css attribute to the canvas,
        // which causes major performance issues for iOS.
        this.viewer.canvas.focus();
    }

    this.navigator.activate();
};

proto.deactivate = function(name) {

    this.active = false;
    this.clock.stop();

    this.viewer.impl.pauseHighlight(false);

    this.navigator.deactivate();

    // Make sure that the extension is synced with the tool.
    // This is needed when bimWalkTool.deactivate hasn't been called from the extension, but directly or from the tool controller.
    this.bimWalkExtension.deactivate();
};

proto.update = function() {

    // If this.viewer.model is null, we have no visible model at all - and calling metersToModel would crash.
    if (!this.active || !this.navapi.isActionEnabled('walk') || !this.viewer.model) {
        return false;
    }

    // Returns delta time in seconds since previous call.
    var elapsed = this.clock.getDelta();

    // Update navigator using fixed time step (frame rate of viewer is very unpredictable).
    var FIX_DELTA = 1 / 30;
    var MAX_UPDATES = 15;

    var updateNumber = 0;
    var updatesCount = Math.min(Math.ceil(elapsed / FIX_DELTA) | 0, MAX_UPDATES);

    var navigator = this.navigator;
    var mtsToModel = metersToModel(1, this.viewer);
    var localCam = this.camera.clone(); // used to modify this camera to see if it will be in viable range
    var deltaPitch = 0;
    var deltaYaw = 0;

    for (var i = 0; i < updatesCount; ++i) {

        var delta = Math.min(elapsed, FIX_DELTA);
        elapsed -= FIX_DELTA;

        freeTempVectors();
        navigator.update(delta, localCam, updateNumber++, updatesCount);

        // Handle displacement changes.
        var deltaPosition = getTempVector(navigator.getVelocity()).multiplyScalar(delta);
        localCam.position.add(deltaPosition.multiplyScalar(mtsToModel));

        // Handle rotation changes.
        var deltaRotation = getTempVector(navigator.getAngularVelocity()).multiplyScalar(delta);
        deltaPitch += deltaRotation.x;
        deltaYaw += deltaRotation.y;
    }

    freeTempVectors();

    let posChanged = (localCam.position.distanceToSquared(this.camera.position) !== 0);
    var forward = getTempVector(this.camera.target).sub(this.camera.position);
    let newTarget = getTempVector(localCam.position).add(forward);
    let targetChanged = (newTarget.distanceToSquared(this.camera.target) !== 0);

    // If position or target changed then update camera.
    if (posChanged || targetChanged) {

        this.navapi.setView(localCam.position, newTarget);
        this.navapi.orientCameraUp();
    }

    // From the Collaboration extension:
    //the "go home" call may change the camera back to ortho... and we can't do ortho while walking...
    //HACK: Really, the home view should be set once when launch the extension, then set it back.
    if (!this.camera.isPerspective) {
        console.log("Lost perspective mode: resetting view.");
        this.navapi.toPerspective();
    }

    // Handle look changes
    var directionFwd = getTempVector(this.camera.target).sub(this.camera.position);
    var directionRight = getTempVector(directionFwd).cross(this.camera.worldup).normalize();

    if (deltaPitch !== 0) {

        var pitchQ = new THREE.Quaternion();
        pitchQ.setFromAxisAngle(directionRight, -deltaPitch);

        var dirFwdTmp = getTempVector(directionFwd);
        dirFwdTmp.applyQuaternion(pitchQ);

        var vertical = getTempVector(this.camera.worldup);
        var verticalAngle = dirFwdTmp.angleTo(vertical);

        // If new angle is within limits then update values; otherwise ignore
        var minPitchLimit = navigator.getMinPitchLimit();
        var maxPitchLimit = navigator.getMaxPitchLimit();

        var angleBelowLimit = verticalAngle < minPitchLimit;
        var angleOverLimit = verticalAngle > maxPitchLimit;

        if (angleBelowLimit) {
            pitchQ.setFromAxisAngle(directionRight, -(minPitchLimit - verticalAngle + deltaPitch));
        }

        if (angleOverLimit) {
            pitchQ.setFromAxisAngle(directionRight, -(maxPitchLimit - verticalAngle + deltaPitch));
        }

        directionFwd.applyQuaternion(pitchQ);
        localCam.up.applyQuaternion(pitchQ);
    }

    if (deltaYaw !== 0) {

        var yawQ = new THREE.Quaternion();
        yawQ.setFromAxisAngle(this.camera.worldup, -deltaYaw);
        directionFwd.applyQuaternion(yawQ);
        localCam.up.applyQuaternion(yawQ);
    }

    // Now calc new target location and if it changed.
    var newPosition = localCam.position;
    posChanged = (newPosition.distanceToSquared(this.camera.position) !== 0);
    newTarget = getTempVector(newPosition).add(directionFwd);

    //now fix newPosition for lockInPlane
    targetChanged = (newTarget.distanceToSquared(this.camera.target) !== 0);
    // If position or target changed then update camera.
    if (posChanged || targetChanged) {
        this.navapi.setView(newPosition, newTarget);
        this.navapi.orientCameraUp();
    }

    return this.camera.dirty;
};

proto.getNames = function() {

    return this.names;
};

proto.getName = function() {

    return this.names[0];
};

proto.getCursor = function() {

    return this.navigator.getCursor();
};

proto.handleButtonDown = function(event, button) {

    return this.navigator.handleButtonDown(event, button);
};

proto.handleButtonUp = function(event, button) {

    return this.navigator.handleButtonUp(event, button);
};

proto.handleMouseMove = function(event) {

    return this.navigator.handleMouseMove(event);
};

proto.handleGesture = function(event) {

    return this.navigator.handleGesture(event);
};

proto.handleSingleClick = function(event, button) {

    return this.navigator.handleMouseClick(event, button);
};

proto.handleDoubleClick = function(event, button) {

    return this.navigator.handleMouseDoubleClick(event, button);
};

proto.handleKeyDown = function(event, keyCode) {

    return this.navigator.handleKeyDown(event, keyCode);
};

proto.handleKeyUp = function(event, keyCode) {

    return this.navigator.handleKeyUp(event, keyCode);
};

proto.handleWheelInput = function(delta) {

    return this.navigator.handleWheelInput(delta);
};

proto.handleSingleTap = function(event) {
    // In case of a 2 pointers tap - consume the event so it won't trigger a "home view" request by DefaultHandler.
    if (event.pointers ? .length === 2) {
        return true;
    }

    return this.handleSingleClick(event, 0);
};

proto.handleDoubleTap = function(event) {

    return this.navigator.handleMouseDoubleClick(event);
};

proto.handleBlur = function(event) {

    return this.navigator.handleBlur(event);
};

proto.activateJoystick = function() {

    if (this.navigator.ui) {
        this.navigator.ui.activate();
    }
};

proto.deactivateJoystick = function() {

    if (this.navigator.ui) {
        this.navigator.ui.deactivate();
    }
};

proto.setJoystickPosition = function(x, y) {

    if (this.navigator.ui) {
        this.navigator.ui.setJoystickPosition(x, y);
    }
};

proto.setJoystickRelativePosition = function(x, y) {

    if (this.navigator.ui) {
        this.navigator.ui.setJoystickRelativePosition(x, y);
    }
};

proto.setJoystickSize = function(backgroundRadius, handleRadius) {

    if (this.navigator.ui) {
        this.navigator.ui.setJoystickSize(backgroundRadius, handleRadius);
    }
};