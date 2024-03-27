import {
    logger
} from "../../logger/Logger";

import {
    SpatialQuery
} from './SpatialQuery';
import {
    PropertyQuery
} from './PropertyQuery';
import {
    LambdaQuery
} from './LambdaQuery';


export const LoaderStateFlags = Object.freeze({
    FRAGMENT_LIST_READY: 1 << 0,
    BOUNDING_VOLUME_HIERARCHY_READY: 1 << 1,
    PROPERTIES_READY: 1 << 2,
});


/**
 * The spatial query behavior specifies when loading should start evaluating a given spatial query.
 * If no spatial query is set, this does not interfere with loading. If a spatial query is set,
 * it can be evaluated when (1) a preliminary fragment is ready (available in fragment list but fragment list
 * not yet complete), (2) the fragment list is complete (having all preliminary fragment data available), or
 * (3) when the bounding volume hierarchy is available, which provides a fragment list with more accurate
 * bounding volumes (@see SelectiveLoadingController.setSpatialQueryBehavior).
 */
export const SpatialQueryBehavior = Object.freeze({
    ON_FRAGMENT_READY: 'immediate',
    ON_FRAGMENT_LIST_READY: 'fast',
    ON_BOUNDING_VOLUME_HIERARCHY_READY: 'exact',
});
const DEFAULT_SPATIAL_QUERY_BEHAVIOR = SpatialQueryBehavior.ON_BOUNDING_VOLUME_HIERARCHY_READY;

/**
 * The root condition defines how top-level queries provided via loader options or set later are supposed
 * to be evaluated in respect to one another (@).
 */
export const RootCondition = Object.freeze({
    ANY: 0, // Fragment passes if it passes any top-level (root) queries.
    ALL: 1, // Fragment passes if it passes all top-level (root) queries.
});
const DEFAULT_ROOT_CONDITION = RootCondition.ALL;


/**
 * Selecitve loading controller provides facilities for load-time and run-time filtering of fragments based
 * on spatial queries, property queries, and custom queries. To be lazy on initializations but fast on
 * evaluations this class does the following:
 * - It tracks loader states to exactly and exclusively react when criteria for query evaluations are met.
 * - When a state changes, i.e., fragment list, bounding volume hierarchy, or properties ready, @see update
 *   is called which sets up the isFragmentPassing implementation and, if required, triggers (re)evaluation.
 * - The isFragmentPassing forwards to an internal isFragmentPassingImpl which is always set to the minimal
 *   evaluation required for the current loader state. This is to minimize per-fragment testing overhead.
 * - @see prepare can be used to initialize selective loading using loader options
 * - In addition, there is a dedicated fast-pass for the immediate, per-fragment evaluation of a set spatial
 *   query. In contrast to the other events, the onFragmentReady is skipping the internal update and sets
 *   isFragmentPassing implementation to the spatial test. This only works when (1) the spatial query
 *   behavior is set to 'immediate' using loader options (in prepare) and (2) only a spatial query is setup.
 * - To avoid any unnecessary per-fragment evaluation, two bits per fragment are stored for caching whether
 *   a fragment was already evaluated and if it has passed the evaluation.
 */
export class SelectiveLoadingController {

    _model;

    _rootCondition = DEFAULT_ROOT_CONDITION;

    /**
     * Is true if at any point in time, a valid query was set (@see isActive).
     */
    _active = false;

    /**
     * The spatial query is provided as Object (@see setSpatialQuery) and stored as string, since we are
     * using the static fromString initializer for creating and verifying the actual spatial query object
     * (@see SpatialQuery). The query is only created when (1) the loader is in a state ready for spatial
     * queries (accounting for the custom load-time behavior) and (2) @see update is called.
     */
    _spatialQuery = new SpatialQuery();
    _spatialQueryLoadTimeBehavior = DEFAULT_SPATIAL_QUERY_BEHAVIOR;

    /**
     * The property query is provided as Object (@see setPropertyQuery) and stored as string, since we are
     * using the static fromString initializer for creating and verifying the actual property query object
     * (@see PropertyQuery). The query is only created when (1) the loader is in a state ready for property
     * queries and (2) @see update is called.
     */
    _propertyQuery = new PropertyQuery();

    _lambdaQuery = new LambdaQuery();

    /**
     * Stores the loader states relevant for selective loading in a bitmask using @see LoaderStateFlags.
     */
    _state = 0x00;

    // /**
    //  * The loader might try to activate fragments multiple times. To avoid any unnecessary query evaluation,
    //  * we keep track for two things:
    //  *   1. Whether the fragment was evaluated since the loader's last state change.
    //  *   2. Whether the fragment has already passed an evaluation, thus is assumed to being loaded.
    //  * The second state might require additional handling as soon as unloading becomes available.
    //  *
    //  * The states can be accessed using
    //  *   @see _updateFragmentStates,
    //  *   @see _getFragmentEvaluationState,
    //  *   @see _getFragmentPassingState, and
    //  *   @see _resetFragmentStates.
    //  */
    // _fragmentEvaluationStates;
    // _fragmentPassingStates;
    // _invalidateCache = false;


    constructor(evaluateFn) {

        this.evaluate = evaluateFn;

        this._state = 0x00;
        this._isFragmentPassingImpl = this._isFragmentPassing_true;
    }

    // /**
    //  * Computes the byte index and bit for a uint8 cache storing a single bit per fragment.
    //  *
    //  * @param {number} fragmentID
    //  * @returns {[ number, number ]} - Tuple containing the byteIndex and the bit.
    //  */
    // _getCacheTuple(fragmentID) {
    //     return [ Math.floor(fragmentID / 8), 1 << (fragmentID % 8) ];
    // }

    // _updateFragmentStates(fragmentID, passing) {
    //     if (fragmentID === undefined) {
    //         return;
    //     }
    //     const [ byteIndex, bit ] = this._getCacheTuple(fragmentID);
    //     if (passing) {
    //         this._fragmentEvaluationStates[byteIndex] |= bit;
    //         this._fragmentPassingStates[byteIndex] |= bit;
    //     } else {
    //         this._fragmentEvaluationStates[byteIndex] &= ~bit;
    //     }
    // }

    // _getFragmentEvaluationState(fragmentID) {
    //     const [ byteIndex, bit ] = this._getCacheTuple(fragmentID);
    //     return !!(this._fragmentEvaluationStates[byteIndex] & bit);
    // }

    // _getFragmentPassingState(fragmentID) {
    //     const [ byteIndex, bit ] = this._getCacheTuple(fragmentID);
    //     return !!(this._fragmentPassingStates[byteIndex] & bit);
    // }

    // _resetFragmentStates() {
    //     const bytes = Math.ceil(this._model.getFragmentList().fragments.length / 8);
    //     if (this._fragmentEvaluationStates?.length !== bytes) {
    //         this._fragmentEvaluationStates = new Uint8Array(bytes);
    //         this._fragmentPassingStates = new Uint8Array(bytes);
    //     } else {
    //         this._fragmentEvaluationStates.set(this._fragmentPassingStates); // skip all fragments that have passed
    //     }
    //     this._invalidateCache = false;
    // }

    onModelRootReady(model) {
        this._model = model;
    }

    /**
     * In contrast to the other following event handlers, this one is special since it implements a fast-pass
     * to spatial evaluation instead of using the update procedure. The fast-pass is based on the 'immediate'
     * spatial load-time behavior (ON_FRAGMENT_READY) and setup only in the @see setSpatialQueryBehavior. If
     * fast-pass is available and set, isFragmentPassing should be set to _isFragmentPassing_spatial.
     *
     * @param {number} fragmentID - ID of a fragment to pass to evaluation.
     */
    onFragmentReady(fragmentID) {
        if (this._isFragmentPassingImpl !== this._isFragmentPassing_spatial) {
            return;
        }
        // if (!this._fragmentPassingStates) { // enable cache
        //     this._resetFragmentStates();
        // }
        this.evaluate(fragmentID);
    }

    onFragmentListReady() {
        this.update(LoaderStateFlags.FRAGMENT_LIST_READY);
    }

    onBoundingVolumeHierarchyReady() {
        this.update(LoaderStateFlags.BOUNDING_VOLUME_HIERARCHY_READY);
    }

    onPropertiesReady() {
        this.update(LoaderStateFlags.PROPERTIES_READY);
    }

    setRootCondition(rootCondition) {
        if (rootCondition === undefined || this._rootCondition === rootCondition) {
            return;
        }
        this._rootCondition = rootCondition;
    }

    /**
     * Sets the load time behavior for when to start evaluating spatial queries at load-time
     * (@see SpatialQueryBehavior). This becomes irrelevant as soon as all loading states have been passed.
     *
     * @param {SpatialQueryBehavior} loadTimeBehavior - When to trigger spatial fragment tests.
     */
    setSpatialQueryBehavior(loadTimeBehavior) {
        if (loadTimeBehavior === undefined || this._spatialQueryLoadTimeBehavior === loadTimeBehavior) {
            return;
        }
        this._spatialQueryLoadTimeBehavior = loadTimeBehavior;
    }
    setSpatialQuery(spatialQueryObject) {
        this._spatialQuery.fromObject(spatialQueryObject);
        this._active || = !this._spatialQuery.isEmpty(); // once a query is set, this flag remains true.
    }

    setPropertyQuery(propertyQueryObject) {
        this._propertyQuery.fromObject(propertyQueryObject);
        this._active || = !this._propertyQuery.isEmpty(); // once a query is set, this flag remains true.
    }

    setLambdaQuery(asyncInitObject, matchObject) {
        this._lambdaQuery.fromObjects(asyncInitObject, matchObject);
        this._active || = !this._lambdaQuery.isEmpty(); // once a query is set, this flag remains true.
    }

    /**
     * Convenience function to setup queries and other settings (e.g., load time behavior, root condition)
     * based on loader options. The relevant option is `filter` and can supports the following optional
     * properties:
     *
     * @example
     *  viewer.loadDocumentNode(lmvDocument, model, { // options object passed to this function
     *      filter: {
     *          // Behavior in case both spatial and property queries are used.
     *          'root_condition': 'or',    // 'or' | 'and' -> @see setRootCondition
     *          // Load time behavior describing when to execute spatial queries.
     *          'spatial_behavior': 'fast', // 'immediate' | 'fast' | 'exact' -> @see setSpatialQueryBehavior
     *          'spatial_query':  { ... },  // @see setSpatialQuery
     *          'property_query': { ... },  // @see setPropertyQuery
     *      } } );
     *
     * @param {Object} options - Loader options that @todo should have a deciated type for better
     *      communication, validation, and code navigation of all those options flying around in LMV.
     */
    prepare(options) {

        // Important: all queries for load-time must be set before spatial-query behavior is set to correctly
        // configure fast-pass mode for onFragmentReady (skipping update etc.).

        this.setSpatialQuery(options.filter ? .spatial_query);
        this.setPropertyQuery(options.filter ? .property_query);

        // If lambda query is set, it only is executed when neither a spatial nor a property query is set.
        // It also bypasses the caching and it initialized when fragment_list becomes ready.
        this.setLambdaQuery(options.filter ? .asyncInit, options.filter ? .match);

        const rootConditionOption = options.filter ? .root_condition;
        switch (rootConditionOption) {
            case 'or':
                this.setRootCondition(RootCondition.ANY);
                break;
            case 'and':
                this.setRootCondition(RootCondition.ALL);
                break;
            default:
                this.setRootCondition(DEFAULT_ROOT_CONDITION);
        }

        const queryBehaviorOption = options.filter ? .spatial_behavior;
        switch (queryBehaviorOption) {
            case SpatialQueryBehavior.ON_FRAGMENT_READY:
            case SpatialQueryBehavior.ON_FRAGMENT_LIST_READY:
            case SpatialQueryBehavior.ON_BOUNDING_VOLUME_HIERARCHY_READY:
                this.setSpatialQueryBehavior(queryBehaviorOption);
                break;
            default:
                this.setSpatialQueryBehavior(DEFAULT_SPATIAL_QUERY_BEHAVIOR);
        }

        const spatialQueryRequested = !this._spatialQuery.isEmpty();
        const noOtherQueriesRequested = this._propertyQuery.isEmpty();
        const noBlockingRequests = this._rootCondition === RootCondition.ANY || noOtherQueriesRequested;
        const readyForSpatialQuery = this._spatialQueryLoadTimeBehavior === SpatialQueryBehavior.ON_FRAGMENT_READY;

        const setupFastPass = spatialQueryRequested && readyForSpatialQuery && noBlockingRequests;
        if (!setupFastPass) {
            return;
        }

        this._spatialQuery.initialize();
        this._isFragmentPassingImpl = this._isFragmentPassing_spatial;
    }

    /**
     * Checks if queries are set, if so, checks if the actual query objects have been created already (and
     * if not, creates these). Finally, triggers the abstract evaluate function to (re)evaluate all fragments
     * for selective loading in the actual loader, i.e., OtgLoader. The provided fragment ID will be
     * passed through to the evaluate call. If no fragment ID is provided, all fragments will be evaluated,
     * otherwise, only the single fragment will be.
     */
    update(state = undefined, needsEvaluate = false) {

        if (state && !!(this._state & state)) {
            return;
        }
        this._state |= state;

        // Skip evaluation (always pass) if no queries are present:

        const noQueries = this._spatialQuery.isEmpty() && this._propertyQuery.isEmpty() && this._lambdaQuery.isEmpty();
        if (noQueries) {
            this._isFragmentPassingImpl = this._isFragmentPassing_true;
            if (!this._active) {
                return;
            }
            // this._resetFragmentStates(); // should not be required, since _isFragmentPassing_true skips caching
            this.evaluate();
            return;
        }

        this._state |= state !== undefined ? state : 0;

        // Check query-specific readyness:

        const lambdaQueryRequested = !this._lambdaQuery.isEmpty();
        const readyForLambdaQuery = !this._lambdaQuery.needsInitializing() || !!(this._state & LoaderStateFlags.FRAGMENT_LIST_READY);

        let readyForSpatialQuery = !lambdaQueryRequested;
        switch (this._spatialQueryLoadTimeBehavior) {
            case SpatialQueryBehavior.ON_FRAGMENT_READY:
                readyForSpatialQuery && = true;
                break;
            case SpatialQueryBehavior.ON_FRAGMENT_LIST_READY:
                readyForSpatialQuery && = !!(this._state & LoaderStateFlags.FRAGMENT_LIST_READY);
                break;
            case SpatialQueryBehavior.ON_BOUNDING_VOLUME_HIERARCHY_READY:
                readyForSpatialQuery && = !!(this._state & LoaderStateFlags.BOUNDING_VOLUME_HIERARCHY_READY);
                break;
        }

        const readyForPropertyQuery = !lambdaQueryRequested &&
            !!(this._state & LoaderStateFlags.FRAGMENT_LIST_READY) &&
            !!(this._state & LoaderStateFlags.PROPERTIES_READY);

        // Initialize queries if required:

        const spatialQueryRequested = !this._spatialQuery.isEmpty();
        if (spatialQueryRequested && readyForSpatialQuery && !this._spatialQuery.isReady()) {
            this._spatialQuery.initialize();
            // this._invalidateCache = true;
            needsEvaluate = true;
        } else if (spatialQueryRequested && !lambdaQueryRequested && !readyForSpatialQuery) {
            // If a spatial query was requested but isn't ready yet, we defer evaluation of a potentially set
            // property query.
            needsEvaluate = false;
        }

        const propertyQueryRequested = !this._propertyQuery.isEmpty();
        if (propertyQueryRequested && readyForPropertyQuery && !this._propertyQuery.isReady() && !this._propertyQuery.isInitializing()) {
            // The property query initialization is asynchronous, so in this run, _propertyQuery is most likely not
            // ready. If its initialization is done, update is called again;
            const scope = this;
            this._propertyQuery.initialize(this._model).then(() => scope.update(undefined, true));
            // this._invalidateCache = true;
            return;
        } else if (propertyQueryRequested && !lambdaQueryRequested &&
            (!readyForPropertyQuery || this._propertyQuery.isInitializing())) {
            // If a property query was requested but isn't ready yet, we defer evaluation of a potentially set
            // spatial query.
            needsEvaluate = false;
        }

        if (lambdaQueryRequested && readyForLambdaQuery && !this._lambdaQuery.isReady() && !this._lambdaQuery.isInitializing()) {
            // The lambda query initialization is asynchronous, so in this run, _lambdaQuery is most likely not
            // ready. If its initialization is done, update is called again;
            const scope = this;
            this._lambdaQuery.initialize(this._model).catch(err => {
                logger.warn("Filter initialization failed, falling back to load the whole model", err);
                this.setLambdaQuery(undefined);
            }).then(() => scope.update(undefined, true));
            return;
        }

        // Assign evaluation function and trigger evaluation if required:

        const evaluateLambdaQuery = lambdaQueryRequested && readyForLambdaQuery && this._lambdaQuery.isReady();
        if (evaluateLambdaQuery) {
            // currently, lambda queries and the other queries are mutually exclusive...
            this._isFragmentPassingImpl = this._isFragmentPassing_lambda;
            needsEvaluate = true;
        } else {

            const evaluateSpatialQuery = spatialQueryRequested && readyForSpatialQuery && this._spatialQuery.isReady();
            const evaluatePropertyQuery = propertyQueryRequested && readyForPropertyQuery && this._propertyQuery.isReady();

            const bitmask = this._rootCondition |
                (spatialQueryRequested << 1) | (evaluateSpatialQuery << 2) |
                (propertyQueryRequested << 3) | (evaluatePropertyQuery << 4);

            switch (bitmask) {
                case 0b00110:
                case 0b01110:
                case 0b00111:
                    this._isFragmentPassingImpl = this._isFragmentPassing_spatial;
                    break;
                case 0b11000:
                case 0b11010:
                case 0b11001:
                    this._isFragmentPassingImpl = this._isFragmentPassing_property;
                    break;
                case 0b11110:
                    this._isFragmentPassingImpl = this._isFragmentPassing_any;
                    break;
                case 0b11111:
                    this._isFragmentPassingImpl = this._isFragmentPassing_all;
                    break;
                default:
                    this._isFragmentPassingImpl = this._isFragmentPassing_false;
            }
        }
        if (this._isFragmentPassingImpl === this._isFragmentPassing_false) {
            return;
        }
        // if (this._invalidateCache) {
        //     this._resetFragmentStates();
        // }
        if (needsEvaluate) {
            this.evaluate();
        }
    }

    /**
     * Must be set in the constructor and is expected to iterate over all fragments
     * and decide whether to load/request them or not. For this, the subclass is expected to rely on this
     * class's @see isFragmentPassing implementation.
     *
     * @param {number} fragmentID - ID of a fragment to focus evaluation on. If undefined (default), all
     *      fragments should be (re)evaluated.
     */
    evaluate(fragmentID = undefined) {
        throw new TypeError('Method expected to be replaced.');
    }

    /**
     * The following functions check if a fragment of a model passes all set queries. Before this works,
     * update needs to be called which sets up the actual query predicates if required or modified.
     * Predicates are provided by query objects and have the exact same function name and signature. So
     * based on the root condition (any|all), all types of queries (spatially-based and property-based so
     * far) are evaluated.
     *
     * To reduce the number of computations and lookups a simple caching is implemented tracking if fragments
     * have been evaluated already and if they have passed the predicates.
     * The specific evaluation is pre-set to one of the following different fixed functions in @see update.
     */

    _isFragmentPassing_true() {
        return true;
    }
    _isFragmentPassing_false() {
        return false;
    }
    _isFragmentPassing_spatial(fragmentID) {
        return this._spatialQuery.isFragmentPassing(this._model, fragmentID);
    }
    _isFragmentPassing_property(fragmentID) {
        return this._propertyQuery.isFragmentPassing(this._model, fragmentID);
    }
    _isFragmentPassing_all(fragmentID) {
        return this._spatialQuery.isFragmentPassing(this._model, fragmentID) && this._propertyQuery.isFragmentPassing(this._model, fragmentID);
    }
    _isFragmentPassing_any(fragmentID) {
        return this._spatialQuery.isFragmentPassing(this._model, fragmentID) || this._propertyQuery.isFragmentPassing(this._model, fragmentID);
    }
    _isFragmentPassing_lambda(fragmentID) {
        return this._lambdaQuery.isFragmentPassing(this._model, fragmentID);
    }
    _isFragmentPassingImpl(fragmentID) {
        throw new TypeError('This method must be set to a specific evaluation.');
    }

    isFragmentPassing(fragmentID) {
        if (this._isFragmentPassingImpl === this._isFragmentPassing_true ||
            this._isFragmentPassingImpl === this._isFragmentPassing_false ||
            this._isFragmentPassingImpl === this._isFragmentPassing_lambda) {
            return this._isFragmentPassingImpl(fragmentID);
        }
        // if (this._getFragmentEvaluationState(fragmentID)) {
        //     return this._getFragmentPassingState(fragmentID); // If already evaluated, return that result.
        // }
        const result = this._isFragmentPassingImpl(fragmentID);
        // this._updateFragmentStates(fragmentID, result); // Remember for subsequent 'passing' requests.
        return result;
    }

    /**
     * True if at any time a valid query was set (even though not created yet). This can be used by the
     * loader to adapt its loading behavior, e.g., keep workers alive for later use (modified or removed
     * queries). False by default and if no query was set. Queries can be set directly (@see setSpatialQuery,
     * @see setPropertyQuery, ...) or implicitly (@see prepare), e.g., using options.
     */
    get isActive() {
        return this._active;
    }

}