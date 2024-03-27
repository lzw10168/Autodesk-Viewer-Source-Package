/**
 * Functions on the global scope need to be called with the global scope as their 'this' context.
 * Therefore, we can't simply return function properties from the global scope proxy like other properties.
 * We create another (temporary) proxy instead, which implements the 'apply' hook.
 * Invoking a function through this hook will ensure the correct 'this' context inside of the function.
 * 
 * @param {Object} globalScope The global scope that the function is a property of (e.g. window).
 * @param {Function} func The function property that is accessed through the global scope proxy.
 * @returns {Proxy} A new proxy that forwards function invocations so that the 'this' context of the invoked function
 *   is set up properly.
 */
function createFunctionProxy(globalScope, func) {
    return new Proxy(func, {
        get(obj, prop) {
            return obj[prop];
        },
        apply(target, thisArg, argumentsList) {
            return target.call(globalScope || thisArg, ...argumentsList);
        }
    });
}

// A helper method to get an app-specific namespace under the global scope, or create it if it's not present yet.
function getAppNamespace(globalScope) {
    return globalScope[globalScope.LMV_APP_NAMESPACE] = globalScope[globalScope.LMV_APP_NAMESPACE] || {};
}

/**
 * Returns the global object of the current environment (e.g. window in a browser).
 * If `USE_LMV_APP_NAMESPACES` is set to `true` on the global scope, the returned value will be a proxy that intercepts
 * set operations on non-existing properties and writes the value to an app-specific namespace instead. The actual
 * property on the window object is a placeholder that forwards read and write operations to the app-specific version.
 *
 * Example:
 * Given that window.LMV_APP_NAMESPACE is 'myApp' and window.Autodesk does not exist yet
 *
 * getGlobal().Autodesk = {}
 *
 * will be rewritten as
 *
 * window.myApp.Autodesk = {};
 * window.Autodesk = Placeholder that forwards to window[window.LMV_APP_NAMESPACE].Autodesk
 *
 * Changing window.LMV_APP_NAMESPACE to 'myOtherApp' will then rewrite
 *
 * window.Autodesk to window.myOtherApp.Autodesk
 *
 * @returns {Object} The global scope of the environment.
 */
export function getGlobal() {
    // Determine the global scope of the environment
    const globalScope = (typeof window !== "undefined" && window !== null) ?
        window :
        (typeof self !== "undefined" && self !== null) ?
        self :
        global;

    // If app namespaces are used, create and return a proxy instead of the actual global scope object.
    if (globalScope.USE_LMV_APP_NAMESPACES) {
        if (!globalScope.globalProxy) {
            // The proxy is a singleton that will only be created once, even across multiple viewer bundles.
            globalScope.globalProxy = new Proxy({}, {
                // Get requests are simply forwarded to the global scope.
                // Functions get some special treatment, because they need to invoked with the global scope as their
                // 'this' context.
                get(obj, prop) {
                    let value = globalScope[prop];
                    if (typeof value === 'function') {
                        return createFunctionProxy(globalScope, value);
                    }
                    return value;
                },
                // Set requests are intercepted to create properties in app-specific namespaces.
                set(obj, prop, value) {
                    if (Object.prototype.hasOwnProperty.call(globalScope, prop)) {
                        // Don't proxy existing properties
                        if (globalScope[prop] !== value)
                            globalScope[prop] = value;
                    } else {
                        // Create the property under the app's namespace and inject a proxy object in the global
                        // scope that forwards to the namespaced property.
                        getAppNamespace(globalScope)[prop] = value;
                        Object.defineProperty(globalScope, prop, {
                            get: () => {
                                return getAppNamespace(globalScope)[prop];
                            },
                            set: (value) => {
                                getAppNamespace(globalScope)[prop] = value;
                            }
                        });
                    }
                    return true; // Proxy setters must return true
                }
            });
        }

        return globalScope.globalProxy;
    } else {
        return globalScope;
    }
}