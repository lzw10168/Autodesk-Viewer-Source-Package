//
// Controls animations between different animation states.
//

import {
    SceneAnimState
} from './AnimState.js';


// An AnimController contains multiple scene animation states and can smoothly interpolate between those. Each state defines the positions for several objects.
//
// Example: Transition from "original shape positions" to "shapes are grouped by categories".
export default class AnimController {

    constructor(viewer) {

        // Describes animation state at the current time.
        this.currentState = new SceneAnimState();

        // Different states that we can interpolate between - indexed by stateName.
        this.states = {}; // string => SceneAnimState

        // Animation state at the point when the last animation had started
        this.startState = new SceneAnimState();

        // {Viewer3D}
        this.viewer = viewer;

        // Used to interrupt running in-progress animations
        this.animControl = null;
    }

    // Start animation to a target state.
    //
    // @param {string} [stateName] - A previously registered stateName or null. Null returns to original shape positions.
    //
    // @returns {AnimControl} Control in-progress animation..
    //                          control.stop(): to interrupt it.
    //                          control.isRunning(): to check whether it is in progress.
    animateTo(stateName = null, animTime = 2.0) {

        // Make sure that we don't run any previous animation concurrently
        this.stopAnim();

        const endState = this.states[stateName];

        const onTimer = t => {

            // Ensure that motion speed is changed smoothly
            t = Autodesk.Viewing.Private.smootherStep(t);

            this.currentState.lerp(this.startState, endState, t);
            this.currentState.apply(this.viewer);
        };

        // Freeze current SceneAnimState and keep it as start for interpolation
        this.startState.copyFrom(this.currentState);

        return Autodesk.Viewing.Private.fadeValue(0, 1, animTime, onTimer, () => this.onAnimEnded());
    }

    // Immediately stop current animation at its current state. No-op if no animation is running
    stopAnim() {
        if (this.animControl && this.animControl.isRunning) {
            this.animControl.stop();
            this.animControl = null;
        }
    }

    // Register new SceneState that we can animate to
    registerState(stateName, sceneState) {
        this.states[stateName] = sceneState;

        // Make sure that currentState addresses all objects that are modified by the new SceneAnimState.
        this.currentState.createObjectAnimStates(sceneState);
    }

    // Immediately apply a given animation state
    setState(stateName) {
        let state = this.states[stateName];
        if (state) {
            this.currentState.copyFrom(state);
        } else {
            // Recover shape transforms
            this.currentState.resetTransforms();
        }
        this.currentState.apply(this.viewer);
    }

    onAnimEnded() {
        //this should trigger ANIM_ENDED event
        this.viewer.dispatchEvent({
            type: Autodesk.Viewing.ANIM_ENDED
        });
    }

    // Ensures that no animation is active and all anim transform is being cleared for all fragments that we modified before.
    reset() {
        this.stopAnim();
        this.currentState.resetTransforms();
        this.currentState.apply(this.viewer);

        // Drop all states to free some memory
        this.currentState = new SceneAnimState();
        this.states = {};
        this.startState = new SceneAnimState();
    }
};