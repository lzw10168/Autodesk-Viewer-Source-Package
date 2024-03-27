import {
    Navigator
} from './Navigator';
import {
    getTempVector
} from '../BimWalkPools';
import {
    metersToModel,
    easeInOutQuad,
    getFloorCandidates,
    getForward,
    updateVelocity,
    updateFriction,
    getMousePosition,
    setWorldUpComponent,
    isFloorIntersection,
    isWallIntersection
} from '../BimWalkUtils';
import {
    NavigatorSimple as UI_NavigatorSimple
} from '../UI/NavigatorSimple';

var EPSILON = 0.0001;
var temporalMousePosition = {
    x: 0,
    y: 0
};
var avp = Autodesk.Viewing.Private;

/**
 *
 * @constructor
 */
export function NavigatorSimple(tool) {

    Navigator.call(this, tool);

    // Set initial configurable values.
    this.configuration = {

        // Walk and run.
        minWalkSpeed: 2,
        maxWalkSpeed: 6,
        topWalkSpeed: 4,
        minRunSpeed: 4,
        maxRunSpeed: 12,
        runMultiplier: 2,

        // Walk with mouse.
        mouseWalkMaxTargetDistance: 2,
        mouseWalkStopDuration: 0.5,

        // Vertical movement with mouse.
        topVerticalSpeed: 2,
        topVerticalSpeedMultiplier: 1.5,
        allowVerticalSuspension: false,

        // Mobile gestures multipliers.
        panDistanceMultiplier: 150,
        pinchDistanceMultiplier: 250,

        // Turning with keyboard.
        keyboardTopTurnSpeed: 1.5,
        keyboardTurnStopDuration: 0.75,

        // Turning with mouse.
        mouseTurnInverted: false,
        mouseTurnStopDuration: 0.2,
        mouseTurnMinPitchLimit: THREE.Math.degToRad(20),
        mouseTurnMaxPitchLimit: THREE.Math.degToRad(160),

        // Teleport.
        teleportDuration: 0.5,
        teleportWallDistance: 1.0,

        cameraDistanceFromFloor: 1.8,
        minAllowedRoofDistance: 0.6,
        smallAllowedVerticalStep: 0.3,
        bigAllowedVerticalStep: 0.6,
        minFloorSidesLengthForBigVerticalStep: 5,

        gravityUpdatesBeforeFalling: 10,
        gravityAcceleration: 9.8,
        gravityTopFallSpeed: 10
    };

    this.modelToMeters = 1;
    this.metersToModel = 1;

    this.keys = Autodesk.Viewing.KeyCode;
    this.mousePosition = new THREE.Vector2(0, 0);

    // Keyboard displacement
    this.moveForward = 0;
    this.moveBackward = 0;
    this.moveLeft = 0;
    this.moveRight = 0;

    this.moveKeyboardVelocity = new THREE.Vector3();

    // Mouse displacement.
    this.moveMouseTargetDistance = 0;
    this.moveMouseLastWheelDelta = 0;
    this.moveMouseVelocity = new THREE.Vector3();
    this.moveMouseLastVelocity = new THREE.Vector3();
    this.mouseForwardDirection = new THREE.Ray();

    // Turn with rotations.
    this.turningWithMouse = false;
    this.turnMouseDelta = new THREE.Vector3();
    this.turnMouseLastVelocity = new THREE.Vector3();

    // Turn with Keyboard.
    this.turnLeft = 0;
    this.turnRight = 0;

    this.angularKeyboardVelocity = new THREE.Vector3();
    this.angularMouseVelocity = new THREE.Vector3();

    // Between floors displacement.
    this.moveUp = 0;
    this.moveDown = 0;

    this.moveUpDownKeyboardVelocity = new THREE.Vector3();

    // Gravity displacement.
    this.gravityEnabled = this.viewer.prefs.get(avp.Prefs3D.BIM_WALK_GRAVITY);

    // While moving up/down, gravity is temporarily blocked (even if enabled)
    this.movingUpOrDown = false;

    this.userOverFloor = false;
    this.fallingToCandidate = null;
    this.gravityVelocity = new THREE.Vector3();
    this.updatesToStartFalling = 0;

    // Teleport.
    this.teleporting = false;
    this.teleportInitial = new THREE.Vector3();
    this.teleportTarget = new THREE.Vector3();

    this.teleportTime = 0;
    this.teleportVelocity = new THREE.Vector3();
    this.teleportedDistance = 0;

    this.ui = new UI_NavigatorSimple(this);

    this.modelAddedCb = this.updateUnits.bind(this);

    this.lastPanPosition = new THREE.Vector2();
    this.lastPinchDistance = new THREE.Vector2();

    this.isPinching = false;
    this.isDragging = false;

    this.immediateDisplacement = false;

    this.enableGravity = this.enableGravity.bind(this);
}

NavigatorSimple.prototype = Object.create(Navigator.prototype);
NavigatorSimple.prototype.constructor = NavigatorSimple;

var proto = NavigatorSimple.prototype;

/**
 *
 * @param configuration
 * @param value
 * @returns {boolean}
 */
proto.set = function(configuration, value) {

    var result = Navigator.prototype.set.call(this, configuration, value);

    // Ensure top walk speed stays in it's limits.
    var minWalkSpeed = this.get('minWalkSpeed');
    var maxWalkSpeed = this.get('maxWalkSpeed');

    this.configuration.topWalkSpeed = Math.min(Math.max(
        this.configuration.topWalkSpeed, minWalkSpeed), maxWalkSpeed);
    return result;
};

/**
 *
 * @param configuration
 * @param value
 * @returns {boolean}
 */
proto.getTopRunSpeed = function() {

    var minRunSpeed = this.get('minRunSpeed');
    var maxRunSpeed = this.get('maxRunSpeed');

    var speed = this.get('topWalkSpeed') * this.get('runMultiplier');
    return Math.min(Math.max(speed, minRunSpeed, maxRunSpeed));
};

/**
 * 
 * @returns {Number}
 */
proto.getMinPitchLimit = function() {

    return this.get('mouseTurnMinPitchLimit');
};

/**
 * 
 * @returns {Number}
 */
proto.getMaxPitchLimit = function() {

    return this.get('mouseTurnMaxPitchLimit');
};

/**
 *
 *
 */
proto.activate = function() {

    this.updateUnits();
    this.userOverFloor = false;
    this.fallingToCandidate = null;
    this.ui.activate();

    // Make sure that we always use units from latest added model
    this.viewer.addEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, this.modelAddedCb);
    this.viewer.prefs.addListeners(avp.Prefs3D.BIM_WALK_GRAVITY, this.enableGravity);
};

/**
 *
 *
 */
proto.deactivate = function() {
    this.viewer.removeEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, this.modelAddedCb);
    this.viewer.prefs.removeListeners(avp.Prefs3D.BIM_WALK_GRAVITY, this.enableGravity);

    // Reset key states and velocities to avoid movement when reactivating the tool
    this.moveForward = this.moveBackward = 0;
    this.moveLeft = this.moveRight = 0;
    this.moveUp = this.moveDown = 0;
    this.moveKeyboardVelocity.set(0, 0, 0);
    this.moveUpDownKeyboardVelocity.set(0, 0, 0);

    this.ui.deactivate();
};

proto.updateUnits = function() {
    // Avoid crash if view is empty
    if (!this.viewer.impl.model) {
        return;
    }

    this.metersToModel = metersToModel(1, this.viewer);
    this.modelToMeters = 1 / this.metersToModel;
};

/**
 *
 *
 */
proto.enableGravity = function(enable) {

    if (this.gravityEnabled === enable) {
        return;
    }

    this.gravityEnabled = enable;
    this.resetGravity();
};

proto.resetGravity = function() {
    this.gravityVelocity.set(0, 0, 0);
    this.userOverFloor = false;
    this.fallingToCandidate = null;
    this.updatesToStartFalling = Number.MAX_VALUE;
};

/**
 *
 * @param elapsed
 * @param camera
 * @param updateNumber
 * @param updatesCount
 */
proto.update = function(elapsed, camera, updateNumber, updatesCount) {

    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);

    if (this.ui.isDialogOpen && this.ui.isDialogOpen()) {
        return;
    }

    if (this.viewer.autocam.currentlyAnimating) {
        this.userOverFloor = false;
        this.fallingToCandidate = null;
        this.updatesToStartFalling = this.get('gravityUpdatesBeforeFalling');
        return;
    }

    if (this.teleporting) {

        // Update displacement velocity.
        this.updateTeleportDisplacement(elapsed);
        this.velocity.add(this.teleportVelocity);
    } else {

        if (!this.immediateDisplacement) {
            // Update displacement velocity.
            this.updateKeyboardUpDownDisplacement(elapsed);
            this.updateGravityDisplacement(elapsed, camera, updateNumber, updatesCount);
            this.updateKeyboardDisplacement(elapsed);
            this.updateMouseDisplacement(elapsed);
        }

        this.velocity.add(this.gravityVelocity);
        this.velocity.add(this.moveUpDownKeyboardVelocity);
        this.velocity.add(this.moveKeyboardVelocity);
        this.velocity.add(this.moveMouseVelocity);

        // Update angular velocity.
        this.updateKeyboardAngularVelocity(elapsed);

        // Gyro based Look At movement
        this.updateGyroscopeVelocity();

        // Mouse based Look At movement
        this.updateMouseAngularVelocity(elapsed);

        this.angularVelocity.add(this.angularKeyboardVelocity);
        this.angularVelocity.add(this.angularMouseVelocity);
    }
};

/**
 *
 * @param elapsed
 */
proto.updateTeleportDisplacement = function(elapsed) {

    var initial = this.teleportInitial;
    var target = this.teleportTarget;
    var duration = this.get('teleportDuration');
    var velocity = this.teleportVelocity;

    this.teleportTime = Math.min(duration, this.teleportTime + elapsed);
    var lerp = easeInOutQuad(this.teleportTime, 0, 1, duration);

    var newDisplacement = initial.distanceTo(target) * lerp;
    var oldDisplacement = this.teleportedDistance;

    this.teleportedDistance = newDisplacement;

    if (lerp === 1) {

        this.teleporting = false;
        this.fallingToCandidate = null;
        this.teleportTime = 0;
        this.teleportedDistance = 0;
    }

    velocity.copy(target);
    velocity.sub(initial).normalize();
    velocity.multiplyScalar((newDisplacement - oldDisplacement) * this.modelToMeters / elapsed);
};

proto.updateGravityDisplacement = function(elapsed, camera, updateNumber, updatesCount) {

    if (this.ignoreGravity) {
        this.resetGravity();
        return;
    }

    var viewer = this.viewer;
    var worldDown = getTempVector(camera.worldup).multiplyScalar(-1);
    var velocity = this.gravityVelocity;

    // It's assumed the user is still over a floor if it was during the previous frame and he didn't move.
    this.userOverFloor =
        this.userOverFloor &&
        this.moveMouseVelocity.lengthSq() === 0 &&
        this.moveKeyboardVelocity.lengthSq() === 0 &&
        this.moveUpDownKeyboardVelocity.lengthSq() === 0;

    if (!this.gravityEnabled || this.movingUpOrDown) {
        return;
    }

    if (this.userOverFloor) {

        // Position is not updated by the navigator, we stop movement at the beginning of the next frame
        // the floor was found and the user was moved over it.
        velocity.set(0, 0, 0);
        return;
    }

    // Camera x/y changed - reset fallingToCandidate in order to check closer candidates.
    if (this.moveKeyboardVelocity.lengthSq() !== 0) {
        this.fallingToCandidate = null;
    }

    // Get floor candidates.
    var candidates = [];
    var obstacles = [];
    var metersToModel = this.metersToModel;
    var cameraDistanceFromFloor = this.get('cameraDistanceFromFloor');
    var minAllowedRoofDistance = this.get('minAllowedRoofDistance');
    var smallAllowedVerticalStep = this.get('smallAllowedVerticalStep');
    var bigAllowedVerticalStep = this.get('bigAllowedVerticalStep');
    var minFloorSidesLengthForBigVerticalStep = this.get('minFloorSidesLengthForBigVerticalStep');

    const _getFloorCandidates = (filterByFloorDistance) => {
        return getFloorCandidates(
            camera.position,
            cameraDistanceFromFloor * metersToModel,
            minAllowedRoofDistance * metersToModel,
            smallAllowedVerticalStep * metersToModel,
            bigAllowedVerticalStep * metersToModel,
            minFloorSidesLengthForBigVerticalStep * metersToModel,
            viewer,
            candidates,
            obstacles,
            filterByFloorDistance
        );
    };

    // Trying finding candidates only in the close range first. It makes the ray intersection process much faster in case we are on a floor,
    // which is the common use-case anyway.
    var bestCandidateIndex = _getFloorCandidates(true);
    let candidate;

    // No candidate found in the close range.
    if (bestCandidateIndex === -1) {
        // Use cached floor candidate if exists.
        if (this.fallingToCandidate !== null) {
            candidate = this.fallingToCandidate;
        } else {
            // In this case we want to check if there is a far away floor - so we'll know if we need to fall down or stay floating in the air.
            // In order to do that, call _getFloorCandidates without distance filtering (slower).
            bestCandidateIndex = _getFloorCandidates(false);

            if (bestCandidateIndex !== -1) {
                candidate = candidates[bestCandidateIndex];
            }
        }
    } else {
        // Candidate was found in the close range.
        candidate = candidates[bestCandidateIndex];
    }

    // There is no floor, so there is no falling at all, keeping same camera height.
    if (!candidate || obstacles.length > 0) {
        velocity.set(0, 0, 0);
        return;
    }

    // Fall into the floor or stay over it if distance is less that epsilon.
    var candidateDistance = candidate.point.distanceTo(camera.position) * this.modelToMeters;
    var deltaFeetToCandidate = candidateDistance - cameraDistanceFromFloor;

    if (deltaFeetToCandidate < EPSILON || Math.abs(deltaFeetToCandidate) < smallAllowedVerticalStep) {

        velocity.copy(worldDown).multiplyScalar(deltaFeetToCandidate / elapsed);
        this.userOverFloor = true;
        this.fallingToCandidate = null;
        this.updatesToStartFalling = 0;
    } else {
        this.fallingToCandidate = candidate;

        if (this.updatesToStartFalling++ < this.get('gravityUpdatesBeforeFalling')) {
            return;
        }

        var acceleration = this.get('gravityAcceleration');
        var topFallSpeed = this.get('gravityTopFallSpeed');
        var speed = Math.min(topFallSpeed, velocity.length() + acceleration * elapsed);

        velocity.copy(worldDown.multiplyScalar(speed));
    }
};

/**
 *
 * @param elapsed
 */
proto.updateKeyboardUpDownDisplacement = function(elapsed) {

    var tool = this.tool;
    var running = this.running;

    var moveUp = this.moveUp;
    var moveDown = this.moveDown;

    // Update acceleration.
    var topSpeed = this.get('topVerticalSpeed') * (running ? this.get('topVerticalSpeedMultiplier') : 1);
    var velocity = this.moveUpDownKeyboardVelocity;
    var acceleration = getTempVector();
    var accelerationModule = topSpeed / 1;

    var moving = moveUp !== 0 || moveDown !== 0;
    var suspendMoving = this.get('allowVerticalSuspension') && this.moveKeyboardVelocity.lengthSq() > 0;

    if (moving && !suspendMoving) {

        var upVector = tool.camera.worldup;
        var speed = velocity.length();

        var directionUp = getTempVector(upVector);
        var directionDown = getTempVector(upVector).multiplyScalar(-1);

        acceleration.add(directionUp.multiplyScalar(moveUp));
        acceleration.add(directionDown.multiplyScalar(moveDown));
        acceleration.normalize();

        velocity.copy(acceleration).multiplyScalar(speed);
        acceleration.multiplyScalar(accelerationModule);
    } else {

        velocity.set(0, 0, 0);
    }

    // When starting or ending vertical move, reset gravity
    if (this.gravityEnabled && moving !== this.movingUpOrDown) {
        this.resetGravity();
    }

    // Remember movement state: This blocks gravity during while moving and 
    // is used to detect changes between moving/not-moving.
    this.movingUpOrDown = moving;

    // Decelerate if stop running.
    var deceleration = getTempVector();
    if (!running && velocity.lengthSq() > topSpeed * topSpeed) {

        deceleration.copy(velocity).normalize();
        deceleration.multiplyScalar(-this.getTopRunSpeed() / 1);

        acceleration.copy(deceleration);
    }

    // Update velocity.
    var frictionPresent = false;
    var clampToTopSpeed = deceleration.lengthSq() === 0;
    updateVelocity(elapsed, acceleration, topSpeed, clampToTopSpeed, frictionPresent, velocity);
};

/**
 *
 * @param elapsed
 */
proto.updateKeyboardDisplacement = function(elapsed) {

    var running = this.running;

    var moveForward = this.moveForward;
    var moveBackward = this.moveBackward;
    var moveLeft = this.moveLeft;
    var moveRight = this.moveRight;

    // Update acceleration.
    var topSpeed = running ? this.getTopRunSpeed() : this.get('topWalkSpeed');
    var velocity = this.moveKeyboardVelocity;
    var acceleration = getTempVector();
    var accelerationModule = topSpeed / 1;

    var moving = (
        moveForward !== 0 ||
        moveBackward !== 0 ||
        moveLeft !== 0 ||
        moveRight !== 0);

    if (moving) {

        var camera = this.tool.camera;
        var upVector = camera.worldup;
        var speed = velocity.length();

        var directionForward = getForward(camera);
        var directionForwardXZ = getTempVector(directionForward);
        directionForwardXZ.sub(getTempVector(upVector).multiplyScalar(upVector.dot(directionForward)));
        directionForwardXZ.normalize();

        var directionRight = getTempVector(directionForward).cross(upVector).normalize();
        var directionRightXZ = getTempVector(directionRight);
        directionRightXZ.sub(getTempVector(upVector).multiplyScalar(upVector.dot(directionRight)));
        directionRightXZ.normalize();

        var directionBackwardXZ = getTempVector(directionForwardXZ).multiplyScalar(-1);
        var directionLeftXZ = getTempVector(directionRight).multiplyScalar(-1);

        acceleration.add(directionForwardXZ.multiplyScalar(moveForward));
        acceleration.add(directionBackwardXZ.multiplyScalar(moveBackward));
        acceleration.add(directionRightXZ.multiplyScalar(moveRight));
        acceleration.add(directionLeftXZ.multiplyScalar(moveLeft));
        acceleration.normalize();

        velocity.copy(acceleration).multiplyScalar(speed);
        acceleration.multiplyScalar(accelerationModule);
    }

    // Decelerate if stop running.
    var deceleration = getTempVector();
    if (!running && velocity.lengthSq() > topSpeed * topSpeed) {

        deceleration.copy(velocity).normalize();
        deceleration.multiplyScalar(-this.getTopRunSpeed() / 1);

        acceleration.copy(deceleration);
    }

    // Update friction contribution.
    var frictionPresent = !moving && updateFriction(accelerationModule, velocity, acceleration);

    // Update velocity.
    var clampToTopSpeed = deceleration.lengthSq() === 0;
    updateVelocity(elapsed, acceleration, topSpeed, clampToTopSpeed, frictionPresent, velocity);
};

/**
 * Returns the speed that is used for the moveMouseLastVelocity.
 * @private
 */
proto.calculateMouseDisplacementSpeed = function(elapsed, velocity, accelerationModule) {
    return velocity.length() + accelerationModule * elapsed;
};

/**
 * Updates the this.moveMouseTargetDistance variable. 
 * This method will decelerate the camera to make a smooth transition from 'moving' to 'stopping'.
 * @private
 */
proto.updateMoveMouseTargetDistance = function(elapsed, velocity, target) {
    var displacement = velocity.length() * elapsed;
    this.moveMouseTargetDistance += target < 0 ? displacement : -displacement;
    if (this.moveMouseTargetDistance * target < 0) {
        this.moveMouseTargetDistance = 0;
    }
};

/**
 *
 * @param elapsed
 */
proto.updateMouseDisplacement = function(elapsed) {

    var topSpeed = this.getTopRunSpeed();
    var target = this.moveMouseTargetDistance;
    var velocity = this.moveMouseVelocity;
    var acceleration = getTempVector();
    var moving = this.moveMouseTargetDistance !== 0;
    var accelerationModule =
        (moving ? topSpeed : this.moveMouseLastVelocity.length()) / this.get('mouseWalkStopDuration');

    // Update acceleration module.
    if (moving) {

        var camera = this.tool.camera;
        var upVector = camera.worldup;

        var ray = this.mouseForwardDirection;
        var targetPosition = this.viewer.impl.clientToViewport(this.mousePosition.x, this.mousePosition.y);
        this.viewer.impl.viewportToRay(targetPosition, ray);

        var direction = ray.direction;
        direction.sub(getTempVector(upVector).multiplyScalar(upVector.dot(direction)));
        direction.normalize();

        if (target > 0) {
            direction.multiplyScalar(-1);
        }

        var speed = this.calculateMouseDisplacementSpeed(elapsed, velocity, accelerationModule);

        velocity.copy(direction.multiplyScalar(speed));

        this.moveMouseLastVelocity.copy(velocity);

        this.fallingToCandidate = null;
    }

    // Update friction contribution.
    var frictionPresent = !moving && updateFriction(accelerationModule, velocity, acceleration);

    // Update velocity.
    updateVelocity(elapsed, acceleration, topSpeed, true, frictionPresent, velocity);

    // Update distance traveled.
    if (moving) {
        this.updateMoveMouseTargetDistance(elapsed, velocity, target);
    }
};

/**
 *
 * @param elapsed
 */
proto.updateKeyboardAngularVelocity = function(elapsed) {

    var topSpeed = this.get('keyboardTopTurnSpeed');
    var stopDuration = this.get('keyboardTurnStopDuration');
    var velocity = this.angularKeyboardVelocity;
    var acceleration = getTempVector();
    var accelerationModule = topSpeed / stopDuration;

    // Update angular acceleration.
    var turning = this.turnLeft !== 0 || this.turnRight !== 0;
    if (turning) {

        var speed = Math.min(topSpeed, velocity.length() + accelerationModule * elapsed);

        velocity.y = 0;
        velocity.y -= this.turnLeft;
        velocity.y += this.turnRight;

        velocity.normalize().multiplyScalar(speed);
    }

    // Update friction contribution.
    var friction = !turning && updateFriction(accelerationModule, velocity, acceleration);

    // Update velocity.
    updateVelocity(elapsed, acceleration, topSpeed, true, friction, velocity);
};

/**
 *
 * @param elapsed
 */
proto.updateMouseAngularVelocity = function(elapsed) {

    // suppress mouse/touch based navigation while gyroscope mode On
    if (this.isGyroEnabled) {
        return;
    }

    var stopDuration = this.get('mouseTurnStopDuration');
    var velocity = this.angularMouseVelocity;
    var acceleration = getTempVector();
    var accelerationModule = this.turnMouseLastVelocity.length() / stopDuration;

    // Update mouse angular acceleration.
    var delta = this.turnMouseDelta;
    var turning = delta.lengthSq() > 0;

    if (turning) {

        var MAGIC_NUMBER = 1 / 200;

        var dx = -delta.y * MAGIC_NUMBER;
        var dy = -delta.x * MAGIC_NUMBER;

        delta.set(0, 0, 0);

        // Average velocity with previous one.
        velocity.add(getTempVector().set(dx / elapsed, dy / elapsed, 0));
        velocity.multiplyScalar(0.5);

        this.turnMouseLastVelocity.copy(velocity);
    }

    // Update friction contribution.
    var friction = !turning && updateFriction(accelerationModule, velocity, acceleration);

    // Update velocity.
    updateVelocity(elapsed, acceleration, 0, false, friction, velocity);

};

/**
 * Dummy function for Gyroscope on non mobile devices
 */
proto.updateGyroscopeVelocity = function() {
    return;
};

/**
 * Dummy function for Gyroscope on non mobile devices
 */
proto.addDeviceOrientationInputListener = function() {
    return;
};

/**
 * Dummy function for Gyroscope on non mobile devices
 */
proto.removeDeviceOrientationInputListener = function() {
    return;
};

proto.jumpToFloor = function(floorIndex) {
    const levelExt = this.viewer.getExtension('Autodesk.AEC.LevelsExtension');

    if (!levelExt) {
        console.warn('BimWalk.jumpToFloor can be used only when "Autodesk.AEC.LevelsExtension" is loaded.');
        return;
    }

    const floors = levelExt.floorSelector.floorData;

    if (!floors.length) {
        console.warn('BimWalk.jumpToFloor - No floor data available');
        return;
    }

    const floor = floors[floorIndex];

    if (floor) {
        const camera = this.viewer.impl.camera;

        // Floor plus eye height (Should be 1.80m).
        let height = floor.zMin + (this.get('cameraDistanceFromFloor') * this.metersToModel);

        // In case the ceiling is lower than 1.80m, we don't want to jump accidentally to the next level,
        // So in that case, just set the camera in the middle of the floor.
        if (height >= floor.zMax) {
            height = (floor.zMin + floor.zMax) / 2;
        }

        const pos = camera.position.clone().setZ(height);

        this.teleportInitial.copy(camera.position);
        this.teleportTarget.copy(pos);
        this.teleporting = true;
        this.teleportTime = 0;
    } else {
        console.warn('BimWalk.jumpToFloor - the given floor index is not available.');
    }
};

/**
 *
 *
 */
proto.getCursor = function() {

    if (this.get('mouseTurnInverted')) {

        if (this.turningWithMouse) {
            return 'url(data:image/x-icon;base64,AAABAAEAICAAAAEAIACoEAAAFgAAACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAcAAAAHgAAABwAAAAJAAAAAQAAABQAAAAbAQEBBwEBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///8ACAgIfD4+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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/////////////////////////////wB///8Af//+AH///AB///gAP//4AB//8AAf//AAH//wAB//8AAf//wAH//8AB///AA//h+A//4f///+D////gf///4D///+A////wP///////////////////////////////////////8=), auto';
        } else {
            return 'url(data:image/x-icon;base64,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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA///////////////////////8AP///AD///wA///4AP//8AB///AAP//gAD//wAA//8AAP//AAB//wAAf/8AAH//wAB//4AAf/+AA//wwAf/8OQv//B+f//wP///8B////Af///4H//////////////////////////////////8=), auto';
        }
    } else {
        return "url(data:image/x-icon;base64,AAABAAEAICAAAAEAIACoEAAAFgAAACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAP//////////////////////////////////////////////////////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////////////////////////////////////////////////////8AAAD/AAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA///////+P////j////4////+P////j////4////+P////j////4////+P////j////4////////AA+ABwAPgAcAD4AH///////4////+P////j////4////+P////j////4////+P////j////4////+P////j////////////8=) 16 16, auto";
    }
};

proto.ignoreInput = function() {

    return this.teleporting;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleButtonDown = function(event, button) {
    if (this.viewer.navigation.getIsLocked()) {
        return true;
    }
    getMousePosition(event, this.viewer, this.mousePosition);

    if (button === 0) {

        this.turningWithMouse = true;
        this.turnMouseDelta.set(0, 0, 0);
    }

    return true;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleButtonUp = function(event, button) {

    getMousePosition(event, this.viewer, this.mousePosition);

    if (button === 0) {
        this.turningWithMouse = false;
    }

    return true;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleMouseClick = function(event, button) {

    getMousePosition(event, this.viewer, this.mousePosition);
    return false;
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleMouseDoubleClick = function(event, button) {

    // Other than skipping the internal logic here, we consume the event so DefaultHandler won't trigger fitToView.
    if (this.tool.options.disableBimWalkFlyTo) {
        return true;
    }

    var onFloorFound = function(intersection) {

        this.teleporting = true;
        this.teleportTime = 0;

        var camera = this.viewer.impl.camera;

        // Set intial position to current camera position.
        this.teleportInitial.copy(camera.position);

        // Set target position, collision plus camera's height.
        var cameraUp = getTempVector(camera.worldup);
        cameraUp.multiplyScalar(this.get('cameraDistanceFromFloor') * this.metersToModel);

        this.teleportTarget.copy(intersection.intersectPoint).add(cameraUp);

        // On floor teleport ends on the spot.
        this.teleportVelocity.set(0, 0, 0);
    }.bind(this);

    var onWallFound = function(intersection) {

        var viewer = this.viewer;
        var camera = this.viewer.impl.camera;
        var metersToModel = this.metersToModel;
        var cameraDistanceFromFloor = this.get('cameraDistanceFromFloor');
        var feetToCameraDelta = getTempVector(camera.worldup).multiplyScalar(cameraDistanceFromFloor * metersToModel);

        // Set intial position to current camera position.
        var initial = getTempVector(camera.position);

        // Set target position to collision displaced the teleport distance at floor level.
        var direction = getTempVector(intersection.intersectPoint);
        direction.sub(camera.position);
        setWorldUpComponent(camera, direction, 0).normalize();

        var target = getTempVector(intersection.intersectPoint);
        target.add(direction.multiplyScalar(this.get('teleportWallDistance') * metersToModel));
        target.add(feetToCameraDelta);

        // Get floor candidates.
        var candidates = [];
        var minAllowedRoofDistance = this.get('minAllowedRoofDistance');
        var bigAllowedVerticalStep = this.get('bigAllowedVerticalStep');
        var minFloorSidesLengthForBigVerticalStep = this.get('minFloorSidesLengthForBigVerticalStep');

        var bestCandidateIndex = getFloorCandidates(
            target,
            cameraDistanceFromFloor * metersToModel,
            minAllowedRoofDistance * metersToModel,
            0,
            bigAllowedVerticalStep * metersToModel,
            minFloorSidesLengthForBigVerticalStep * metersToModel,
            viewer,
            candidates);

        // There is no floor, so there is no falling at all, keeping same camera height.
        if (bestCandidateIndex === -1) {
            return;
        }

        // Target is the best floor candidate displaced by the distance from floor.
        target.copy(candidates[bestCandidateIndex].point).add(feetToCameraDelta);

        this.teleporting = true;
        this.teleportTime = 0;
        this.teleportInitial.copy(initial);
        this.teleportTarget.copy(target);
    }.bind(this);

    if (this.teleporting) {
        return true;
    }
    var viewer = this.viewer;
    getMousePosition(event, viewer, this.mousePosition);

    var mousePosition = this.mousePosition;
    var viewerportPosition = viewer.impl.clientToViewport(mousePosition.x, mousePosition.y);
    var camera = viewer.impl.camera;

    // No intersection with geometry.
    var intersection = viewer.impl.castRayViewport(viewerportPosition, false, false, false);
    if (intersection && intersection.face) {

        if (isFloorIntersection(intersection, camera)) {
            onFloorFound(intersection);
        }

        if (isWallIntersection(intersection, camera)) {
            onWallFound(intersection);
        }
    }

    return true;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleMouseMove = function(event) {

    var prevMousePosition = this.mousePosition;
    var currMousePosition = temporalMousePosition;

    getMousePosition(event, this.viewer, currMousePosition);

    if (this.turningWithMouse) {

        if (this.get('mouseTurnInverted')) {
            this.turnMouseDelta.x += currMousePosition.x - prevMousePosition.x;
            this.turnMouseDelta.y += currMousePosition.y - prevMousePosition.y;
        } else {
            this.turnMouseDelta.x -= currMousePosition.x - prevMousePosition.x;
            this.turnMouseDelta.y -= currMousePosition.y - prevMousePosition.y;
        }
    }

    this.mousePosition.copy(currMousePosition);
    return this.turningWithMouse;
};

function getNormalizedPointersDistance(viewer, event) {
    var rect = viewer.impl.getCanvasBoundingClientRect();
    var dx = (event.pointers[1].clientX - event.pointers[0].clientX) / rect.width;
    var dy = (event.pointers[1].clientY - event.pointers[0].clientY) / rect.height;
    return Math.sqrt(dx * dx + dy * dy);
}

proto.shouldOrbit = function() {
    const floorCandidate = this.getBestFloorCandidate();

    if (!floorCandidate) {
        return true; // There is no floor beneath us - fallback to regular pinch from the orbit tool.
    }

    const bounds = this.viewer.impl.getVisibleBounds();
    const pos = this.viewer.getCamera().position;
    const cameraInBounds = bounds.containsPoint(pos);

    // If there is a floor beneath us, but the camera is outside of the visible bounds,
    // it means that we are way above the model itself. In that case - use regular orbit.
    return !cameraInBounds;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleGesture = function(event) {

    // Convert Hammer touch-event X,Y into mouse-event X,Y.
    if (event.pointers && event.pointers.length > 0) {
        event.pageX = event.pointers[0].pageX;
        event.pageY = event.pointers[0].pageY;
    }

    var handled = false;

    switch (event.type) {
        case "dragstart":
            this.ignoreGravity = true;
            if (this.shouldOrbit()) {
                return false;
            }

            this.isDragging = true;

            // Single touch, fake the mouse for now...
            handled = this.handleButtonDown(event, 0);
            break;

        case "dragmove":
            if (!this.isDragging) return false;

            handled = this.handleMouseMove(event);
            break;

        case "dragend":
            if (!this.isDragging) return false;

            this.isDragging = false;

            handled = this.handleButtonUp(event, 0);
            break;

        case "panstart":
        case "pinchstart":
            this.ignoreGravity = true;
            if (this.shouldOrbit()) {
                return false;
            }

            this.isPinching = true;

            this.lastPinchDistance = getNormalizedPointersDistance(this.viewer, event);
            getMousePosition(event, this.viewer, this.mousePosition);
            this.lastPanPosition.copy(this.mousePosition);

            return true;

        case "panmove":
        case "pinchmove":
            {

                if (!this.isPinching) return false;

                const rect = this.viewer.impl.getCanvasBoundingClientRect();
                const cameraVector = this.tool.camera.worldup;
                const cameraForward = getForward(this.tool.camera);
                const cameraRight = getTempVector(cameraForward).cross(cameraVector).normalize();

                // Calculate forward distance.
                const pinchDistance = getNormalizedPointersDistance(this.viewer, event);
                const targetDistance = pinchDistance - this.lastPinchDistance;

                const targetPosition = this.viewer.impl.clientToViewport(this.mousePosition.x, this.mousePosition.y);
                this.viewer.impl.viewportToRay(targetPosition, this.mouseForwardDirection);
                const direction = this.mouseForwardDirection.direction;
                direction.sub(getTempVector(cameraVector).multiplyScalar(cameraVector.dot(direction)));
                direction.normalize();

                this.moveMouseVelocity.copy(direction.multiplyScalar(targetDistance * this.get('pinchDistanceMultiplier')));

                // Calculate vertical and horizontal panning vectors.
                getMousePosition(event, this.viewer, temporalMousePosition);

                let panRatio = (temporalMousePosition.y - this.lastPanPosition.y) / rect.height;
                this.moveUpDownKeyboardVelocity.copy(cameraVector).multiplyScalar(panRatio * this.get('panDistanceMultiplier'));

                panRatio = (temporalMousePosition.x - this.lastPanPosition.x) / rect.width;
                this.moveKeyboardVelocity.copy(cameraRight).multiplyScalar(-panRatio * this.get('panDistanceMultiplier'));

                // Update camera now.
                this.immediateDisplacement = true;
                this.tool.update();
                this.immediateDisplacement = false;

                // Update values for next touch event.
                this.lastPinchDistance = pinchDistance;
                this.lastPanPosition.copy(temporalMousePosition);
                this.moveUpDownKeyboardVelocity.set(0, 0, 0);
                this.moveMouseVelocity.set(0, 0, 0);
                this.moveKeyboardVelocity.set(0, 0, 0);

                return true;
            }
        case "panend":
        case "pinchend":
            if (!this.isPinching) return false;

            this.isPinching = false;
            return true;

            // Disable rotation
        case "rotatestart":
        case "rotatemove":
        case "rotateend":
            this.ignoreGravity = true;
            return true;
    }

    return handled;
};

/**
 *
 * @param event
 * @param keyCode
 * @returns {boolean}
 */
proto.handleKeyDown = function(event, keyCode) {

    var handled = true;
    switch (keyCode) {
        case this.keys.SHIFT:
            this.running = true;
            break;

        case this.keys.DASH:
            {
                const topSpeed = this.get('topWalkSpeed') - 1;
                this.tool.set('topWalkSpeed', topSpeed);
                break;
            }

        case this.keys.EQUALS:
        case this.keys.PLUS:
        case this.keys.PLUSMOZ:
            {
                const topSpeed = this.get('topWalkSpeed') + 1;
                this.tool.set('topWalkSpeed', topSpeed);
                break;
            }

        case this.keys.CONTROL:
        case this.keys.ALT:
            break;

        case this.keys.SPACE:
            this.enableGravity(!this.gravityEnabled);
            break;

        case this.keys.UP:
        case this.keys.w:
            this.moveForward = 1.0;
            break;

        case this.keys.LEFT:
            this.turnLeft = 1.0;
            break;

        case this.keys.RIGHT:
            this.turnRight = 1.0;
            break;

        case this.keys.DOWN:
        case this.keys.s:
            this.moveBackward = 1.0;
            break;

        case this.keys.a:
            this.moveLeft = 1.0;
            break;

        case this.keys.d:
            this.moveRight = 1.0;
            break;

        case this.keys.e:
            this.moveUp = 1.0;
            break;

        case this.keys.q:
            this.moveDown = 1.0;
            break;

        default:
            handled = false;
            break;
    }

    this.running = event.shiftKey;
    if (this.ui.onKeyDown) {
        handled |= this.ui.onKeyDown(event, keyCode);

    }

    return handled;
};

proto.getBestFloorCandidate = function() {
    var viewer = this.viewer;
    var camera = this.viewer.impl.camera;
    var metersToModel = this.metersToModel;
    var cameraDistanceFromFloor = this.get('cameraDistanceFromFloor');

    var target = getTempVector(camera.position);
    target.add(getTempVector(camera.worldup).multiplyScalar(1.5 * metersToModel));

    // Get floor candidates.
    var candidates = [];
    var minFloorSidesLengthForBigVerticalStep = this.get('minFloorSidesLengthForBigVerticalStep');

    var bestCandidateIndex = getFloorCandidates(
        target,
        cameraDistanceFromFloor * metersToModel,
        Number.MAX_SAFE_INTEGER,
        0,
        0,
        minFloorSidesLengthForBigVerticalStep * metersToModel,
        viewer,
        candidates);

    if (bestCandidateIndex === -1) {
        return null;
    }

    return candidates[bestCandidateIndex];
};

/**
 *
 * @param event
 * @param keyCode
 * @returns {boolean}
 */
proto.handleKeyUp = function(event, keyCode) {

    var moveToFloor = function() {
        var camera = this.viewer.impl.camera;
        var metersToModel = this.metersToModel;
        var cameraDistanceFromFloor = this.get('cameraDistanceFromFloor');
        var feetToCameraDelta = getTempVector(camera.worldup).multiplyScalar(cameraDistanceFromFloor * metersToModel);

        // Set intial position to current camera position.
        var initial = getTempVector(camera.position);

        var target = getTempVector(camera.position);
        target.add(getTempVector(camera.worldup).multiplyScalar(1.5 * metersToModel));

        // Get floor candidates.

        var bestCandidate = this.getBestFloorCandidate();

        // There is no floor, so there is no falling at all, keeping same camera height.
        if (!bestCandidate) {
            return;
        }

        // Target is the best floor candidate displaced by the distance from floor.
        target.copy(bestCandidate.point).add(feetToCameraDelta);

        this.teleporting = true;
        this.teleportTime = 0;
        this.teleportInitial.copy(initial);
        this.teleportTarget.copy(target);
    }.bind(this);

    var handled = true;
    var moveUp = this.moveUp;
    var moveDown = this.moveDown;

    switch (keyCode) {

        case this.keys.SHIFT:
            this.running = false;
            break;

        case this.keys.CONTROL:
        case this.keys.ALT:
            break;

        case this.keys.SPACE:
            break;

        case this.keys.UP:
        case this.keys.w:
            this.moveForward = 0;
            break;

        case this.keys.LEFT:
            this.turnLeft = 0;
            break;

        case this.keys.RIGHT:
            this.turnRight = 0;
            break;

        case this.keys.DOWN:
        case this.keys.s:
            this.moveBackward = 0;
            break;

        case this.keys.a:
            this.moveLeft = 0;
            break;

        case this.keys.d:
            this.moveRight = 0;
            break;

        case this.keys.e:
            this.moveUp = 0;
            break;

        case this.keys.q:
            this.moveDown = 0;
            break;

        default:
            handled = false;
            break;
    }

    if (this.moveUp === 0 && this.moveDown === 0 && (this.moveUp !== moveUp || this.moveDown !== moveDown)) {
        // If gravity is disabled, just keep current altitude.
        if (this.gravityEnabled) {
            moveToFloor();
        }
    }

    this.running = event.shiftKey;
    return handled;
};

/**
 * Calculates a target from the passed in delta and assignes it to the this.moveMouseTargetDistance variable.
 * @param {number} delta
 * @returns {boolean}
 */
proto.applyDeltaToMouseTargetDistance = function(delta) {
    // Add delta to target distance until filling the maximum allowed.
    var curTargetDistance = this.moveMouseTargetDistance;
    var maxTargetDistance = this.get('mouseWalkMaxTargetDistance');

    var MAGIC_NUMBER = 0.5;
    var target = Math.min(maxTargetDistance, Math.abs(curTargetDistance + delta * MAGIC_NUMBER)) * (delta > 0 ? 1 : -1);

    this.moveMouseTargetDistance = target;
    return true;
};

/**
 *
 * @param delta
 * @returns {boolean}
 */
proto.handleWheelInput = function(delta) {
    if (this.viewer.navigation.getIsLocked()) {
        return true;
    }
    // If user changes wheel direction, target distance switches directions.
    if (this.tool.navapi.getReverseZoomDirection()) {
        delta *= -1;
    }
    return this.applyDeltaToMouseTargetDistance(delta);
};

/**
 *
 * @param event
 * @param button
 * @returns {boolean}
 */
proto.handleSingleClick = function(event, button) {

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

    return true;
};

/**
 *
 * @param event
 * @returns {boolean}
 */
proto.handleBlur = function(event) {

    // Reset things when we lose focus...
    this.moveForward = this.moveBackward = 0;
    this.moveLeft = this.moveRight = 0;
    this.moveUp = this.moveDown = 0;

    return false;
};