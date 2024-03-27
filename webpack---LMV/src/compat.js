import {
    getGlobal
} from './global';

const _window = getGlobal();
const _document = _window && _window.document;

export {
    getGlobal
};

export const isBrowser = (typeof navigator !== "undefined");

export const isNodeJS = function() {
    return !isBrowser;
};

export let isIE11 = isBrowser && !!navigator.userAgent.match(/Edge|Trident\/7\./);

// Although the naming is misleading, isIE11 contains Edge too for some legacy reason.
// For backward compatibility, instead of renaming `isIE11` to `isIEOrEdge`, I just added `isIE11Only`.
export let isIE11Only = isBrowser && !!navigator.userAgent.match(/Trident\/7\./);

// Launch full screen on the given element with the available method
export function launchFullscreen(element, options) {
    if (element.requestFullscreen) {
        element.requestFullscreen(options);
    } else if (element.mozRequestFullScreen) {
        element.mozRequestFullScreen(options);
    } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen(options);
    } else if (element.msRequestFullscreen) {
        element.msRequestFullscreen(options);
    }
};

// Exit full screen with the available method
export function exitFullscreen(_document) {
    if (!inFullscreen(_document)) {
        return;
    }
    if (_document.exitFullscreen) {
        _document.exitFullscreen();
    } else if (_document.mozCancelFullScreen) {
        _document.mozCancelFullScreen();
    } else if (_document.webkitExitFullscreen) {
        _document.webkitExitFullscreen();
    } else if (_document.msExitFullscreen) {
        _document.msExitFullscreen();
    }
};

// Determines if the browser is in full screen
export function inFullscreen(_document) {

    // Special case for Ms-Edge that has webkitIsFullScreen with correct value
    // and fullscreenEnabled with wrong value (thanks MS)

    if ("webkitIsFullScreen" in _document) return !!(_document.webkitIsFullScreen);
    if ("fullscreenElement" in _document) return !!(_document.fullscreenElement);
    if ("mozFullScreenElement" in _document) return !!(_document.mozFullScreenElement);
    if ("msFullscreenElement" in _document) return !!(_document.msFullscreenElement);

    return !!(_document.querySelector(".viewer-fill-browser")); // Fallback for iPad
};

export function fullscreenElement(_document) {
    return _document.fullscreenElement || _document.mozFullScreenElement || _document.webkitFullscreenElement || _document.msFullscreenElement;
};

export function isFullscreenAvailable(element) {
    return element.requestFullscreen || element.mozRequestFullScreen || element.webkitRequestFullscreen || element.msRequestFullscreen;
};

/**
 * Returns true if full screen mode is enabled. 
 * @param {Document} _document
 * @return {Boolean} - true if full screen mode is enabled false otherwise.
 */
export function isFullscreenEnabled(_document) {
    return (
        _document.fullscreenEnabled ||
        _document.webkitFullscreenEnabled ||
        _document.mozFullScreenEnabled ||
        _document.msFullscreenEnabled
    );
}

// Get the IOS version through user agent.
// Return the version string of IOS, e.g. 14.1.1, 15.4 ... or empty string if version couldn't be detected
// User agents can be changed and thus might be inaccurate or incompatible at some point, but this pattern
// has been stable at least since IOS 5
export function getIOSVersion(ua) {
    ua = ua || navigator.userAgent;
    var match = ua.match(/OS ((\d+)_(\d+)(_(\d+))?) like Mac OS X/);
    if (!match && isIOSDevice()) {
        // On IPadOS Safari requests the desktop version by default with a MacOS user.
        // The major version seems to be reliable, but the minor version might be incorrect.
        match = ua.match(/\/((\d+)\.(\d+)(\.\d)?) Safari\//);
    }

    return match ? match[1].replace('_', '.') : "";
};

// Get the version of the android device through user agent.
// Return the version string of android device, e.g. 4.4, 5.0...
export function getAndroidVersion(ua) {
    ua = ua || navigator.userAgent;
    var match = ua.match(/Android\s([0-9\.]*)/);
    return match ? match[1] : false;
};

// Determine if this is a touch or notouch device.
export function isTouchDevice() {
    return (typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
};

// Since iOS 13, the iPad identifies itself as a desktop, so the only way to reliably detect is to search for multitouch capabilities
// (insofar as no other Apple device implements it)
// It also returns different values in a worker so we need to look in the platform as well to distinguish from a regular Mac
const _isIOSDevice = isBrowser && (/ip(ad|hone|od)/.test(navigator.userAgent.toLowerCase()) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
    (/^ip(ad|hone|od)$/.test(navigator.platform ? .toLowerCase())));
export function isIOSDevice() {
    return _isIOSDevice;
}

const _isAndroidDevice = isBrowser && (navigator.userAgent.toLowerCase().indexOf('android') !== -1);
export function isAndroidDevice() {
    return _isAndroidDevice;
}

export function isMobileDevice() {
    if (!isBrowser) return false;
    return isIOSDevice() || isAndroidDevice();
};

export function isPhoneFormFactor() {
    return (
        isMobileDevice() &&
        (_window.matchMedia('(max-width: 750px)').matches || _window.matchMedia('(max-height: 750px)').matches)
    );
}

export function isSafari() {
    if (!isBrowser) return false;
    var _ua = navigator.userAgent.toLowerCase();
    return ((_ua.indexOf("safari") !== -1) && (_ua.indexOf("chrome") === -1));
};

export function isFirefox() {
    if (!isBrowser) return false;
    var _ua = navigator.userAgent.toLowerCase();
    return (_ua.indexOf("firefox") !== -1);
};

export function isChrome() {
    if (!isBrowser) return false;
    var _ua = navigator.userAgent.toLowerCase();
    return (_ua.indexOf("chrome") !== -1);
};

export function isMac() {
    if (!isBrowser) return false;
    var _ua = navigator.userAgent.toLowerCase();
    return (_ua.indexOf("mac os") !== -1) && !isIOSDevice();
};

export function isWindows() {
    if (!isBrowser) return false;
    var _ua = navigator.userAgent.toLowerCase();
    return (_ua.indexOf("win32") !== -1 || _ua.indexOf("windows") !== -1);
};

export function ObjectAssign(des, src) {
    for (var key in src) {
        if (src.hasOwnProperty(key))
            des[key] = src[key];
    }
    return des;
};

// Hack to work around Safari's use of pinch and pan inside the viewer canvas.
function disableTouchSafari(event) {
    var xOff = _window.hasOwnProperty("pageXOffset") ? _window.pageXOffset : _document.documentElement.scrollLeft;
    var yOff = _window.hasOwnProperty("pageYOffset") ? _window.pageYOffset : _document.documentElement.scrollTop;

    // event.pageX and event.pageY returned undefined through Chrome console device mode
    var pageX = typeof event.pageX === "undefined" ? event.changedTouches[0].pageX : event.pageX;
    var pageY = typeof event.pageY === "undefined" ? event.changedTouches[0].pageY : event.pageY;

    // If we aren't inside the canvas, then allow default propagation of the event
    var element = _document.elementFromPoint(pageX - xOff, pageY - yOff);
    if (!element || element.nodeName !== 'CANVAS')
        return true;
    // If it's a CANVAS, check that it's owned by us
    if (element.getAttribute('data-viewer-canvas') !== 'true')
        return true;
    // Inside the canvas, prevent the event from propagating to Safari'safely
    // standard handlers, which will pan and zoom the page.
    event.preventDefault();
    return false;
}

// Hack to work around Safari's use of pinch and pan inside the viewer canvas.
export function disableDocumentTouchSafari() {
    if (isMobileDevice() && isSafari()) {
        // Safari mobile disable default touch handling inside viewer canvas
        // Use capture to make sure Safari doesn't capture the touches and prevent
        // us from disabling them.
        _document.documentElement.addEventListener('touchstart', disableTouchSafari, true);
        _document.documentElement.addEventListener('touchmove', disableTouchSafari, true);
        _document.documentElement.addEventListener('touchcanceled', disableTouchSafari, true);
        _document.documentElement.addEventListener('touchend', disableTouchSafari, true);
    }
};

// Hack to work around Safari's use of pinch and pan inside the viewer canvas.
// This method is not being invoked explicitly.
export function enableDocumentTouchSafari() {
    if (isMobileDevice() && isSafari()) {
        // Safari mobile disable default touch handling inside viewer canvas
        // Use capture to make sure Safari doesn't capture the touches and prevent
        // us from disabling them.
        _document.documentElement.removeEventListener('touchstart', disableTouchSafari, true);
        _document.documentElement.removeEventListener('touchmove', disableTouchSafari, true);
        _document.documentElement.removeEventListener('touchcanceled', disableTouchSafari, true);
        _document.documentElement.removeEventListener('touchend', disableTouchSafari, true);
    }
};


// Convert touchstart event to click to remove the delay between the touch and
// the click event which is sent after touchstart with about 300ms deley.
// Should be used in UI elements on touch devices.
export function touchStartToClick(e) {
    // Buttons that activate fullscreen are a special case. The HTML5 fullscreen spec
    // requires the original user gesture signal to avoid a security issue.  See LMV-2396 and LMV-2326
    if (e.target.className && (e.target.className.indexOf("fullscreen") > -1 ||
            e.target.className.indexOf("webvr") > -1))
        return;
    e.preventDefault(); // Stops the firing of delayed click event.
    e.stopPropagation();
    e.target.click(); // Maps to immediate click.
}