import {
    EventDispatcher
} from '../../application/EventDispatcher';

import {
    getIOSVersion,
    isIOSDevice
} from "../../compat";

import * as THREE from "three";
import {
    WebGLRenderer
} from './WebGLRenderer';
import {
    DrawCallIntrusion
} from "./DrawCallIntrusion";


export const Events = {
    WEBGL_CONTEXT_LOST: 'webglcontextlost',
    WEBGL_CONTEXT_RESTORED: 'webglcontextrestored',
};

export class LMVRenderer extends WebGLRenderer {

    // This magic number is based on error reports, stating that after tens of thousands of draw calls
    // per frame, crashes might occur. A reasonable value would probably be within 100 to 10000...
    static DEFAULT_NUM_DRAW_CALLS_TO_INJECT_FLUSH_AFTER_IOS = 1000;

    _drawCallIntrusion;

    #
    animationFrameCallbacks;#
    parentRender;#
    parentSetRenderTarget;

    constructor(params = {}) {
        super(params);

        params.canvas ? .addEventListener('webglcontextlost', () => {
            this.fireEvent({
                type: Events.WEBGL_CONTEXT_LOST
            });
        });
        params.canvas ? .addEventListener('webglcontextrestored', () => {
            this.fireEvent({
                type: Events.WEBGL_CONTEXT_RESTORED
            });
        });
        this.refCount = 0;


        /**
         * IOS 15 introduced a regression causing the browser tab to freeze for large models, most likely,
         * due to the number of draw calls (but might also be caused by memory or number of state changes).
         * @todo: Remove the fix, once https://bugs.webkit.org/show_bug.cgi?id=239896 got fixed.
         */
        const iOSVersion = parseInt(getIOSVersion(), 10);
        const implementIOSFlushResolve = isIOSDevice() && iOSVersion >= 15;
        if (implementIOSFlushResolve) {
            // Setup draw call hooks that (1) support draw call counting (and probably more heuristics in the future)
            // and (2) is used to insert additional context flushes to avoid driver crashes on some iOS devices (VIZNXT-382).
            this._drawCallIntrusion = new DrawCallIntrusion();
            this._drawCallIntrusion.initialize(this.getContext());

            const numberOfCallsIgnoredBeforeFlush = LMVRenderer.DEFAULT_NUM_DRAW_CALLS_TO_INJECT_FLUSH_AFTER_IOS - 1;
            this._drawCallIntrusion.inject(() => {
                // Continuous draw call counting should typically not be used for injection.
                // In this case, however, we do not even assume that framebuffer swap flushes.
                this.getContext().flush();
            }, numberOfCallsIgnoredBeforeFlush, true);

            console.debug(numberOfCallsIgnoredBeforeFlush < 1 ?
                `LMVRenderer: Additional context flushes will be invoked after every draw call.` :
                `LMVRenderer: Additional context flushes will be invoked after ${numberOfCallsIgnoredBeforeFlush + 1} subsequent draw calls.`);
        } else {
            this._drawCallIntrusion = undefined;
        }


        this.#animationFrameCallbacks = [];
        this.loadingAnimationDuration = -1;
        this.highResTimeStamp = -1;
        // render function is not part of the prototype but is assigned when instantiating the base class, that
        // is why we re-assign the render function
        this.#parentRender = this.render;
        this.#parentSetRenderTarget = this.setRenderTarget;
        this.render = LMVRenderer.prototype.render.bind(this);
        this.setRenderTarget = LMVRenderer.prototype.setRenderTarget.bind(this);
    }

    /**
     * @public Deprecated. Always returns true.
     * @returns {boolean} True
     */
    supportsMRT() {
        console.warn('LMVRenderer: .supportsMRT() has been deprecated. It always returns true.');
        return true;
    }


    updateTimestamp(highResTimeStamp) {
        return this.highResTimeStamp = highResTimeStamp;
    }

    getLoadingAnimationDuration() {
        return this.loadingAnimationDuration;
    }

    setLoadingAnimationDuration(duration) {
        return this.loadingAnimationDuration = duration;
    }

    clearBlend() {
        this.state.setBlending(THREE.NoBlending);
    }

    isWebGL2() {
        console.warn('LMVRenderer: .isWebGL2() has been deprecated. It always returns true.');
        return true;
    }

    /**
     * @overrride
     * @param {THREE.Scene|RenderBatch} scene
     * @param {THREE.Camera|Array<THREE.Camera>} camera
     * @param {Array<THREE.Light>} lights
     */
    render(scene, camera, lights) {
        this.#parentRender(scene, camera, false, lights);
    }

    /**
     * This function is supposed to be called by its owner, e.g., a `Viewer3DImpl` instance,
     * once all progressive geometry or post is done. This provides the renderer the means to
     * monitor, measure, and react on renderings spanning multiple, progressive frames.
     *
     * @todo: first step towards refined progressive rendering control. Suggest to add a
     * `notifyIntermediateFrameRendered()` as well.
     */
    notifyFinalFrameRendered(event) {
        if (this._drawCallIntrusion !== undefined) {
            this._drawCallIntrusion.resetCounters();
        }
    }

    /**
     * @overrride
     * @param {THREE.WebGLRenderTarget|THREE.WebGLMultipleRenderTarget} renderTarget
     */
    setRenderTarget(renderTarget) {
        this.#parentSetRenderTarget(renderTarget);
    }
}

EventDispatcher.prototype.apply(LMVRenderer.prototype);
LMVRenderer.Events = Events;