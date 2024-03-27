/**
 * This class is primarily intended for two uses: First, take control of counting draw calls, including
 * instancing-based ones and others, that are provided by extensions, regardless of the renderer used.
 * Some renderers might not differentiate between types of draw calls or are error prone.
 * Second, allow for injection of callbacks that are invoked after a specific number of draw calls. This
 * was intiallly motivated for injecting additional context flushes due to a driver issue on iOS devices.
 *
 * This class could be easily extended for more detailed statistics, e.g., on the number of points, lines,
 * and triangles that are send for rasterization... Memory could be tracked similiary by hooking rendering
 * objects instead of draw calls.
 *
 * Design Remarks:
 * - creating function hooks on draw calls within a given context cannot be undone
 * - removal of injected callbacks not yet implemented (not required for now)
 * - using multiple DrawCallIntrusion instances will polute the function stack due to hooks beeing blindly
 *   stacked on top of one another... @todo: probably fix and allow only one intrusion per context (get or create approach)
 *
 * Usage example during initialization of a WebGL-based rendering:
 *
 * @example
 *  const gl = canvas.getContext('webgl2');
 *  ...
 *  this._drawCallIntrusion = new DrawCallIntrusion();
 *  this._drawCallIntrusion.initialize(gl);
 *  ...
 *  this._drawCallIntrusion.inject(() => { gl.flush(); }, 4096);
 *  console.debug(`Additional context flushes will be invoked every 4096 subsequent draw calls.`);
 *  ...
 *  // optional somewhere in swap (finished frame)
 *  this._drawCallIntrusion.resetCounters();
 */
export class DrawCallIntrusion {

    _callbacks;

    _numberOfTotalDrawCalls;
    _numberOfInjections;

    constructor() {

        this._callbacks = new Array();

        this._numberOfTotalDrawCalls = 0;
        this._numberOfInjections = 0;

        this.counters = {
            drawArrays: 0,
            drawArraysInstanced: 0,
            drawElements: 0,
            drawElementsInstanced: 0,
            total: 0,
        };
    }

    /**
     * Creates hooks for every known draw call of the given context (including draw calls introduced by extensions).
     * Note that only draw calls from already enabled extensions will be found and hooked.
     *
     * @param {WebGL2RenderingContext} context - Any context to create draw call hooks for.
     */
    initialize(context) {

        if (!(context instanceof WebGL2RenderingContext)) {
            console.debug('Draw calls cannot be intruded and counted: Valid context object expected, given', context);
            return;
        }

        this.#intrudeWebGL2(context);
        this.#intrudeWebGL2Extensions(context);
    }

    uninitialize() {
        // note that function hooks cannot be undone/unhooked easily since additional hooks added later
        // somewhere else are unknown (due to leaky api use)
    }

    /**
     * Reset the number of draw calls counted.

     */
    resetCounters() {
        for (const injection of this._callbacks) {
            // To account for continuous callback invocations (ignoring count resets),
            // `callCountOnLastInvocation` must be adjusted accordingly.
            if (injection.continuous) {
                injection.callCountOnLastInvocation -= this.counters.total;
            } else {
                injection.callCountOnLastInvocation = 0;
            }
        }

        this.counters.drawArrays = 0;
        this.counters.drawArraysInstanced = 0;
        this.counters.drawElements = 0;
        this.counters.drawElementsInstanced = 0;
        this.counters.total = 0;
    }

    /**
     * Allows to register callbacks that will be repeatedy invoked after a specific number of subsequent draw calls.
     *
     * @param {Function} callback - Function that will be invoked when conditions are met.
     * @param {Number} numberOfCallsIgnoreBeforeInvocation - As the name suggests. If 0, the callback will be invoked after every single draw call.
     * @param {boolean} continuous - Tracks invocations regardless of call count resets.
     */
    inject(callback, numberOfCallsIgnoreBeforeInvocation, continuous = false) {

        if (Number.isInteger(numberOfCallsIgnoreBeforeInvocation) && numberOfCallsIgnoreBeforeInvocation < 0) {
            console.warn('After-draw-call callback injection ignored. Number of calls ignored before invocation must be a positive number, given', numberOfCallsIgnoreBeforeInvocation);
            return;
        }
        this._callbacks.push({
            callback,
            numberOfCallsIgnoreBeforeInvocation: numberOfCallsIgnoreBeforeInvocation,
            callCountOnLastInvocation: 0, // per-callback tracking of last invocation
            continuous: continuous,
        });
    }

    /**
     * Auxiliary that creates a wrapper function which (1) calls the target function first and (2) the afterCallback second.
     *
     * @param {Function} targetFunction - Function to call first.
     * @param {Function} afterCallback - Function to call second.
     * @returns {Function} a wrapper function calling the given target, then the given callback.
     */
    #
    hookWithAfterCallback(targetFunction, afterCallback) {

        if (targetFunction === undefined) {
            return undefined;
        }

        return function() {
            targetFunction.apply(this, arguments);
            afterCallback.apply(this);
        };
    }

    /**
     * Updates the total number of draw calls counted and evaluates for every injected callback, whether or not to invoke it.
     */
    #
    callCountChanged() {

        ++this.counters.total;
        ++this._numberOfTotalDrawCalls;

        if (this._callbacks.length === 0) {
            return;
        }

        for (const injection of this._callbacks) {
            if ((this.counters.total - injection.callCountOnLastInvocation) <= injection.numberOfCallsIgnoreBeforeInvocation) {
                continue;
            }
            injection.callback();
            injection.callCountOnLastInvocation = this.counters.total;

            ++this._numberOfInjections;
        }
    }

    /**
     * Creates hooks/wrapper for all default draw calls of a given WebGL2 context.
     * Intended to be used once during initialization.
     *
     * @param {WebGL2RenderingContext} context - Context to create hooks for.
     */
    #
    intrudeWebGL2(context) {

        context.drawArrays = this.#hookWithAfterCallback(
            context.drawArrays, () => {
                ++this.counters.drawArrays;
                this.#callCountChanged();
            });
        context.drawArraysInstanced = this.#hookWithAfterCallback(
            context.drawArraysInstanced, () => {
                ++this.counters.drawArraysInstanced;
                this.#callCountChanged();
            });

        context.drawElements = this.#hookWithAfterCallback(
            context.drawElements, () => {
                ++this.counters.drawElements;
                this.#callCountChanged();
            });
        context.drawElementsInstanced = this.#hookWithAfterCallback(
            context.drawElementsInstanced, () => {
                ++this.counters.drawElementsInstanced;
                this.#callCountChanged();
            });

        context.drawRangeElements = this.#hookWithAfterCallback(
            context.drawRangeElements, () => {
                ++this.counters.drawElements;
                this.#callCountChanged();
            });
    }

    /**
     * Creates hooks/wrapper for all extension-based draw calls of a given WebGL2 context.
     * Intended to be used once during initialization.
     *
     * @param {WebGL2RenderingContext} context - Context to create hooks for.
     */
    #
    intrudeWebGL2Extensions(context) {}

}