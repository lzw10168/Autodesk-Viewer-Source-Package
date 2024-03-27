import {
    NavigatorSimple
} from './NavigatorSimple';
import {
    NavigatorMobileJoystick
} from '../UI/NavigatorMobileJoystick';
import {
    getTempVector
} from '../BimWalkPools';
import {
    getForward,
    updateFriction,
    updateVelocity
} from '../BimWalkUtils';

var MOBILE_SPEED_FACTOR = 15.0;
const EPSILON = 0.0000125;

/**
 *
 * @constructor
 */
export function NavigatorMobile(tool) {

    NavigatorSimple.call(this, tool);
    this.viewer.setGlobalManager(tool.viewer.globalManager);

    this.configuration.keyboardTopTurnSpeed = 0.5;
    this.configuration.keyboardTurnStopDuration = 0.4;
    this.configuration.mouseTurnInverted = true;

    this.ui = new NavigatorMobileJoystick(this.viewer, this, tool.options.joystickOptions);
}

NavigatorMobile.prototype = Object.create(NavigatorSimple.prototype);
NavigatorMobile.prototype.constructor = NavigatorMobile;

let startQuat;
const endQuat = new THREE.Quaternion();
let camOffsetMatrix = new THREE.Matrix4(); // rotation matrix to maintain offset between gyro's and viewer's rotations of cameras.
// offSetQuat compensates caused by initial device's orientation
// facing towards the ground while screen is up
const offsetQuat = new THREE.Quaternion(0, 0, -Math.sqrt(0.5), Math.sqrt(0.5));
var proto = NavigatorMobile.prototype;

/**
 * Extends NavigatorSimple.activate function
 */
proto.activate = function() {
    NavigatorSimple.prototype.activate.call(this);
    // Gravity state, Gravity should be ignored by default, until user interacts with joystick.
    // ignoreGravity becomes true again once pinch/rotate/drag used.
    this.ignoreGravity = true;

    // Maintain correct Up Direction across different documents, some may have Up World different than Z axis.
    const worldUp = this.viewer.getCamera().worldup;
    this.worldUpAxis = Object.keys(worldUp).find(axis => worldUp[axis] === 1);
};

/**
 * Extends NavigatorSimple.deactivate function
 */
proto.deactivate = function() {
    NavigatorSimple.prototype.deactivate.call(this);
    this.deactivateGyroNavigation();
};

/**
 *
 * @param elapsed
 */
proto.updateKeyboardDisplacement = function(elapsed) {

    var running = this.running;
    var moveForward = this.moveForward;
    var moveBackward = this.moveBackward;

    // Update acceleration.
    var topSpeed = running ? this.getTopRunSpeed() : this.get('topWalkSpeed');
    var velocity = this.moveKeyboardVelocity;
    var acceleration = getTempVector();
    var accelerationModule = topSpeed * MOBILE_SPEED_FACTOR;

    var moving = (
        moveForward !== 0 ||
        moveBackward !== 0);

    if (moving) {

        var camera = this.tool.camera;
        var upVector = camera.worldup;
        var speed = Math.max(this.moveForward, this.moveBackward);

        var directionForward = getForward(camera);
        var directionForwardXZ = getTempVector(directionForward);
        directionForwardXZ.sub(getTempVector(upVector).multiplyScalar(upVector.dot(directionForward)));
        directionForwardXZ.normalize();

        var directionBackwardXZ = getTempVector(directionForwardXZ).multiplyScalar(-1);

        acceleration.add(directionForwardXZ.multiplyScalar(moveForward));
        acceleration.add(directionBackwardXZ.multiplyScalar(moveBackward));
        acceleration.normalize();

        velocity.copy(acceleration).multiplyScalar(speed);
        acceleration.multiplyScalar(accelerationModule * Math.max(this.moveForward, this.moveBackward));
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
 *
 * @param elapsed
 */
proto.updateKeyboardAngularVelocity = function(elapsed) {

    var topSpeed = this.get('keyboardTopTurnSpeed');
    var stopDuration = this.get('keyboardTurnStopDuration');
    var velocity = this.angularKeyboardVelocity;
    var acceleration = getTempVector();
    var accelerationModule = topSpeed / stopDuration;
    var turning = this.turningWithKeyboard;


    // Update angular acceleration.
    if (turning) {

        var speed = Math.min(topSpeed, Math.max(this.moveLeft, this.moveRight) + accelerationModule * elapsed);

        velocity.y = 0;
        velocity.y -= this.moveLeft;
        velocity.y += this.moveRight;

        velocity.normalize().multiplyScalar(speed);
    }

    // Update friction contribution.
    var friction = !turning && updateFriction(accelerationModule, velocity, acceleration);

    // Update velocity.
    updateVelocity(elapsed, acceleration, topSpeed, true, friction, velocity);
};

/**
 * Function handles movement according to input from Gyroscope
 */
proto.updateGyroscopeVelocity = function() {
    // No navigation without data from device
    if (!this.isGyroEnabled) {
        return;
    }

    // according to BLMV-6838, we would like to disable Avatar's rotation by user
    // setLockDragDirection disables Drag Direction in Avatar extension
    if (!this.minimap3dExt) {
        this.minimap3dExt = this.viewer.getExtension("Autodesk.AEC.Minimap3DExtension");
        this.minimap3dExt ? .setLockDragDirection(true);
    }

    const tool = this.tool;
    const tempAngle = new THREE.Euler();
    const camVector = new THREE.Vector3(0, 0, -1); // Default direction of camera
    const camPosition = tool.camera.position;

    endQuat.set(this.x, this.y, this.z, this.w); // create quaternion based Quaternion values from gyroscope

    if (!startQuat) {
        // Refernce point for rotation
        startQuat = endQuat.clone();

        // Calculate and save offset between gyro's and viewer's cameras, around Up direction.
        tempAngle.setFromQuaternion(endQuat);
        const gyroDirection = camVector.applyEuler(tempAngle);
        gyroDirection[this.worldUpAxis] = 0;

        const camTarget = tool.camera.target;
        const camDirection = camTarget.clone().sub(camPosition);
        camDirection[this.worldUpAxis] = 0;

        // accept the offset if problematic angle acquired
        if (gyroDirection.lengthSq() < EPSILON || camDirection.lengthSq() < EPSILON) {
            camOffsetMatrix.identity();
            return;
        }

        gyroDirection.normalize();
        camDirection.normalize();

        // check if vectors are opposite, in this case, rotate camOffsetMatrix by 180 around worldUp direction
        if (gyroDirection.dot(camDirection) < -1 + EPSILON) {
            switch (this.worldUpAxis) {
                case 'x':
                    camOffsetMatrix.makeRotationX(Math.PI);
                    break;
                case 'y':
                    camOffsetMatrix.makeRotationY(Math.PI);
                    break;
                case 'z':
                    camOffsetMatrix.makeRotationZ(Math.PI);
                    break;
            }
        } else {
            const quaternion = new THREE.Quaternion();
            quaternion.setFromUnitVectors(gyroDirection, camDirection);
            camOffsetMatrix.makeRotationFromQuaternion(quaternion);
        }

    } else {
        // Based on THREE JS example, DeviceOrientationControls, which was deleted recently
        // Eliminates minor movements and steadies camera
        const isGyroChanged = 1 - startQuat.dot(endQuat) > EPSILON;
        if (!isGyroChanged) {
            return;
        }
        startQuat = endQuat.clone();
        endQuat.multiply(offsetQuat);

        // setView handles better transition from gyro to touch based movements than trivial quaternion copy
        // in addition, it eliminates yaw (from device's POV) movement
        tempAngle.setFromQuaternion(endQuat);
        const camDirection = camVector.applyEuler(tempAngle);
        camDirection.applyMatrix4(camOffsetMatrix);
        const newTarget = camDirection.add(camPosition);
        tool.navapi.setView(camPosition, newTarget);
        tool.navapi.orientCameraUp();
    }
};

/**
 * Function which updates quaternion values from mobile device's gyro
 * @param {number} w 
 * @param {number} x 
 * @param {number} y 
 * @param {number} z 
 */
proto.updateGyroValues = function(w, x, y, z) {
    // update quaternion values for camera movement.
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    this.isGyroEnabled = true;
};


proto.deactivateGyroNavigation = function() {
    this.w = undefined; // reset value since used as updateGyroscopeVelocity exit condition
    this.x = undefined;
    this.y = undefined;
    this.z = undefined;
    this.isGyroEnabled = false;
    startQuat = undefined; // reset value to make sure smooth transition between mouse and gyro navigations persist
    camOffsetMatrix = new THREE.Matrix4();

    if (this.minimap3dExt) {
        this.minimap3dExt.setLockDragDirection(false);
        this.minimap3dExt = undefined;
    }
};