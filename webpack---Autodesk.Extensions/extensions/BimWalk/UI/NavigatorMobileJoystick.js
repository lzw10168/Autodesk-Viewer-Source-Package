import './NavigatorMobileJoystick.css';

const av = Autodesk.Viewing;

export function NavigatorMobileJoystick(viewer, navigator, options) {

    var _viewer = viewer;
    this.setGlobalManager(viewer.globalManager);

    var _navigator = navigator;
    var _options = options || {};

    var _joystickContainer = null;
    var _joystickHandle = null;
    var _joystickBackCircle = null;

    var _arrowUp = null;
    var _arrowDown = null;
    var _arrowLeft = null;
    var _arrowRight = null;

    var _backCircleRadius = _options.backCircleRadius || 75;
    var _frontCircleRadius = _options.frontCircleRadius || 37.5;
    var _xOffsetFromCorner = _options.xOffsetFromCorner || 100;
    var _yOffsetFromCorner = _options.yOffsetFromCorner || 100;
    var _threshold = _options.threshold || 0.1;
    var _joystickCenter = null;

    var _isDragging = false;

    _navigator.reverseDrag = -1;

    this.updateJoystickHandlePosition = function(x, y) {
        var v = new THREE.Vector2(x - _joystickCenter.x, y - _joystickCenter.y);
        var length = Math.min(v.length(), _frontCircleRadius);
        v.normalize();
        v.multiplyScalar(length);
        v.add(_joystickCenter);

        _joystickHandle.style.left = v.x - _frontCircleRadius + 'px';
        _joystickHandle.style.top = v.y - _frontCircleRadius + 'px';

        return v;
    };

    this.changeJoystickColor = function(isFocused) {
        if (isFocused) {
            _joystickHandle.classList.toggle('focus', true);
            _joystickBackCircle.classList.toggle('focus', true);
            _joystickHandle.classList.remove('transition');
        } else {
            _joystickHandle.classList.remove('focus');
            _joystickBackCircle.classList.remove('focus');
            _joystickHandle.classList.toggle('transition', true);
        }
    };

    this.updateNavigator = function(pos) {
        if (!pos) {
            return;
        }

        var horizontalDelta = (_joystickCenter.x - pos.x) / _backCircleRadius;
        var verticalDelta = (_joystickCenter.y - pos.y) / _backCircleRadius;

        _navigator.moveForward = 0;
        _navigator.moveBackward = 0;
        _navigator.moveLeft = 0;
        _navigator.moveRight = 0;
        _navigator.turningWithKeyboard = false;

        if (verticalDelta > _threshold) {
            _navigator.moveForward = verticalDelta;
        } else if (verticalDelta < -_threshold) {
            _navigator.moveBackward = -verticalDelta;
        }

        if (horizontalDelta > _threshold) {
            _navigator.moveLeft = horizontalDelta;
            _navigator.turningWithKeyboard = true;
        } else if (horizontalDelta < -_threshold) {
            _navigator.moveRight = -horizontalDelta;
            _navigator.turningWithKeyboard = true;
        }

        // Set blue color only for arrows that are currently active.
        this.updateArrowColor(_arrowUp, _navigator.moveForward !== 0);
        this.updateArrowColor(_arrowDown, _navigator.moveBackward !== 0);
        this.updateArrowColor(_arrowLeft, _navigator.moveLeft !== 0);
        this.updateArrowColor(_arrowRight, _navigator.moveRight !== 0);
    };

    this.handleGesture = function(event) {
        var pos = null;

        switch (event.type) {
            case "dragstart":
                _isDragging = true;
                this.changeJoystickColor(true);
                pos = this.updateJoystickHandlePosition(event.center.x, event.center.y);
                _navigator.ignoreGravity = false;
                break;

            case "dragmove":
                if (_isDragging) {
                    this.changeJoystickColor(true);
                    pos = this.updateJoystickHandlePosition(event.center.x, event.center.y);
                }
                break;

            case "dragend":
                if (_isDragging) {
                    this.changeJoystickColor(false);
                    pos = this.updateJoystickHandlePosition(_joystickCenter.x, _joystickCenter.y);
                    _isDragging = false;
                }
                break;
        }

        this.updateNavigator(pos);
        event.preventDefault();
    };

    this.setJoystickPosition = function(x, y) {
        _joystickHandle.classList.remove('transition');

        var viewerBounds = _viewer.impl.getCanvasBoundingClientRect();
        x += viewerBounds.left;
        y += viewerBounds.top;

        _joystickCenter = new THREE.Vector2(x, y);
        _joystickHandle.style.left = (_joystickCenter.x - _frontCircleRadius) + 'px';
        _joystickHandle.style.top = (_joystickCenter.y - _frontCircleRadius) + 'px';
        _joystickContainer.style.left = (_joystickCenter.x - _backCircleRadius) + 'px';
        _joystickContainer.style.top = (_joystickCenter.y - _backCircleRadius) + 'px';
    };

    this.setJoystickRelativePosition = function(x = _xOffsetFromCorner, y = _yOffsetFromCorner) {
        _xOffsetFromCorner = x;
        _yOffsetFromCorner = y;

        var centerX = _viewer.container.clientWidth - _backCircleRadius - _xOffsetFromCorner;
        var centerY = _viewer.container.clientHeight - _backCircleRadius - _yOffsetFromCorner;
        this.setJoystickPosition(centerX, centerY);
    };

    this.setJoystickPositionRelativeToCorner = function() {
        this.setJoystickRelativePosition();
    };

    this.setJoystickSize = function(backgroundRadius, handleRadius) {
        _backCircleRadius = backgroundRadius;
        _joystickContainer.style.width = (_backCircleRadius * 2) + 'px';
        _joystickContainer.style.height = (_backCircleRadius * 2) + 'px';

        _frontCircleRadius = handleRadius;
        _joystickHandle.style.width = (_frontCircleRadius * 2) + 'px';
        _joystickHandle.style.height = (_frontCircleRadius * 2) + 'px';

        if (_joystickCenter) {
            this.setJoystickPosition(_joystickCenter.x, _joystickCenter.y);
        }
    };

    this.updateArrowColor = function(arrow, isActive) {
        if (isActive && !arrow.classList.contains('active')) {
            arrow.classList.add('active');
        } else if (!isActive && arrow.classList.contains('active')) {
            arrow.classList.remove('active');
        }
    };

    this.init = function() {
        if (!_joystickContainer) {
            const _document = this.getDocument();
            // joystick container
            _joystickContainer = _document.createElement('div');
            _joystickContainer.className = 'mobile-joystick';
            _viewer.container.appendChild(_joystickContainer);
            _joystickContainer.classList.add(_viewer.theme);

            // joystick background circle
            _joystickBackCircle = _document.createElement('div');
            _joystickBackCircle.className = 'mobile-joystick mobile-joystick-back-circle';
            _joystickContainer.appendChild(_joystickBackCircle);

            // joystick handle
            _joystickHandle = _document.createElement('div');
            _joystickHandle.className = 'mobile-joystick mobile-joystick-handle';
            this.changeJoystickColor(false);
            _joystickContainer.appendChild(_joystickHandle);

            const innerCircle = _document.createElement('div');
            innerCircle.className = 'mobile-joystick mobile-joystick-inner-circle';
            _joystickHandle.appendChild(innerCircle);

            /// Arrows                    
            _arrowUp = _document.createElement('div');
            _arrowUp.className = 'mobile-joystick-arrow arrow-up';
            _joystickContainer.appendChild(_arrowUp);

            _arrowRight = _document.createElement('div');
            _arrowRight.className = 'mobile-joystick-arrow arrow-right';
            _joystickContainer.appendChild(_arrowRight);

            _arrowDown = _document.createElement('div');
            _arrowDown.className = 'mobile-joystick-arrow arrow-down';
            _joystickContainer.appendChild(_arrowDown);

            _arrowLeft = _document.createElement('div');
            _arrowLeft.className = 'mobile-joystick-arrow arrow-left';
            _joystickContainer.appendChild(_arrowLeft);

            this.setJoystickSize(_backCircleRadius, _frontCircleRadius);
            this.setJoystickPositionRelativeToCorner();

            var av = Autodesk.Viewing;
            this.hammer = new av.Hammer.Manager(_joystickHandle, {
                recognizers: [
                    av.GestureRecognizers.drag
                ],
                handlePointerEventMouse: false,
                inputClass: av.Hammer.TouchInput
            });

            this.hammer.on("dragstart dragmove dragend", this.handleGesture.bind(this));

            this.onOrientationChanged = this.setJoystickPositionRelativeToCorner.bind(this);
        }
    };

    this.init();

    this.activate = function() {
        this.updateJoystickHandlePosition(_joystickCenter.x, _joystickCenter.y);
        _joystickContainer.classList.toggle('visible', true);
        _viewer.addEventListener(Autodesk.Viewing.VIEWER_RESIZE_EVENT, this.onOrientationChanged);
    };

    this.deactivate = function() {
        _joystickContainer.classList.remove('visible');
        _isDragging = false;
        _viewer.removeEventListener(Autodesk.Viewing.VIEWER_RESIZE_EVENT, this.onOrientationChanged);
    };
}

av.GlobalManagerMixin.call(NavigatorMobileJoystick.prototype);